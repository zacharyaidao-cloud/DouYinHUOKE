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

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, 'results.json');
  const previous = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
  const settled = new Set(previous.filter(row => ['confirmed_success', 'refused', 'skipped', 'pending_verification'].includes(row.dm?.state)).map(row => row.secUid));
  const targets = JSON.parse(fs.readFileSync(listFile, 'utf8')).filter(row => row.priority === priority && row.secUid && !settled.has(row.secUid));
  const trace = createTrace(path.join(outDir, 'trace.jsonl'));
  trace.step('outreach.plan', { priority, users: targets.length, follow, dm, alreadySettled: settled.size, message });
  const session = new Session({ profileDir, trace });
  try {
    await session.open();
    if (!await session.ensureLogin()) throw new Error('未登录');
    const all = [...previous];
    await outreachList(session, targets, { follow, dm, message, onResult: result => {
      all.push({ ...result, at: new Date().toISOString() });
      fs.writeFileSync(resultsFile, JSON.stringify(all, null, 2), 'utf8');
    } });
    const tally = key => all.reduce((acc, row) => ({ ...acc, [row[key]?.state || 'none']: (acc[row[key]?.state || 'none'] || 0) + 1 }), {});
    trace.step('outreach.done', { follow: tally('follow'), dm: tally('dm') });
  } catch (error) {
    trace.step('outreach.error', { message: error.message });
  } finally { await session.close(); }
})();
