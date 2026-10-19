'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const obfuscator = require('../../build-tools/node_modules/javascript-obfuscator');
const browserActions = require('../lib/browser-actions');
const workflow = require('../workflow');
const AI = require('../ai');
const { EventEmitter } = require('node:events');

// These are the shipping build's options, including Node string-array helpers.
// A deterministic seed makes the regression repeatable without building an EXE.
const options = {
  compact: true, controlFlowFlattening: false, deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal', numbersToExpressions: true,
  renameGlobals: false, selfDefending: false, simplify: true, splitStrings: false,
  stringArray: true, stringArrayCallsTransform: false,
  stringArrayEncoding: ['base64'], stringArrayThreshold: 0.75,
  rotateStringArray: true, shuffleStringArray: true, target: 'node', log: false
};

function loadObfuscatedActions(seed) {
  const filename = path.resolve(__dirname, '../engine-actions.js');
  const code = obfuscator.obfuscate(fs.readFileSync(filename, 'utf8'), { ...options, seed }).getObfuscatedCode();
  const module = { exports: {} };
  const wrap = vm.runInNewContext('(function(require, module, exports) {' + code + '\n})', { Buffer, Date, URL });
  wrap(createRequire(filename), module, module.exports);
  return module.exports;
}

function domFixture({ followText = '关注', editors = 1, sendDisabled = false, sendMissing = false } = {}) {
  const clicks = [], inputs = [], called = [];
  let conversationOpen = false;
  function element(tag, text, attributes = {}, visible = () => true, onClick = () => {}) {
    return {
      tag, textContent: text, attributes, disabled: false,
      getClientRects: () => visible() ? [{}] : [],
      getAttribute: name => attributes[name] || null,
      click: onClick, focus: () => {}, dispatchEvent: event => { inputs.push(event); }
    };
  }
  const follow = element('button', followText, {}, () => true, () => { clicks.push('follow'); follow.textContent = '已关注'; });
  const dm = element('button', '私信', {}, () => true, () => { clicks.push('openDm'); conversationOpen = true; });
  const send = element('button', '发送', {}, () => conversationOpen, () => { clicks.push('send'); });
  send.disabled = sendDisabled;
  const messageEditors = Array.from({ length: editors }, () => element('div', '', { contenteditable: 'true' }, () => conversationOpen));
  const nodes = [follow, dm, ...messageEditors, ...(sendMissing ? [] : [send])];
  function matches(node, selector) {
    const attr = selector.match(/^\[([\w-]+)(\*=|=)"([^"]+)"(?: (i))?\]$/);
    if (!attr) return node.tag === selector;
    let actual = String(node.attributes[attr[1]] || ''), expected = attr[3];
    if (attr[4]) { actual = actual.toLowerCase(); expected = expected.toLowerCase(); }
    return attr[2] === '=' ? actual === expected : actual.includes(expected);
  }
  const document = { body: { textContent: '本地隔离主页' }, querySelectorAll: selector => nodes.filter(node => selector.split(',').some(part => matches(node, part))) };
  const context = { document, getComputedStyle: () => ({ visibility: 'visible' }), InputEvent: class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } } };
  const evaluate = async (callback, arg) => {
    called.push(callback.name);
    // No Node globals, decoder helpers, browser, request or account profile is
    // available here. This is Playwright's function-serialization boundary.
    return vm.runInNewContext('(' + callback.toString() + ')(argument)', { ...context, argument: arg });
  };
  return { evaluate, clicks, inputs, called, messageEditors };
}

function taskFixture(module, dom) {
  const settings = {
    ai: { prompt: '隔离测试规则' }, action: { pacingVersion: 1, userIntervalSec: 0, userIntervalJitter: 0 },
    human: { workPeriods: [], breakEvery: 0, maxConsecutiveErrors: 3 },
    follow: { enabled: true, dailyLimit: 20 },
    dm: { enabled: true, dailyLimit: 20, template: '本地测试消息', repeat: { enabled: false } },
    outreach: { businessId: 'default' }
  };
  const lead = { id: 'fixture-lead', accountId: 'fixture-account', uid: 'fixture-user', homepage: 'https://www.douyin.com/user/fixture-user', demand: '具体需求', aiNeed: '是', aiReason: '询问相关处理方法', aiDone: true };
  lead.aiPromptVersion = AI.getRuleSet(settings).version; lead.aiInputHash = workflow.aiInputHash(lead);
  const plan = { id: 'fixture-plan', kind: 'outreach', accountId: 'fixture-account', actions: { follow: true, dm: true }, leadIds: [lead.id], leads: [{ id: lead.id, uid: lead.uid }], fingerprint: workflow.settingsFingerprint(settings, { follow: true, dm: true }) };
  let currentUrl = 'https://www.douyin.com/';
  const state = { running: false, stopRequested: false, errors: [] }, usage = {}, savedDmStates = [], authorizations = [];
  const emitter = new EventEmitter();
  const page = { isClosed: () => false, url: () => currentUrl, on: emitter.on.bind(emitter), off: emitter.off.bind(emitter), goto: async url => { currentUrl = url; } };
  page.evaluate = async (callback, argument) => {
    const value = await dom.evaluate(callback, argument);
    if (callback === browserActions.clickFollow && value === 'clicked') {
      const request = {
        url: () => 'https://www.douyin.com/aweme/v1/web/commit/follow/user/', method: () => 'POST',
        postData: () => 'sec_user_id=fixture-user&type=1', headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }), frame: () => ({ page: () => page })
      };
      emitter.emit('request', request);
      emitter.emit('response', { url: request.url, request: () => request, status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }), body: async () => Buffer.from('{"status_code":0,"follow_status":1}'),
        text: async () => '{"status_code":0,"follow_status":1}', json: async () => ({ status_code: 0, follow_status: 1 }) });
    }
    return value;
  };
  const store = {
    getSettings: () => settings, getLeads: () => [structuredClone(lead)], getVideos: () => ({}),
    getDailyUsage: () => ({ ...usage }), bumpDaily: (accountId, key) => { usage[key] = (usage[key] || 0) + 1; },
    nowStr: () => '2026-10-08 10:00:00', log: () => {}
  };
  const actions = module.createActions({
    observeProfileRelation: () => ({ wait: async () => ({ state: 'unknown' }), dispose: () => {} }),
    observeDmHistory: () => ({ wait: async () => ({ state: 'unknown' }), dispose: () => {} }),
    saveContactObservation: () => {},
    store, taskState: state, setTask: update => Object.assign(state, update), SLEEP: async () => {},
    getAlive: () => ({ page }), launchAccount: async () => ({ page }),
    navigateProfilePage: async (targetPage, url, options) => {
      options.checkStopped(); await options.authorize({ kind: 'video_redirect' }); options.checkStopped();
      return targetPage.goto(url);
    },
    makeScheduler: () => ({ run: async (meta, work) => work(), prepare: async (meta, work) => work(), before: async meta => { authorizations.push(meta.kind); }, checkStopped: () => {}, scheduleBoundary: () => {} }),
    // This VM test covers the obfuscated caller's module boundary. Native
    // locator interactions are exercised separately in real Chromium.
    browserActionAdapter: {
      prepareFollow: async () => ({ state: 'ready', click: async () => (await page.evaluate(browserActions.clickFollow)) === 'clicked' }),
      openDirectMessage: async () => page.evaluate(browserActions.openDirectMessage),
      ensureDirectMessageConversation: async () => true,
      fillDirectMessage: async (_page, _lead, message) => page.evaluate(browserActions.fillDirectMessage, message),
      prepareSend: async (_page, _lead, message) => ({ state: 'ready', click: async () => page.evaluate(browserActions.sendDirectMessage, message) })
    },
    saveLeadAction: (next, kind) => { Object.assign(lead, next); if (kind === 'dm') savedDmStates.push(next.dmState); },
    resolvePlan: () => plan, checkpoint: () => {}, applyTemplate: () => '本地测试消息', getSignal: () => undefined,
    getHooks: () => ({ dmVerifier: async () => ({ state: 'pending_verification', reason: 'isolated test has no platform receipt' }) })
  });
  return { actions, lead, usage, savedDmStates, authorizations };
}

function healthNode(tag, ownText = '', attrs = {}, children = []) {
  const node = { tag, ownText, attrs, children, parentElement: null,
    get tagName() { return tag.toUpperCase(); },
    get textContent() { return ownText + children.map(child => child.textContent).join(''); },
    getAttribute: name => attrs[name] === undefined ? null : String(attrs[name]),
    getClientRects() {
      for (let current = this; current; current = current.parentElement) if (current.attrs.hidden || current.attrs.display === 'none') return [];
      return [{}];
    },
    querySelectorAll(selector) {
      const descendants = []; const walk = child => { descendants.push(child); child.children.forEach(walk); };
      children.forEach(walk); return descendants.filter(child => selector.split(',').some(part => healthMatches(child, part)));
    }
  };
  for (const child of children) child.parentElement = node;
  return node;
}
function healthSimpleMatches(node, selector) {
  const tag = selector.match(/^[a-z]+/i);
  if (tag && node.tag !== tag[0]) return false;
  for (const match of selector.matchAll(/\[([\w-]+)(?:(\*=|=)"([^"]+)")?(?: (i))?\]/g)) {
    let value = node.getAttribute(match[1]), expected = match[3];
    if (value === null) return false;
    if (match[4]) { value = value.toLowerCase(); expected = String(expected).toLowerCase(); }
    if (match[2] === '=' && value !== expected || match[2] === '*=' && !value.includes(expected)) return false;
  }
  return true;
}
function healthMatches(node, selector) {
  const parts = selector.trim().replace(/ i\]/g, '~i]').split(/\s+/).map(part => part.replace(/~i\]/g, ' i]'));
  if (!healthSimpleMatches(node, parts.pop())) return false;
  let ancestor = node.parentElement;
  while (parts.length) {
    const part = parts.pop(); while (ancestor && !healthSimpleMatches(ancestor, part)) ancestor = ancestor.parentElement;
    if (!ancestor) return false; ancestor = ancestor.parentElement;
  }
  return true;
}
function healthPage(nodes) {
  const root = healthNode('body', '本地隔离作品页', {}, nodes), all = [];
  const walk = node => { all.push(node); node.children.forEach(walk); }; walk(root);
  const document = { body: root, querySelectorAll: selector => all.filter(node => selector.split(',').some(part => healthMatches(node, part))) };
  return { isClosed: () => false, url: () => 'https://www.douyin.com/user/fixture-user',
    evaluate: async callback => vm.runInNewContext('(' + callback.toString() + ')()', { document,
      getComputedStyle: node => ({ visibility: node.attrs.visibility || 'visible', display: node.attrs.display || 'block' }) }) };
}

test('发行混淆后的执行模块经独立适配器边界运行，未知私信回执仍待核验', async () => {
  for (const seed of [19, 37]) {
    const dom = domFixture();
    const f = taskFixture(loadObfuscatedActions(seed), dom);
    const result = await f.actions.outreachTask('fixture-account', { planId: 'fixture-plan' });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(dom.clicks, ['follow', 'openDm', 'send']);
    assert.deepEqual(new Set(dom.called), new Set(Object.keys(browserActions).filter(name => name !== 'isFollowConfirmed')));
    assert.equal(result.followCount, 1); assert.equal(result.pendingCount, 1); assert.equal(result.dmCount, 0);
    assert.equal(f.usage.dm || 0, 0); assert.equal(f.lead.dmState, 'pending_verification');
    assert.deepEqual(f.savedDmStates, ['pending_verification', 'pending_verification']);
    assert.ok(f.authorizations.includes('follow')); assert.ok(f.authorizations.includes('ui')); assert.ok(f.authorizations.includes('dm'));
    assert.equal(dom.inputs[0].type, 'input'); assert.equal(dom.inputs[0].data, '本地测试消息');
  }
});

test('独立浏览器回调保留已关注、消息编辑器唯一性、发送文本一致和禁用按钮检查', async () => {
  const followed = domFixture({ followText: '已关注' });
  assert.equal(await followed.evaluate(browserActions.clickFollow), 'already');
  assert.equal(await followed.evaluate(browserActions.isFollowConfirmed), true);
  assert.deepEqual(followed.clicks, []);
  for (const editors of [0, 2]) {
    const dom = domFixture({ editors });
    await dom.evaluate(browserActions.openDirectMessage);
    assert.equal(await dom.evaluate(browserActions.fillDirectMessage, '本地测试消息'), false);
    assert.equal(await dom.evaluate(browserActions.sendDirectMessage, '本地测试消息'), false);
    assert.deepEqual(dom.clicks, ['openDm']);
  }
  for (const options of [{}, { sendDisabled: true }, { sendMissing: true }]) {
    const dom = domFixture(options);
    await dom.evaluate(browserActions.openDirectMessage);
    assert.equal(await dom.evaluate(browserActions.fillDirectMessage, '本地测试消息'), true);
    assert.equal(await dom.evaluate(browserActions.sendDirectMessage, '不同文本'), false);
    if (options.sendDisabled || options.sendMissing) assert.equal(await dom.evaluate(browserActions.sendDirectMessage, '本地测试消息'), false);
    assert.deepEqual(dom.clicks, ['openDm']);
  }
});

test('发行混淆后的健康检查不把评论、视频描述或消息中的登录文字当作账户失效', async () => {
  for (const seed of [19, 37]) {
    const actions = loadObfuscatedActions(seed);
    for (const tag of ['span', 'a', 'button']) for (const text of ['登录', '扫码登录', '登录后发送消息']) {
      for (const container of [
        healthNode('div', '', { 'data-e2e': 'comment-item' }, [healthNode(tag, text)]),
        healthNode('div', '', { 'data-e2e': 'video-caption' }, [healthNode(tag, text)]),
        healthNode('div', '', { class: 'message-bubble' }, [healthNode(tag, text)]),
        healthNode('div', '', { contenteditable: 'true' }, [healthNode(tag, text)]),
        healthNode(tag, text)
      ]) await actions.assertPageHealth(healthPage([container]), 'fixture-account', 'fixture-user');
    }
    for (const parent of [healthNode('header'), healthNode('div', '', { role: 'banner' }), healthNode('div', '', { 'data-e2e': 'top-header' })]) {
      const button = healthNode('button', '扫码登录'); parent.children.push(button); button.parentElement = parent;
      await assert.rejects(actions.assertPageHealth(healthPage([parent]), 'fixture-account', 'fixture-user'), error => error.code === 'LOGIN_REQUIRED');
    }
    await actions.assertPageHealth(healthPage([
      healthNode('header', '', {}, [healthNode('span', '登录', { 'data-e2e': 'user-name' })])
    ]), 'fixture-account', 'fixture-user');
    for (const attrs of [{ 'data-e2e': 'message-panel' }, { class: 'im-chatPanel-container' }]) {
      await assert.rejects(actions.assertPageHealth(healthPage([
        healthNode('div', '', attrs, [healthNode('button', '登录后发送消息')])
      ]), 'fixture-account', 'fixture-user'), error => error.code === 'LOGIN_REQUIRED');
      await actions.assertPageHealth(healthPage([
        healthNode('div', '', attrs, [healthNode('div', '', { 'data-e2e': 'message-item' }, [healthNode('button', '登录后发送消息')])])
      ]), 'fixture-account', 'fixture-user');
    }
  }
});

test('普通消息及引用不充当平台限制，真实系统限制与验证码仍优先暂停', async () => {
  const actions = loadObfuscatedActions(19);
  for (const text of ['操作太频繁，请稍后再试', '今日发送次数已达上限', '请完成验证']) {
    for (const attrs of [{ 'data-e2e': 'comment-content' }, { class: 'message-history' }, { role: 'log' }, { contenteditable: 'true' }]) {
      await actions.assertPageHealth(healthPage([healthNode('div', '', attrs, [healthNode('div', text, { role: 'alert' })])]), 'fixture-account', 'fixture-user');
    }
    for (const attrs of [{ 'data-e2e': 'message-item' }, { class: 'chatMessageBubble' }, { class: 'quoted-message' }]) {
      await actions.assertPageHealth(healthPage([healthNode('div', '', { role: 'dialog' }, [
        healthNode('div', '', attrs, [healthNode('span', text)])
      ])]), 'fixture-account', 'fixture-user');
    }
    await actions.assertPageHealth(healthPage([healthNode('div', '', { role: 'dialog' }, [
      healthNode('blockquote', text)
    ])]), 'fixture-account', 'fixture-user');
  }
  await assert.rejects(actions.assertPageHealth(healthPage([healthNode('div', '操作太频繁，请稍后再试', { role: 'alert' })]), 'fixture-account', 'fixture-user'), error => error.code === 'PLATFORM_RESTRICTED');
  await assert.rejects(actions.assertPageHealth(healthPage([healthNode('div', '今日发送次数已达上限', { 'data-e2e': 'global-toast' })]), 'fixture-account', 'fixture-user'), error => error.code === 'PLATFORM_DAILY_LIMIT');
  await assert.rejects(actions.assertPageHealth(healthPage([
    healthNode('header', '', {}, [healthNode('button', '登录')]),
    healthNode('div', '今日发送次数已达上限', { role: 'alert' }),
    healthNode('div', '', { class: 'captcha-popup' }, [healthNode('button', '完成验证', { disabled: 'true' })])
  ]), 'fixture-account', 'fixture-user'), error => error.code === 'PLATFORM_VERIFICATION');
});
