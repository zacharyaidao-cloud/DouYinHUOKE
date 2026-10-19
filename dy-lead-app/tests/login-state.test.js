'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createLoginMonitor, inspectLoginState } = require('../lib/login-state');

// Synthetic DOM, context, response and Cookie fixtures only: no account profile,
// Chromium process, navigation, network request, or real Cookie is read.
function element(tag, text = '', attrs = {}, children = []) {
  const node = { tag, ownText: text, attrs, children, parent: null,
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); },
    get parentElement() { return this.parent; },
    get tagName() { return this.tag.toUpperCase(); },
    getAttribute(name) { return this.attrs[name] === undefined ? null : String(this.attrs[name]); },
    getBoundingClientRect() { return this.attrs.rect || { top: 400, left: 0, width: 200, height: 200 }; },
    matches(selector) { return selector.split(',').some(part => matches(this, part)); },
    querySelectorAll(selector) {
      const descendants = [];
      const walk = child => { descendants.push(child); child.children.forEach(walk); };
      this.children.forEach(walk);
      return descendants.filter(child => selector.split(',').some(part => matches(child, part)));
    },
    getClientRects() { let current = this; while (current) { if (current.attrs.hidden) return []; current = current.parent; } return [{}]; }
  };
  for (const child of children) child.parent = node;
  return node;
}
function matchesSimple(node, selector) {
  const tag = selector.match(/^[a-z]+/i);
  if (tag && node.tag !== tag[0]) return false;
  for (const attribute of selector.matchAll(/\[([\w-]+)(?:(\*=|=)"([^"]+)")?\]/g)) {
    const value = node.attrs[attribute[1]];
    if (value === undefined) return false;
    if (attribute[2] === '=' && String(value) !== attribute[3]) return false;
    if (attribute[2] === '*=' && !String(value).includes(attribute[3])) return false;
  }
  return true;
}
function matches(node, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimple(node, parts.pop())) return false;
  let parent = node.parent;
  while (parts.length) {
    const part = parts.pop();
    while (parent && !matchesSimple(parent, part)) parent = parent.parent;
    if (!parent) return false;
    parent = parent.parent;
  }
  return true;
}
function pageFixture({ url = 'https://www.douyin.com/user/self?from_tab_name=main', nodes = [], body = '抖音页面已加载', loading = false } = {}) {
  const page = new EventEmitter();
  page.currentUrl = url; page.closed = false; page.reads = 0;
  page.nodes = nodes; page.bodyText = body; page.loading = loading;
  page.url = () => page.currentUrl;
  page.isClosed = () => page.closed;
  page.context = () => page.owner;
  page.close = () => { page.closed = true; page.emit('close'); };
  page.evaluate = async (reader, arg) => {
    page.reads++;
    const all = [];
    const walk = node => { all.push(node); node.children.forEach(walk); };
    page.nodes.forEach(walk);
    const document = {
      readyState: page.loading ? 'loading' : 'complete',
      body: { get textContent() { return page.bodyText + all.map(node => node.ownText).join(''); } },
      querySelectorAll: selector => all.filter(node => selector.split(',').some(part => matches(node, part)))
    };
    return vm.runInNewContext('(' + reader.toString() + ')(argument)', { document, argument: arg,
      getComputedStyle: node => ({ visibility: node.attrs.visibility || 'visible', display: node.attrs.display || 'block' }) });
  };
  return page;
}
function cookie(patch = {}) {
  return { name: 'sessionid', value: 'fake-private-cookie-value-only', domain: '.douyin.com', path: '/', expires: -1, ...patch };
}
function contextFixture(pages, cookies = [cookie()]) {
  const context = new EventEmitter();
  context.list = pages; context.cookieList = cookies; context.cookieReads = [];
  context.pages = () => context.list;
  context.cookies = async urls => { context.cookieReads.push(urls); return context.cookieList; };
  for (const page of pages) page.owner = context;
  context.add = page => { page.owner = context; context.list.push(page); context.emit('page', page); };
  return context;
}
const ownNodes = () => [element('button', '编辑个人简介'), element('span', '作品'), element('span', '喜欢'), element('span', '收藏')];

test('图文渲染跳转打断页面读取时保留短暂切换原因，下一次仍重新确认真实登录', async () => {
  const page = pageFixture({ nodes: ownNodes() });
  contextFixture([page]);
  const evaluate = page.evaluate;
  for (const message of ['Execution context was destroyed, most likely because of a navigation', 'Cannot find context with specified id']) {
    page.evaluate = async () => { throw new Error(message); };
    const interrupted = await inspectLoginState(page);
    assert.equal(interrupted.state, 'unknown'); assert.equal(interrupted.loggedIn, false);
    assert.equal(interrupted.pageTransition, true);
    assert(interrupted.evidence.includes('page_navigation_read_interrupted'));
  }
  page.evaluate = async () => { throw new Error('synthetic unrelated read failure'); };
  assert.equal((await inspectLoginState(page)).pageTransition, undefined);
  page.evaluate = evaluate;
  assert.equal((await inspectLoginState(page)).state, 'authenticated');
  page.close();
  assert.equal((await inspectLoginState(page)).state, 'browser_closed');
});
const topSelfNodes = () => [element('div', '', { class: 'current-top-navigation' }, [element('a', '',
  { href: '/user/self', rect: { top: 8, left: 1150, width: 40, height: 40 } }, [element('img', '', { src: 'synthetic-avatar' })])])];
const privatePanel = () => element('div', '', { class: 'account-panel' }, [element('img', '', { src: 'synthetic-avatar' }),
  element('div', '测试昵称'), element('div', '关注292 粉丝40'), element('div', '我的喜欢', {}, [element('span', '125')]),
  element('div', '我的收藏', {}, [element('span', '17')]), element('div', '观看历史', {}, [element('span', '30天内')]),
  element('span', '稍后再看'), element('span', '我的作品'), element('span', '退出登录')]);
function response({ url = 'https://www.douyin.com/aweme/v1/web/user/profile/self/', status = 200,
  body = { status_code: 0, user: { uid: '123456789', sec_uid: 'fake-sec-uid' } }, page = null, failure = false, headers = {} } = {}) {
  return { url: () => url, status: () => status, headers: () => headers, frame: () => ({ page: () => page }),
    json: async () => { if (failure) throw new Error('synthetic malformed JSON'); return body; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function timedMonitor(context, page, responseTimeoutMs) {
  const timers = new Set(), module = { exports: {} };
  const trackedTimeout = (handler, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); handler(); }, delay);
    timers.add(timer); return timer;
  };
  const trackedClear = timer => { timers.delete(timer); clearTimeout(timer); };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/login-state.js'), 'utf8'),
    { module, URL, WeakMap, setTimeout: trackedTimeout, clearTimeout: trackedClear });
  return { monitor: module.exports.createLoginMonitor(context, page, { responseTimeoutMs }), timers };
}

test('真实样本形状：本人 self 主页编辑与个人标签结合有效会话才确认登录', async () => {
  const page = pageFixture({ nodes: ownNodes() });
  const context = contextFixture([page]);
  const current = await inspectLoginState(page);
  assert.equal(current.state, 'authenticated');
  assert.deepEqual(current.evidence, ['valid_session_cookie', 'self_profile_editor']);
  assert.deepEqual(context.cookieReads, [[page.url()]]);
  assert.equal(JSON.stringify(current).includes('fake-private-cookie'), false);
});

test('Cookie 单独、一般用户头像及他人主页编辑文字都不能确认登录', async () => {
  for (const options of [ {}, { nodes: [element('div', '', { 'data-e2e': 'user-avatar' })] },
    { url: 'https://www.douyin.com/user/another-user', nodes: ownNodes() } ]) {
    const page = pageFixture(options); contextFixture([page]);
    assert.equal((await inspectLoginState(page)).state, 'unknown');
  }
});

test('没有编辑文字的 self 个人面板：纯 div/span 退出登录和嵌套数字的私人菜单可确认', async () => {
  const menu = element('div', '', { class: 'account-panel' }, [
    element('div', '', {}, [element('span', '我的喜欢'), element('span', ' 12')]),
    element('div', '我的收藏', {}, [element('span', '3')]),
    element('span', '观看历史（10）'), element('span', '退出登录')
  ]);
  const page = pageFixture({ nodes: [menu] }); const context = contextFixture([page]);
  const current = await inspectLoginState(page);
  assert.equal(current.state, 'authenticated');
  assert.deepEqual(current.evidence, ['valid_session_cookie', 'self_private_menu']);
  context.cookieList = [];
  assert.equal((await inspectLoginState(page)).state, 'unknown');
});

test('普通评论、全页散落文字、仅一个私人菜单和他人页面不能冒充 self 私人面板', async () => {
  const menuNodes = () => [element('span', '我的喜欢'), element('span', '我的收藏'), element('span', '退出登录')];
  const cases = [
    { nodes: menuNodes() },
    { nodes: [element('main', '', {}, menuNodes())] },
    { nodes: [element('div', '', { class: 'comment-content' }, menuNodes())] },
    { nodes: [element('div', '', { class: 'comment-content' }, [element('div', '', {}, menuNodes())])] },
    { nodes: [element('div', '', { 'data-e2e': 'comment-item' }, menuNodes())] },
    { nodes: [element('div', '', { contenteditable: 'true' }, menuNodes())] },
    { nodes: [element('div', '', {}, [element('span', '我的喜欢'), element('span', '退出登录')])] },
    { nodes: [element('div', '', {}, [element('span', '我的喜欢'), element('span', '我的喜欢1'), element('span', '退出登录')])] },
    { url: 'https://www.douyin.com/user/other-user', nodes: [element('div', '', {}, menuNodes())] }
  ];
  for (const options of cases) {
    const page = pageFixture(options); contextFixture([page]);
    assert.equal((await inspectLoginState(page)).state, 'unknown');
  }
});

test('self 私人面板组合证据不能覆盖验证码或尚未确认的扫码弹窗', async () => {
  const menu = element('div', '', {}, [element('span', '我的作品'), element('span', '稍后再看'), element('span', '退出登录')]);
  for (const [blocker, state] of [
    [element('div', '', { class: 'captcha-container' }), 'verification_required'],
    [element('div', '扫码成功，请在手机上确认登录', { role: 'dialog' }), 'pending']
  ]) {
    const page = pageFixture({ nodes: [menu, blocker] }); contextFixture([page]);
    assert.equal((await inspectLoginState(page)).state, state);
  }
});

test('退出登录按钮和严格导航头像支持已登录检测；无有效会话不确认', async () => {
  const variants = [ [element('button', '退出登录')],
    [element('div', '', { role: 'menu' }, [element('span', '退出登录')])],
    [element('header', '', {}, [element('div', '', { 'data-e2e': 'user-avatar' }), element('a', '个人主页', { href: '/user/self' })])] ];
  for (const nodes of variants) {
    const page = pageFixture({ nodes }); const context = contextFixture([page]);
    assert.equal((await inspectLoginState(page)).state, 'authenticated');
    context.cookieList = [];
    assert.equal((await inspectLoginState(page)).state, 'unknown');
  }
});

test('会话 Cookie 域、到期时间、路径及名称严格检查', async () => {
  for (const patch of [ { domain: '.douyin.com.evil.example' }, { domain: '.passport.douyin.com' },
    { domain: 'douyin.com' }, { expires: 0 }, { expires: Date.now() / 1000 - 1 },
    { expires: undefined }, { expires: NaN }, { path: '/passport' }, { value: '' }, { name: 'msToken' } ]) {
    const page = pageFixture({ nodes: ownNodes() }); contextFixture([page], [cookie(patch)]);
    assert.equal((await inspectLoginState(page)).state, 'unknown', JSON.stringify(patch));
  }
  for (const patch of [ { name: 'sessionid_ss' }, { domain: 'www.douyin.com' }, { expires: Date.now() / 1000 + 60 } ]) {
    const page = pageFixture({ nodes: ownNodes() }); contextFixture([page], [cookie(patch)]);
    assert.equal((await inspectLoginState(page)).state, 'authenticated');
  }
});

test('可见验证码优先于本人控件；隐藏提示不阻止登录', async () => {
  for (const node of [element('div', '', { class: 'captcha-container' }), element('span', '请完成验证')]) {
    const page = pageFixture({ nodes: [...ownNodes(), node] }); contextFixture([page]);
    assert.equal((await inspectLoginState(page)).state, 'verification_required');
    node.attrs.hidden = true;
    assert.equal((await inspectLoginState(page)).state, 'authenticated');
  }
});

test('手机未确认和登录弹窗保持等待；明确顶部登录入口标为未登录', async () => {
  for (const label of ['请使用抖音扫码登录', '扫码成功，请在手机上确认登录']) {
    const page = pageFixture({ nodes: [...ownNodes(), element('div', label, { role: 'dialog' })] }); contextFixture([page]);
    assert.equal((await inspectLoginState(page)).state, 'pending');
  }
  const page = pageFixture({ nodes: [element('header', '', {}, [element('button', '登录')]), ...ownNodes()] }); contextFixture([page]);
  assert.equal((await inspectLoginState(page)).state, 'logged_out');
});

test('空白、加载、HTTP/离站以及同形域名都不误报已登录', async () => {
  for (const options of [ { body: '' }, { body: '', loading: true },
    { url: 'about:blank', nodes: ownNodes() }, { url: 'http://www.douyin.com/user/self', nodes: ownNodes() },
    { url: 'https://www.douyin.com.evil.example/user/self', nodes: ownNodes() },
    { url: 'https://www.douyin.com:444/user/self', nodes: ownNodes() },
    { url: 'https://name@www.douyin.com/user/self', nodes: ownNodes() } ]) {
    const page = pageFixture(options); contextFixture([page]);
    assert.equal((await inspectLoginState(page)).loggedIn, false);
  }
});

test('页面其他位置的登录文字不否定明确本人证据，普通文本退出登录不构成证明', async () => {
  const page = pageFixture({ nodes: [...ownNodes(), element('div', '登录'), element('a', '登录')] }); contextFixture([page]);
  assert.equal((await inspectLoginState(page)).state, 'authenticated');
  const commentPage = pageFixture({ nodes: [element('span', '退出登录')] }); contextFixture([commentPage]);
  assert.equal((await inspectLoginState(commentPage)).state, 'unknown');
});

test('仅被动本人信息成功响应可补充证据；单独 Cookie 无法登录，结果不含资料', async () => {
  const page = pageFixture(); const context = contextFixture([page]); const monitor = createLoginMonitor(context, page);
  try {
    assert.equal((await monitor.inspect()).state, 'unknown');
    context.emit('response', response({ page })); await settle();
    const current = await inspectLoginState(page);
    assert.equal(current.state, 'authenticated');
    assert.deepEqual(current.evidence, ['valid_session_cookie', 'successful_self_profile_response']);
    assert.equal(JSON.stringify(current).includes('123456789'), false);
    assert.equal(JSON.stringify(current).includes('fake-sec-uid'), false);
    assert.equal(context.listenerCount('response'), 1);
  } finally { monitor.dispose(); }
});

test('被动响应严格限制来源、精确本人路径、HTTP 成功和本人身份结构', async () => {
  const invalid = [
    { url: 'https://evil.example/aweme/v1/web/user/profile/self/' },
    { url: 'https://www.douyin.com.evil.example/aweme/v1/web/user/profile/self/' },
    { url: 'http://www.douyin.com/aweme/v1/web/user/profile/self/' },
    { url: 'https://www.douyin.com/aweme/v1/web/user/profile/other/' },
    { url: 'https://www.douyin.com/aweme/v1/web/user/profile/self/extra' },
    { status: 401 }, { status: 403 }, { body: { status_code: 1, user: { uid: '123' } } },
    { body: { status_code: '0', user: { uid: '123' } } },
    { body: { status_code: 0, is_login: false, user: { uid: '123' } } },
    { body: { status_code: 0, user: { nickname: '仅名称不算身份' } } },
    { body: { status_code: 0, user: { uid: '0', sec_uid: '' } } },
    { body: { status_code: 0, user: ['123'] } }, { failure: true }, { headers: { 'content-length': '9999999' } }
  ];
  for (const options of invalid) {
    const page = pageFixture(); const context = contextFixture([page]); const monitor = createLoginMonitor(context, page);
    try {
      context.emit('response', response({ ...options, page })); await settle();
      assert.equal((await monitor.inspect()).state, 'unknown', JSON.stringify(options));
    } finally { monitor.dispose(); }
  }
});

test('退出/会话过期或新的本人接口失败会作废旧响应，不因旧成功继续报告登录', async () => {
  const page = pageFixture(); const context = contextFixture([page]); const monitor = createLoginMonitor(context, page);
  try {
    context.emit('response', response({ page })); await settle();
    assert.equal((await monitor.inspect()).state, 'authenticated');
    context.cookieList = [cookie({ expires: 0 })];
    assert.equal((await monitor.inspect()).state, 'unknown');
    context.cookieList = [cookie()];
    assert.equal((await monitor.inspect()).state, 'unknown', '恢复 Cookie 不能复活已作废的本人响应');
    context.emit('response', response({ status: 401, page })); await settle();
    assert.equal((await monitor.inspect()).state, 'unknown');
    context.emit('response', response({ page })); await settle();
    page.nodes = [element('header', '', {}, [element('button', '登录')])];
    assert.equal((await monitor.inspect()).state, 'logged_out');
  } finally { monitor.dispose(); }
});

test('异步响应乱序不能覆盖更晚的退出/失败结果，卸载期间响应不能复活', async () => {
  const page = pageFixture(); const context = contextFixture([page]); const monitor = createLoginMonitor(context, page);
  let release;
  const slow = response({ page }); slow.json = () => new Promise(resolve => { release = resolve; });
  context.emit('response', slow);
  await settle();
  context.emit('response', response({ status: 401, page }));
  release({ status_code: 0, user: { uid: '123' } }); await settle();
  assert.equal((await monitor.inspect()).state, 'unknown');
  const later = response({ page }); later.json = () => new Promise(resolve => { release = resolve; });
  context.emit('response', later); await settle(); monitor.dispose();
  release({ status_code: 0, user: { uid: '123' } }); await settle();
  assert.equal((await monitor.inspect()).state, 'browser_closed');
  assert.equal((await inspectLoginState(page)).state, 'unknown');
});

test('主窗口关闭后识别同上下文已开的本人页；他人主页不能替代登录证据', async () => {
  const primary = pageFixture(); const other = pageFixture({ url: 'https://www.douyin.com/user/other', nodes: ownNodes() });
  const context = contextFixture([primary, other]); const monitor = createLoginMonitor(context, primary);
  try {
    primary.close();
    assert.equal((await monitor.inspect()).state, 'unknown');
    const self = pageFixture({ nodes: ownNodes() }); context.add(self);
    assert.equal((await monitor.inspect()).state, 'authenticated');
    self.close(); other.close();
    assert.equal((await monitor.inspect()).state, 'browser_closed');
  } finally { monitor.dispose(); }
});

test('主窗口可见验证码保持优先，不被其他窗口的登录证据遮蔽', async () => {
  const primary = pageFixture({ nodes: [element('div', '', { id: 'captcha' })] });
  const self = pageFixture({ nodes: ownNodes() }); const context = contextFixture([primary, self]);
  const monitor = createLoginMonitor(context, primary);
  try { assert.equal((await monitor.inspect()).state, 'verification_required'); }
  finally { monitor.dispose(); }
});

test('Cookie 和 DOM 读取异常不会误报成功；页面关闭提供明确状态', async () => {
  const page = pageFixture({ nodes: ownNodes() }); const context = contextFixture([page]);
  context.cookies = async () => { throw new Error('synthetic closed context'); };
  assert.equal((await inspectLoginState(page)).state, 'unknown');
  page.evaluate = async () => { throw new Error('synthetic DOM unavailable'); };
  assert.equal((await inspectLoginState(page)).state, 'unknown');
  page.close();
  assert.equal((await inspectLoginState(page)).state, 'browser_closed');
});

test('重复创建与 dispose 彻底卸载 context/page 事件；standalone 不自动创建监视器', async () => {
  const page = pageFixture({ nodes: ownNodes() }); const context = contextFixture([page]);
  await inspectLoginState(page);
  assert.equal(context.listenerCount('response'), 0);
  const first = createLoginMonitor(context, page);
  const second = createLoginMonitor(context, page);
  assert.equal(context.listenerCount('response'), 1);
  assert.equal(context.listenerCount('page'), 1);
  assert.equal(context.listenerCount('close'), 1);
  assert.equal(page.listenerCount('close'), 1);
  assert.equal((await first.inspect()).state, 'browser_closed');
  context.emit('close');
  assert.equal((await second.inspect()).state, 'browser_closed');
  second.dispose(); second.dispose();
  for (const name of ['response', 'page', 'close']) assert.equal(context.listenerCount(name), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('成功本人响应无需立即检查，超过15秒仍仅绑定同上下文当前有效会话承接', async () => {
  let now = 100000;
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/login-state.js'), 'utf8'), { module, Date: Clock, URL, WeakMap, setTimeout, clearTimeout });
  const page = pageFixture(); const context = contextFixture([page]);
  const monitor = module.exports.createLoginMonitor(context, page);
  try {
    context.emit('response', response({ page })); await settle();
    now += 15000;
    page.currentUrl = 'https://douyin.com/note/7693579483274183025';
    const carried = await monitor.inspect();
    assert.equal(carried.state, 'authenticated');
    assert.deepEqual(Array.from(carried.evidence), ['valid_session_cookie', 'verified_self_response_session']);
    context.emit('response', response({ page })); await settle();
    assert.equal((await monitor.inspect()).state, 'authenticated');
    now += 15000;
    assert.equal((await monitor.inspect()).state, 'authenticated');
    context.cookieList = [cookie({ value: 'different-synthetic-session' })];
    assert.equal((await monitor.inspect()).state, 'unknown');
  } finally { monitor.dispose(); }
});

test('成功本人响应优先于同页头像/私人菜单，响应确认的会话不会被UI覆盖', async () => {
  let now = 100000;
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/login-state.js'), 'utf8'), { module, Date: Clock, URL, WeakMap, setTimeout, clearTimeout });
  const page = pageFixture({ nodes: [...topSelfNodes(), privatePanel()], url: 'https://www.douyin.com/video/7693378601286309625' });
  const context = contextFixture([page]), monitor = module.exports.createLoginMonitor(context, page);
  try {
    assert.deepEqual(Array.from((await monitor.inspect()).evidence), ['valid_session_cookie', 'account_private_menu']);
    context.emit('response', response({ page })); await settle();
    assert.deepEqual(Array.from((await monitor.inspect()).evidence), ['valid_session_cookie', 'successful_self_profile_response']);
    now += 15001;
    assert.deepEqual(Array.from((await monitor.inspect()).evidence), ['valid_session_cookie', 'verified_self_response_session']);
    page.nodes = []; page.currentUrl = 'https://douyin.com/note/7693579483274183025';
    assert.equal((await monitor.inspect()).state, 'authenticated');
    context.emit('response', response({ status: 401, page })); await settle();
    assert.equal((await monitor.inspect()).state, 'unknown');
  } finally { monitor.dispose(); }
});

test('读取本人回复期间 Cookie 更换/读取失败不登记会话，换Cookie和失败回复仍撤销旧证明', async () => {
  for (const mutate of [context => { context.cookieList = [cookie({ value: 'replacement-during-response' })]; },
    context => { context.cookies = async () => { throw new Error('synthetic failed second Cookie read'); }; }]) {
    const page = pageFixture(), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
    try {
      let release;
      const pending = response({ page }); pending.json = () => new Promise(resolve => { release = resolve; });
      context.emit('response', pending); await settle(); mutate(context);
      release({ status_code: 0, user: { uid: '123' } }); await settle();
      assert.equal((await monitor.inspect()).state, 'unknown');
      context.cookies = async () => [cookie()];
      assert.equal((await monitor.inspect()).state, 'unknown', '旧回复不能在恢复Cookie后复活');
    } finally { monitor.dispose(); }
  }
  const page = pageFixture(), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
  try {
    context.emit('response', response({ page })); await settle(); assert.equal((await monitor.inspect()).state, 'authenticated');
    context.cookieList = [cookie({ value: 'different-after-response' })];
    assert.equal((await monitor.inspect()).state, 'unknown');
    context.emit('response', response({ page })); await settle(); assert.equal((await monitor.inspect()).state, 'authenticated');
    context.emit('response', response({ status: 401, page })); await settle(); assert.equal((await monitor.inspect()).state, 'unknown');
  } finally { monitor.dispose(); }
});

test('截图形状：图标本人链接和纯文字私人账户浮层在 www/裸域 video/note 都能识别', async () => {
  for (const host of ['www.douyin.com', 'douyin.com']) for (const type of ['video', 'note']) {
    const page = pageFixture({ url: 'https://' + host + '/' + type + '/7693378601286309625', nodes: [...topSelfNodes(), privatePanel()] });
    const context = contextFixture([page]);
    const current = await inspectLoginState(page);
    assert.equal(current.state, 'authenticated');
    assert.deepEqual(current.evidence, ['valid_session_cookie', 'account_private_menu']);
    context.cookieList = [];
    assert.equal((await inspectLoginState(page)).state, 'unknown');
  }
});

test('图标本人链接必须有头像和顶部导航位置，评论/编辑器和低位伪链接不确认', async () => {
  const link = () => element('a', '', { href: '/user/self', rect: { top: 8, width: 40, height: 40 } }, [element('img')]);
  const variants = [
    [element('a', '', { href: '/user/self', rect: { top: 8, width: 40, height: 40 } })],
    [element('a', '', { href: '/user/self' }, [element('img')])],
    [element('div', '', { class: 'comment-item' }, [link(), privatePanel()])],
    [element('div', '', { contenteditable: 'true' }, [link(), privatePanel()])],
    [privatePanel()]
  ];
  for (const nodes of variants) {
    const page = pageFixture({ url: 'https://www.douyin.com/video/7693378601286309625', nodes }); contextFixture([page]);
    assert.equal((await inspectLoginState(page)).state, 'unknown');
  }
});

test('同 BrowserContext 已确认会话可承接菜单关闭和跨视频图文，首次未知不提升为登录', async () => {
  const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
  try {
    assert.equal((await monitor.inspect()).state, 'authenticated');
    page.nodes = [];
    for (const url of ['https://www.douyin.com/video/7693378601286309625', 'https://douyin.com/note/7693579483274183025']) {
      page.currentUrl = url;
      const current = await inspectLoginState(page);
      assert.equal(current.state, 'authenticated');
      assert.deepEqual(current.evidence, ['valid_session_cookie', 'verified_context_session']);
      assert.equal(JSON.stringify(current).includes('fake-private-cookie'), false);
    }
    const unknown = pageFixture({ url: page.currentUrl }); const other = contextFixture([unknown]); const otherMonitor = createLoginMonitor(other, unknown);
    try { assert.equal((await otherMonitor.inspect()).state, 'unknown', '不能继承其他上下文/磁盘状态'); } finally { otherMonitor.dispose(); }
  } finally { monitor.dispose(); }
});

test('已确认内存会话在 Cookie 更换/过期/读取失败时作废，恢复旧 Cookie 不能复活', async () => {
  for (const mutation of [context => { context.cookieList = [cookie({ value: 'replacement-synthetic-session' })]; },
    context => { context.cookieList = [cookie({ expires: 0 })]; },
    context => { context.cookies = async () => { throw new Error('synthetic failed Cookie read'); }; }]) {
    const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
    try {
      assert.equal((await monitor.inspect()).state, 'authenticated'); page.nodes = []; page.currentUrl = 'https://www.douyin.com/video/7693378601286309625';
      mutation(context); assert.equal((await inspectLoginState(page)).state, 'unknown');
      context.cookies = async () => [cookie()];
      assert.equal((await inspectLoginState(page)).state, 'unknown');
    } finally { monitor.dispose(); }
  }
});

test('已确认内存会话不能覆盖扫码弹窗、顶部登录入口或验证码，关闭后也不能复活', async () => {
  for (const [node, state] of [[element('div', '请使用抖音扫码登录', { role: 'dialog' }), 'pending'],
    [element('header', '', {}, [element('button', '登录')]), 'logged_out'], [element('div', '', { class: 'captcha-popup' }), 'verification_required']]) {
    const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
    try {
      assert.equal((await monitor.inspect()).state, 'authenticated'); page.nodes = [node]; page.currentUrl = 'https://www.douyin.com/video/7693378601286309625';
      assert.equal((await inspectLoginState(page)).state, state); page.nodes = [];
      assert.equal((await inspectLoginState(page)).state, 'unknown');
    } finally { monitor.dispose(); }
  }
  const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
  assert.equal((await monitor.inspect()).state, 'authenticated'); page.close();
  const work = pageFixture({ url: 'https://www.douyin.com/video/7693378601286309625' }); context.add(work);
  assert.equal((await inspectLoginState(work)).state, 'unknown');
  context.emit('close'); assert.equal((await inspectLoginState(work)).state, 'unknown'); monitor.dispose();
});

test('新的失败本人响应立即撤销上下文会话，也不接受未更新的缓存本人面板', async () => {
  const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
  try {
    assert.equal((await monitor.inspect()).state, 'authenticated');
    context.emit('response', response({ status: 401, page })); await settle();
    assert.equal((await inspectLoginState(page)).state, 'unknown');
    page.nodes = []; page.currentUrl = 'https://www.douyin.com/video/7693378601286309625';
    assert.equal((await inspectLoginState(page)).state, 'unknown');
    context.emit('response', response({ page })); await settle();
    assert.equal((await inspectLoginState(page)).state, 'authenticated');
  } finally { monitor.dispose(); }
});

test('多页检查的明确未登录优先，旧本人页不能恢复被否定的上下文会话', async () => {
  const self = pageFixture({ nodes: ownNodes() }), work = pageFixture({ url: 'https://www.douyin.com/video/7693378601286309625' });
  const context = contextFixture([self, work]), monitor = createLoginMonitor(context, self);
  try {
    assert.equal((await monitor.inspect()).state, 'authenticated');
    work.nodes = [element('header', '', {}, [element('button', '登录')])];
    assert.equal((await monitor.inspect()).state, 'logged_out');
    work.nodes = [];
    assert.equal((await inspectLoginState(work)).state, 'unknown');
  } finally { monitor.dispose(); }
});

test('退出后的迟到成功响应和正在检查时的新失败响应不能复活会话', async () => {
  const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
  try {
    assert.equal((await monitor.inspect()).state, 'authenticated');
    let releaseResponse;
    const slow = response({ page }); slow.json = () => new Promise(resolve => { releaseResponse = resolve; });
    context.emit('response', slow); await settle();
    assert.equal((await inspectLoginState(page)).state, 'unknown', '本人响应尚在读取时不复用旧证据');
    page.nodes = [element('header', '', {}, [element('button', '登录')])];
    assert.equal((await monitor.inspect()).state, 'logged_out');
    releaseResponse({ status_code: 0, user: { uid: '123' } }); await settle();
    page.nodes = [];
    assert.equal((await inspectLoginState(page)).state, 'unknown');
    page.nodes = ownNodes(); assert.equal((await monitor.inspect()).state, 'authenticated');
    const originalEvaluate = page.evaluate;
    let releaseDom;
    page.evaluate = async (...args) => {
      const signals = await originalEvaluate(...args);
      await new Promise(resolve => { releaseDom = resolve; });
      return signals;
    };
    const inspection = inspectLoginState(page); await settle();
    context.emit('response', response({ status: 401, page })); await settle();
    releaseDom(); assert.equal((await inspection).state, 'unknown');
  } finally { monitor.dispose(); }
});

test('菜单关闭后，评论/聊天中的登录和退出登录控件均不改变已核验会话', async () => {
  for (const attrs of [{ class: 'comment-content' }, { 'data-e2e': 'comment-item' }, { class: 'message-content' },
    { id: 'chat-message-list' }, { contenteditable: 'true' }, { role: 'textbox' }]) {
    const textNodes = () => [element('button', '登录'), element('a', '扫码登录'), element('button', '退出登录'),
      element('div', '', { role: 'menu' }, [element('span', '退出登录')]),
      element('header', '', {}, [element('button', '登录')]), element('div', '请使用抖音扫码登录', { role: 'dialog' })];
    const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
    try {
      assert.equal((await monitor.inspect()).state, 'authenticated');
      page.currentUrl = 'https://www.douyin.com/video/7693378601286309625'; page.nodes = [element('div', '', attrs, textNodes())];
      const current = await inspectLoginState(page);
      assert.equal(current.state, 'authenticated'); assert.deepEqual(current.evidence, ['valid_session_cookie', 'verified_context_session']);
      const other = pageFixture({ url: page.currentUrl, nodes: [element('div', '', attrs, textNodes())] }); contextFixture([other]);
      assert.equal((await inspectLoginState(other)).state, 'unknown', '评论中的退出登录不能冒充已登录');
    } finally { monitor.dispose(); }
  }
});

test('真实导航与系统登录对话框仍优先于会话承接，未标明来源的普通登录文字不判退出', async () => {
  for (const [node, state] of [[element('header', '', {}, [element('button', '登录')]), 'logged_out'],
    [element('nav', '', {}, [element('button', '登录')]), 'logged_out'],
    [element('div', '', { role: 'dialog' }, [element('button', '登录')]), 'logged_out'],
    [element('div', '', { 'data-e2e': 'login-dialog' }, [element('a', '登录')]), 'logged_out'],
    [element('div', '请使用抖音扫码登录', { role: 'dialog' }), 'pending']]) {
    const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
    try {
      assert.equal((await monitor.inspect()).state, 'authenticated'); page.nodes = [...ownNodes(), ...topSelfNodes(), node];
      assert.equal((await inspectLoginState(page)).state, state);
    } finally { monitor.dispose(); }
  }
  const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
  try {
    assert.equal((await monitor.inspect()).state, 'authenticated'); page.nodes = [element('button', '登录'), element('a', '扫码登录')];
    assert.equal((await inspectLoginState(page)).state, 'authenticated');
  } finally { monitor.dispose(); }
});

test('评论/视频说明/聊天引用中的验证和扫码文字不能伪装系统反馈', async () => {
  const forms = [ { class: 'comment-item' }, { 'data-e2e': 'video-desc' }, { class: 'video-caption' },
    { class: 'chat-bubble' }, { class: 'message-item' }, { class: 'quoted-message' }, { role: 'log' } ];
  for (const attrs of forms) {
    const authored = () => element('div', '', attrs, [element('span', '安全验证'), element('span', '请完成安全验证'),
      element('span', '拖动滑块完成验证'), element('div', '请使用抖音扫码登录', { role: 'dialog' }),
      element('div', '', { class: 'captcha-container' }), element('button', '退出登录')]);
    const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
    try {
      assert.equal((await monitor.inspect()).state, 'authenticated'); page.currentUrl = 'https://www.douyin.com/video/7693378601286309625';
      page.nodes = [element('div', '', { role: 'dialog', class: 'chat-window' }, [authored()])];
      assert.equal((await inspectLoginState(page)).state, 'authenticated');
      const unconfirmed = pageFixture({ url: page.currentUrl, nodes: [authored()] }); contextFixture([unconfirmed]);
      assert.equal((await inspectLoginState(unconfirmed)).state, 'unknown');
    } finally { monitor.dispose(); }
  }
});

test('原生登录modal可包含手机号输入框，真正验证码与登录入口仍最高优先', async () => {
  for (const [native, state] of [[element('div', '请使用抖音扫码登录', { 'data-e2e': 'login-modal', role: 'dialog' }, [element('input', '', { type: 'tel' })]), 'pending'],
    [element('div', '请使用抖音扫码登录', { role: 'dialog' }, [element('input', '', { type: 'tel' })]), 'pending'],
    [element('div', '', { 'data-e2e': 'captcha' }), 'verification_required'],
    [element('div', '安全验证', { role: 'dialog' }), 'verification_required']]) {
    const page = pageFixture({ nodes: ownNodes() }), context = contextFixture([page]), monitor = createLoginMonitor(context, page);
    try {
      assert.equal((await monitor.inspect()).state, 'authenticated'); page.nodes = [...ownNodes(), native];
      assert.equal((await inspectLoginState(page)).state, state);
    } finally { monitor.dispose(); }
  }
});

test('本人响应体永久pending有界超时释放，迟到正文不能复活，后续成功回复可恢复', async () => {
  const page = pageFixture(), context = contextFixture([page]), { monitor, timers } = timedMonitor(context, page, 15);
  try {
    context.emit('response', response({ page })); await settle(); assert.equal((await monitor.inspect()).state, 'authenticated');
    let release;
    const stalled = response({ page }); stalled.json = () => new Promise(resolve => { release = resolve; });
    context.emit('response', stalled); await settle(); assert.equal(timers.size, 1);
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(timers.size, 0);
    const timedOut = await monitor.inspect(); assert.equal(timedOut.state, 'unknown'); assert.doesNotMatch(timedOut.message, /正在更新/);
    const reads = context.cookieReads.length;
    release({ status_code: 0, user: { uid: '123' } }); await settle();
    assert.equal(context.cookieReads.length, reads, '超时后不继续读会话或写回证明');
    assert.equal((await monitor.inspect()).state, 'unknown');
    context.emit('response', response({ page })); await settle();
    assert.equal((await monitor.inspect()).state, 'authenticated'); assert.equal(timers.size, 0);
  } finally { monitor.dispose(); }
});

test('Cookie读取永久pending同样有界，检测计时器清理且后续回复可以恢复', async () => {
  const page = pageFixture(), context = contextFixture([page]), { monitor, timers } = timedMonitor(context, page, 15);
  try {
    context.cookies = () => new Promise(() => {});
    context.emit('response', response({ page })); await settle(); assert.equal(timers.size, 1);
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(timers.size, 0);
    assert.equal((await monitor.inspect()).state, 'unknown'); assert.equal(timers.size, 0, '普通检查的Cookie读超时也释放计时器');
    context.cookies = async () => [cookie()];
    const current = await monitor.inspect(); assert.equal(current.state, 'unknown'); assert.doesNotMatch(current.message, /正在更新/);
    context.emit('response', response({ page })); await settle();
    assert.equal((await monitor.inspect()).state, 'authenticated'); assert.equal(timers.size, 0);
  } finally { monitor.dispose(); }
});

test('page/context关闭和dispose主动清理读取计时器，未完成的正文或Cookie不写回证明', async () => {
  for (const action of ['page', 'context', 'dispose']) for (const stage of ['body', 'cookie']) {
    const page = pageFixture(), context = contextFixture([page]), { monitor, timers } = timedMonitor(context, page, 1000);
    try {
      let release, bodyReads = 0;
      const stalled = response({ page });
      if (stage === 'body') stalled.json = () => { bodyReads++; return new Promise(resolve => { release = resolve; }); };
      else { context.cookies = () => new Promise(resolve => { release = resolve; }); stalled.json = async () => { bodyReads++; return { status_code: 0, user: { uid: '123' } }; }; }
      context.emit('response', stalled); await settle(); assert.equal(timers.size, 1);
      if (action === 'page') page.close(); else if (action === 'context') context.emit('close'); else monitor.dispose();
      assert.equal(timers.size, 0);
      const before = bodyReads;
      release(stage === 'body' ? { status_code: 0, user: { uid: '123' } } : [cookie()]); await settle();
      assert.equal(timers.size, 0); assert.equal(bodyReads, before, '取消后不继续解码');
      assert.equal((await monitor.inspect()).state, 'browser_closed');
      if (action === 'page') {
        context.cookies = async () => [cookie()]; const work = pageFixture({ url: 'https://www.douyin.com/video/7693378601286309625' }); context.add(work);
        assert.equal((await monitor.inspect()).state, 'unknown');
      }
    } finally { monitor.dispose(); }
    assert.equal(timers.size, 0);
  }
});

test('已关闭页面的迟到新回复不登记会话，也不创建计时器或影响后来新页面', async () => {
  const old = pageFixture(), context = contextFixture([old]), { monitor, timers } = timedMonitor(context, old, 15);
  try {
    old.close();
    context.emit('response', response({ page: old })); await settle(); assert.equal(timers.size, 0);
    const work = pageFixture({ url: 'https://www.douyin.com/video/7693378601286309625' }); context.add(work);
    context.emit('response', response({ page: old })); await settle(); assert.equal(timers.size, 0);
    assert.equal((await monitor.inspect()).state, 'unknown');
    context.emit('response', response({ page: work })); await settle();
    assert.equal((await monitor.inspect()).state, 'authenticated');
  } finally { monitor.dispose(); }
});
