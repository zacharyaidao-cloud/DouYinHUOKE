'use strict';
/**
 * 核心流程 · ⑤ 多账号轮换触达
 *
 * 规则（2026-10-21 用户确认）：
 *   - 名单是共享用户池；账号按顺序轮流，一次只开一个账号的浏览器。
 *   - 每个号发满 perTurn（默认 5）人立即切换下一个号；所有可用号都发过一轮 → 统一休息 roundRestMin（默认 5 分钟）再开始下一轮。
 *     单号时即“发 5 人、休息 5 分钟”。
 *   - 某个号“频繁”（账号级拒绝，实测回执 send=3/check_code=2）：从触发那一刻起暂停 30 分钟 → 到点试发 1 人；
 *     仍频繁暂停 1 小时、再仍频繁暂停 2 小时；试发 3 次仍频繁 → 按今日上限处理。试发恢复则回到正常轮换。
 *     暂停期间其他号照常轮换，不等这个号。
 *   - 显示“今日上限”→ 该号今天的额度用完，不再使用。
 *   - 因账号级拒绝没发出去的用户回到池里，由下一个号联系；对方原因发不出去的不再重试。
 *   - 没打开聊天（入口 / 会话 / 填写）的人回池再试一次（会话建好后再开通常正常），累计 2 次才算定论。
 *   - 登录失效 / 验证未完成：该号本次不再使用（unhealthy），其余号继续。
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

async function distribute({ accounts, targets, message, follow = true, dm = true, trace, perTurn = 5,
  roundRestMin = 5, frequentLadderMin = [30, 60, 120], history = [], pacing = DEFAULT_PACING.outreach, onResult = () => {},
  sleep = ms => new Promise(r => setTimeout(r, ms)), openSession, runList = outreachList, now: clock = Date.now }) {
  const ladder = (Array.isArray(frequentLadderMin) && frequentLadderMin.length ? frequentLadderMin : [30, 60, 120]).map(m => Math.max(1, Number(m) || 30));
  const queue = accounts.map(account => ({ ...account, state: 'ready', coolUntil: 0, tries: 0, cooldowns: 0, sent: 0, turned: false }));
  const settled = createSettled(history);
  const followed = new Set(history.filter(row => FOLLOWED.includes(row.follow?.state)).map(row => row.secUid));
  const withFollow = row => followed.has(row.secUid) ? { ...row, skipFollow: true } : row;
  let pool = targets.map(withFollow);
  let restUntil = 0;
  const open = openSession || (account => new Session({ profileDir: account.profileDir, trace }).open());
  const label = account => account.name || account.id;
  trace.step('dist.plan', { accounts: queue.map(label), users: pool.length, perTurn, roundRestMin, frequentLadderMin: ladder });
  while (pool.length) {
    const now = clock();
    const usable = queue.filter(a => ['ready', 'cooling'].includes(a.state));
    if (!usable.length) { trace.step('dist.halt', { reason: '没有可用账号（全部今日上限或异常）', remaining: pool.length }); break; }
    // 冷却到点的号优先试发（计时从该号触发频繁那一刻开始，不等其他号的流程）；否则轮到本轮还没发过的号
    let account = usable.find(a => a.state === 'cooling' && a.coolUntil <= now);
    if (!account && now >= restUntil) account = queue.find(a => a.state === 'ready' && !a.turned);
    if (!account) {
      const ready = queue.filter(a => a.state === 'ready');
      if (ready.length && now >= restUntil) {
        // 可用号都发过一轮 → 统一休息后开始下一轮
        restUntil = now + roundRestMin * 60000;
        ready.forEach(a => { a.turned = false; });
        trace.step('dist.round_rest', { minutes: roundRestMin, remaining: pool.length });
        continue;
      }
      const wakeAt = Math.min(...[...(ready.length ? [restUntil] : []), ...usable.filter(a => a.state === 'cooling').map(a => a.coolUntil)]);
      const waitMs = Math.max(0, wakeAt - now);
      trace.step('dist.wait', { waitMin: Math.round(waitMs / 6000) / 10, cooling: usable.filter(a => a.state === 'cooling').map(a => ({ account: label(a), resumeInMin: Math.round((a.coolUntil - now) / 6000) / 10 })) });
      await sleep(waitMs);
      continue;
    }
    const probing = account.state === 'cooling';
    const batch = pool.slice(0, probing ? 1 : perTurn);
    trace.step('dist.turn', { account: label(account), probing, users: batch.length, poolLeft: pool.length });
    let session;
    try {
      session = await open(account);
      if (!await session.ensureLogin(60000)) { account.state = 'unhealthy'; trace.step('dist.account_unhealthy', { account: label(account), reason: '未登录' }); continue; }
      const results = await runList(session, batch, { follow, dm, message, pacing, onResult: row => { settled.record(row); onResult({ ...row, accountId: account.id }); } });
      for (const row of results) if (FOLLOWED.includes(row.follow?.state)) followed.add(row.secUid);
      const done = new Set(results.filter(settled.settledOf).map(row => row.secUid));
      const tried = new Set(results.map(row => row.secUid));
      account.sent += results.filter(row => row.dm?.state === 'confirmed_success').length;
      // 未定论的已处理用户排到池尾（过后再试 / 由下一个账号联系），已关注的不再点关注
      pool = [...pool.filter(row => !done.has(row.secUid) && !tried.has(row.secUid)), ...pool.filter(row => !done.has(row.secUid) && tried.has(row.secUid)).map(withFollow)];
      const stop = results[results.length - 1]?.stop;
      if (isDailyLimit(stop)) { account.state = 'done_today'; trace.step('dist.account_daily_limit', { account: label(account), sent: account.sent, reason: '平台提示今日上限' }); }
      else if (isFrequent(stop)) {
        // 首次频繁暂停 ladder[0]；到点试发仍频繁依次暂停 ladder[1]、ladder[2]；试发 ladder.length 次仍频繁 → 今日上限
        if (probing) account.tries++; else account.tries = 0;
        account.cooldowns++;
        if (probing && account.tries >= ladder.length) {
          account.state = 'done_today';
          trace.step('dist.account_daily_limit', { account: label(account), sent: account.sent, reason: `频繁后试发 ${account.tries} 次仍频繁，按今日上限处理` });
        } else {
          const minutes = ladder[Math.min(account.tries, ladder.length - 1)];
          account.state = 'cooling'; account.coolUntil = clock() + minutes * 60000;
          trace.step('dist.account_cooling', { account: label(account), minutes, sent: account.sent, tries: account.tries });
        }
      } else if (stop) { account.state = 'unhealthy'; trace.step('dist.account_unhealthy', { account: label(account), reason: stop.reason }); }
      else if (probing) {
        // 试发恢复：回到正常轮换，本轮还能正常发一次
        trace.step('dist.account_recovered', { account: label(account), tries: account.tries });
        account.state = 'ready'; account.coolUntil = 0; account.tries = 0; account.turned = false;
      } else { account.state = 'ready'; account.turned = true; }
    } catch (error) {
      account.state = 'unhealthy';
      trace.step('dist.account_error', { account: label(account), message: error.message });
    } finally { if (session && typeof session.close === 'function') await session.close(); }
  }
  const summary = queue.map(a => ({ account: label(a), state: a.state, sent: a.sent, cooldowns: a.cooldowns }));
  trace.step('dist.done', { remaining: pool.length, accounts: summary });
  return { remaining: pool, accounts: summary };
}

module.exports = { createSettled, distribute, settledOf };
