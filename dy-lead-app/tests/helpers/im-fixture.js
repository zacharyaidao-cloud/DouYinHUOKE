'use strict';

// Synthetic protocol fixtures only. These helpers never access browser/network.
function varint(value) {
  let n = BigInt(value);
  if (n < 0n) n = BigInt.asUintN(64, n);
  const bytes = [];
  do { let byte = Number(n & 127n); n >>= 7n; bytes.push(n ? byte | 128 : byte); } while (n);
  return Buffer.from(bytes);
}
function int(field, value) { return Buffer.concat([varint(field * 8), varint(value)]); }
function data(field, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}
function join(...parts) { return Buffer.concat(parts.flat().filter(Boolean)); }
const defaults = Object.freeze({
  targetNumericUid: '700000000000000002', selfNumericUid: '700000000000000001',
  message: '合成协议测试\n保留空格 ', clientMessageId: 'synthetic-client-01',
  sequenceId: '9007199254740993', conversationShortId: '700000000000000003', inboxType: 1
});
function makeSendRequest(overrides = {}) {
  const o = { ...defaults, ...overrides };
  const conversation = o.conversationId === undefined
    ? `0:1:${[o.selfNumericUid, o.targetNumericUid].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).join(':')}` : o.conversationId;
  const content = o.content === undefined
    ? JSON.stringify({ aweType: 700, type: 0, richTextInfos: [], text: o.message }) : o.content;
  const send = o.sendBody === undefined ? join(
    data(1, conversation), int(2, o.conversationType ?? 1),
    o.conversationShortId === null ? null : int(3, o.conversationShortId),
    data(4, content), int(6, o.messageType ?? 7), data(8, o.clientMessageId), o.extraSend
  ) : o.sendBody;
  return join(int(1, o.command ?? 100), int(2, o.sequenceId), int(6, o.inboxType),
    data(8, o.body === undefined ? data(100, send) : o.body), o.extraEnvelope);
}
function makeSendResponse(overrides = {}) {
  const o = { ...defaults, status: 0, statusCode: 0, serverMessageId: '800000000000000001', ...overrides };
  const send = o.sendBody === undefined ? join(
    o.serverMessageId === null ? null : int(1, o.serverMessageId),
    o.status === null ? null : int(3, o.status),
    o.clientMessageId === null ? null : data(4, o.clientMessageId), o.extraSend
  ) : o.sendBody;
  return join(int(1, o.command ?? 100), int(2, o.sequenceId),
    o.statusCode === null ? null : int(3, o.statusCode), int(5, o.inboxType),
    o.body === null ? null : data(6, o.body === undefined ? data(100, send) : o.body),
    o.selfNumericUid === null ? null : int(13, o.selfNumericUid), o.extraEnvelope);
}
module.exports = { defaults, varint, int, data, join, makeSendRequest, makeSendResponse };
