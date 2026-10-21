'use strict';
/**
 * 核心流程 · ⑤ 多账号轮换触达
 *
 * 规则（用户确认）：
 *   - 名单是共享用户池；账号按顺序轮流，一次只开一个账号的浏览器。
 *   - 每个账号连续处理用户，直到：本轮配额用完（perTurn）→ 正常排到队尾；
 *     遇到“频繁”（账号级拒绝，实测回执 send=3/check_code=2）→ 进入冷却、排到队尾；
 *     遇到“今日上限”→ 该账号今天完成，不再使用。
 *   - 因账号级拒绝没发出去的用户回到池里，由下一个账号联系；对方原因发不出去的不再重试。
 *   - 正常用完一轮配额 → 该账号静默休息 restMin（默认 60 分钟；实测一阵约 11–12 条触发频繁）后才再轮到。
 *   - 所有可用账号都在冷却 / 休息时：等到最早到期者。冷却到期的账号先试发 1 人：恢复则继续；
 *     **仍频繁 → 按今日上限处理**（2026-10-21 实测：当日约 30 条后，安静 3.5 小时仍是同一回执，平台不区分“频繁”与“当日额度”）。
 *   - 没打开聊天（入口 / 会话 / 填写）的人回池再试一次（会话建好后再开通常正常），累计 2 次才算定论。
 *   - 登录失效 / 验证未完成：该账号本次不再使用（unhealthy），其余账号继续。
 * 冷却时长：首次 cooldownMin（默认 60 分钟。2026-10-21 实测：频繁后 30 分钟内反复试探均被拒；两次“完全安静 60 分钟”后首条即恢复），之后逐次翻倍。
 */
const { Session } = require('./session');
const { outreachList } = require('./outreach');
const { DEFAULT_PACING } = require('./pacing');

const NOT_OPENED = ['entry', 'conversation', 'fill'];
// history：此前的结果行（用于累计“没打开聊天”的次数）。返回 { settledOf(row), record(row) }。
function createSettled(history = []) {
  const notOpened = new Map();
  const record = row => { if (row.dm?.state === 'not_sent' && NOT_OPENED.includes(row.dm.stage)) notOpened.set(row.secUid, (notOpened.get(row.secUid) || 0) + 1); };
  history.forEach(record);
  const settledOf = row => {
    const dm = row.dm || {};
    if (['confirmed_success', 'refused', 'skipped', 'pending_verification'].includes(dm.state)) return true;
    if (dm.state === 'not_sent' && NOT_OPENED.includes(dm.stage)) return (notOpened.get(row.secUid) || 0) >= 2;
    if (dm.state === 'not_sent' && dm.stage !== 'error') return true;
    // 只有检查码 2、无提示文字的拒绝也是账号级频繁（旧结果里可能未带 failureScope）
    if (dm.state === 'confirmed_failure' && dm.failureScope !== 'account' && !/检查码：2/.test(dm.reason || '')) return true;
    return false;
  };
  return { settledOf, record };
}
const settledOf = createSettled().settledOf;
const FOLLOWED = ['confirmed_success', 'requested', 'already'];
const isDailyLimit = stop => /DAILY_LIMIT|daily_limit/i.test(stop?.code || '');
const isFrequent = stop => /FREQUENT|restricted/i.test(stop?.code || '');

async function distribute({ accounts, targets, message, follow = true, dm = true, trace, perTurn = 10,
  cooldownMin = 60, restMin = 60, history = [], pacing = DEFAULT_PACING.outreach, onResult = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), openSession, runList = outreachList, now: clock = Date.now }) {
  const queue = accounts.map(account => ({ ...account, state: 'ready', coolUntil: 0, cooldowns: 0, sent: 0 }));
  const settled = createSettled(history);
  const followed = new Set(history.filter(row => FOLLOWED.includes(row.follow?.state)).map(row => row.secUid));
  const withFollow = row => followed.has(row.secUid) ? { ...row, skipFollow: true } : row;
  let pool = targets.map(withFollow);
  const open = openSession || (account => new Session({ profileDir: account.profileDir, trace }).open());
  trace.step('dist.plan', { accounts: queue.map(a => a.name || a.id), users: pool.length, perTurn, cooldownMin, restMin });
  while (pool.length) {
    const now = clock();
    const usable = queue.filter(a => ['ready', 'cooling', 'resting'].includes(a.state));
    if (!usable.length) { trace.step('dist.halt', { reason: '没有可用账号（全部今日上限或异常）', remaining: pool.length }); break; }
    let account = usable.find(a => a.state === 'ready' || a.coolUntil <= now);
    if (!account) {
      const next = usable.reduce((a, b) => (a.coolUntil <= b.coolUntil ? a : b));
      const waitMs = Math.max(0, next.coolUntil - now);
      trace.step('dist.all_cooling', { waitMin: Math.round(waitMs / 60000), next: next.name || next.id, state: next.state });
      await sleep(waitMs);
      continue;
    }
    const probing = account.state === 'cooling';
    if (account.state === 'resting') { account.state = 'ready'; account.coolUntil = 0; }
    // 轮到的账号移到队尾（不论结果如何，下一次从其他账号开始）
    queue.splice(queue.indexOf(account), 1); queue.push(account);
    const batch = pool.slice(0, probing ? 1 : perTurn);
    trace.step('dist.turn', { account: account.name || account.id, probing, users: batch.length, poolLeft: pool.length });
    let session;
    try {
      session = await open(account);
      if (!await session.ensureLogin(60000)) { account.state = 'unhealthy'; trace.step('dist.account_unhealthy', { account: account.name || account.id, reason: '未登录' }); continue; }
      const results = await runList(session, batch, { follow, dm, message, pacing, onResult: row => { settled.record(row); onResult({ ...row, accountId: account.id }); } });
      for (const row of results) if (FOLLOWED.includes(row.follow?.state)) followed.add(row.secUid);
      const done = new Set(results.filter(settled.settledOf).map(row => row.secUid));
      const tried = new Set(results.map(row => row.secUid));
      account.sent += results.filter(row => row.dm?.state === 'confirmed_success').length;
      // 未定论的已处理用户排到池尾（过后再试 / 由下一个账号联系），已关注的不再点关注
      pool = [...pool.filter(row => !done.has(row.secUid) && !tried.has(row.secUid)), ...pool.filter(row => !done.has(row.secUid) && tried.has(row.secUid)).map(withFollow)];
      const stop = results[results.length - 1]?.stop;
      if (isDailyLimit(stop)) { account.state = 'done_today'; trace.step('dist.account_daily_limit', { account: account.name || account.id, sent: account.sent }); }
      else if (isFrequent(stop) && probing) {
        account.state = 'done_today';
        trace.step('dist.account_daily_limit', { account: account.name || account.id, sent: account.sent, reason: '冷却后首条仍频繁，按今日上限处理' });
      } else if (isFrequent(stop)) {
        account.cooldowns++;
        account.state = 'cooling'; account.coolUntil = clock() + cooldownMin * 60000;
        trace.step('dist.account_cooling', { account: account.name || account.id, minutes: cooldownMin, sent: account.sent, cooldowns: account.cooldowns });
      } else if (stop) { account.state = 'unhealthy'; trace.step('dist.account_unhealthy', { account: account.name || account.id, reason: stop.reason }); }
      else {
        if (probing) trace.step('dist.account_recovered', { account: account.name || account.id, cooldowns: account.cooldowns });
        // 试发恢复后立刻接着发；正常用完一轮配额则静默休息，避免连续发送触发频繁
        if (!probing && batch.length >= perTurn && restMin > 0 && pool.length) {
          account.state = 'resting'; account.coolUntil = clock() + restMin * 60000;
          trace.step('dist.account_resting', { account: account.name || account.id, minutes: restMin, sent: account.sent });
        } else { account.state = 'ready'; account.coolUntil = 0; }
      }
    } catch (error) {
      account.state = 'unhealthy';
      trace.step('dist.account_error', { account: account.name || account.id, message: error.message });
    } finally { if (session && typeof session.close === 'function') await session.close(); }
  }
  const summary = queue.map(a => ({ account: a.name || a.id, state: a.state, sent: a.sent, cooldowns: a.cooldowns }));
  trace.step('dist.done', { remaining: pool.length, accounts: summary });
  return { remaining: pool, accounts: summary };
}

module.exports = { createSettled, distribute, settledOf };
