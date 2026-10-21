'use strict';
/**
 * 私信归集 · 合并扫描结果、未读计数、关联线索“已回复”（纯函数，便于测试）。
 *
 * 存储结构 inbox.json：{ accounts: { [accountId]: { selfUid, baselineAt, scannedAt, conversations: { [对方UID]: 会话 } } } }
 *   会话：{ convId, inbox, peerUid, peerSecUid, nickname, followStatus, followerStatus, firstSeenAt, lastAt, lastPeerAt, unread, messages[] }
 *   消息：{ id, from: 'me'|'peer', kind: text|image|share|other|system, text, at(毫秒) }
 * 规则：
 *   - 按消息 ID 去重，每个会话保留最近 MAX_MESSAGES 条
 *   - 某账号第一次扫描只建基线：已有的对方消息存下来但不算未读（不把账号原有的聊天全标成新消息）
 *   - 之后出现的、没见过的对方非系统消息 → 未读 +1
 *   - 线索“已回复”：会话对方是我们私信成功过的线索，且对方的非系统消息晚于我们的私信时间（与基线无关，首次扫描也能认出）
 */
const MAX_MESSAGES = 30;
const SKIP_KINDS = new Set(['system']);

const beijingMs = value => {
  const text = String(value || '').trim();
  if (!text) return 0;
  const ms = Date.parse(text.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(text) ? '' : '+08:00'));
  return Number.isFinite(ms) ? ms : 0;
};
const beijingText = ms => new Date(ms + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);

function mergeScan(inbox, { accountId, scan, now = Date.now() }) {
  const store = inbox && typeof inbox === 'object' && inbox.accounts ? inbox : { accounts: {} };
  const key = String(accountId);
  const account = store.accounts[key] || { conversations: {} };
  const firstScan = !account.baselineAt;
  const selfUid = String(scan.selfUid || account.selfUid || '');
  const users = new Map((scan.users || []).map(u => [String(u.uid), u]));
  const newPeerMessages = [];
  for (const conv of scan.conversations || []) {
    const peer = (conv.participants || []).find(p => String(p.uid) !== selfUid);
    if (!peer || !peer.uid) continue;
    const peerUid = String(peer.uid);
    const user = users.get(peerUid) || {};
    const saved = account.conversations[peerUid] || { firstSeenAt: now, unread: 0, messages: [] };
    const seen = new Set(saved.messages.map(m => m.id));
    for (const m of conv.messages || []) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      const message = { id: String(m.id), from: String(m.senderUid) === selfUid ? 'me' : 'peer', kind: m.kind, text: m.text, at: Number(m.createdMs) || 0 };
      saved.messages.push(message);
      if (message.from === 'peer' && !SKIP_KINDS.has(message.kind) && !firstScan) {
        saved.unread = (Number(saved.unread) || 0) + 1;
        newPeerMessages.push({ accountId: key, peerUid, peerSecUid: peer.secUid || user.secUid || '', nickname: user.nickname || saved.nickname || '', ...message });
      }
    }
    saved.messages.sort((a, b) => a.at - b.at);
    if (saved.messages.length > MAX_MESSAGES) saved.messages = saved.messages.slice(-MAX_MESSAGES);
    const peerMessages = saved.messages.filter(m => m.from === 'peer' && !SKIP_KINDS.has(m.kind));
    Object.assign(saved, {
      convId: conv.convId, inbox: conv.inbox || saved.inbox || '', peerUid, peerSecUid: peer.secUid || user.secUid || saved.peerSecUid || '',
      nickname: user.nickname || saved.nickname || '', followStatus: user.followStatus ?? saved.followStatus ?? null, followerStatus: user.followerStatus ?? saved.followerStatus ?? null,
      lastAt: saved.messages.length ? saved.messages[saved.messages.length - 1].at : saved.lastAt || 0,
      lastPeerAt: peerMessages.length ? peerMessages[peerMessages.length - 1].at : saved.lastPeerAt || 0
    });
    account.conversations[peerUid] = saved;
  }
  Object.assign(account, { selfUid, scannedAt: now, baselineAt: account.baselineAt || now, lastScanCount: (scan.conversations || []).length });
  store.accounts[key] = account;
  return { inbox: store, newPeerMessages, firstScan };
}

/**
 * 把会话里对方的回复关联到线索：返回被新标记“已回复”的线索数。直接修改 leads。
 * 只认我们私信成功过（dmState=confirmed_success 或 dmCount>0）的线索，且回复时间晚于私信时间。
 */
function linkLeadReplies(leads, inbox) {
  const bySecUid = new Map();
  for (const [accountId, account] of Object.entries((inbox && inbox.accounts) || {})) {
    for (const conv of Object.values(account.conversations || {})) {
      if (!conv.peerSecUid) continue;
      const list = bySecUid.get(conv.peerSecUid) || [];
      list.push({ accountId, conv });
      bySecUid.set(conv.peerSecUid, list);
    }
  }
  let marked = 0;
  for (const lead of leads) {
    if (!lead || lead.replied || !lead.uid || !bySecUid.has(lead.uid)) continue;
    const contacted = lead.dmState === 'confirmed_success' || Number(lead.dmCount) > 0;
    if (!contacted) continue;
    const dmAt = beijingMs(lead.dmLastAt || lead.dmSentAt || lead.dmAt);
    let first = null;
    for (const { accountId, conv } of bySecUid.get(lead.uid)) {
      for (const m of conv.messages || []) {
        if (m.from !== 'peer' || SKIP_KINDS.has(m.kind) || !m.at || (dmAt && m.at <= dmAt)) continue;
        if (!first || m.at < first.at) first = { ...m, accountId };
      }
    }
    if (!first) continue;
    Object.assign(lead, { replied: true, repliedAt: beijingText(first.at), replyText: String(first.text || '').slice(0, 200), replyAccountId: first.accountId });
    marked++;
  }
  return marked;
}

/** 汇总给界面：所有账号的会话按“有未读 → 对方最近消息时间”排序 */
function listConversations(inbox, { accounts = [], leadsBySecUid = new Map(), onlyPeer = true } = {}) {
  const names = new Map(accounts.map(a => [String(a.id), a.name || String(a.id)]));
  const rows = [];
  for (const [accountId, account] of Object.entries((inbox && inbox.accounts) || {})) {
    for (const conv of Object.values(account.conversations || {})) {
      const peerMessages = (conv.messages || []).filter(m => m.from === 'peer' && !SKIP_KINDS.has(m.kind));
      if (onlyPeer && !peerMessages.length) continue;
      const lead = leadsBySecUid.get(conv.peerSecUid) || null;
      rows.push({
        accountId, accountName: names.get(accountId) || accountId, peerUid: conv.peerUid, peerSecUid: conv.peerSecUid, nickname: conv.nickname || '',
        inbox: conv.inbox, unread: Number(conv.unread) || 0, lastAt: conv.lastAt || 0, lastPeerAt: conv.lastPeerAt || 0,
        followerStatus: conv.followerStatus, messages: (conv.messages || []).slice(-8),
        lead: lead ? { id: lead.id, nickname: lead.nickname, replied: !!lead.replied, dmLastAt: lead.dmLastAt || '' } : null
      });
    }
  }
  return rows.sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.lastPeerAt - a.lastPeerAt);
}

function markRead(inbox, accountId, peerUid) {
  const conv = inbox && inbox.accounts && inbox.accounts[String(accountId)] && inbox.accounts[String(accountId)].conversations[String(peerUid)];
  if (!conv) return false;
  conv.unread = 0;
  return true;
}

module.exports = { mergeScan, linkLeadReplies, listConversations, markRead, beijingMs, beijingText, MAX_MESSAGES };
