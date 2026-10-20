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
 *   - 所有可用账号都在冷却时：等到最早的冷却到期，用该账号试发 1 人，恢复则继续，否则冷却翻倍（上限 maxCooldownMin）。
 *   - 登录失效 / 验证未完成：该账号本次不再使用（unhealthy），其余账号继续。
 * 冷却时长：首次 cooldownMin（默认 30 分钟，2026-10-21 实测测试号触发频繁后至少 18 分钟仍未恢复），之后逐次翻倍。
 */
const { Session } = require('./session');
const { outreachList } = require('./outreach');
const { DEFAULT_PACING } = require('./pacing');

function settledOf(row) {
  const dm = row.dm || {};
  if (['confirmed_success', 'refused', 'skipped', 'pending_verification'].includes(dm.state)) return true;
  if (dm.state === 'not_sent' && dm.stage !== 'error') return true;
  if (dm.state === 'confirmed_failure' && dm.failureScope !== 'account') return true;
  return false;
}
const isDailyLimit = stop => /DAILY_LIMIT|daily_limit/i.test(stop?.code || '');
const isFrequent = stop => /FREQUENT|restricted/i.test(stop?.code || '');

async function distribute({ accounts, targets, message, follow = true, dm = true, trace, perTurn = 10,
  cooldownMin = 30, maxCooldownMin = 120, pacing = DEFAULT_PACING.outreach, onResult = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), openSession, runList = outreachList, now: clock = Date.now }) {
  const queue = accounts.map(account => ({ ...account, state: 'ready', coolUntil: 0, cooldowns: 0, sent: 0 }));
  let pool = [...targets];
  const open = openSession || (account => new Session({ profileDir: account.profileDir, trace }).open());
  trace.step('dist.plan', { accounts: queue.map(a => a.name || a.id), users: pool.length, perTurn, cooldownMin });
  while (pool.length) {
    const now = clock();
    const usable = queue.filter(a => ['ready', 'cooling'].includes(a.state));
    if (!usable.length) { trace.step('dist.halt', { reason: '没有可用账号（全部今日上限或异常）', remaining: pool.length }); break; }
    let account = usable.find(a => a.state === 'ready' || a.coolUntil <= now);
    if (!account) {
      const next = usable.reduce((a, b) => (a.coolUntil <= b.coolUntil ? a : b));
      const waitMs = Math.max(0, next.coolUntil - now);
      trace.step('dist.all_cooling', { waitMin: Math.round(waitMs / 60000), next: next.name || next.id });
      await sleep(waitMs);
      continue;
    }
    const probing = account.state === 'cooling';
    // 轮到的账号移到队尾（不论结果如何，下一次从其他账号开始）
    queue.splice(queue.indexOf(account), 1); queue.push(account);
    const batch = pool.slice(0, probing ? 1 : perTurn);
    trace.step('dist.turn', { account: account.name || account.id, probing, users: batch.length, poolLeft: pool.length });
    let session;
    try {
      session = await open(account);
      if (!await session.ensureLogin(60000)) { account.state = 'unhealthy'; trace.step('dist.account_unhealthy', { account: account.name || account.id, reason: '未登录' }); continue; }
      const results = await runList(session, batch, { follow, dm, message, pacing, onResult: row => onResult({ ...row, accountId: account.id }) });
      const done = new Set(results.filter(settledOf).map(row => row.secUid));
      account.sent += results.filter(row => row.dm?.state === 'confirmed_success').length;
      pool = pool.filter(row => !done.has(row.secUid));
      const stop = results[results.length - 1]?.stop;
      if (isDailyLimit(stop)) { account.state = 'done_today'; trace.step('dist.account_daily_limit', { account: account.name || account.id, sent: account.sent }); }
      else if (isFrequent(stop)) {
        account.cooldowns++;
        const minutes = Math.min(maxCooldownMin, cooldownMin * 2 ** (account.cooldowns - 1));
        account.state = 'cooling'; account.coolUntil = clock() + minutes * 60000;
        trace.step('dist.account_cooling', { account: account.name || account.id, minutes, sent: account.sent, cooldowns: account.cooldowns });
      } else if (stop) { account.state = 'unhealthy'; trace.step('dist.account_unhealthy', { account: account.name || account.id, reason: stop.reason }); }
      else {
        if (probing) trace.step('dist.account_recovered', { account: account.name || account.id, cooldowns: account.cooldowns });
        account.state = 'ready'; account.coolUntil = 0;
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

module.exports = { distribute, settledOf };
