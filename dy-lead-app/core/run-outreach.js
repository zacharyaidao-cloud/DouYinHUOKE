'use strict';
/**
 * 核心流程 · 关注 + 私信执行入口（只处理名单文件里经人工确认的用户）
 *
 *   node core/run-outreach.js --profile=<资料目录> --list=<名单.json> --out=<输出目录> --message=<话术> [--priority=A] [--follow=1] [--dm=1]
 *
 * 名单文件为数组，每项至少含 nickname、secUid、uid（数字 UID，用于协议核验）、priority。
 * 输出：trace.jsonl（每步动作与响应）、results.json（每人的关注/私信结果与停止原因）。
 * 已在 results.json 里有确定结果（成功/已关注/拒绝）的用户再次运行时跳过，不会重复发送。
 */
const fs = require('node:fs');
const path = require('node:path');
const { Session } = require('./session');
const { createTrace } = require('./trace');
const { outreachList } = require('./outreach');

const arg = name => (process.argv.find(value => value.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const profileDir = arg('profile'), listFile = arg('list'), outDir = arg('out'), message = arg('message').trim();
const priority = arg('priority') || 'A';
const follow = arg('follow') !== '0', dm = arg('dm') !== '0';
if (!profileDir || !listFile || !outDir || (dm && !message)) {
  console.error('用法：node core/run-outreach.js --profile=<资料目录> --list=<名单.json> --out=<输出目录> --message=<话术> [--priority=A] [--follow=1] [--dm=1]');
  process.exit(2);
}

// 一个用户是否已有“定论”（不再重试）：送达 / 跳过 / 待核验 / 对方原因发不出（私密、窗口不出现、接收人级拒绝）。
// 账号级拒绝（频繁、上限）不算定论：对方根本没收到，账号恢复后要重发。
function settledOf(row) {
  const dm = row.dm || {};
  if (['confirmed_success', 'refused', 'skipped', 'pending_verification'].includes(dm.state)) return true;
  if (dm.state === 'not_sent' && dm.stage !== 'error') return true;
  if (dm.state === 'confirmed_failure' && dm.failureScope !== 'account') return true;
  return false;
}
const probeMinutes = Math.max(0, Number(arg('probe-interval-min')) || 0); // >0：触发频繁后每隔 N 分钟试发 1 条，恢复即续发
const probeMax = Math.max(1, Number(arg('probe-max')) || 18);

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, 'results.json');
  const all = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
  const latest = new Map(); for (const row of all) latest.set(row.secUid, row);
  const settled = new Set([...latest.values()].filter(settledOf).map(row => row.secUid));
  // 以前已关注成功/已请求的人：重发私信时不再点关注
  const followed = new Set(all.filter(row => ['confirmed_success', 'requested', 'already'].includes(row.follow?.state)).map(row => row.secUid));
  let targets = JSON.parse(fs.readFileSync(listFile, 'utf8')).filter(row => row.priority === priority && row.secUid && !settled.has(row.secUid))
    .map(row => followed.has(row.secUid) ? { ...row, skipFollow: true } : row);
  const trace = createTrace(path.join(outDir, 'trace.jsonl'));
  trace.step('outreach.plan', { priority, users: targets.length, follow, dm, alreadySettled: settled.size, probeMinutes, message });
  const session = new Session({ profileDir, trace });
  const save = result => { all.push({ ...result, at: new Date().toISOString() }); fs.writeFileSync(resultsFile, JSON.stringify(all, null, 2), 'utf8'); };
  try {
    await session.open();
    if (!await session.ensureLogin()) throw new Error('未登录');
    let limitedAt = null, probes = 0;
    while (targets.length) {
      const results = await outreachList(session, targets, { follow, dm, message, onResult: save });
      const done = new Set(results.filter(settledOf).map(row => row.secUid));
      targets = targets.filter(row => !done.has(row.secUid));
      const stop = results[results.length - 1]?.stop;
      if (!stop) break;                                       // 名单走完
      const frequent = /FREQUENT|restricted/i.test(stop.code || '');
      if (!frequent || !probeMinutes) { trace.step('outreach.halt', { reason: stop.reason, code: stop.code, remaining: targets.length }); break; }
      limitedAt = limitedAt || Date.now();
      // 频繁冷却：每隔 N 分钟只试发 1 人，恢复了就回到上面的循环继续发
      let recovered = false;
      while (!recovered && probes < probeMax && targets.length) {
        trace.step('outreach.cooldown_wait', { minutes: probeMinutes, sinceLimitedMin: Math.round((Date.now() - limitedAt) / 60000), probes, remaining: targets.length });
        await session.page.waitForTimeout(probeMinutes * 60000);
        probes++;
        const [probe] = await outreachList(session, targets.slice(0, 1), { follow, dm, message, onResult: row => { save(row); if (['confirmed_success', 'requested'].includes(row.follow?.state)) targets[0] = { ...targets[0], skipFollow: true }; } });
        const minutes = Math.round((Date.now() - limitedAt) / 60000);
        if (probe?.dm?.state === 'confirmed_success') {
          recovered = true;
          trace.step('outreach.recovered', { afterMinutes: minutes, probes });
          limitedAt = null;
        } else trace.step('outreach.still_limited', { afterMinutes: minutes, probes, dm: probe?.dm?.state, code: probe?.stop?.code || probe?.dm?.failureCode || '' });
        if (probe && settledOf(probe)) targets = targets.slice(1);
      }
      if (!recovered) { trace.step('outreach.halt', { reason: '冷却试探次数用尽仍未恢复', probes, remaining: targets.length }); break; }
    }
    const tally = key => all.reduce((acc, row) => ({ ...acc, [row[key]?.state || 'none']: (acc[row[key]?.state || 'none'] || 0) + 1 }), {});
    trace.step('outreach.done', { follow: tally('follow'), dm: tally('dm'), remaining: targets.length });
  } catch (error) {
    trace.step('outreach.error', { message: error.message });
  } finally { await session.close(); }
})();
