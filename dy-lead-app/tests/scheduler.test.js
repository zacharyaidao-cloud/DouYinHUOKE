const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ActionScheduler, TaskStopError } = require('../scheduler');
function fixture(human = {}, extra = {}) {
  let time = Date.parse('2026-10-08T02:00:00Z'), stopped = false, authorized = true;
  const auth = [], waits = [], updates = [];
  const settings = {
    collect: { scrollIntervalSec: 3, scrollJitter: .4, linkIntervalSec: 10, linkIntervalJitter: .2 },
    action: { userIntervalSec: 10, userIntervalJitter: .4, pacingVersion: 1 },
    human: { maxConsecutiveErrors: 3, ...human }, ...extra
  };
  const s = new ActionScheduler({ settings, now: () => time, random: () => 0, stopped: () => stopped,
    authorize: async m => { auth.push(m); return authorized; },
    sleep: async ms => { waits.push(ms); time += ms; }, update: p => updates.push(p) });
  return { s, auth, waits, updates, time: () => time, advance: ms => { time += ms; }, stop: () => { stopped = true; }, revoke: () => { authorized = false; } };
}

test('仅三组节奏生效，默认抖动上下界和零值明确', () => {
  const f = fixture();
  for (const [kind, low, high] of [['scroll', 1800, 4200], ['collect', 8000, 12000], ['user', 6000, 14000]]) {
    f.s.random = () => 0; assert.equal(f.s.interval(kind), low);
    f.s.random = () => 1; assert.equal(f.s.interval(kind), high);
  }
  for (const kind of ['video', 'open_comments', 'visit', 'follow', 'ui', 'dm', 'ai']) assert.equal(f.s.interval(kind), 0);
  f.s.settings.collect.scrollIntervalSec = 0; f.s.settings.action.userIntervalSec = 0;
  assert.equal(f.s.interval('scroll'), 0); assert.equal(f.s.interval('user'), 0);
  assert.throws(() => f.s.scheduleBoundary('dm'), /未知节奏边界/);
});

test('一个用户主页内访问关注打开填写发送连续执行，旧间隔与休息失效', async () => {
  const f = fixture({ workPeriods: [{ start: 'invalid', end: 'invalid' }], timeZone: 'invalid', breakEvery: 1, breakMinSec: 9999, breakMaxSec: 9999 });
  Object.assign(f.s.settings.action, { intervalMinSec: 6000, intervalMaxSec: 9999 });
  f.s.settings.follow = { intervalMinSec: 5000 }; f.s.settings.dm = { intervalMinSec: 4000 };
  const started = [];
  for (const kind of ['visit', 'follow', 'ui', 'dm']) await f.s.run({ kind }, async () => started.push(f.time()));
  await f.s.prepare({ kind: 'ui' }, async () => started.push(f.time()));
  assert.equal(new Set(started).size, 1); assert.equal(f.waits.length, 0);
  assert.equal(f.s.actions, 3); assert.equal(f.auth.length, 5);
  assert.deepEqual(f.s.boundaries, { collect: 0, user: 0, scroll: 0 });
});

test('只有实际用户结束显式设置一次用户切换，跳过名单不新增等待', async () => {
  const f = fixture(), started = [];
  await f.s.run({ kind: 'visit' }, async () => started.push(f.time()));
  await f.s.run({ kind: 'dm' }, async () => {});
  const finish = f.time(); f.s.scheduleBoundary('user');
  await f.s.run({ kind: 'ui' }, async () => ({ skipped: true }));
  assert.equal(f.time(), finish);
  await f.s.run({ kind: 'visit' }, async () => started.push(f.time()));
  await f.s.run({ kind: 'follow' }, async () => started.push(f.time()));
  assert.deepEqual(started.map(t => t - started[0]), [0, 6000, 6000]);
  assert.equal(f.s.actions, 4);
  assert(f.updates.some(p => p.stage === 'waiting_user' && p.waitingReason === 'user'));
  assert.equal(f.updates.filter(p => Object.hasOwn(p, 'waitingReason')).at(-1).waitingReason, '');
});

test('作品切换等待独立于评论及用户截止，导航打开评论不产生翻页延迟', async () => {
  const f = fixture(), start = f.time();
  f.s.scheduleBoundary('user'); f.s.scheduleBoundary('collect');
  await f.s.run({ kind: 'video' }, async () => {});
  assert.equal(f.time() - start, 8000);
  assert.equal(f.s.boundaries.scroll, 0);
  await f.s.run({ kind: 'open_comments' }, async () => {});
  await f.s.run({ kind: 'scroll', operation: 'open_comments' }, async () => {});
  assert.equal(f.s.boundaries.scroll, 0); assert.equal(f.time() - start, 8000);
  assert(f.updates.some(p => p.stage === 'waiting_work' && p.waitingReason === 'work'));
});

test('翻页按完成时间设置截止，响应等待占用同一间隔而不是额外叠加', async () => {
  const f = fixture(), start = f.time();
  f.s.scheduleBoundary('scroll');
  await f.s.run({ kind: 'scroll' }, async () => { f.advance(100); });
  assert.equal(f.time() - start, 1900);
  assert.equal(f.s.boundaries.scroll - f.time(), 1800);
  f.advance(1000);
  await f.s.run({ kind: 'scroll' }, async () => {});
  assert.equal(f.time() - start, 3700);
  f.advance(2500);
  const ready = f.time(); await f.s.run({ kind: 'scroll' }, async () => {});
  assert.equal(f.time(), ready);
  assert(f.updates.some(p => p.stage === 'waiting_comments' && p.waitingReason === 'comments'));
});

test('各边界按实际完成时重新设定，不延续旧失效截止', () => {
  const f = fixture(), start = f.time();
  assert.equal(f.s.scheduleBoundary('user'), start + 6000);
  f.advance(9000);
  assert.equal(f.s.scheduleBoundary('user'), start + 15000);
  assert.equal(f.s.boundaries.collect, 0); assert.equal(f.s.boundaries.scroll, 0);
});

test('等待后才检查授权，撤销授权不执行下一主页', async () => {
  const f = fixture(); let actions = 0;
  await f.s.run({ kind: 'dm' }, async () => { actions++; });
  f.s.scheduleBoundary('user'); f.revoke();
  const start = f.time();
  await assert.rejects(f.s.run({ kind: 'visit' }, async () => { actions++; }), e => e.code === 'AUTH_REQUIRED');
  assert.equal(f.time() - start, 6000); assert.equal(actions, 1); assert.equal(f.s.actions, 1);
});

test('三种间隔中停止均立即中断，不再授权或执行', async () => {
  for (const [boundary, kind] of [['user', 'visit'], ['collect', 'video'], ['scroll', 'scroll']]) {
    const f = fixture(); f.s.scheduleBoundary(boundary);
    const sleep = f.s.sleep; f.s.sleep = async ms => { await sleep(ms); f.stop(); };
    await assert.rejects(f.s.run({ kind }, async () => assert.fail('stopped action')), e => e.code === 'TASK_STOPPED');
    assert.equal(f.auth.length, 0); assert.equal(f.s.actions, 0); assert.equal(f.waits.length, 1);
    assert.equal(f.updates.at(-1).waitingUntil, null); assert.equal(f.updates.at(-1).waitingReason, '');
  }
});

test('同主页准备步骤仍逐次检查授权与停止，本地动作不计额度', async () => {
  const f = fixture(); await f.s.prepare({ kind: 'ui' }, async () => {});
  f.revoke(); await assert.rejects(f.s.prepare({ kind: 'ui' }, async () => assert.fail('revoked')), /授权/);
  f.stop(); await assert.rejects(f.s.prepare({ kind: 'ui' }, async () => assert.fail('stopped')), e => e.code === 'TASK_STOPPED');
  assert.equal(f.s.actions, 0); assert.equal(f.auth.length, 2);
});

test('内部重复before不会重新起算间隔，也不会免除授权检查', async () => {
  const f = fixture(), start = f.time(); f.s.scheduleBoundary('user');
  await f.s.run({ kind: 'visit' }, async () => { await f.s.before({ kind: 'visit' }); });
  assert.equal(f.time() - start, 6000); assert.equal(f.auth.length, 2); assert.equal(f.s.actions, 1);
});

test('失败无额外等待，连续三次异常暂停；访问主页不清除触达异常', async () => {
  const f = fixture();
  await f.s.run({ kind: 'ui' }, async () => ({ anomaly: true }));
  await f.s.run({ kind: 'visit' }, async () => {});
  assert.equal(f.s.consecutiveErrors, 1);
  await assert.rejects(f.s.run({ kind: 'dm' }, async () => { throw new Error('second'); }), /second/);
  await assert.rejects(f.s.run({ kind: 'dm' }, async () => { throw new Error('third'); }), e => e instanceof TaskStopError && e.code === 'CONSECUTIVE_ERRORS');
  assert.equal(f.waits.length, 0);
});

test('明确跳过、取消和未启动操作不计尝试；成功触达清除异常', async () => {
  const f = fixture(); f.s.consecutiveErrors = 1;
  await f.s.run({ kind: 'follow' }, async () => ({ skipped: true }));
  assert.equal(f.s.actions, 0); assert.equal(f.s.consecutiveErrors, 1);
  await assert.rejects(f.s.run({ kind: 'follow' }, async () => { throw Object.assign(new Error('not clicked'), { actionNotStarted: true }); }), /not clicked/);
  assert.equal(f.s.actions, 0); assert.equal(f.s.consecutiveErrors, 2);
  await assert.rejects(f.s.run({ kind: 'dm' }, async () => { throw new TaskStopError(); }), e => e.code === 'TASK_STOPPED');
  assert.equal(f.s.actions, 0); assert.equal(f.s.consecutiveErrors, 2);
  await f.s.run({ kind: 'dm' }, async () => ({ state: 'confirmed_success' }));
  assert.equal(f.s.actions, 1); assert.equal(f.s.consecutiveErrors, 0);
});

test('AI不消耗浏览器截止或动作计数，仍检查授权', async () => {
  const f = fixture(); for (const kind of ['collect', 'user', 'scroll']) f.s.scheduleBoundary(kind);
  const before = { ...f.s.boundaries }, start = f.time(); f.s.actions = 5; f.s.consecutiveErrors = 2;
  for (let i = 0; i < 4; i++) await f.s.run({ kind: 'ai' }, async () => {});
  assert.equal(f.time(), start); assert.equal(f.waits.length, 0); assert.equal(f.auth.length, 4);
  assert.equal(f.s.actions, 5); assert.equal(f.s.consecutiveErrors, 2); assert.equal(f.s.aiAttempts, 4); assert.deepEqual(f.s.boundaries, before);
  f.revoke(); await assert.rejects(f.s.run({ kind: 'ai' }, async () => assert.fail('revoked AI')), /授权/);
  assert.equal(f.s.aiAttempts, 4);
});

test('AI成功与异常只更新独立保护，三次AI异常暂停不影响抖音', async () => {
  const f = fixture(); f.s.consecutiveErrors = 2;
  for (let i = 0; i < 2; i++) await assert.rejects(f.s.run({ kind: 'ai' }, async () => { throw new Error('AI failure'); }), /AI failure/);
  await f.s.run({ kind: 'ai' }, async () => {}); assert.equal(f.s.aiConsecutiveErrors, 0);
  for (let i = 0; i < 2; i++) await assert.rejects(f.s.run({ kind: 'ai' }, async () => { throw new Error('AI failure'); }), /AI failure/);
  await assert.rejects(f.s.run({ kind: 'ai' }, async () => { throw new Error('AI failure'); }), e => e.code === 'AI_CONSECUTIVE_ERRORS');
  assert.equal(f.s.actions, 0); assert.equal(f.s.consecutiveErrors, 2); assert.equal(f.waits.length, 0);
});

test('AI真实异常退避保持可停止，不消耗浏览器动作或授权次数', async () => {
  const f = fixture(), previous = f.s.sleep;
  f.s.sleep = async ms => { await previous(ms); f.stop(); };
  await assert.rejects(f.s.waitAiRetry(5000), e => e.code === 'TASK_STOPPED');
  assert.equal(f.waits[0], 250); assert.equal(f.s.actions, 0); assert.equal(f.s.aiAttempts, 0); assert.equal(f.auth.length, 0);
  assert(f.updates.some(p => /AI 接口暂时异常/.test(p.status || '')));
});
