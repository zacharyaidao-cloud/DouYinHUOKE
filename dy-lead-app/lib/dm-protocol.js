'use strict';

// Read-only allowlist decoder for the official web IM protobuf send protocol.
// Source/version evidence: doc-tools/handoff-v2214/im-protocol-research.txt.
// This module has no transport, credentials, history lookup, or send capability.
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { classifyCheckMessage } = require('./dm-rejection');
const MAX_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 16 * 1024;
const MAX_FIELDS = 1024;
const MAX_I64 = (1n << 63n) - 1n;
const decoder = new TextDecoder('utf-8', { fatal: true });
const records = new WeakSet();
const historyRecords = new WeakSet();
const MAX_HISTORY_BYTES = 512 * 1024;
const requestSchema = { 1: 'v', 2: 'v', 6: 'v', 8: 'b' };
const responseSchema = { 1: 'v', 2: 'v', 3: 'v', 5: 'v', 6: 'b', 13: 'v' };
const sendRequestSchema = {
  1: 's', 2: 'v', 3: 'v', 4: 's', 6: 'v', 8: 's',
  9: 'reject', 11: 'reject', 14: 'v', 33: 'v', 50: 'reject', 51: 'reject', 52: 'reject'
};
const sendResponseSchema = { 1: 'v', 3: 'v', 4: 's', 5: 'v', 6: 's', 7: 's', 8: 'v', 10: 'b' };

function inputBytes(value, maxBytes = MAX_BYTES) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maxBytes) return null;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function varint(bytes, cursor) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (cursor.at >= bytes.length) throw new Error('truncated');
    const byte = bytes[cursor.at++];
    if (i === 9 && byte > 1) throw new Error('overflow');
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) {
      if (i > 0 && byte === 0) throw new Error('noncanonical');
      return value;
    }
  }
  throw new Error('overflow');
}

// Only allowlisted fields are materialized. Unknown length-delimited values,
// including token/ticket/header maps, are skipped without UTF-8 decoding.
function fields(bytes, schema, budget, depth = 0) {
  if (depth > 4) throw new Error('depth');
  const out = new Map(), cursor = { at: 0 };
  while (cursor.at < bytes.length) {
    if (++budget.count > (budget.limit || MAX_FIELDS)) throw new Error('fields');
    const tag = varint(bytes, cursor);
    if (tag > 0xffffffffn || tag < 8n) throw new Error('tag');
    const number = Number(tag >> 3n), wire = Number(tag & 7n), kind = schema[number];
    if (kind === 'reject' || kind && kind !== 'rb' && out.has(number)) throw new Error('ambiguous');
    if (kind && wire !== (kind === 'v' ? 0 : 2)) throw new Error('wire');
    let value;
    if (wire === 0) value = varint(bytes, cursor);
    else if (wire === 2) {
      const size = varint(bytes, cursor);
      if (size > BigInt(bytes.length - cursor.at)) throw new Error('length');
      const end = cursor.at + Number(size);
      if (kind) value = bytes.subarray(cursor.at, end);
      cursor.at = end;
    } else if (wire === 1 || wire === 5) {
      cursor.at += wire === 1 ? 8 : 4;
      if (cursor.at > bytes.length) throw new Error('truncated');
    } else throw new Error('wire');
    if (kind === 's') value = decoder.decode(value);
    if (kind === 'rb') {
      if (!out.has(number)) out.set(number, []);
      out.get(number).push(value);
    } else if (kind) out.set(number, value);
  }
  return out;
}

function nested(parent, field, schema, budget, depth) {
  return parent.has(field) ? fields(parent.get(field), schema, budget, depth) : null;
}
function positive(value) { return typeof value === 'bigint' && value > 0n && value <= MAX_I64; }
function uid(value) {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= MAX_I64 ? value : '';
}
function textHash(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function clientId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value); }

function plainText(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) return null;
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { return null; }
  // The official content builder uses JSON.stringify. Round-trip equality also
  // rejects duplicate keys, including escaped duplicates, without last-wins.
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || JSON.stringify(parsed) !== content) return null;
  const keys = Object.keys(parsed);
  if (typeof parsed.text !== 'string') return null;
  if (keys.length === 1 && keys[0] === 'text') return parsed.text;
  if (keys.some(key => !['aweType', 'type', 'richTextInfos', 'text'].includes(key))) return null;
  if (parsed.aweType !== 700 || parsed.type !== 0) return null;
  if ('richTextInfos' in parsed && (!Array.isArray(parsed.richTextInfos) || parsed.richTextInfos.length)) return null;
  return parsed.text;
}

function parseSendRequest(value, options = {}) {
  try {
    const bytes = inputBytes(value), target = uid(options.targetNumericUid);
    if (!bytes || !target || typeof options.message !== 'string' || !options.message.length
      || Buffer.byteLength(options.message, 'utf8') > MAX_CONTENT_BYTES) return null;
    const self = options.selfNumericUid === undefined ? '' : uid(options.selfNumericUid);
    if (options.selfNumericUid !== undefined && (!self || self === target)) return null;
    const budget = { count: 0 }, envelope = fields(bytes, requestSchema, budget);
    if (envelope.get(1) !== 100n || !positive(envelope.get(2))) return null;
    if (envelope.has(6) && envelope.get(6) > 0x7fffffffn) return null;
    const body = nested(envelope, 8, { 100: 'b' }, budget, 1);
    const send = body && nested(body, 100, sendRequestSchema, budget, 2);
    if (!send || send.get(2) !== 1n || send.get(6) !== 7n || !clientId(send.get(8))) return null;
    if (send.has(3) && !positive(send.get(3)) || send.has(14) && send.get(14) !== 0n) return null;
    const conversation = send.get(1), match = typeof conversation === 'string'
      && /^0:1:([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(conversation);
    if (!match || !uid(match[1]) || !uid(match[2]) || BigInt(match[1]) >= BigInt(match[2])) return null;
    const other = match[1] === target ? match[2] : match[2] === target ? match[1] : '';
    if (!other || self && other !== self || send.has(33) && send.get(33).toString() !== target) return null;
    const text = plainText(send.get(4));
    if (text === null || text !== options.message) return null;
    const record = Object.freeze({
      sequenceId: envelope.get(2).toString(), clientMessageId: send.get(8),
      conversationId: conversation, conversationShortId: send.has(3) ? send.get(3).toString() : '',
      targetNumericUid: target, otherParticipantUid: other, senderVerified: Boolean(self),
      inboxType: envelope.has(6) ? Number(envelope.get(6)) : 0,
      messageHash: textHash(text)
    });
    records.add(record);
    return record;
  } catch (_) { return null; }
}

function parseSendResponse(value, record) {
  try {
    const bytes = inputBytes(value);
    if (!bytes || !record || !records.has(record)) return null;
    const budget = { count: 0 }, envelope = fields(bytes, responseSchema, budget);
    if (envelope.get(1) !== 100n || !positive(envelope.get(2))
      || envelope.get(2).toString() !== record.sequenceId) return null;
    // protobuf permits omitted scalar zero, but it never supplies the mandatory
    // identity/body/server-id evidence below. Outer failures may be retried.
    if (envelope.has(3) && envelope.get(3) !== 0n) return null;
    if (envelope.has(5) && envelope.get(5) !== BigInt(record.inboxType)) return null;
    if (envelope.has(13)) {
      if (!positive(envelope.get(13)) || envelope.get(13).toString() !== record.otherParticipantUid) return null;
    } else if (!record.senderVerified) return null;
    const body = nested(envelope, 6, { 100: 'b' }, budget, 1);
    const send = body && nested(body, 100, sendResponseSchema, budget, 2);
    if (!send || send.get(4) !== record.clientMessageId) return null;
    if (send.has(8) && send.get(8) !== 0n) return null; // async result is not final
    if (send.has(7) && send.get(7) !== '') {
      const filtered = plainText(send.get(7));
      if (filtered === null || textHash(filtered) !== record.messageHash) return null;
    }
    if (send.has(10)) {
      const conversation = fields(send.get(10), { 1: 's', 2: 'v', 3: 'v', 9: 'v' }, budget, 3);
      if (conversation.has(1) && conversation.get(1) !== record.conversationId
        || conversation.has(2) && record.conversationShortId && conversation.get(2).toString() !== record.conversationShortId
        || conversation.has(3) && conversation.get(3) !== 1n
        || conversation.has(9) && conversation.get(9) !== BigInt(record.inboxType)) return null;
    }
    const status = send.has(3) ? send.get(3) : 0n;
    if (status === 0n) {
      if (!positive(send.get(1))) return null;
      return {
        state: 'confirmed_success', reason: '服务端已接受本次私信',
        evidence: 'im-protobuf:cmd=100;status=0;send=0;matched-request+sender+client;server-id-present'
      };
    }
    const failures = {
      1: '服务端拒绝本次私信：发送者不在会话中',
      2: '服务端拒绝本次私信：会话检查未通过',
      3: '服务端拒绝本次私信：消息检查未通过',
      4: '服务端未向目标正常发送本次私信：仅自己可见'
    };
    if (!Object.hasOwn(failures, status.toString())) return null;
    const detail = status === 3n ? classifyCheckMessage(send.get(6)) : null;
    const checkCode = positive(send.get(5)) ? send.get(5).toString() : '';
    return {
      state: 'confirmed_failure', reason: (detail ? `[${detail.code}] ${detail.reason}` : failures[status.toString()]) + (checkCode ? `（检查码：${checkCode}）` : ''),
      evidence: `im-protobuf:cmd=100;status=0;send=${status};matched-request+sender+client` + (checkCode ? `;check=${checkCode}` : '')
        + (detail?.businessStatusCode != null ? `;business=${detail.businessStatusCode}` : ''),
      ...(detail ? { failureScope: detail.failureScope, failureCode: detail.code } : {})
    };
  } catch (_) { return null; }
}

// Passive history schema comes from the same pinned official SDK. See
// doc-tools/im-history-research for field evidence; no transport is provided.
// A history message proves a prior outgoing text record, never a new send or
// receipt delivery. Empty/partial/deleted/permission-limited history stays unknown.
function conversationParticipants(value, target) {
  const match = typeof value === 'string' && /^0:1:([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(value);
  if (!match || !uid(match[1]) || !uid(match[2]) || BigInt(match[1]) >= BigInt(match[2])) return '';
  return match[1] === target ? match[2] : match[2] === target ? match[1] : '';
}

function parseHistoryRequest(value, options = {}) {
  try {
    const bytes = inputBytes(value), target = uid(options.targetNumericUid);
    const self = options.selfNumericUid === undefined ? '' : uid(options.selfNumericUid);
    if (!bytes || !target || options.selfNumericUid !== undefined && (!self || self === target)) return null;
    const budget = { count: 0 }, envelope = fields(bytes, requestSchema, budget);
    const command = envelope.get(1);
    if (![301n, 1002n].includes(command) || !positive(envelope.get(2)) || envelope.has(6) && envelope.get(6) > 0x7fffffffn) return null;
    const bodyField = command === 301n ? 301 : 1001;
    const body = nested(envelope, 8, { [bodyField]: 'b' }, budget, 1);
    const query = body && nested(body, bodyField, command === 301n
      ? { 1: 's', 2: 'v', 3: 'v', 4: 'v', 5: 'v', 6: 'v', 7: 'v', 8: 'reject', 9: 'v', 20: 'reject' }
      : { 1: 'v', 2: 'v' }, budget, 2);
    if (!query) return null;
    let conversationId = '', other = '', shortId;
    if (command === 301n) {
      conversationId = query.get(1); other = conversationParticipants(conversationId, target); shortId = query.get(3);
      if (!other || query.get(2) !== 1n || self && other !== self || query.has(9) && query.get(9) !== 0n) return null;
      if (query.has(4) && ![1n, 2n].includes(query.get(4)) || query.has(6) && (!positive(query.get(6)) || query.get(6) > 200n)) return null;
      if (query.has(5) && query.get(5) > MAX_I64 || query.has(7) && query.get(7) > MAX_I64) return null;
    } else { shortId = query.get(1); if (query.has(2) && ![0n, 1n].includes(query.get(2))) return null; }
    if (!positive(shortId)) return null;
    const record = Object.freeze({ command: Number(command), bodyField,
      sequenceId: envelope.get(2).toString(), inboxType: envelope.has(6) ? Number(envelope.get(6)) : 0,
      targetNumericUid: target, selfNumericUid: self, otherParticipantUid: other,
      conversationId, conversationShortId: shortId.toString(),
      fromLatestAvailable: command === 301n && query.get(5) === MAX_I64 && (!query.has(4) || query.get(4) === 1n) && !query.has(7) });
    historyRecords.add(record); return record;
  } catch (_) { return null; }
}

// Target-independent identity of a page history request: which conversation the
// page itself asked for. Used only to tell "the opened chat's own history" from
// requests for other conversations; it never establishes history by itself.
// cmd301 carries the 1:1 conversation id "0:1:<uidA>:<uidB>" (both participants'
// numeric UIDs). cmd1002 carries only the conversation short id. No sec_uid
// appears in either request.
function parseHistoryConversation(value) {
  try {
    const bytes = inputBytes(value);
    if (!bytes) return null;
    const budget = { count: 0 }, envelope = fields(bytes, requestSchema, budget);
    const command = envelope.get(1);
    if (![301n, 1002n].includes(command) || !positive(envelope.get(2))) return null;
    const bodyField = command === 301n ? 301 : 1001;
    const body = nested(envelope, 8, { [bodyField]: 'b' }, budget, 1);
    const query = body && nested(body, bodyField, command === 301n ? { 1: 's', 3: 'v' } : { 1: 'v' }, budget, 2);
    if (!query) return null;
    const shortId = query.get(command === 301n ? 3 : 1);
    if (!positive(shortId)) return null;
    if (command === 1002n) return { command: 1002, conversationId: '', participants: null, conversationShortId: shortId.toString() };
    const conversationId = query.get(1);
    const match = typeof conversationId === 'string' && /^0:1:([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(conversationId);
    if (!match || !uid(match[1]) || !uid(match[2]) || BigInt(match[1]) >= BigInt(match[2])) return null;
    return { command: 301, conversationId, participants: [match[1], match[2]], conversationShortId: shortId.toString() };
  } catch (_) { return null; }
}

function parseHistoryResponse(value, record) {
  try {
    const bytes = inputBytes(value, MAX_HISTORY_BYTES);
    if (!bytes || !record || !historyRecords.has(record)) return null;
    const budget = { count: 0, limit: 8192 }, envelope = fields(bytes, responseSchema, budget);
    if (envelope.get(1) !== BigInt(record.command) || !positive(envelope.get(2)) || envelope.get(2).toString() !== record.sequenceId
      || envelope.has(3) && envelope.get(3) !== 0n || envelope.has(5) && envelope.get(5) !== BigInt(record.inboxType)) return null;
    if (envelope.has(13) && !positive(envelope.get(13))) return null;
    const sender = envelope.has(13) ? envelope.get(13).toString() : record.selfNumericUid;
    if (!sender || sender === record.targetNumericUid || record.selfNumericUid && sender !== record.selfNumericUid
      || record.otherParticipantUid && sender !== record.otherParticipantUid) return null;
    const body = nested(envelope, 6, { [record.bodyField]: 'b' }, budget, 1);
    const history = body && nested(body, record.bodyField, record.command === 301
      ? { 1: 'rb', 2: 'v', 3: 'v', 4: 'reject' } : { 3: 'rb' }, budget, 2);
    if (!history || record.command === 301 && history.has(3) && ![0n, 1n].includes(history.get(3))) return null;
    const messages = history.get(record.command === 301 ? 1 : 3) || [];
    if (messages.length > 200) return null;
    let outgoingTextCount = 0, otherMessageCount = 0, unclassifiedOutgoingCount = 0, indexedMessages = true;
    let latestOutgoingAt = null, allOutgoingTimesKnown = true;
    for (const bytes of messages) {
      const item = fields(bytes, { 1: 's', 2: 'v', 3: 'v', 4: 'v', 5: 'v', 6: 'v', 7: 'v', 8: 's', 10: 'v', 12: 'v', 20: 'v', 50: 'reject', 51: 'reject' }, budget, 3);
      if (item.get(2) !== 1n || !positive(item.get(3)) || !positive(item.get(5)) || !positive(item.get(7))
        || item.get(5).toString() !== record.conversationShortId
        || record.conversationId && item.get(1) !== record.conversationId
        || conversationParticipants(item.get(1), record.targetNumericUid) !== sender || item.has(20) && item.get(20) !== 0n) return null;
      if (![sender, record.targetNumericUid].includes(item.get(7).toString())) return null;
      if (!positive(item.get(4))) indexedMessages = false;
      if (item.get(7).toString() === sender && item.get(6) === 7n && plainText(item.get(8)) !== null) {
        outgoingTextCount++;
        // Official web SDK constructs new Date(MessageBody.create_time) and
        // subtracts it from Date.now(): this field is milliseconds, unlike
        // separate property-item timestamps. Invalid/future units stay unknown.
        const time = item.get(10);
        if (positive(time) && time >= 946684800000n && time <= BigInt(Number.MAX_SAFE_INTEGER)
          && time <= BigInt(Date.now() + 300000)) latestOutgoingAt = Math.max(latestOutgoingAt || 0, Number(time));
        else allOutgoingTimesKnown = false;
      }
      else { otherMessageCount++; if (item.get(7).toString() === sender) unclassifiedOutgoingCount++; }
    }
    const complete = record.fromLatestAvailable && history.has(3) && history.get(3) === 0n && !unclassifiedOutgoingCount && indexedMessages;
    return { state: outgoingTextCount ? 'already_sent' : complete ? 'no_outbound' : 'unknown',
      // An older/partial page cannot establish the latest outgoing time for a
      // repeat cooldown even when it proves some historical outgoing message.
      lastSentAt: complete && allOutgoingTimesKnown ? latestOutgoingAt : null,
      reason: outgoingTextCount ? '本次网页历史响应存在当前账号向目标发送的文本记录'
        : complete ? '已核对本次接口可见的完整历史，未见本人发出的消息' : '本次历史未见可确认的本人文本记录，不能断言从未私信',
      evidence: outgoingTextCount ? 'im-protobuf-history:matched-request+conversation+sender;positive-server-id;outgoing-text-present'
        : complete ? 'im-protobuf-history:cmd301;older-from-max-index;explicit-end;no-prior-outbound-in-available-history' : '',
      observedMessages: messages.length, outgoingTextCount, otherMessageCount, unclassifiedOutgoingCount,
      hasMore: record.command === 301 ? history.has(3) ? history.get(3) === 1n : false : null,
      cursorPresent: record.command === 301 && history.has(2), protocol: record.command === 301 ? 'im-history-cmd301' : 'im-history-cmd1002',
      source: record.command === 301 ? 'im-history-cmd301' : 'im-history-cmd1002', complete,
      completeHistoryProven: complete };
  } catch (_) { return null; }
}

module.exports = { parseSendRequest, parseSendResponse, parseHistoryRequest, parseHistoryConversation, parseHistoryResponse, MAX_BYTES, MAX_HISTORY_BYTES };
