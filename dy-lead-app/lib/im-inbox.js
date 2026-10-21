'use strict';
/**
 * 私信归集 · 解析抖音网页版私信页自己请求到的数据（只读，不构造任何请求）。
 * 结构依据 2026-10-22 测试号探测，见 使用文档/正确流程规格 第 7 节。
 *
 *   get_message_by_init（protobuf，cmd 2043）：根 2 = 收件箱（10001 普通 / 10002 陌生人），根 13 = 本账号数字 UID，
 *     根 6 → 2043 → 字段 1（每个会话）：
 *       1 会话信息：1 会话 ID（0:1:对方UID:本人UID）、2 短 ID、6 参与者（1 数字 UID、5 sec_uid）
 *       2 消息（可多条）：3 服务端消息 ID、6 类型、7 发送者数字 UID、8 内容 JSON、10 发送时间（毫秒）、14 发送者 sec_uid
 *     payload 2 = has_more，3 = 下一页游标
 *   /aweme/v1/web/im/user/info/（JSON）：data[] 的 uid / sec_uid / nickname / follow_status / follower_status
 */
const MAX_BYTES = 8 * 1024 * 1024;

function readFields(buf, budget = { fields: 200000 }) {
  const out = [];
  let i = 0;
  const varint = () => {
    let result = 0n, shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint');
      const byte = buf[i++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
  };
  while (i < buf.length) {
    if (--budget.fields < 0) throw new Error('too many fields');
    const key = varint(), field = Number(key >> 3n), wire = Number(key & 7n);
    if (field <= 0) throw new Error('invalid field');
    if (wire === 0) out.push({ field, value: varint() });
    else if (wire === 2) {
      const len = Number(varint());
      if (len < 0 || i + len > buf.length) throw new Error('truncated bytes');
      out.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('unsupported wire type ' + wire);
  }
  return out;
}
const one = (list, field) => list.find(item => item.field === field);
const all = (list, field) => list.filter(item => item.field === field);
const text = item => item && item.bytes ? item.bytes.toString('utf8') : '';
const number = item => item && item.value !== undefined ? item.value.toString() : '';
const nested = (list, field, budget) => { const item = one(list, field); return item && item.bytes ? readFields(item.bytes, budget) : []; };

// 消息类型：7 文本；1 系统提示（如“对方回复或关注你之前，只能发送一条文字消息”）；其余为图片、表情、分享等
function describeContent(type, raw) {
  let content = null;
  try { content = JSON.parse(raw); } catch (_) { content = null; }
  const value = content && typeof content === 'object' ? content : {};
  if (type === '1' || value.tips) return { kind: 'system', text: String(value.tips || '').replace(/\{\{\d+\}\}/g, '').slice(0, 500) };
  const body = typeof value.text === 'string' ? value.text.trim() : '';
  if (body) return { kind: 'text', text: body.slice(0, 2000) };
  if (value.url || value.resource_url || /image|pic/i.test(String(value.aweType || ''))) return { kind: 'image', text: '[图片]' };
  if (value.display_name || value.item_id || value.aweme_id || value.related_share_video) return { kind: 'share', text: '[分享]' };
  return { kind: 'other', text: '[非文字消息]' };
}

/** 解析一份 get_message_by_init 响应；不认识的结构返回 null（不猜） */
function parseInitResponse(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buf.length || buf.length > MAX_BYTES) return null;
  try {
    const budget = { fields: 400000 };
    const root = readFields(buf, budget);
    if (number(one(root, 1)) !== '2043') return null;
    const selfUid = number(one(root, 13));
    const inbox = number(one(root, 2));
    const payload = nested(nested(root, 6, budget), 2043, budget);
    if (!payload.length) return null;
    const conversations = [];
    for (const item of all(payload, 1)) {
      const parts = readFields(item.bytes, budget);
      const info = nested(parts, 1, budget);
      const convId = text(one(info, 1));
      if (!convId) continue;
      const participants = all(nested(info, 6, budget), 1).map(p => { const f = readFields(p.bytes, budget); return { uid: number(one(f, 1)), secUid: text(one(f, 5)) }; })
        .filter(p => p.uid);
      const messages = all(parts, 2).map(m => {
        const f = readFields(m.bytes, budget);
        const type = number(one(f, 6));
        const { kind, text: body } = describeContent(type, text(one(f, 8)));
        return { id: number(one(f, 3)), type, kind, text: body, senderUid: number(one(f, 7)), senderSecUid: text(one(f, 14)), createdMs: Number(number(one(f, 10))) || 0 };
      }).filter(m => m.id && m.senderUid);
      conversations.push({ convId, shortId: number(one(info, 2)), participants, messages });
    }
    return { selfUid, inbox, inboxLabel: inbox === '10002' ? 'stranger' : inbox === '10001' ? 'normal' : inbox, hasMore: number(one(payload, 2)) === '1', cursor: number(one(payload, 3)), conversations };
  } catch (_) { return null; }
}

/** 解析 im/user/info 响应：uid → { uid, secUid, nickname, followStatus, followerStatus } */
function parseUserInfo(json) {
  const list = json && Array.isArray(json.data) ? json.data : [];
  const users = [];
  for (const u of list) {
    if (!u || typeof u !== 'object' || !u.uid) continue;
    users.push({ uid: String(u.uid), secUid: String(u.sec_uid || ''), nickname: String(u.nickname || ''),
      followStatus: Number(u.follow_status) || 0, followerStatus: Number(u.follower_status) || 0 });
  }
  return users;
}

module.exports = { parseInitResponse, parseUserInfo, describeContent, readFields };
