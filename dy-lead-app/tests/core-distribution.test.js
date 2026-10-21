'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { distribute } = require('../core/distribution');

// 假会话与假逐人执行：behavior(accountId, user, sentSoFar) 返回该人的结果；遇 stop 时停止本批
function harness(behavior, { accounts = ['A', 'B'], users = 6, perTurn = 10 } = {}) {
  let time = 0; const steps = [], results = [], sleeps = [];
  const trace = { step: (name, data) => steps.push({ name, ...data }) };
  const sent = {};
  const runList = async (session, batch, options) => {
    const out = [];
    for (const user of batch) {
      const row = { secUid: user.secUid, nickname: user.secUid, ...behavior(session.id, user, sent[session.id] || 0) };
      if (row.dm?.state === 'confirmed_success') sent[session.id] = (sent[session.id] || 0) + 1;
      out.push(row); options.onResult(row);
      if (row.stop) break;
    }
    return out;
  };
  const run = (extra = {}) => distribute({ accounts: accounts.map(id => ({ id, name: id })), targets: Array.from({ length: users }, (_, i) => ({ secUid: 'u' + (i + 1) })),
    message: 'hi', trace, perTurn, cooldownMin: 30, runList, onResult: row => results.push(row),
    openSession: async account => ({ id: account.id, ensureLogin: async () => true, close: async () => {} }),
    sleep: async ms => { sleeps.push(ms); time += ms; }, now: () => time, ...extra });
  return { run, steps, results, sleeps };
}
const ok = { dm: { state: 'confirmed_success' } };
const frequent = { dm: { state: 'confirmed_failure', failureScope: 'account' }, stop: { stop: true, code: 'DM_ACCOUNT_FREQUENT' } };
const daily = { dm: { state: 'confirmed_failure', failureScope: 'account' }, stop: { stop: true, code: 'DM_ACCOUNT_DAILY_LIMIT' } };

test('账号频繁后进入冷却并排到队尾，被拒用户回池由下一个账号发出', async () => {
  const h = harness((account, user, sent) => account === 'A' && sent >= 2 ? frequent : ok);
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  const delivered = h.results.filter(r => r.dm.state === 'confirmed_success');
  assert.equal(delivered.length, 6);                                 // 6 人都送达，没有人因 A 频繁而丢失
  assert.equal(delivered.filter(r => r.accountId === 'B').length, 4); // 第 3 人起由 B 发
  assert(h.steps.some(s => s.name === 'dist.account_cooling' && s.account === 'A' && s.minutes === 30));
});

test('今日上限的账号当天不再使用，其余账号继续', async () => {
  const h = harness((account, user, sent) => account === 'A' && sent >= 1 ? daily : ok, { users: 4 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  assert.equal(out.accounts.find(a => a.account === 'A').state, 'done_today');
  assert.equal(h.results.filter(r => r.accountId === 'A' && r.dm.state === 'confirmed_success').length, 1);
});

test('冷却到期试发 1 人恢复则继续发', async () => {
  let attempts = 0;
  const h = harness(() => { attempts++; return attempts === 1 ? frequent : ok; }, { accounts: ['A'], users: 3 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  assert.deepEqual(h.steps.filter(s => s.name === 'dist.account_cooling').map(s => s.minutes), [30]);
  assert(h.steps.some(s => s.name === 'dist.account_recovered'));
  assert.equal(h.sleeps[0], 30 * 60000);                     // 等满冷却才试发
});

test('冷却后首条仍频繁：按今日上限处理，不再翻倍试探（2026-10-21 实测）', async () => {
  const h = harness(() => frequent, { accounts: ['A'], users: 3 });
  const out = await h.run();
  assert.equal(out.accounts[0].state, 'done_today');
  assert.equal(out.remaining.length, 3);                     // 没人被丢：都留在池里
  assert.equal(h.results.length, 2);                         // 只试了首轮 1 次 + 冷却后 1 次
  assert(h.steps.some(s => s.name === 'dist.account_daily_limit' && /今日上限/.test(s.reason)));
});

test('正常用完一轮配额：该账号休息 restMin 后才再轮到，期间由其他账号发', async () => {
  const h = harness(() => ok, { accounts: ['A', 'B'], users: 7, perTurn: 2 });
  const out = await h.run({ restMin: 60 });
  assert.equal(out.remaining.length, 0);
  const order = h.results.map(r => r.accountId).join('');
  assert.equal(order, 'AABBAABB'.slice(0, 7));
  assert(h.steps.filter(s => s.name === 'dist.account_resting').length >= 2);
  assert.equal(h.sleeps.reduce((a, b) => a + b, 0) >= 60 * 60000, true); // 两个号都休息时等最早到期者
});

test('没打开聊天的用户回池再试一次，累计 2 次才算定论；已关注的不再点关注', async () => {
  const seen = [];
  const h = harness((account, user) => { seen.push([user.secUid, !!user.skipFollow]); return user.secUid === 'u2' ? { follow: { state: 'confirmed_success' }, dm: { state: 'not_sent', stage: 'conversation' } } : ok; }, { users: 3 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  assert.equal(h.results.filter(r => r.secUid === 'u2').length, 2);
  assert.deepEqual(seen.filter(([id]) => id === 'u2').map(([, skip]) => skip), [false, true]);
});

test('对方原因拒收（refused）的用户不回池重试', async () => {
  const h = harness((account, user) => user.secUid === 'u2' ? { dm: { state: 'refused', reason: '对方设置' } } : ok, { users: 3 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  assert.equal(h.results.filter(r => r.secUid === 'u2').length, 1);
});

test('历史结果：旧的检查码 2 拒绝视为未送达；此前没打开过 1 次的人还能再试 1 次', async () => {
  const history = [
    { secUid: 'u1', dm: { state: 'confirmed_failure', reason: '服务端拒绝本次私信：消息检查未通过（检查码：2）' } },
    { secUid: 'u2', dm: { state: 'not_sent', stage: 'conversation' } }
  ];
  const { createSettled } = require('../core/distribution');
  const s = createSettled(history);
  assert.equal(s.settledOf(history[0]), false);
  assert.equal(s.settledOf(history[1]), false);
  s.record(history[1]);
  assert.equal(s.settledOf(history[1]), true);
});
