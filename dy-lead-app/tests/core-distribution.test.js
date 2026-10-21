'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { distribute, createSettled } = require('../core/distribution');

// 假会话与假逐人执行：behavior(accountId, user, sentSoFar, time) 返回该人的结果；遇 stop 时停止本批
function harness(behavior, { accounts = ['A', 'B'], users = 6, perTurn = 5 } = {}) {
  let time = 0; const steps = [], results = [], sleeps = [];
  const trace = { step: (name, data) => steps.push({ name, at: time, ...data }) };
  const sent = {};
  const runList = async (session, batch, options) => {
    const out = [];
    for (const user of batch) {
      const row = { secUid: user.secUid, nickname: user.secUid, ...behavior(session.id, user, sent[session.id] || 0, time) };
      if (row.dm?.state === 'confirmed_success') sent[session.id] = (sent[session.id] || 0) + 1;
      out.push(row); options.onResult(row);
      if (row.stop) break;
    }
    return out;
  };
  const run = (extra = {}) => distribute({ accounts: accounts.map(id => ({ id, name: id })), targets: Array.from({ length: users }, (_, i) => ({ secUid: 'u' + (i + 1) })),
    message: 'hi', trace, perTurn, runList, onResult: row => results.push({ ...row, at: time }),
    openSession: async account => ({ id: account.id, ensureLogin: async () => true, close: async () => {} }),
    sleep: async ms => { sleeps.push(ms); time += ms; }, now: () => time, ...extra });
  return { run, steps, results, sleeps };
}
const ok = { dm: { state: 'confirmed_success' } };
const frequent = { dm: { state: 'confirmed_failure', failureScope: 'account' }, stop: { stop: true, code: 'DM_ACCOUNT_FREQUENT' } };
const daily = { dm: { state: 'confirmed_failure', failureScope: 'account' }, stop: { stop: true, code: 'DM_ACCOUNT_DAILY_LIMIT' } };
const MIN = 60000;

test('单号：每发 5 人休息 5 分钟再发下一轮', async () => {
  const h = harness(() => ok, { accounts: ['A'], users: 12 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  assert.deepEqual(h.sleeps, [5 * MIN, 5 * MIN]);              // 5 + 5 + 2：两次休息
  assert.deepEqual(h.results.map(r => r.at / MIN), [0, 0, 0, 0, 0, 5, 5, 5, 5, 5, 10, 10]);
});

test('多号：每号发满 5 人立即切换下一个号，号都轮完一遍再统一休息 5 分钟', async () => {
  const h = harness(() => ok, { accounts: ['A', 'B', 'C'], users: 20 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  assert.equal(h.results.map(r => r.accountId).join(''), 'AAAAABBBBBCCCCCAAAAA');
  // A、B、C 之间没有等待；三号都发过后才休息一次
  assert.deepEqual(h.results.slice(0, 15).map(r => r.at), Array(15).fill(0));
  assert.deepEqual(h.sleeps, [5 * MIN]);
  assert.equal(h.steps.filter(s => s.name === 'dist.round_rest').length, 1); // 第二轮 A 发完名单即结束
});

test('频繁：暂停 30 分钟（从触发时刻计时）→ 试发恢复后回到正常轮换；暂停期间其他号照常发', async () => {
  let aFrequentOnce = false;
  const h = harness((account, user, sentSoFar, time) => {
    if (account === 'A' && sentSoFar === 2 && !aFrequentOnce) { aFrequentOnce = true; return frequent; }
    return ok;
  }, { accounts: ['A', 'B'], users: 50 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  const cooling = h.steps.find(s => s.name === 'dist.account_cooling');
  assert.equal(cooling.minutes, 30); assert.equal(cooling.at, 0);
  const probe = h.steps.find(s => s.name === 'dist.turn' && s.probing);
  assert.equal(probe.at, 30 * MIN, '到点（触发后 30 分钟）就试发，不等 B 的流程');
  assert(h.steps.some(s => s.name === 'dist.account_recovered'));
  // A 暂停期间 B 继续每轮 5 人 + 休息 5 分钟
  assert(h.results.filter(r => r.accountId === 'B' && r.at < 30 * MIN).length >= 15);
  const delivered = h.results.filter(r => r.dm.state === 'confirmed_success');
  assert.equal(new Set(delivered.map(r => r.secUid)).size, 50, '被拒的人回池，没有人丢失');
});

test('频繁阶梯 30 分钟 / 1 小时 / 2 小时，试发 3 次仍频繁 → 今日上限', async () => {
  const h = harness(() => frequent, { accounts: ['A'], users: 4 });
  const out = await h.run();
  assert.deepEqual(h.steps.filter(s => s.name === 'dist.account_cooling').map(s => s.minutes), [30, 60, 120]);
  assert.deepEqual(h.steps.filter(s => s.name === 'dist.turn' && s.probing).map(s => s.at / MIN), [30, 90, 210]);
  const limit = h.steps.find(s => s.name === 'dist.account_daily_limit');
  assert.match(limit.reason, /试发 3 次仍频繁/);
  assert.equal(out.accounts[0].state, 'done_today');
  assert.equal(out.remaining.length, 4, '没人被丢：都留在池里');
  assert.equal(h.results.length, 4, '首次 1 次 + 试发 3 次');
});

test('试发恢复后再次频繁：重新从 30 分钟开始', async () => {
  let attempts = 0;
  const h = harness(() => { attempts++; return [1, 2, 5].includes(attempts) ? frequent : ok; }, { accounts: ['A'], users: 8 });
  await h.run();
  assert.deepEqual(h.steps.filter(s => s.name === 'dist.account_cooling').map(s => s.minutes), [30, 60, 30]);
});

test('显示今日上限的号当天不再使用，其余号继续', async () => {
  const h = harness((account, user, sent) => account === 'A' && sent >= 1 ? daily : ok, { users: 8 });
  const out = await h.run();
  assert.equal(out.remaining.length, 0);
  assert.equal(out.accounts.find(a => a.account === 'A').state, 'done_today');
  assert.equal(h.results.filter(r => r.accountId === 'A' && r.dm.state === 'confirmed_success').length, 1);
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

test('历史结果：旧的检查码 2 拒绝视为未送达；此前没打开过 1 次的人还能再试 1 次', () => {
  const history = [
    { secUid: 'u1', dm: { state: 'confirmed_failure', reason: '服务端拒绝本次私信：消息检查未通过（检查码：2）' } },
    { secUid: 'u2', dm: { state: 'not_sent', stage: 'conversation' } }
  ];
  const s = createSettled(history);
  assert.equal(s.settledOf(history[0]), false);
  assert.equal(s.settledOf(history[1]), false);
  s.record(history[1]);
  assert.equal(s.settledOf(history[1]), true);
});
