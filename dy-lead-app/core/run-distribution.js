'use strict';
/**
 * 核心流程 · 多账号轮换触达入口
 *
 *   node core/run-distribution.js --accounts=名称1=资料目录1,名称2=资料目录2 --list=<名单.json> --out=<输出目录>
 *        --message=<话术> [--priority=R2] [--per-turn=10] [--rest-min=60] [--cooldown-min=60] [--follow=1] [--dm=1] [--dry-run=1]
 *
 * 每个账号一个浏览器资料目录（先用 core/run-login.js 扫码登录过）。
 * 结果写入 results.json（含 accountId）；已有定论的用户再次运行时跳过，账号级拒绝的用户会重新入池。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createTrace } = require('./trace');
const { distribute, createSettled } = require('./distribution');

const arg = name => (process.argv.find(value => value.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const accounts = arg('accounts').split(',').filter(Boolean).map(item => { const [name, ...dir] = item.split('='); return { id: name, name, profileDir: dir.join('=') }; });
const listFile = arg('list'), outDir = arg('out'), message = arg('message').trim(), priority = arg('priority');
if (!accounts.length || accounts.some(a => !a.profileDir) || !listFile || !outDir || !message) {
  console.error('用法：node core/run-distribution.js --accounts=名称=资料目录,... --list=<名单.json> --out=<输出目录> --message=<话术> [--priority=] [--per-turn=10] [--cooldown-min=30]');
  process.exit(2);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, 'results.json');
  const all = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
  const latest = new Map(); for (const row of all) latest.set(row.secUid, row);
  const { settledOf } = createSettled(all);
  const settled = new Set([...latest.values()].filter(settledOf).map(row => row.secUid));
  const targets = JSON.parse(fs.readFileSync(listFile, 'utf8')).filter(row => (!priority || row.priority === priority) && row.secUid && !settled.has(row.secUid));
  if (arg('dry-run') === '1') { console.log('accounts', accounts.map(a => a.name).join(','), 'users', targets.length, 'alreadySettled', settled.size); console.log(JSON.stringify(targets.map(row => row.nickname))); return; }
  const trace = createTrace(path.join(outDir, 'trace.jsonl'));
  try {
    await distribute({ accounts, targets, message, trace, follow: arg('follow') !== '0', dm: arg('dm') !== '0',
      perTurn: Math.max(1, Number(arg('per-turn')) || 10), cooldownMin: Math.max(1, Number(arg('cooldown-min')) || 60),
      restMin: arg('rest-min') === '' ? 60 : Math.max(0, Number(arg('rest-min')) || 0), history: all,
      onResult: row => { all.push({ ...row, at: new Date().toISOString() }); fs.writeFileSync(resultsFile, JSON.stringify(all, null, 2), 'utf8'); } });
  } catch (error) { trace.step('dist.error', { message: error.message }); }
})();
