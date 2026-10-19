'use strict';
// Synthetic encoding of the pinned official cmd301/body301 and cmd1002/body1001
// schemas, documented in doc-tools/im-history-research/im-history-protocol-review.txt.
const { defaults: d, int, data, join } = require('./im-fixture');
const defaults = { ...d, command: 301, anchor: '9223372036854775807', direction: 1,
  conversationId: `0:1:${d.selfNumericUid}:${d.targetNumericUid}` };
function message(patch = {}) {
  const p = { ...defaults, sender: d.selfNumericUid, messageType: 7, serverId: '800000000000000007', index: '800000000000000005',
    content: JSON.stringify({ text: '合成旧消息，不得输出日志' }), ...patch };
  return join(data(1, p.conversationId), int(2, p.conversationType ?? 1), int(3, p.serverId), p.index === null ? null : int(4, p.index), int(5, p.conversationShortId),
    int(6, p.messageType), int(7, p.sender), data(8, p.content), p.createTime === undefined ? null : int(10, p.createTime), p.extra);
}
function request(patch = {}) {
  const p = { ...defaults, ...patch }, field = p.command === 1002 ? 1001 : 301;
  const query = p.query === undefined ? p.command === 1002
    ? join(int(1, p.conversationShortId), int(2, 0), p.extraQuery)
    : join(data(1, p.conversationId), int(2, 1), int(3, p.conversationShortId), int(4, p.direction),
      p.anchor === null ? null : int(5, p.anchor), int(6, 20), p.extraQuery) : p.query;
  return join(int(1, p.command), int(2, p.sequenceId), int(6, p.inboxType), data(8, data(p.bodyField ?? field, query)), p.extraEnvelope);
}
function response(patch = {}) {
  const p = { ...defaults, messages: [message()], hasMore: false, status: 0, ...patch }, field = p.command === 1002 ? 1001 : 301;
  const history = p.history === undefined ? join(p.messages.map(bytes => data(p.command === 1002 ? 3 : 1, bytes)),
    p.command === 1002 || p.hasMore === null ? null : int(3, p.hasMore ? 1 : 0),
    p.command === 1002 ? null : int(2, 0), p.extraHistory) : p.history;
  return join(int(1, p.command), int(2, p.sequenceId), int(3, p.status), int(5, p.inboxType),
    data(6, data(p.bodyField ?? field, history)), p.selfNumericUid === null ? null : int(13, p.selfNumericUid), p.extraEnvelope);
}
module.exports = { defaults, message, request, response, int, data, join };
