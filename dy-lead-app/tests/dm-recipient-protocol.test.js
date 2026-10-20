'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseHistoryConversation } = require('../lib/dm-protocol');
const { observeDmHistory } = require('../lib/dm-history-observer');
const { defaults: d, message, request, response } = require('./helpers/im-history-fixture');
const { makeSendRequest } = require('./helpers/im-fixture');
const tick = () => new Promise(resolve => setImmediate(resolve));
const STRANGER = 'https://imapi.douyin.com/v1/stranger/get_messages';
const FOREIGN = '0:1:11:22';

test('history request identity exposes the 1:1 participants (cmd301) or only the short id (cmd1002), never a sec_uid', () => {
  const direct = parseHistoryConversation(request());
  assert.deepEqual(direct, { command: 301, conversationId: `0:1:${d.selfNumericUid}:${d.targetNumericUid}`,
    participants: [d.selfNumericUid, d.targetNumericUid], conversationShortId: d.conversationShortId });
  assert.deepEqual(parseHistoryConversation(request({ conversationId: FOREIGN })).participants, ['11', '22']);
  assert.deepEqual(parseHistoryConversation(request({ command: 1002 })),
    { command: 1002, conversationId: '', participants: null, conversationShortId: d.conversationShortId });
  for (const bytes of [request({ conversationId: '0:2:7000000001' }), request({ conversationId: '0:1:22:11' }), request({ conversationShortId: '0' }),
    request({ bodyField: 1002, command: 1002 }), makeSendRequest(), Buffer.from('{}'), Buffer.alloc(0)]) {
    assert.equal(parseHistoryConversation(bytes), null);
  }
});

function fixture({ targetNumericUid = d.targetNumericUid } = {}) {
  const page = new EventEmitter(), frame = { page: () => page }; let clock = 1000;
  page.mainFrame = () => frame; page.isClosed = () => false;
  const observer = observeDmHistory({ page, targetNumericUid, now: () => clock });
  const req = (patch = {}) => ({ url: () => patch.url || 'https://imapi.douyin.com/v1/message/get_by_conversation',
    method: () => 'POST', frame: () => frame, headers: () => ({ 'content-type': 'application/x-protobuf' }),
    postDataBuffer: () => patch.bytes || request(patch.payload) });
  const res = (item, payload = {}) => page.emit('response', { request: () => item, url: () => item.url(), status: () => 200,
    headers: () => ({ 'content-type': 'application/x-protobuf' }), body: async () => response(payload) });
  const send = (a = {}, b) => { const item = req(a); page.emit('request', item); if (b !== null) res(item, b); return item; };
  return { observer, send, setNow: value => { clock = value; } };
}
const state = f => f.observer.getRecipientEvidence().state;

test('only the target conversation\'s own request plus a valid response confirms the recipient', async () => {
  const f = fixture();
  assert.equal(state(f), 'none');
  const pending = f.send({}, null);
  assert.equal(state(f), 'none', 'a request without its response is not evidence');
  assert.equal(f.observer.getRecipientEvidence().targetRequests, 1);
  f.send({}, { messages: [] }); await tick();
  const evidence = f.observer.getRecipientEvidence();
  assert.equal(evidence.state, 'confirmed');
  assert.match(evidence.evidence, /conversation-participants-include-target/);
  for (const secret of [d.targetNumericUid, d.selfNumericUid, d.conversationShortId]) assert(!JSON.stringify(evidence).includes(secret));
  assert(pending);
});

test('any other conversation, unattributable request or capped traffic voids the protocol evidence', async () => {
  const foreign = fixture();
  foreign.send(); foreign.send({ payload: { conversationId: FOREIGN } }, null); await tick();
  assert.equal(state(foreign), 'conflict');
  assert.equal(foreign.observer.getRecipientEvidence().foreignRequests, 1);

  const garbage = fixture();
  garbage.send(); garbage.send({ bytes: Buffer.from('not protobuf') }, null); await tick();
  assert.equal(state(garbage), 'conflict');

  const capped = fixture();
  for (let i = 0; i < 25; i++) capped.send({}, null);
  assert.equal(capped.observer.getRecipientEvidence().overflow, true);
  assert.equal(state(capped), 'conflict');
});

test('cmd1002 is attributed through a target cmd301 short id or a response whose messages carry the target conversation', async () => {
  const known = fixture();
  known.send({}, null); known.send({ url: STRANGER, payload: { command: 1002 } }, { command: 1002 }); await tick();
  assert.equal(state(known), 'confirmed');

  const proven = fixture();
  proven.send({ url: STRANGER, payload: { command: 1002 } }, null);
  assert.equal(state(proven), 'conflict', 'an unknown short id is unattributed until its response proves it');
  proven.send({ url: STRANGER, payload: { command: 1002 } }, { command: 1002 }); await tick();
  assert.equal(proven.observer.getRecipientEvidence().unattributedRequests, 1, 'the first request still has no response');
  const resolved = fixture();
  resolved.send({ url: STRANGER, payload: { command: 1002 } }, { command: 1002, messages: [message({ sender: d.targetNumericUid })] }); await tick();
  assert.equal(state(resolved), 'confirmed');

  const empty = fixture();
  empty.send({ url: STRANGER, payload: { command: 1002 } }, { command: 1002, messages: [] }); await tick();
  assert.equal(state(empty), 'conflict', 'an empty stranger page proves nothing about its recipient');
});

test('without a numeric target UID there is no protocol check, and the result freezes at dispose', async () => {
  const unknown = fixture({ targetNumericUid: '' });
  unknown.send(); await tick();
  assert.equal(state(unknown), 'conflict', 'requests that cannot be attributed are never treated as the target');

  const frozen = fixture();
  frozen.send(); await tick();
  assert.equal(state(frozen), 'confirmed');
  frozen.observer.dispose();
  frozen.send({ payload: { conversationId: FOREIGN } }, null); await tick();
  assert.equal(state(frozen), 'confirmed', 'traffic after the pre-send freeze is not counted');

  const expired = fixture();
  expired.setNow(1000 + 30001);
  expired.send(); await tick();
  assert.equal(state(expired), 'none');
});
