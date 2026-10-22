'use strict';
// 私信实时同步引擎：模拟页面（合成 protobuf，不含真实私信）。连接、推送合并、指令触发刷新、发送前核对会话、回执状态、断线重连。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatRuntime } = require('../engine-chat');

const SELF = '2772333550910919', PEER = '3563978199939675';
const CONV = `0:1:${SELF}:${PEER}`;
// —— 最小 protobuf 编码器
const varint = n => { let v = BigInt(n); const out = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const key = (field, wire) => varint((field << 3) | wire);
const vInt = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
const vBytes = (field, value) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); return Buffer.concat([key(field, 2), varint(b.length), b]); };
const cat = (...p) => Buffer.concat(p);
const message = ({ id, sender, text, type = 7, at }) => cat(vBytes(1, CONV), vInt(3, id), vInt(6, type), vInt(7, sender),
  vBytes(8, JSON.stringify(type === 50001 ? { command_type: 6 } : { text })), vInt(10, at), vBytes(14, 'SEC-' + sender));
function initBody(inbox, messages) {
  const info = cat(vBytes(1, CONV), vInt(2, 1), vBytes(6, cat(vBytes(1, cat(vInt(1, PEER), vBytes(5, 'SEC-PEER'))), vBytes(1, cat(vInt(1, SELF), vBytes(5, 'SEC-SELF'))))));
  const conv = cat(vBytes(1, info), ...messages.map(m => vBytes(2, message(m))));
  return cat(vInt(1, 2043), vInt(2, inbox), vBytes(6, vBytes(2043, cat(vBytes(1, conv), vInt(2, 0)))), vInt(13, SELF));
}
const pushFrame = m => cat(vInt(1, 1), vBytes(8, cat(vInt(1, 500), vBytes(6, vBytes(500, vBytes(5, message(m)))))));
const T = Date.parse('2026-10-22T14:00:00+08:00');

function fakePage({ rowsFor = () => 1, historyMatches = () => true } = {}) {
  const listeners = { response: new Set(), websocket: new Set(), close: new Set() };
  const page = {
    gotos: 0, typed: '', presses: [], closed: false, ws: null,
    on: (e, fn) => listeners[e].add(fn), off: (e, fn) => listeners[e].delete(fn),
    isClosed: () => page.closed,
    close: async () => { page.closed = true; for (const fn of listeners.close) fn(); },
    emit(path, body, reqBody = Buffer.alloc(0)) {
      for (const fn of listeners.response) fn({ url: () => (path.startsWith('/v1') ? 'https://imapi.douyin.com' : 'https://www.douyin.com') + path, status: () => 200,
        body: async () => body, json: async () => JSON.parse(String(body)), request: () => ({ postDataBuffer: () => reqBody }) });
    },
    async goto() {
      page.gotos++;
      const wsListeners = { framereceived: new Set(), close: new Set() };
      page.ws = { url: () => 'wss://frontier-im.douyin.com/ws/v2', on: (e, fn) => wsListeners[e].add(fn), push: data => { for (const fn of wsListeners.framereceived) fn({ payload: data }); } };
      for (const fn of listeners.websocket) fn(page.ws);
      page.emit('/v1/message/get_message_by_init', initBody(10001, [{ id: 1, sender: SELF, text: '你好', at: T }]));
      page.emit('/v1/message/get_message_by_init', initBody(10002, []));
      page.emit('/aweme/v1/web/im/user/info/', Buffer.from(JSON.stringify({ data: [{ uid: PEER, sec_uid: 'SEC-PEER', nickname: '崔广安' }] })));
    },
    waitForTimeout: async () => {}, evaluate: async () => ({ text: '' }),
    getByText: () => ({ first: () => ({ count: async () => 0, click: async () => {} }) }),
    locator(selector) {
      if (selector.includes('conversation-item')) return { filter: () => ({ count: async () => rowsFor(), nth: i => ({ click: async () => { page.emit('/v1/message/get_by_conversation', Buffer.from([]), Buffer.from(historyMatches(i) ? `${CONV}` : `0:1:999:${SELF}`, 'latin1')); } }) }) };
      return { last: () => ({ count: async () => 1, click: async () => {} }) };
    },
    keyboard: { type: async ch => { page.typed += ch; }, press: async k => { page.presses.push(k); if (k === 'Enter' && page.onSend) page.onSend(); } }
  };
  return page;
}

function harness({ page = fakePage(), alive = null, receipt = { state: 'confirmed_success' } } = {}) {
  let inbox = { accounts: {} }, leads = [{ id: 1, uid: 'SEC-PEER', dmState: 'confirmed_success', dmLastAt: '2026-10-22 13:00:00' }];
  const launched = [], closedAccounts = [], logs = [];
  const runtime = createChatRuntime({
    store: { getInbox: () => inbox, setInbox: v => { inbox = v; }, getLeads: () => leads, setLeads: v => { leads = v; }, log: (id, line) => logs.push(line) },
    authorize: async () => true, getAlive: () => alive,
    launchAccount: async (id, opts) => { launched.push([id, opts.headless]); return { page }; },
    closeAccount: async id => { closedAccounts.push(id); },
    refreshLeadStatus: lead => { if (lead.replied) lead.status = 'replied'; },
    sleep: async () => {}, typeDelay: () => 0, reconnectMs: 20, refreshDebounceMs: 20, initTimeoutMs: 500, rowWaitMs: 50,
    createReceipt: () => { let armed = null; return { arm: o => { armed = o; }, waitForReceipt: async () => true, getOutcome: () => receipt, dispose() {}, get armed() { return armed; } }; }
  });
  return { runtime, page, launched, closedAccounts, logs, get inbox() { return inbox; }, get leads() { return leads; } };
}
const conv = h => h.inbox.accounts.A.conversations[PEER];
const wait = ms => new Promise(r => setTimeout(r, ms));

test('连接：没有窗口时后台启动；读到初始同步后在线，会话与对方昵称入库', async () => {
  const h = harness();
  const r = await h.runtime.connect('A');
  assert.deepEqual(r, { ok: true, state: 'online' });
  assert.deepEqual(h.launched, [['A', true]]);
  assert.equal(conv(h).nickname, '崔广安');
  assert.equal(h.runtime.status().runtimes.A.state, 'online');
  assert.equal(h.runtime.status().runtimes.A.live, true);
});

test('连接：已有外部窗口时在其中新开标签页，断开只关标签页不关窗口', async () => {
  const tab = fakePage();
  const h = harness({ page: tab, alive: { page: { isClosed: () => false }, context: { newPage: async () => tab } } });
  await h.runtime.connect('A');
  assert.deepEqual(h.launched, []);
  await h.runtime.disconnect('A');
  assert.equal(tab.closed, true); assert.deepEqual(h.closedAccounts, []);
  assert.equal(h.runtime.status().runtimes.A.state, 'offline');
});

test('实时推送：对方文字消息立即入库并计未读、关联线索已回复；会话指令触发一次刷新', async () => {
  const h = harness();
  await h.runtime.connect('A');
  h.page.ws.push(pushFrame({ id: 2, sender: PEER, text: '多少钱', at: T + 60000 }));
  assert.equal(conv(h).unread, 1);
  assert.deepEqual(conv(h).messages.map(m => [m.from, m.text]), [['me', '你好'], ['peer', '多少钱']]);
  assert.equal(h.leads[0].replied, true); assert.equal(h.leads[0].status, 'replied');
  const before = h.page.gotos;
  h.page.ws.push(pushFrame({ id: 3, sender: PEER, type: 50001, at: T + 61000 }));
  await wait(80);
  assert.equal(h.page.gotos, before + 1, '指令推送后刷新私信页');
  assert.equal(conv(h).messages.length, 2, '指令本身不入库');
});

test('发送：先核对点开的会话是这个人，逐字输入、Enter 发送，回执送达后标“已送达”', async () => {
  const h = harness();
  await h.runtime.connect('A');
  const r = await h.runtime.send('A', PEER, '你好\n第二行');
  assert.deepEqual(r, { ok: true, state: 'sent' });
  assert.equal(h.page.typed, '你好第二行');
  assert.deepEqual(h.page.presses, ['Shift+Enter', 'Enter']);
  const mine = conv(h).messages.filter(m => m.local === true || m.status);
  assert.equal(mine.at(-1).status, 'sent'); assert.equal(mine.at(-1).text, '你好\n第二行');
  // 服务器回推同一条：并入本机这条，不重复
  h.page.ws.push(pushFrame({ id: 9, sender: SELF, text: '你好\n第二行', at: Date.now() }));
  assert.equal(conv(h).messages.filter(m => m.text === '你好\n第二行').length, 1);
});

test('发送：会话核对不上则停止且不输入；回执失败记录原因', async () => {
  const wrong = harness({ page: fakePage({ historyMatches: () => false }) });
  await wrong.runtime.connect('A');
  const r1 = await wrong.runtime.send('A', PEER, '你好');
  assert.equal(r1.ok, false); assert.equal(r1.code, 'CHAT_RECIPIENT_UNCONFIRMED');
  assert.equal(wrong.page.typed, ''); assert.deepEqual(wrong.page.presses, []);
  assert.equal(conv(wrong).messages.at(-1).status, 'failed');
  const fail = harness({ receipt: { state: 'confirmed_failure', reason: '平台提示私信操作频繁', failureScope: 'account' } });
  await fail.runtime.connect('A');
  const r2 = await fail.runtime.send('A', PEER, '你好');
  assert.equal(r2.ok, false); assert.equal(r2.error, '平台提示私信操作频繁'); assert.equal(r2.scope, 'account');
  assert.equal(conv(fail).messages.at(-1).reason, '平台提示私信操作频繁');
});

test('未连接不能发送；页面被关闭后自动重连', async () => {
  const h = harness();
  assert.equal((await h.runtime.send('A', PEER, '你好')).ok, false);
  await h.runtime.connect('A');
  await h.page.close();
  assert.equal(h.runtime.status().runtimes.A.state, 'offline');
  h.page.closed = false;
  await wait(120);
  assert.equal(h.runtime.status().runtimes.A.state, 'online');
  assert.equal(h.launched.length, 2);
});
