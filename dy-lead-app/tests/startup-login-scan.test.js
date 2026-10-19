'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStartupLoginScan } = require('../lib/startup-login-scan');

function fixture() {
  const accounts = [{ id: 1, loginState: '已登录', loginStatus: 'authenticated', loginCheckedAt: '2025-01-01', loginAt: '2025-01-01' }, { id: 2, loginState: '未登录' }];
  let busy = false, valid = true, starts = 0, pending = null, next = 1, run;
  const timers = new Map(), fresh = new Map();
  const session = { authContext: { secret: 'fixture-private-context' } };
  const service = createStartupLoginScan({ getAccounts: () => accounts,
    getFreshAccountResult: id => fresh.get(id), isBusy: () => busy, isSessionValid: () => valid,
    start: (owner, fn) => { assert.equal(owner.session, session); starts++; busy = true; pending = Promise.resolve().then(fn).finally(() => { busy = false; }); },
    setTimer: (fn, delay) => { const id = next++; timers.set(id, { fn, delay }); return id; }, clearTimer: id => timers.delete(id)
  });
  run = async () => ({ ok: true, total: 2, done: 2, message: '完成', accountStates: { 1: { state: 'authenticated', message: '确认', checked: true }, 2: { state: 'logged_out', message: '需扫码', checked: true } } });
  return { service, accounts, session, fresh, timers,
    request: () => service.request(session, options => run(options)),
    flush: async () => { const first = timers.entries().next().value; if (!first) return; timers.delete(first[0]); first[1].fn(); await Promise.resolve(); },
    settled: async () => pending && await pending,
    setBusy: value => { busy = value; }, setValid: value => { valid = value; }, setRun: value => { run = value; }, starts: () => starts
  };
}

test('启动只把保存状态视为历史，授权请求后仅调度一次且状态不暴露私有上下文', async () => {
  const f = fixture();
  assert.equal(f.starts(), 0);
  assert.equal(f.service.projectAccount(f.accounts[0]).loginStatus, 'unknown');
  assert.equal(f.accounts[0].loginStatus, 'authenticated', '不修改原账号记录');
  f.request(); f.request();
  assert.equal(f.timers.size, 1); assert.equal(f.service.readState().phase, 'queued');
  await f.flush(); await f.settled();
  assert.equal(f.starts(), 1); assert.equal(f.service.readState().phase, 'completed');
  assert.equal(f.service.readState().done, 2);
  assert(!JSON.stringify(f.service.readState()).includes('fixture-private-context'));
  f.request(); assert.equal(f.timers.size, 0);
});

test('正在采集时延期，不抢占；任务结束后使用同一授权按序启动', async () => {
  const f = fixture(); f.setBusy(true); f.request();
  await f.flush(); assert.equal(f.starts(), 0);
  assert.equal([...f.timers.values()][0].delay, 1000);
  assert.match(f.service.readState().message, /等待当前任务结束/);
  f.setBusy(false); await f.flush(); await f.settled();
  assert.equal(f.starts(), 1); assert.equal(f.service.readState().phase, 'completed');
});

test('等待期间授权失效或退出，不启动浏览器；停止队列不会在下一轮自行重启', async () => {
  for (const action of ['expire', 'stop', 'logout']) {
    const f = fixture(); f.request();
    if (action === 'expire') f.setValid(false);
    else if (action === 'logout') f.service.cancelSession(f.session);
    else f.service.cancel();
    await f.flush();
    assert.equal(f.starts(), 0); assert.equal(f.service.readState().phase, 'stopped');
    assert.equal(f.timers.size, 0); assert.equal(f.service.projectAccount(f.accounts[0]).loginStatus, 'unknown');
    f.request(); assert.equal(f.timers.size, 0);
  }
});

test('运行中停止后迟到进度和结果不能重新显示检查中或成功', async () => {
  const f = fixture(); let release, observe;
  f.setRun(({ onProgress }) => { observe = onProgress; return new Promise(resolve => { release = resolve; }); });
  f.request(); await f.flush();
  observe({ total: 2, done: 0, accountId: '1', message: '检查中', accountStates: { 1: { state: 'checking', message: '检查中', checked: false, cookie: 'must-not-leak' } } });
  assert.equal(f.service.readState().phase, 'running');
  assert.equal(f.service.projectAccount(f.accounts[0]).loginStatus, 'checking');
  assert(!JSON.stringify(f.service.readState()).includes('must-not-leak'));
  f.service.cancel();
  observe({ done: 1, accountId: '1', accountStates: { 1: { state: 'authenticated', checked: true } } });
  release({ ok: true, total: 2, done: 2, accountStates: { 1: { state: 'authenticated', checked: true } } });
  await f.settled();
  assert.equal(f.service.readState().phase, 'stopped'); assert.equal(f.service.readState().done, 0);
  assert.equal(f.service.projectAccount(f.accounts[0]).loginStatus, 'unknown');
});

test('停止后真实人工或采集检查可更新状态，不被旧启动待确认快照永久覆盖', () => {
  const f = fixture(); f.request(); f.service.cancel();
  f.accounts[0].loginStatus = 'logged_out'; f.accounts[0].loginState = '未登录';
  f.fresh.set('1', { state: 'logged_out', message: '当前未登录', loggedIn: false });
  assert.equal(f.service.readState().accountStates['1'].checked, true);
  assert.equal(f.service.projectAccount(f.accounts[0]).loginState, '未登录');
  f.accounts[0].loginStatus = 'authenticated'; f.accounts[0].loginState = '已登录';
  f.fresh.set('1', { state: 'authenticated', message: '已重新登录', loggedIn: true });
  assert.equal(f.service.projectAccount(f.accounts[0]).loginStatus, 'authenticated');
  assert.equal(f.service.readState().accountStates['1'].state, 'authenticated');
});

test('没有账号不启动浏览器或占用任务；异常结束保持剩余账号待确认', async () => {
  const f = fixture(); f.accounts.length = 0; f.request();
  assert.equal(f.service.readState().phase, 'completed'); assert.equal(f.starts(), 0); assert.equal(f.timers.size, 0);
  const broken = fixture(); broken.setRun(async () => { throw new Error('private browser details'); });
  broken.request(); await broken.flush(); await broken.settled();
  assert.equal(broken.service.readState().phase, 'stopped');
  assert.equal(broken.service.projectAccount(broken.accounts[0]).loginStatus, 'unknown');
  assert(!JSON.stringify(broken.service.readState()).includes('private browser details'));
});

test('全部账号在十分钟内刚验证过时，重启不再顺序启动浏览器', async () => {
  const f = fixture();
  const now = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  for (const account of f.accounts) { account.loginStatus = 'authenticated'; account.loginState = '已登录'; account.loginCheckedAt = now; }
  f.request();
  const state = f.service.readState();
  assert.equal(state.phase, 'completed');
  assert.equal(state.done, 2);
  assert.equal(f.starts(), 0, '不启动登录扫描任务');
  assert.equal(f.timers.size, 0);
  assert.match(state.message, /未重复检查/);
  assert.equal(state.accountStates['2'].checked, true);
  assert.equal(f.service.projectAccount(f.accounts[1]).loginStatus, 'authenticated');
});
