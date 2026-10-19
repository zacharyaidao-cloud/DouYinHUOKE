'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { assertPageHealth } = require('../engine-actions');

// Execute the browser-side health reader against an isolated DOM-shaped fixture.
// No browser, network, real platform account or click is involved.
function node({ tag = 'div', text = '', attrs = {}, hidden = false, visibility = 'visible', children = [] } = {}) {
  const element = { tag, attrs, children, parentElement: null, visibility,
    get tagName() { return tag.toUpperCase(); },
    get textContent() { return text + children.map(child => child.textContent).join(''); },
    getAttribute: name => attrs[name] === undefined ? null : String(attrs[name]),
    getClientRects: () => hidden ? [] : [{}]
  };
  for (const child of children) child.parentElement = element;
  return element;
}
function fixture(nodes = [], { url = 'https://www.douyin.com/user/user1', closed = false, body = '主页已加载' } = {}) {
  function simpleMatches(element, selector) {
    const attribute = selector.match(/^\[([\w-]+)(\*=|=)"([^"]+)"(?: (i))?\]$/);
    if (!attribute) return element.tag === selector;
    let value = String(element.attrs[attribute[1]] || ''), expected = attribute[3];
    if (attribute[4]) { value = value.toLowerCase(); expected = expected.toLowerCase(); }
    return attribute[2] === '=' ? value === expected : value.includes(expected);
  }
  function matches(element, selector) {
    const parts = selector.trim().replace(/ i\]/g, '~i]').split(/\s+/).map(part => part.replace(/~i\]/g, ' i]'));
    if (!simpleMatches(element, parts.pop())) return false;
    let ancestor = element.parentElement;
    while (parts.length) {
      const part = parts.pop(); while (ancestor && !simpleMatches(ancestor, part)) ancestor = ancestor.parentElement;
      if (!ancestor) return false; ancestor = ancestor.parentElement;
    }
    return true;
  }
  const all = []; const walk = element => { all.push(element); element.children.forEach(walk); }; nodes.forEach(walk);
  const document = { body: { textContent: body }, querySelectorAll: selector => all.filter(element => selector.split(',').some(part => matches(element, part))) };
  return { url: () => url, isClosed: () => closed,
    evaluate: async reader => vm.runInNewContext('(' + reader.toString() + ')()', { document, getComputedStyle: element => ({ visibility: element.visibility }) }) };
}

test('可见系统提示中的当前账户每日关注及发送上限暂停，支持不同提示容器', async () => {
  const messages = [
    '今日发送次数已达上限', '今日发送私信人数已经达到上限，请明天再试',
    '您今日关注人数已达到上限。', '你的账号今日私信额度已用完',
    '系统提示：今天私信次数已超过每日上限！', '今日关注次数（30次）达到上限',
    '当前账号已达到今日私信人数上限', '今日的发送消息数量已达到当日上限',
    '今天发送私信次数已超出每日额度', '今日发送人数已达上限（每日20人）',
    '今日陌生人私信达到上限', '今日向陌生人发送私信次数已达上限', '您今日给陌生人发送消息已达上限'
  ];
  const containers = [{ role: 'alert' }, { role: 'dialog' }, { 'aria-live': 'assertive' }, { 'aria-live': 'polite' }, { class: 'Semi-Toast-content' }, { 'data-e2e': 'global-toast' }];
  for (const text of messages) for (const attrs of containers) {
    await assert.rejects(assertPageHealth(fixture([node({ text, attrs })]), '1', 'user1'), error => error.code === 'PLATFORM_DAILY_LIMIT', text);
  }
});

test('接收方权限和陌生人单会话限制不误判为当前账户每日额度', async () => {
  for (const text of [
    '对方未关注你，暂时无法发送私信', '该用户设置了私信权限',
    '陌生人只能发送一条消息', '当前会话发送次数已达上限',
    '今日向该用户发送次数已达上限', '今日私信给这位用户的次数已达上限',
    '今日私信人数已达上限（对方限制）', '每日单个会话发送数量已达上限',
    '请稍后再试，对方暂不接受陌生人私信'
  ]) await assertPageHealth(fixture([node({ text, attrs: { role: 'alert' } })]), '1', 'user1');
});

test('普通评论和昵称不是账户反馈，隐藏系统提示也不能触发暂停', async () => {
  await assertPageHealth(fixture([
    node({ tag: 'span', text: '今日发送次数已达上限', attrs: { 'data-e2e': 'comment-content' } }),
    node({ tag: 'span', text: '操作太频繁', attrs: { 'data-e2e': 'user-name' } }),
    node({ text: '今日关注人数已达上限', attrs: { role: 'alert' }, hidden: true }),
    node({ text: '账号存在风险', attrs: { class: 'toast' }, visibility: 'hidden' })
  ]), '1', 'user1');
  await assertPageHealth(fixture([node({ text: '每日发送次数上限为20次', attrs: { role: 'dialog' } })]), '1', 'user1');
});

test('原有频繁及功能受限系统提示仍然暂停', async () => {
  for (const text of ['操作太频繁，请稍后再试', '访问过于频繁', '账号存在风险！', '功能暂不可用', '请稍后再试。',
    '关注频率过高，请稍后再试', '你关注太快了，休息一下吧', '私信发送过于频繁', '系统提示：发送消息太频繁，请稍后再试']) {
    await assert.rejects(assertPageHealth(fixture([node({ text, attrs: { role: 'alert' } })]), '1', 'user1'), error => error.code === 'PLATFORM_RESTRICTED');
  }
});

test('验证和登录反馈仍保持独立暂停原因，空页面明确报错', async () => {
  await assert.rejects(assertPageHealth(fixture([node({ attrs: { class: 'captcha-container' } })]), '1', 'user1'), error => error.code === 'PLATFORM_VERIFICATION');
  await assert.rejects(assertPageHealth(fixture([node({ tag: 'button', text: '请完成验证' })]), '1', 'user1'), error => error.code === 'PLATFORM_VERIFICATION');
  for (const text of ['登录', '扫码登录']) await assert.rejects(assertPageHealth(fixture([
    node({ tag: 'header', children: [node({ tag: 'button', text })] })
  ]), '1', 'user1'), error => error.code === 'LOGIN_REQUIRED');
  await assert.rejects(assertPageHealth(fixture([
    node({ attrs: { 'data-e2e': 'message-panel' }, children: [node({ tag: 'button', text: '登录后发送消息' })] })
  ]), '1', 'user1'), error => error.code === 'LOGIN_REQUIRED');
  for (const text of ['登录', '扫码登录', '登录后发送消息']) await assertPageHealth(fixture([node({ tag: 'button', text })]), '1', 'user1');
  await assert.rejects(assertPageHealth(fixture([], { body: '' }), '1', 'user1'), /页面未正常加载/);
});
