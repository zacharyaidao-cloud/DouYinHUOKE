'use strict';

// Only exact, understood business messages change recipient or account handling.
// Unknown check codes/text remain generic rejections; never dump raw payloads.
const REJECTION_RULES = [
  { code: 'DM_ACCOUNT_FREQUENT', failureScope: 'account', reason: '平台提示私信操作频繁，已暂停任务，请稍后人工确认再执行',
    texts: ['操作频繁', '操作太频繁', '操作过于频繁', '操作频繁，请稍后再试', '操作过于频繁，请稍后再试', '私信频繁', '私信操作频繁', '私信发送频繁', '私信发送过于频繁，请稍后再试', '发送频繁', '发送消息过于频繁，请稍后再试', '发送消息太频繁，请稍后再试', '给陌生人发送消息过于频繁，请稍后再发送陌生人消息'] },
  { code: 'DM_ACCOUNT_DAILY_LIMIT', failureScope: 'account', reason: '平台提示今日陌生人私信已达上限，已暂停任务，请人工确认额度恢复后再执行',
    texts: ['今日陌生人私信达到上限', '今日陌生人私信已达到上限', '今日陌生人私信已达上限', '今日陌生人私信次数已达上限', '今日陌生人私信次数已达到上限', '今日向陌生人发送私信已达上限', '今日向陌生人发送私信次数已达上限', '今日给陌生人发送消息已达上限', '今日私信次数已达上限', '今日私信次数已达到上限', '今日发送消息次数已达上限'] },
  { code: 'DM_DUPLICATE_MESSAGE', reason: '平台提示重复消息，本次未重复发送', texts: ['重复发送', '消息重复', '请勿重复发送', '请不要重复发送', '请勿重复发送相同内容', '消息已发送，请勿重复发送'] },
  { code: 'DM_RECIPIENT_MUTUAL_ONLY', reason: '对方仅允许互关用户私信，当前账号不在接收范围', texts: ['对方设置了仅和他互关的人可发消息，由于你不在范围内，暂无法给对方发送消息'] },
  { code: 'DM_RECIPIENT_MESSAGE_LIMIT', reason: '向该用户发送的消息已达上限，需对方回复或互关后才能继续', texts: ['给对方发送的消息已达上限，对方回复或互关后才能继续发送消息'] }
];
function classifyRejection(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  const text = value.replace(/\s/g, '').replace(/[。！!]+$/, '');
  const rule = REJECTION_RULES.find(rule => rule.texts.includes(text));
  return rule ? { code: rule.code, reason: rule.reason, failureScope: rule.failureScope || 'recipient' } : null;
}
function classifyCheckMessage(value) {
  const plain = classifyRejection(value);
  if (plain) return plain;
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const data = JSON.parse(value);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    // The observed response's outer tips is empty. The actual platform notice
    // is status_msg.msg_content.tips; arbitrary text fields are not feedback.
    const status = data.status_msg;
    const nested = status && !Array.isArray(status) && status.msg_type === 1
      && status.msg_content && !Array.isArray(status.msg_content) ? status.msg_content.tips : undefined;
    const matches = [data.tips, nested].map(classifyRejection).filter(Boolean);
    const result = matches.find(row => row.failureScope === 'account') || matches[0];
    if (!result) return null;
    return { ...result, ...(Number.isSafeInteger(data.status_code) && data.status_code >= 0 && data.status_code <= 0x7fffffff
      ? { businessStatusCode: data.status_code } : {}) };
  } catch (_) { return null; }
}
module.exports = { REJECTION_RULES, classifyRejection, classifyCheckMessage };
