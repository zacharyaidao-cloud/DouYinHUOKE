'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertTaskLogin } = require('../lib/task-login');

function fixture(state) {
  let accounts = [{ id: 'one', loginStatus: 'authenticated', loginAt: 'previous-confirmation', note: '保留备注' }, { id: 'two', loginStatus: 'authenticated' }];
  let writes = 0;
  const store = { getAccounts: () => structuredClone(accounts), setAccounts: value => { accounts = structuredClone(value); writes++; }, nowStr: () => 'current-inspection' };
  return { store, inspect: async () => state, accounts: () => accounts, writes: () => writes };
}

test('短暂页面切换原因传给采集调用方，但不允许任务执行或复用旧登录标记', async () => {
  const f = fixture({ state: 'unknown', loggedIn: false, pageTransition: true, message: '页面正在切换，登录状态尚待重新确认' });
  let healthCalls = 0;
  f.health = async () => { healthCalls++; };
  await assert.rejects(assertTaskLogin({}, 'one', f), error => error.code === 'LOGIN_UNCONFIRMED' && error.pageTransition === true);
  assert.equal(healthCalls, 0); assert.equal(f.accounts()[0].loginStatus, 'unknown');
});

test('任务证据不足显示待确认并同步对应账号，不把之前的已登录当实时证据', async () => {
  const f = fixture({ state: 'unknown', loggedIn: false, message: '登录状态待确认' });
  await assert.rejects(assertTaskLogin({}, 'one', f), error => error.code === 'LOGIN_UNCONFIRMED' && error.message === '登录状态待确认');
  const account = f.accounts()[0];
  assert.equal(account.loginStatus, 'unknown'); assert.equal(account.loginState, '登录待确认');
  assert.equal(account.loginCheckedAt, 'current-inspection'); assert.equal(account.loginAt, 'previous-confirmation');
  assert.equal(account.note, '保留备注'); assert.equal(f.accounts()[1].loginStatus, 'authenticated');
});

test('确实未登录、扫码确认、安全验证和窗口关闭均保留准确任务原因', async () => {
  for (const [state, code] of [['logged_out', 'LOGIN_REQUIRED'], ['pending', 'LOGIN_PENDING'], ['verification_required', 'PLATFORM_VERIFICATION'], ['browser_closed', 'PAGE_CLOSED']]) {
    const f = fixture({ state, loggedIn: false, message: '准确原因:' + state });
    await assert.rejects(assertTaskLogin({}, 'one', f), error => error.code === code && error.message === '准确原因:' + state);
    assert.equal(f.accounts()[0].loginStatus, state);
  }
});

test('新确认的会话允许任务继续，账号结果不包含会话证据', async () => {
  const f = fixture({ state: 'authenticated', loggedIn: true, message: '已确认抖音账号登录', evidence: ['valid_session_cookie', 'verified_context_session'] });
  assert.equal((await assertTaskLogin({}, 'one', f)).loggedIn, true);
  assert.equal(f.accounts()[0].loginAt, 'current-inspection');
  assert.equal(Object.hasOwn(f.accounts()[0], 'evidence'), false);
});

test('停止发生在异步检测期间时，不回写迟到结果或恢复任务', async () => {
  const f = fixture({ state: 'authenticated', loggedIn: true, message: '已确认' });
  let stopped = false;
  f.inspect = async () => { stopped = true; return { state: 'authenticated', loggedIn: true, message: '迟到确认' }; };
  f.checkStopped = () => { if (stopped) throw Object.assign(new Error('已停止'), { code: 'TASK_STOPPED' }); };
  await assert.rejects(assertTaskLogin({}, 'one', f), error => error.code === 'TASK_STOPPED');
  assert.equal(f.writes(), 0); assert.equal(f.accounts()[0].loginAt, 'previous-confirmation');
});

test('不一致的已登录标记不能将未知状态提升为登录成功', async () => {
  const f = fixture({ state: 'unknown', loggedIn: true, message: '状态待确认' });
  await assert.rejects(assertTaskLogin({}, 'one', f), error => error.code === 'LOGIN_UNCONFIRMED');
});

test('发送控件确认登录失效或要求验证时，账号页同步相同原因', async () => {
  for (const [code, expected] of [['LOGIN_REQUIRED', 'logged_out'], ['PLATFORM_VERIFICATION', 'verification_required'], ['PAGE_CLOSED', 'browser_closed']]) {
    const f = fixture({ state: 'authenticated', loggedIn: true, message: '初步登录已确认' });
    const failure = Object.assign(new Error('真实平台反馈:' + code), { code });
    f.health = async () => { throw failure; };
    await assert.rejects(assertTaskLogin({}, 'one', f), error => error === failure);
    assert.equal(f.accounts()[0].loginStatus, expected);
    assert.equal(f.accounts()[0].loginMessage, failure.message);
  }
});

test('停止发生在页面健康检测期间时，不执行紧随其后的动作', async () => {
  const f = fixture({ state: 'authenticated', loggedIn: true, message: '已确认' });
  let stopped = false, acted = false;
  f.health = async () => { stopped = true; };
  f.checkStopped = () => { if (stopped) throw Object.assign(new Error('已停止'), { code: 'TASK_STOPPED' }); };
  await assert.rejects((async () => { await assertTaskLogin({}, 'one', f); acted = true; })(), error => error.code === 'TASK_STOPPED');
  assert.equal(acted, false);
});
