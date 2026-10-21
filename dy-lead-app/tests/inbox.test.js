'use strict';
// 私信归集：解析（合成 protobuf，不含任何真实私信）、合并与基线、线索已回复、任务流程。
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInitResponse, parseUserInfo, describeContent } = require('../lib/im-inbox');
const { mergeScan, linkLeadReplies, listConversations, markRead, beijingText } = require('../lib/inbox-store');
const { createInboxTasks } = require('../engine-inbox-tasks');

// —— 最小 protobuf 编码器（只用于构造测试数据）
const varint = n => { let v = BigInt(n); const out = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const key = (field, wire) => varint((field << 3) | wire);
const vInt = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
const vBytes = (field, value) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); return Buffer.concat([key(field, 2), varint(b.length), b]); };
const msg = (...parts) => Buffer.concat(parts);

const SELF = '2772333550910919';
function message({ id, sender, text, tips, at, type = text ? 7 : 1 }) {
  return msg(vBytes(1, `0:1:${sender}:${SELF}`), vInt(3, id), vInt(6, type), vInt(7, sender),
    vBytes(8, JSON.stringify(tips ? { tips } : { text, aweType: 700 })), vInt(10, at), vBytes(14, 'SEC-' + sender));
}
function conversation(peer, messages) {
  const info = msg(vBytes(1, `0:1:${peer}:${SELF}`), vInt(2, 7000000000000000000n + BigInt(peer)),
    vBytes(6, msg(vBytes(1, msg(vInt(1, peer), vBytes(5, 'SEC-' + peer))), vBytes(1, msg(vInt(1, SELF), vBytes(5, 'SEC-SELF'))))));
  return msg(vBytes(1, info), ...messages.map(m => vBytes(2, message(m))));
}
function initResponse(inbox, conversations, hasMore = 0) {
  const payload = msg(...conversations.map(c => vBytes(1, c)), vInt(2, hasMore), vInt(3, 1792515598387787n));
  return msg(vInt(1, 2043), vInt(2, inbox), vInt(3, 0), vBytes(4, 'OK'), vBytes(6, vBytes(2043, payload)), vInt(13, SELF));
}
const T = Date.parse('2026-10-21T10:00:00+08:00');

test('解析初始同步：会话、参与者、消息发送者 / 类型 / 时间；收件箱类别与翻页标记', () => {
  const buf = initResponse(10002, [conversation(72551404516, [
    { id: 11, sender: SELF, text: '你好，我们是专门处理亚马逊账户问题的', at: T },
    { id: 12, sender: SELF, tips: '对方回复或关注你之前，只能发送一条文字消息。请礼貌发言，自觉遵守{{0}}', at: T + 1000 },
    { id: 13, sender: 72551404516, text: '怎么收费', at: T + 3600000 }
  ])], 1);
  const r = parseInitResponse(buf);
  assert.equal(r.selfUid, SELF); assert.equal(r.inboxLabel, 'stranger'); assert.equal(r.hasMore, true);
  assert.equal(r.conversations.length, 1);
  const c = r.conversations[0];
  assert.deepEqual(c.participants.map(p => p.uid), ['72551404516', SELF]);
  assert.deepEqual(c.messages.map(m => [m.id, m.kind, m.senderUid]), [['11', 'text', SELF], ['12', 'system', SELF], ['13', 'text', '72551404516']]);
  assert.equal(c.messages[1].text.includes('{{0}}'), false);
  assert.equal(c.messages[2].createdMs, T + 3600000);
});

test('不认识的数据不猜：非 2043、空、损坏、超大都返回 null', () => {
  assert.equal(parseInitResponse(Buffer.alloc(0)), null);
  assert.equal(parseInitResponse(msg(vInt(1, 100))), null);
  assert.equal(parseInitResponse(Buffer.from([0x0a, 0xff])), null);
  assert.equal(parseInitResponse(Buffer.alloc(9 * 1024 * 1024)), null);
});

test('消息内容分类与对方资料解析', () => {
  assert.deepEqual(describeContent('7', JSON.stringify({ text: ' 在吗 ' })), { kind: 'text', text: '在吗' });
  assert.equal(describeContent('5', JSON.stringify({ resource_url: {} })).kind, 'image');
  assert.equal(describeContent('7', 'not-json').kind, 'other');
  assert.deepEqual(parseUserInfo({ data: [{ uid: 9, sec_uid: 'S9', nickname: '小明', follow_status: 1 }, { nickname: '无uid' }] }),
    [{ uid: '9', secUid: 'S9', nickname: '小明', followStatus: 1, followerStatus: 0 }]);
});

const scanOf = (convs, users = []) => ({ selfUid: SELF, users, conversations: convs.map(([peer, messages]) => ({ convId: `0:1:${peer}:${SELF}`, inbox: 'stranger',
  participants: [{ uid: String(peer), secUid: 'SEC-' + peer }, { uid: SELF, secUid: 'SEC-SELF' }],
  messages: messages.map(m => ({ id: String(m.id), kind: m.kind || 'text', text: m.text || '', senderUid: String(m.sender), createdMs: m.at })) })) });

test('首次扫描只建基线不算未读；之后新出现的对方非系统消息才算未读；按消息 ID 去重', () => {
  let r = mergeScan({ accounts: {} }, { accountId: 'A', now: T, scan: scanOf([[1, [{ id: 1, sender: 1, text: '旧聊天', at: T - 86400000 }]]], [{ uid: '1', secUid: 'SEC-1', nickname: '老客户' }]) });
  assert.equal(r.firstScan, true); assert.equal(r.newPeerMessages.length, 0);
  assert.equal(r.inbox.accounts.A.conversations['1'].unread, 0);
  assert.equal(r.inbox.accounts.A.conversations['1'].nickname, '老客户');
  r = mergeScan(r.inbox, { accountId: 'A', now: T + 60000, scan: scanOf([[1, [
    { id: 1, sender: 1, text: '旧聊天', at: T - 86400000 },
    { id: 2, sender: 1, text: '新问题', at: T + 30000 },
    { id: 3, sender: 1, kind: 'system', text: '对方已确认聊天', at: T + 31000 },
    { id: 4, sender: SELF, text: '我方回复', at: T + 40000 }]]]) });
  assert.equal(r.firstScan, false);
  assert.deepEqual(r.newPeerMessages.map(m => m.id), ['2']);
  const conv = r.inbox.accounts.A.conversations['1'];
  assert.equal(conv.unread, 1); assert.equal(conv.messages.length, 4); assert.equal(conv.lastPeerAt, T + 30000);
  assert.equal(conv.nickname, '老客户', '这次没拿到资料时保留上次的昵称');
  assert.equal(markRead(r.inbox, 'A', '1'), true); assert.equal(conv.unread, 0);
});

test('线索已回复：只认我们私信成功过、且对方非系统消息晚于私信时间；首次扫描也能认出', () => {
  const dmAt = T;
  const { inbox } = mergeScan({ accounts: {} }, { accountId: 'B', now: T + 7200000, scan: scanOf([
    [1, [{ id: 1, sender: SELF, text: '你好', at: dmAt + 1000 }, { id: 2, sender: 1, text: '多少钱', at: dmAt + 3600000 }]],
    [2, [{ id: 3, sender: 2, text: '以前聊过的', at: dmAt - 3600000 }]],
    [3, [{ id: 4, sender: 3, kind: 'system', text: '对方已确认聊天', at: dmAt + 60000 }]],
    [4, [{ id: 5, sender: 4, text: '你好呀', at: dmAt + 60000 }]]]) });
  const leads = [
    { id: 1, uid: 'SEC-1', dmState: 'confirmed_success', dmLastAt: beijingText(dmAt) },
    { id: 2, uid: 'SEC-2', dmState: 'confirmed_success', dmLastAt: beijingText(dmAt) },
    { id: 3, uid: 'SEC-3', dmCount: 1, dmLastAt: beijingText(dmAt) },
    { id: 4, uid: 'SEC-4' }
  ];
  assert.equal(linkLeadReplies(leads, inbox), 1);
  assert.deepEqual(leads.map(l => !!l.replied), [true, false, false, false]);
  assert.equal(leads[0].replyText, '多少钱'); assert.equal(leads[0].replyAccountId, 'B');
  assert.equal(leads[0].repliedAt, beijingText(dmAt + 3600000));
  assert.equal(linkLeadReplies(leads, inbox), 0, '已标记的不重复');
});

test('会话列表：默认只列对方发过消息的；未读在前，其次按对方最近发言', () => {
  let { inbox } = mergeScan({ accounts: {} }, { accountId: 'A', now: T, scan: scanOf([[1, [{ id: 1, sender: 1, text: 'a', at: T - 5000 }]], [2, [{ id: 2, sender: 2, text: 'b', at: T - 1000 }]], [3, [{ id: 3, sender: SELF, text: '只有我说过', at: T }]]]) });
  ({ inbox } = mergeScan(inbox, { accountId: 'A', now: T + 1, scan: scanOf([[1, [{ id: 9, sender: 1, text: 'new', at: T + 100 }]]]) }));
  const rows = listConversations(inbox, { accounts: [{ id: 'A', name: '号A' }], leadsBySecUid: new Map([['SEC-2', { id: 7, nickname: '线索昵称', replied: false }]]) });
  assert.deepEqual(rows.map(r => r.peerUid), ['1', '2']);
  assert.equal(rows[0].unread, 1); assert.equal(rows[0].accountName, '号A');
  assert.equal(rows[1].lead.id, 7);
  assert.equal(listConversations(inbox, { onlyPeer: false }).length, 3);
});

test('任务：已打开的外部窗口新开标签页读取后关掉；没打开的后台启动后关闭；结果写入并标记已回复', async () => {
  let inbox = { accounts: {} }, leads = [{ id: 1, uid: 'SEC-5', dmState: 'confirmed_success', dmLastAt: beijingText(T) }];
  const closedPages = [], closedAccounts = [], launched = [], logs = [];
  const fakePage = () => {
    const listeners = new Set();
    return { listeners, isClosed: () => false, on: (e, fn) => listeners.add(fn), off: (e, fn) => listeners.delete(fn), close: async () => { closedPages.push(1); },
      goto: async () => {
        const body = initResponse(10002, [conversation(5, [{ id: 21, sender: 5, text: '我需要申诉', at: T + 600000 }])]);
        for (const fn of listeners) fn({ url: () => 'https://imapi.douyin.com/v1/message/get_message_by_init', status: () => 200, body: async () => body });
        const normal = initResponse(10001, []);
        for (const fn of listeners) fn({ url: () => 'https://imapi.douyin.com/v1/message/get_message_by_init', status: () => 200, body: async () => normal });
      },
      waitForTimeout: async () => {}, evaluate: async () => ({ url: 'https://www.douyin.com/chat?isPopup=1', needLogin: false, verify: false }) };
  };
  const alivePage = fakePage();
  const state = { running: false, stopRequested: false };
  const tasks = createInboxTasks({
    store: { getInbox: () => inbox, setInbox: v => { inbox = v; }, getLeads: () => leads, setLeads: v => { leads = v; }, log: (id, line) => logs.push(line) },
    taskState: state, setTask: patch => Object.assign(state, patch), failTask: error => ({ ok: false, error }),
    authorize: async () => true,
    getAlive: id => id === 'A' ? { page: alivePage, context: { newPage: async () => fakePage() } } : null,
    launchAccount: async (id, options) => { launched.push([id, options.headless]); return { page: fakePage() }; },
    closeAccount: async id => { closedAccounts.push(id); }, refreshLeadStatus: lead => { if (lead.replied) lead.status = 'replied'; },
    sleep: async () => {}, gapMs: () => 0, scanOptions: { timeoutMs: 300, settleMs: 0 }
  });
  const result = await tasks.inboxTask(['A', 'B']);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.results.map(r => [r.accountId, r.ok, r.firstScan]), [['A', true, true], ['B', true, true]]);
  assert.equal(closedPages.length, 1, 'A：只关掉新开的标签页，不动原窗口');
  assert.deepEqual(launched, [['B', true]]); assert.deepEqual(closedAccounts, ['B']);
  assert.equal(leads[0].replied, true); assert.equal(leads[0].status, 'replied');
  assert.equal(result.results[0].repliedLeads, 1);
  assert.ok(logs.some(line => line.includes('首次扫描已建立基线')));
  assert.equal(state.running, false);
});

test('任务：内嵌浏览器窗口正开着时跳过并说明原因；没有会话数据时如实返回', async () => {
  const state = { running: false, stopRequested: false };
  const tasks = createInboxTasks({
    store: { getInbox: () => ({ accounts: {} }), setInbox() {}, getLeads: () => [], setLeads() {}, log() {} },
    taskState: state, setTask: patch => Object.assign(state, patch), failTask: error => ({ ok: false, error }), authorize: async () => true,
    getAlive: id => id === 'E' ? { embedded: true, page: { isClosed: () => false } } : null,
    launchAccount: async () => ({ page: { isClosed: () => false, on() {}, off() {}, goto: async () => {}, waitForTimeout: async () => {}, evaluate: async () => ({ needLogin: true, verify: false }) } }),
    closeAccount: async () => {}, sleep: async () => {}, gapMs: () => 0, scanOptions: { timeoutMs: 300, settleMs: 0 }
  });
  const result = await tasks.inboxTask(['E', 'N']);
  assert.equal(result.results[0].code, 'INBOX_WINDOW_BUSY');
  assert.equal(result.results[1].code, 'LOGIN_REQUIRED');
  assert.match(result.status, /未完成 2 个/);
});
