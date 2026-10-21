'use strict';
/**
 * 核心流程 · 私信归集（只读）
 *
 * 打开账号的私信页 chat?isPopup=1，被动读取页面自己请求到的初始同步（get_message_by_init）与对方资料（im/user/info）。
 * 不点击会话、不输入、不发送；页面不是私信页（掉登录 / 验证）时如实返回，不猜。
 * 实测：打开后约 4–8 秒内到齐两批初始同步（普通 10001 / 陌生人 10002）。
 */
const { parseInitResponse, parseUserInfo } = require('../lib/im-inbox');

const CHAT_URL = 'https://www.douyin.com/chat?isPopup=1';
const INIT_PATH = '/v1/message/get_message_by_init';
const USER_INFO_PATH = '/aweme/v1/web/im/user/info/';

async function scanInbox(page, { timeoutMs = 25000, settleMs = 2500, checkStopped = () => {}, trace = { step() {} } } = {}) {
  const batches = [], users = new Map(), pending = new Set();
  const onResponse = response => {
    let url;
    try { url = new URL(response.url()); } catch (_) { return; }
    const task = (async () => {
      if (/(^|\.)imapi\.douyin\.com$/.test(url.hostname) && url.pathname === INIT_PATH && response.status() === 200) {
        const parsed = parseInitResponse(await response.body());
        if (parsed) batches.push(parsed);
        trace.step('inbox.init_response', { ok: !!parsed, inbox: parsed && parsed.inboxLabel, conversations: parsed ? parsed.conversations.length : 0 });
      } else if (/(^|\.)douyin\.com$/.test(url.hostname) && url.pathname === USER_INFO_PATH && response.status() === 200) {
        for (const user of parseUserInfo(await response.json())) users.set(user.uid, user);
      }
    })().catch(() => { /* 单个响应读不到不影响其他 */ });
    pending.add(task); task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  try {
    trace.step('inbox.open', { url: CHAT_URL });
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + timeoutMs;
    let settledAt = 0;
    while (Date.now() < deadline) {
      checkStopped();
      const inboxes = new Set(batches.map(b => b.inboxLabel));
      // 两批都到了（或已有一批且等过了缓冲时间）就收尾，再多等一会儿让对方资料到齐
      if (inboxes.has('normal') && inboxes.has('stranger')) { if (!settledAt) settledAt = Date.now() + settleMs; }
      if (settledAt && Date.now() >= settledAt) break;
      await page.waitForTimeout(250);
    }
    await Promise.allSettled([...pending]);
  } finally {
    if (typeof page.off === 'function') page.off('response', onResponse); else page.removeListener('response', onResponse);
  }
  const selfUid = (batches.find(b => b.selfUid) || {}).selfUid || '';
  const health = await page.evaluate(() => {
    const text = (document.body && document.body.innerText || '').slice(0, 4000);
    return { url: location.href, needLogin: /扫码登录|登录后/.test(text) && !document.querySelector('[data-e2e="conversation-item"]'), verify: /验证码|安全验证|滑动/.test(text) };
  }).catch(() => ({ url: '', needLogin: false, verify: false }));
  trace.step('inbox.done', { batches: batches.length, users: users.size, selfUid: !!selfUid, health });
  if (!batches.length) {
    const reason = health.verify ? '私信页需要安全验证' : health.needLogin ? '账号未登录' : '私信页没有返回会话数据';
    return { ok: false, reason, code: health.verify ? 'PLATFORM_VERIFICATION' : health.needLogin ? 'LOGIN_REQUIRED' : 'INBOX_NO_DATA' };
  }
  // 同一会话可能出现在多批里：按会话 ID 合并，消息按 ID 去重
  const conversations = new Map();
  for (const batch of batches) {
    for (const conv of batch.conversations) {
      const prev = conversations.get(conv.convId) || { ...conv, inbox: batch.inboxLabel, messages: [] };
      const seen = new Set(prev.messages.map(m => m.id));
      for (const m of conv.messages) if (!seen.has(m.id)) { prev.messages.push(m); seen.add(m.id); }
      conversations.set(conv.convId, prev);
    }
  }
  return { ok: true, selfUid, conversations: [...conversations.values()], users: [...users.values()], hasMore: batches.some(b => b.hasMore) };
}

module.exports = { scanInbox, CHAT_URL };
