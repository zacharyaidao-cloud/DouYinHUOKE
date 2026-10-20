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
  const run = () => distribute({ accounts: accounts.map(id => ({ id, name: id })), targets: Array.from({ length: users }, (_, i) => ({ secUid: 'u' + (i + 1) })),
    message: 'hi', trace, perTurn, cooldownMin: 30, runList, onResult: row => results.push(row),
    openSession: async account => ({ id: account.id, ensureLogin: async () => true, close: async () => {} }),
    sleep: async ms => { sleeps.push(ms); time += ms; }, now: () => time });
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

test('全部账号冷却时等待最早到期者，试发 1 人恢复后继续；未恢复则冷却翻倍', async () => {
  let attempts = 0;
  const h = harness(account => { attempts++; return attempts <= 2 || attempts === 3 ? frequent : ok; }, { accounts: ['A'], users: 3 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  const cooling = h.steps.filter(s => s.name === 'dist.account_cooling').map(s => s.minutes);
  assert.deepEqual(cooling, [30, 60, 120]);                  // 每次仍频繁，冷却翻倍
  assert(h.steps.some(s => s.name === 'dist.account_recovered'));
  assert(h.sleeps.length >= 3);                               // 等过冷却才试发
});

test('对方原因发不出的用户不回池重试', async () => {
  const h = harness((account, user) => user.secUid === 'u2' ? { dm: { state: 'not_sent', stage: 'conversation' } } : ok, { users: 3 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  assert.equal(h.results.filter(r => r.secUid === 'u2').length, 1);
});
