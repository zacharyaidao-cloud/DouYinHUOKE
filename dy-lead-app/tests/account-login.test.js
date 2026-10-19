'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAccountLoginController, persistLoginResult, getFreshLoginResult } = require('../lib/account-login');

function fixture({ states = ['unknown'], currentUrl = 'https://www.douyin.com/user/self', active = false } = {}) {
  let accounts = [{ id: '1', name: '隔离测试账号', loginState: '未登录' }], inspectIndex = 0, alive = active;
  const history = [], calls = []; const taskState = { running: false, stopRequested: false };
  const signals = state => ({ state, loggedIn: state === 'authenticated', message: '测试状态：' + state, evidence: [] });
  const page = { url: () => currentUrl, goto: async () => { calls.push('goto'); currentUrl = 'https://www.douyin.com/'; }, evaluate: async () => { calls.push('click-login'); } };
  const browser = { page, context: {} };
  const monitor = { inspect: async () => { calls.push('inspect'); return signals(states[Math.min(inspectIndex++, states.length - 1)]); } };
  const options = { taskState, maxPolls: 3, pollIntervalMs: 0,
    store: { getAccounts: () => structuredClone(accounts), setAccounts: next => { accounts = structuredClone(next); history.push(accounts[0].loginStatus); }, nowStr: () => '2026-10-08 12:00:00', log: (_, message) => calls.push('log:' + message) },
    setTask: patch => { if (patch.running === true) taskState.stopRequested = false; Object.assign(taskState, patch); },
    authorize: async () => { calls.push('authorize'); },
    launchAccount: async () => { calls.push('launch'); alive = true; return browser; },
    getAlive: () => alive ? browser : null, getMonitor: () => monitor, sleep: async () => { calls.push('sleep'); }
  };
  return { options, taskState, calls, history, page, account: () => accounts[0], create: () => createAccountLoginController(options) };
}

test('已登录的本人页面立即确认，复用当前页而非重复导航或点登录', async () => {
  const f = fixture({ states: ['authenticated'], active: true });
  const r = await f.create().openForLogin('1');
  assert.equal(r.ok, true); assert.equal(r.loggedIn, true);
  assert.equal(f.account().loginState, '已登录'); assert.ok(f.account().loginAt);
  assert.equal(f.taskState.running, false); assert.equal(f.calls.includes('goto'), false); assert.equal(f.calls.includes('click-login'), false);
});
test('扫码等待、人工验证再成功逐步写回账号，并在结束后释放任务', async () => {
  const f = fixture({ states: ['pending', 'pending', 'verification_required', 'authenticated'] });
  const r = await f.create().openForLogin('1');
  assert.equal(r.loggedIn, true); assert.ok(f.history.includes('pending')); assert.ok(f.history.includes('verification_required'));
  assert.equal(f.taskState.loginState, 'authenticated'); assert.equal(f.taskState.running, false);
});
test('未知页面超时保留登录资料，不写入虚假的成功时间', async () => {
  const f = fixture(); const r = await f.create().openForLogin('1');
  assert.equal(r.ok, true); assert.equal(r.state, 'timeout'); assert.equal(r.loggedIn, false);
  assert.equal(f.account().loginState, '登录超时'); assert.equal(f.account().loginAt, undefined);
  assert.match(r.message, /检查.*登录资料已保留/); assert.equal(f.taskState.running, false);
});
test('账号浏览器关闭直接给出关闭状态，不继续等待或打开登录弹窗', async () => {
  const f = fixture({ states: ['browser_closed'] }); const r = await f.create().openForLogin('1');
  assert.equal(r.state, 'browser_closed'); assert.equal(f.account().loginStatus, 'browser_closed');
  assert.equal(f.calls.includes('sleep'), false); assert.equal(f.calls.includes('click-login'), false);
});
test('等待期间停止后不再检测或触发对外动作', async () => {
  const f = fixture({ states: ['pending'] }); f.options.sleep = async () => { f.calls.push('sleep'); f.taskState.stopRequested = true; };
  const r = await f.create().openForLogin('1');
  assert.equal(r.ok, false); assert.equal(r.state, 'stopped'); assert.equal(f.taskState.running, false);
  assert.equal(f.calls.slice(f.calls.indexOf('sleep') + 1).includes('inspect'), false);
});
test('异步读取登录证据期间停止，迟到的成功结果不能覆盖停止状态', async () => {
  for (const action of ['openForLogin', 'checkLogin']) {
    const f = fixture({ active: true });
    let releaseInspection;
    const inspection = new Promise(resolve => { releaseInspection = resolve; });
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    f.options.getMonitor = () => ({ inspect: async () => { started(); return inspection; } });
    const operation = f.create()[action]('1');
    await begun;
    f.taskState.stopRequested = true;
    releaseInspection({ state: 'authenticated', loggedIn: true, message: '迟到的成功', evidence: [] });
    const r = await operation;
    assert.equal(r.ok, false); assert.equal(r.state, 'stopped');
    assert.equal(f.account().loginStatus, 'stopped'); assert.equal(f.account().loginAt, undefined);
    assert.equal(f.taskState.running, false); assert.equal(f.calls.includes('goto'), false);
    assert.equal(f.calls.some(call => call.includes('已确认抖音账号登录成功')), false);
  }
});
test('授权失效停止登录检测，不能被点登录弹窗的 catch 吞掉', async () => {
  const f = fixture({ states: ['pending'] }); let n = 0;
  f.options.authorize = async () => { if (++n === 3) { const e = new Error('fixture revoked'); e.code = 'AUTH_REQUIRED'; throw e; } };
  const r = await f.create().openForLogin('1');
  assert.equal(r.ok, false); assert.match(r.error, /授权已失效/); assert.equal(f.calls.includes('click-login'), false);
  assert.equal(f.account().loginState, '登录待确认'); assert.equal(f.taskState.running, false);
});
test('手动检查未登录或未知时接口正常完成，与登录结果分别返回', async () => {
  for (const state of ['logged_out', 'unknown', 'verification_required']) {
    const f = fixture({ states: [state], active: true }); const r = await f.create().checkLogin('1');
    assert.equal(r.ok, true); assert.equal(r.loggedIn, false); assert.equal(r.state, state);
    assert.equal(f.calls.includes('goto'), false); assert.equal(f.calls.includes('click-login'), false); assert.equal(f.taskState.running, false);
  }
});
test('同一账号扫码等待期间可检查，但不能提前释放仍在运行的等待队列', async () => {
  const f = fixture({ states: ['authenticated'], active: true }); Object.assign(f.taskState, { running: true, kind: 'login', accountId: '1' });
  const r = await f.create().checkLogin('1');
  assert.equal(r.loggedIn, true); assert.equal(f.taskState.running, true); assert.equal(f.calls.includes('goto'), false);
  assert.equal((await f.create().checkLogin('2')).ok, false);
});
test('采集等任务运行时检查仍拒绝，不能改变另一个任务的状态', async () => {
  const f = fixture({ active: true }); Object.assign(f.taskState, { running: true, kind: 'collect', accountId: '1', status: '采集中' });
  const r = await f.create().checkLogin('1');
  assert.equal(r.ok, false); assert.equal(f.taskState.kind, 'collect'); assert.equal(f.taskState.status, '采集中'); assert.equal(f.calls.length, 0);
});
test('页面加载失败不会被吞掉后把空白页误写成已登录', async () => {
  const f = fixture({ currentUrl: 'about:blank' }); f.page.goto = async () => { throw new Error('navigation timeout'); };
  const r = await f.create().openForLogin('1');
  assert.equal(r.ok, false); assert.match(r.error, /加载超时/); assert.equal(f.account().loginAt, undefined); assert.equal(f.taskState.running, false);
});

test('浏览器启动分类直接显示可处理原因，不被关闭字样误判且不泄漏原始启动资料', async () => {
  const expected = {
    BROWSER_RUNTIME_MISSING: /浏览器程序文件缺失.*完整安装包/,
    BROWSER_PROFILE_IN_USE: /其他窗口使用.*关闭对应浏览器/,
    BROWSER_PROFILE_ACCESS_DENIED: /无法读写.*目录权限/,
    BROWSER_LAUNCH_FAILED: /浏览器启动失败.*管理员/,
    BROWSER_UNSUPPORTED_SYSTEM: /Windows.*不支持.*升级系统/
  };
  for (const action of ['openForLogin', 'checkLogin']) for (const [code, messagePattern] of Object.entries(expected)) {
    const f = fixture();
    f.options.launchAccount = async () => { throw Object.assign(new Error('Target browser has been closed; proxy=http://user:private-pass@fake.local; sessionid=private-session; timeout'), { code }); };
    const result = await f.create()[action]('1');
    assert.equal(result.ok, false); assert.equal(result.state, 'unknown'); assert.equal(result.loggedIn, false);
    assert.equal(result.code, code); assert.match(result.error, messagePattern); assert.equal(result.error, result.message);
    assert.equal(f.account().loginMessage, result.message); assert.equal(f.taskState.detail, result.message);
    assert.equal(f.account().loginAt, undefined); assert.equal(f.taskState.running, false);
    assert.ok(f.calls.includes(`log:${result.message}（${code}）`));
    const visible = JSON.stringify([result, f.account(), f.taskState, f.calls]);
    for (const privateValue of ['private-pass', 'private-session', 'fake.local', 'Target browser', 'proxy=http']) assert.equal(visible.includes(privateValue), false);
    assert.equal(f.calls.includes('inspect'), false); assert.equal(f.calls.includes('goto'), false); assert.equal(f.calls.includes('click-login'), false);
  }
});

test('停止优先于浏览器失败分类；授权失败和页面关闭仍保留独立反馈', async () => {
  const f = fixture();
  f.options.launchAccount = async () => { f.taskState.stopRequested = true; throw Object.assign(new Error('private-browser-trace'), { code: 'BROWSER_LAUNCH_FAILED' }); };
  const stopped = await f.create().openForLogin('1');
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.code, undefined); assert.match(stopped.message, /已停止/);
  assert.equal(JSON.stringify([stopped, f.calls]).includes('private-browser-trace'), false);
  const auth = fixture();
  auth.options.launchAccount = async () => { throw Object.assign(new Error('Target browser closed; private-auth-trace'), { code: 'AUTH_REQUIRED' }); };
  const authResult = await auth.create().openForLogin('1');
  assert.equal(authResult.state, 'unknown'); assert.match(authResult.error, /授权已失效/);
  const closed = fixture();
  closed.options.launchAccount = async () => { throw new Error('Target browser has been closed; private-close-trace'); };
  const closedResult = await closed.create().openForLogin('1');
  assert.equal(closedResult.state, 'browser_closed'); assert.match(closedResult.error, /窗口已关闭/);
  assert.equal(JSON.stringify([authResult, closedResult, auth.calls, closed.calls]).includes('private-'), false);
});

test('打开登录先激活账号页面，已登录窗口复用后仍立即返回且不导航', async () => {
  const f = fixture({ states: ['authenticated'], active: true });
  f.page.bringToFront = async () => { f.calls.push('bring-to-front'); };
  const result = await f.create().openForLogin('1');
  assert.equal(result.loggedIn, true); assert.equal(f.calls.filter(call => call === 'bring-to-front').length, 1);
  assert.ok(f.calls.indexOf('bring-to-front') < f.calls.indexOf('inspect'));
  assert.equal(f.calls.includes('goto'), false); assert.equal(f.calls.includes('click-login'), false);
});

test('激活窗口时关闭或停止不会继续登录检测，也不错误记录已登录', async () => {
  const closed = fixture({ states: ['authenticated'], active: true });
  closed.page.bringToFront = async () => { throw new Error('Target page has been closed; private-focus-trace'); };
  const closedResult = await closed.create().openForLogin('1');
  assert.equal(closedResult.state, 'browser_closed'); assert.equal(closedResult.ok, false);
  assert.equal(closed.calls.includes('inspect'), false); assert.equal(closed.account().loginAt, undefined);
  assert.equal(JSON.stringify([closedResult, closed.calls]).includes('private-focus-trace'), false);
  const stopped = fixture({ states: ['authenticated'], active: true });
  stopped.page.bringToFront = async () => { stopped.calls.push('bring-to-front'); stopped.taskState.stopRequested = true; };
  const stoppedResult = await stopped.create().openForLogin('1');
  assert.equal(stoppedResult.state, 'stopped'); assert.equal(stopped.calls.includes('inspect'), false);
  assert.equal(stopped.account().loginAt, undefined); assert.equal(stopped.taskState.running, false);
});

test('浏览器启动返回前停止，不再激活账号窗口；手动检查不抢前台', async () => {
  const stopped = fixture({ states: ['authenticated'], active: true });
  const launch = stopped.options.launchAccount;
  stopped.options.launchAccount = async () => { const alive = await launch(); stopped.taskState.stopRequested = true; return alive; };
  stopped.page.bringToFront = async () => { stopped.calls.push('bring-to-front'); };
  const result = await stopped.create().openForLogin('1');
  assert.equal(result.state, 'stopped'); assert.equal(stopped.calls.includes('bring-to-front'), false); assert.equal(stopped.calls.includes('inspect'), false);
  const checked = fixture({ states: ['authenticated'], active: true });
  checked.page.bringToFront = async () => { checked.calls.push('bring-to-front'); };
  assert.equal((await checked.create().checkLogin('1')).loggedIn, true);
  assert.equal(checked.calls.includes('bring-to-front'), false);
});

test('任务可复用公共账号状态写回，不改变正在运行的任务且不持久化任何证据', () => {
  const f = fixture({ active: true }); Object.assign(f.taskState, { running: true, kind: 'collect', accountId: '1', status: '采集中' });
  const before = structuredClone(f.taskState);
  persistLoginResult(f.options.store, '1', { state: 'unknown', loggedIn: false, message: '当前作品页登录待确认', evidence: ['private-test-evidence'], identity: 'must-not-persist' });
  assert.equal(f.account().loginState, '登录待确认'); assert.equal(f.account().loginStatus, 'unknown');
  assert.equal(f.account().loginMessage, '当前作品页登录待确认'); assert.ok(f.account().loginCheckedAt);
  assert.equal(f.account().identity, undefined); assert.equal(f.account().evidence, undefined);
  assert.deepEqual(f.taskState, before);
  const writes = f.history.length;
  persistLoginResult(f.options.store, '1', { state: 'unknown', loggedIn: false, message: '当前作品页登录待确认' });
  assert.equal(f.history.length, writes, '重复状态不造成反复写数据');
  persistLoginResult(f.options.store, 'missing', { state: 'authenticated', loggedIn: true, message: '测试' });
  assert.equal(f.history.length, writes);
});

test('相同状态的新检查时间写回一次，单次复用时间且不接受不一致的登录标记', () => {
  const f = fixture({ active: true }); let now = '2026-10-08 12:00:00', clockReads = 0;
  f.options.store.nowStr = () => { clockReads++; return now; };
  const r = { state: 'authenticated', loggedIn: true, message: '已确认登录', evidence: ['must-not-persist'], identity: 'must-not-persist' };
  persistLoginResult(f.options.store, '1', r);
  assert.equal(clockReads, 1); assert.equal(f.account().loginCheckedAt, now); assert.equal(f.account().loginAt, now);
  const writes = f.history.length;
  persistLoginResult(f.options.store, '1', r);
  assert.equal(clockReads, 2); assert.equal(f.history.length, writes);
  now = '2026-10-08 12:00:01'; persistLoginResult(f.options.store, '1', r);
  assert.equal(clockReads, 3); assert.equal(f.history.length, writes + 1);
  assert.equal(f.account().loginCheckedAt, now); assert.equal(f.account().loginAt, now);
  assert.equal(f.account().evidence, undefined); assert.equal(f.account().identity, undefined);
  now = '2026-10-08 12:00:02';
  persistLoginResult(f.options.store, '1', { state: 'unknown', loggedIn: true, message: '登录待确认' });
  assert.equal(f.account().loginStatus, 'unknown'); assert.equal(f.account().loginCheckedAt, now);
  assert.equal(f.account().loginAt, '2026-10-08 12:00:01');
});

test('当前进程只公开新检查结果；旧状态不算实时证据，不一致成功标记不能显示已登录', () => {
  const f = fixture();
  assert.equal(getFreshLoginResult(f.options.store, '1'), null);
  persistLoginResult(f.options.store, '1', { state: 'authenticated', loggedIn: false, message: '不可接受的成功', evidence: ['private'], identity: 'private' });
  assert.equal(f.account().loginStatus, 'unknown'); assert.equal(f.account().loginAt, undefined);
  const publicResult = getFreshLoginResult(f.options.store, '1');
  assert.equal(publicResult.state, 'unknown'); assert.equal(publicResult.loggedIn, false);
  assert.deepEqual(Object.keys(publicResult).sort(), ['checkedAt', 'loggedIn', 'message', 'state']);
  publicResult.state = 'authenticated';
  assert.equal(getFreshLoginResult(f.options.store, '1').state, 'unknown');
  assert.equal(getFreshLoginResult(fixture().options.store, '1'), null);
  persistLoginResult(f.options.store, 'missing', { state: 'authenticated', loggedIn: true });
  assert.equal(getFreshLoginResult(f.options.store, 'missing'), null);
});
