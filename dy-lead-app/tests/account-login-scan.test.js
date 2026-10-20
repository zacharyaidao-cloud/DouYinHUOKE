'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { createAccountLoginScan } = require('../lib/account-login-scan');
const { createLoginMonitor } = require('../lib/login-state');
const { chromium } = require('playwright-core');
const fs = require('node:fs');

const immediate = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ count = 2, active = [], states = {}, responseWaitMs = 0 } = {}) {
  let accounts = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: '隔离账号', loginState: '已登录', loginStatus: 'authenticated' }));
  const controller = new AbortController(), browsers = new Map(), calls = [], writes = [], progress = [];
  const taskState = { running: false, stopRequested: false };
  function browser(id) {
    const alive = { context: { close: async () => { calls.push('close:' + id); if (browsers.get(id) === alive) browsers.delete(id); } },
      page: { goto: async url => { calls.push('goto:' + id + ':' + url); } },
      loginMonitor: { dispose: () => { calls.push('dispose:' + id); }, inspect: async () => {
        calls.push('inspect:' + id);
        const value = states[id] || 'unknown';
        return { state: value, loggedIn: value === 'authenticated', message: '隐私测试资料不得外传',
          evidence: ['secret-evidence'], uid: '123456789', identity: 'secret-session' };
      } }
    };
    return alive;
  }
  active.forEach(id => browsers.set(id, browser(id)));
  const options = { taskState, navigationTimeoutMs: 80, inspectTimeoutMs: 80, responseWaitMs, pollIntervalMs: 1, closeTimeoutMs: 80,
    store: { getAccounts: () => structuredClone(accounts), setAccounts: next => { accounts = structuredClone(next); writes.push(structuredClone(next)); },
      nowStr: () => '2026-10-08 12:00:00' },
    setTask: patch => { if (patch.running === true) taskState.stopRequested = false; Object.assign(taskState, patch); },
    authorize: async meta => { calls.push('authorize:' + meta.accountId + ':' + meta.kind); },
    getAlive: id => browsers.get(id), getMonitor: alive => alive.loginMonitor, getSignal: () => controller.signal,
    launchAccount: async (id, opts) => {
      calls.push('launch:' + id + ':' + opts.headless); opts.checkStopped();
      const alive = browser(id); browsers.set(id, alive); opts.onCreated(alive); return alive;
    }
  };
  return { options, taskState, calls, writes, progress, browsers, controller, browser,
    accounts: () => accounts, scan: () => createAccountLoginScan(options)({ onProgress: item => progress.push(item) }),
    stop: () => { taskState.stopRequested = true; controller.abort(); } };
}

test('启动扫描顺序检查全部账号，旧保存已登录不作证据，返回和持久化不含私密证据', async () => {
  const f = fixture({ states: { '1': 'authenticated', '2': 'unknown' } });
  const r = await f.scan();
  assert.equal(r.ok, true); assert.equal(r.total, 2); assert.equal(r.done, 2);
  assert.equal(f.accounts()[0].loginState, '已登录'); assert.equal(f.accounts()[1].loginState, '登录待确认');
  assert.equal(f.accounts()[1].loginAt, undefined); assert.equal(f.taskState.running, false); assert.equal(f.taskState.kind, 'login_scan');
  assert.deepEqual(f.calls.filter(call => call.startsWith('launch:')), ['launch:1:true', 'launch:2:true']);
  assert.ok(f.calls.indexOf('close:1') < f.calls.indexOf('launch:2:true'));
  assert.deepEqual(f.calls.filter(call => call.startsWith('goto:')), ['goto:1:https://www.douyin.com/user/self', 'goto:2:https://www.douyin.com/user/self']);
  assert.equal(f.progress[0].accountStates['1'].checked, false);
  assert.equal(f.progress.find(item => item.accountId === '1').accountStates['1'].state, 'checking');
  const publicJson = JSON.stringify([r, f.progress, f.writes]);
  for (const secret of ['secret-evidence', '123456789', 'secret-session', '隐私测试资料']) assert.equal(publicJson.includes(secret), false);
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('每个浏览器启动、本人页导航和检查均事先授权；缺少证据不变成未登录', async () => {
  const f = fixture({ count: 1 }); const r = await f.scan();
  assert.equal(r.accountStates['1'].state, 'unknown');
  assert.deepEqual(f.calls.slice(0, 6), ['authorize:1:login_scan_browser', 'launch:1:true',
    'authorize:1:login_scan_navigate', 'goto:1:https://www.douyin.com/user/self', 'authorize:1:login_scan_check', 'inspect:1']);
  assert.equal(f.accounts()[0].loginStatus, 'unknown');
});

test('已打开账号浏览器原地复用，不导航、不重新启动、不卸载或关闭原有监视器', async () => {
  const f = fixture({ active: ['1', '2'], states: { '1': 'authenticated', '2': 'logged_out' } });
  const alive = f.browsers.get('1'); const r = await f.scan();
  assert.equal(r.accountStates['2'].state, 'logged_out'); assert.equal(f.accounts()[1].loginState, '未登录');
  assert.equal(f.browsers.get('1'), alive); assert.equal(f.calls.some(call => /^(?:launch|goto|close|dispose):/.test(call)), false);
});

test('验证码和待手机确认保持独立状态，不归入未登录，且不会点击任何控件', async () => {
  for (const state of ['verification_required', 'pending']) {
    const f = fixture({ count: 1, states: { '1': state } }); const r = await f.scan();
    assert.equal(r.accountStates['1'].state, state); assert.equal(r.accountStates['1'].checked, true);
    assert.equal(f.accounts()[0].loginStatus, state); assert.equal(f.calls.some(call => call.includes('click')), false);
  }
});

test('无账号立即完成，运行中拒绝扫描且不抢已有任务或修改其状态', async () => {
  const empty = fixture({ count: 0 }); const r = await empty.scan();
  assert.deepEqual(r.accountStates, {}); assert.equal(r.ok, true); assert.equal(r.done, 0); assert.equal(empty.calls.length, 0);
  const f = fixture(); Object.assign(f.taskState, { kind: 'collect', running: true, status: '采集中' });
  const before = structuredClone(f.taskState); const busy = await f.scan();
  assert.equal(busy.ok, false); assert.deepEqual(f.taskState, before); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});

test('账号加载异常以待确认继续下一个账号，未知异常正文不会泄漏到状态或日志', async () => {
  const f = fixture({ states: { '2': 'authenticated' } }); const launch = f.options.launchAccount;
  f.options.launchAccount = async (id, opts) => { if (id === '1') throw new Error('sessionid=secret-session'); return launch(id, opts); };
  const r = await f.scan(); assert.equal(r.ok, true); assert.equal(r.done, 2);
  assert.equal(r.accountStates['1'].state, 'unknown'); assert.equal(r.accountStates['2'].state, 'authenticated');
  assert.equal(JSON.stringify([r, f.taskState, f.writes]).includes('secret-session'), false);
});

test('授权失效停止整个扫描，不导航、不继续后续账号，也不写回旧成功状态', async () => {
  const f = fixture(); f.options.authorize = async meta => {
    f.calls.push('authorize:' + meta.kind);
    if (meta.kind === 'login_scan_navigate') throw Object.assign(new Error('secret-auth-detail'), { code: 'AUTH_REQUIRED' });
  };
  const r = await f.scan(); assert.equal(r.ok, false); assert.equal(r.done, 0); assert.match(r.message, /授权已失效/);
  assert.deepEqual(f.calls.filter(call => call.startsWith('launch:')), ['launch:1:true']);
  assert.equal(f.calls.some(call => call.startsWith('goto:')), false); assert.equal(f.writes.length, 0);
  assert.equal(f.calls.includes('close:1'), true); assert.equal(f.taskState.running, false);
});

test('停止可立即打断导航，关闭本次背景窗口，迟到结果不持久化且不扫描后续账号', async () => {
  const f = fixture(); const navigation = deferred(), begun = deferred(), launch = f.options.launchAccount;
  f.options.navigationTimeoutMs = 10000;
  f.options.launchAccount = async (id, opts) => {
    const alive = await launch(id, opts); alive.page.goto = async () => { begun.resolve(); return navigation.promise; }; return alive;
  };
  const operation = f.scan(); await begun.promise; const start = Date.now(); f.stop(); const r = await operation;
  assert.ok(Date.now() - start < 1000); assert.equal(r.state, 'stopped'); assert.equal(r.done, 0);
  assert.equal(f.writes.length, 0); assert.equal(f.calls.includes('close:1'), true); assert.equal(f.calls.includes('launch:2:true'), false);
  navigation.resolve(); await immediate(); assert.equal(f.writes.length, 0);
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('已有窗口异步检查期间停止，不关闭原窗口，晚到的认证不能覆盖账号或进度', async () => {
  const f = fixture({ count: 1, active: ['1'] }); const inspection = deferred(), begun = deferred();
  f.options.inspectTimeoutMs = 10000;
  f.browsers.get('1').loginMonitor.inspect = async () => { begun.resolve(); return inspection.promise; };
  const operation = f.scan(); await begun.promise; f.stop(); const r = await operation;
  assert.equal(r.state, 'stopped'); assert.equal(f.calls.includes('close:1'), false); assert.equal(f.writes.length, 0);
  inspection.resolve({ state: 'authenticated', loggedIn: true }); await immediate();
  assert.equal(f.writes.length, 0); assert.equal(r.accountStates['1'].checked, false);
});

test('后台浏览器启动期间停止，迟到的自有窗口关闭且不导航、不触及替换窗口', async () => {
  const f = fixture({ count: 1 }); const launching = deferred(), begun = deferred();
  let created;
  f.options.navigationTimeoutMs = 10000;
  f.options.launchAccount = async (id, opts) => {
    begun.resolve(); await launching.promise;
    created = f.browser(id); opts.onCreated(created); return created;
  };
  const operation = f.scan(); await begun.promise; f.stop(); const r = await operation;
  const replacement = f.browser('replacement'); f.browsers.set('1', replacement);
  launching.resolve(); await immediate(); await immediate();
  assert.equal(r.state, 'stopped'); assert.equal(f.calls.includes('close:1'), true);
  assert.equal(f.calls.includes('close:replacement'), false); assert.equal(f.browsers.get('1'), replacement);
  assert.equal(f.calls.some(call => call.startsWith('goto:')), false); assert.equal(f.writes.length, 0);
});

test('后台启动超时的晚到 context 与下一个账号隔离，不能接管或关闭下一账号的 context', async () => {
  const f = fixture({ states: { '2': 'authenticated' } });
  const firstLaunch = deferred(), secondInspection = deferred(), secondBegun = deferred();
  const originalLaunch = f.options.launchAccount;
  f.options.navigationTimeoutMs = 20; f.options.inspectTimeoutMs = 200;
  f.options.launchAccount = async (id, opts) => {
    if (id === '1') { await firstLaunch.promise; const alive = f.browser(id); opts.onCreated(alive); return alive; }
    const alive = await originalLaunch(id, opts);
    alive.loginMonitor.inspect = async () => { secondBegun.resolve(); return secondInspection.promise; };
    return alive;
  };
  const operation = f.scan(); await secondBegun.promise;
  firstLaunch.resolve(); await immediate(); await immediate();
  assert.equal(f.calls.includes('close:1'), true); assert.equal(f.calls.includes('close:2'), false);
  secondInspection.resolve({ state: 'authenticated', loggedIn: true });
  const r = await operation;
  assert.equal(r.ok, true); assert.equal(r.accountStates['1'].state, 'unknown'); assert.equal(r.accountStates['2'].state, 'authenticated');
  assert.equal(f.calls.filter(call => call === 'close:2').length, 1);
});

test('授权等待期间停止不会继续启动浏览器；观察回调异常不改变真实登录结果', async () => {
  const f = fixture({ count: 1 }); const authorizing = deferred(), begun = deferred();
  f.options.inspectTimeoutMs = 10000;
  f.options.authorize = async () => { begun.resolve(); await authorizing.promise; };
  const operation = f.scan(); await begun.promise; f.stop(); const r = await operation;
  authorizing.resolve(); await immediate();
  assert.equal(r.state, 'stopped'); assert.equal(f.calls.some(call => call.startsWith('launch:')), false);
  const f2 = fixture({ count: 1, states: { '1': 'authenticated' } });
  const r2 = await createAccountLoginScan(f2.options)({ onProgress: () => { throw new Error('observer failed'); } });
  assert.equal(r2.ok, true); assert.equal(r2.accountStates['1'].state, 'authenticated');
});

const browserPath = [chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find(file => fs.existsSync(file));

test('实际 Chromium：自动本人页导航只采集浏览器返回的响应，登录/未登录/验证码/缺证据分别识别',
  { timeout: 60000, skip: !browserPath }, async () => {
    const browser = await chromium.launch({ headless: true, executablePath: browserPath, chromiumSandbox: true });
    const scenarios = ['authenticated', 'logged_out', 'verification_required', 'unknown'];
    const f = fixture({ count: scenarios.length });
    const launched = [], requests = [], closeCount = [];
    f.options.navigationTimeoutMs = 10000; f.options.inspectTimeoutMs = 3000;
    f.options.responseWaitMs = 800; f.options.pollIntervalMs = 30;
    f.options.launchAccount = async (id, opts) => {
      const scenario = scenarios[Number(id) - 1];
      opts.checkStopped();
      const context = await browser.newContext();
      try {
        opts.checkStopped();
        if (scenario === 'authenticated') await context.addCookies([{ name: 'sessionid', value: 'synthetic-private-test-only',
          domain: '.douyin.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
        await context.route('**/*', async route => {
          const url = new URL(route.request().url()); requests.push(url.pathname);
          if (url.hostname !== 'www.douyin.com') return route.abort();
          if (url.pathname === '/aweme/v1/web/user/profile/self/') return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ status_code: 0, user: { uid: '7000000000000000999' } }) });
          if (url.pathname !== '/user/self') return route.abort();
          const html = scenario === 'authenticated' ? '<h1>本地隔离本人页</h1><script>setTimeout(()=>fetch("/aweme/v1/web/user/profile/self/"),60)</script>'
            : scenario === 'logged_out' ? '<header><button>登录</button></header><h1>本地隔离页</h1>'
            : scenario === 'verification_required' ? '<div data-e2e="captcha">请完成安全验证</div>' : '<h1>本地隔离页，没有登录证据</h1>';
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>' });
        });
        const page = await context.newPage(); opts.checkStopped();
        const alive = { context, page, loginMonitor: createLoginMonitor(context, page) };
        context.on('close', () => { closeCount.push(id); alive.loginMonitor.dispose(); });
        launched.push(alive); opts.onCreated(alive); return alive;
      } catch (error) { await context.close(); throw error; }
    };
    try {
      const r = await f.scan();
      // 扫描对单个窗口的关闭最多等 closeTimeoutMs（产品行为），负载高时 close 事件可能晚到；这里等它真正发生再断言全部关闭
      for (let i = 0; i < 100 && closeCount.length < scenarios.length; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(r.ok, true); assert.equal(r.done, scenarios.length);
      assert.deepEqual(Object.values(r.accountStates).map(item => item.state), scenarios);
      assert.equal(launched.length, scenarios.length); assert.equal(closeCount.length, scenarios.length);
      assert.ok(requests.includes('/aweme/v1/web/user/profile/self/'));
      assert.equal(requests.every(path => ['/user/self', '/aweme/v1/web/user/profile/self/'].includes(path)), true);
      assert.equal(JSON.stringify([r, f.progress, f.writes]).includes('synthetic-private-test-only'), false);
      assert.equal(JSON.stringify([r, f.progress, f.writes]).includes('7000000000000000999'), false);
      for (const alive of launched) assert.equal(alive.context.listeners('response').length, 0);
    } finally { await browser.close(); }
  });
