'use strict';
/**
 * 私信实时同步（浏览器方案，2026-10-22 两个自有账号互发实测）
 *
 * 每个连接的账号保持一个停在 chat?isPopup=1 的后台页面：浏览器自己维护登录、签名与实时长连接，
 * 程序只读页面自己收到的数据：
 *   - get_message_by_init（打开 / 刷新页面时）：全部会话 → mergeScan，并标记线索“已回复”
 *   - 实时推送 cmd 500：已有会话的新文字消息直接带正文 → mergeMessages；陌生人首条只推会话指令 → 3 秒后刷新一次页面
 *   - get_by_conversation（打开会话时）：历史消息 → mergeMessages（不计未读）
 * 回复：在该后台页打开会话（按页面请求里的会话 ID 核对是这个人），输入框输入后回车，发送结果以平台回执为准。
 * 不构造任何请求；不点会话以外的地方；掉登录 / 验证如实显示。
 */
const { parseInitResponse, parseUserInfo, parsePushFrame, parseConversationMessages } = require('./lib/im-inbox');
const { mergeScan, mergeMessages, addLocalMessage, updateLocalMessage, linkLeadReplies, markRead } = require('./lib/inbox-store');
const { createDmReceiptObserver } = require('./lib/action-receipts');

const CHAT_URL = 'https://www.douyin.com/chat?isPopup=1';
const RECONNECT_MS = 30000, MAX_RECONNECTS = 5, REFRESH_DEBOUNCE_MS = 3000;

function createChatRuntime({ store, authorize, getAlive, launchAccount, closeAccount, refreshLeadStatus = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, typeDelay = () => 40 + Math.round(Math.random() * 60),
  createReceipt = createDmReceiptObserver, reconnectMs = RECONNECT_MS, refreshDebounceMs = REFRESH_DEBOUNCE_MS, initTimeoutMs = 25000, rowWaitMs = 8000 }) {
  const runtimes = new Map();
  let version = 0;
  const bump = () => { version++; };
  const log = (accountId, line) => { try { store.log(accountId, '私信同步：' + line); } catch (_) {} };

  function rt(accountId) {
    const key = String(accountId);
    if (!runtimes.has(key)) runtimes.set(key, { accountId: key, state: 'offline', wanted: false, reconnects: 0, queue: Promise.resolve(), view: 'main' });
    return runtimes.get(key);
  }
  function setState(r, state, reason = '') { r.state = state; r.reason = reason; r.since = now(); bump(); }
  // 每个账号的页面操作排队，一次只做一件
  function enqueue(r, job) {
    const run = r.queue.then(job, job);
    r.queue = run.catch(() => {});
    return run;
  }

  function save(mutate) {
    const inbox = store.getInbox();
    const result = mutate(inbox);
    store.setInbox(inbox);
    const leads = store.getLeads();
    const marked = linkLeadReplies(leads, inbox);
    if (marked) { for (const lead of leads) if (lead.replied) refreshLeadStatus(lead); store.setLeads(leads); }
    bump();
    return result;
  }

  function attach(r, page) {
    r.pendingInit = [];
    r.users = new Map();
    const onResponse = response => {
      let url; try { url = new URL(response.url()); } catch (_) { return; }
      (async () => {
        if (response.status() !== 200) return;
        if (/(^|\.)imapi\.douyin\.com$/.test(url.hostname) && url.pathname === '/v1/message/get_message_by_init') {
          const parsed = parseInitResponse(await response.body());
          if (!parsed) return;
          r.selfUid = parsed.selfUid || r.selfUid;
          r.pendingInit.push(parsed);
          // 合并到本地：同一批会话可能分两批（普通 / 陌生人）到达，每批到就并入
          save(inbox => mergeScan(inbox, { accountId: r.accountId, scan: { selfUid: r.selfUid, users: [...r.users.values()],
            conversations: parsed.conversations.map(c => ({ ...c, inbox: parsed.inboxLabel })) }, now: now() }));
          r.lastEventAt = now();
        } else if (/(^|\.)imapi\.douyin\.com$/.test(url.hostname) && url.pathname === '/v1/message/get_by_conversation') {
          const reqBody = response.request().postDataBuffer() || Buffer.alloc(0);
          const parsed = parseConversationMessages(await response.body());
          if (r.waitHistory) r.waitHistory(reqBody, parsed);
          if (!parsed || !parsed.messages.length) return;
          const convId = parsed.messages[0].convId;
          save(inbox => mergeMessages(inbox, { accountId: r.accountId, selfUid: parsed.selfUid || r.selfUid, convId, messages: parsed.messages, countUnread: false, now: now() }));
        } else if (/(^|\.)douyin\.com$/.test(url.hostname) && url.pathname === '/aweme/v1/web/im/user/info/') {
          const users = parseUserInfo(await response.json());
          for (const u of users) r.users.set(u.uid, u);
          if (users.length) save(inbox => {
            const account = inbox.accounts[r.accountId];
            if (!account) return;
            for (const u of users) { const c = account.conversations[u.uid]; if (c) Object.assign(c, { nickname: u.nickname || c.nickname, peerSecUid: c.peerSecUid || u.secUid, followerStatus: u.followerStatus }); }
          });
        }
      })().catch(() => {});
    };
    const onWebSocket = ws => {
      if (!/frontier/.test(ws.url())) return;
      r.wsOpen = true; bump();
      ws.on('close', () => { r.wsOpen = false; bump(); });
      ws.on('framereceived', frame => {
        const data = typeof frame.payload === 'string' ? Buffer.from(frame.payload) : frame.payload;
        const push = parsePushFrame(data);
        if (!push) return;
        r.lastEventAt = now();
        if (push.message.kind === 'command') { scheduleRefresh(r); return; }
        if (!r.selfUid) { scheduleRefresh(r); return; }
        const result = save(inbox => mergeMessages(inbox, { accountId: r.accountId, selfUid: r.selfUid, convId: push.message.convId, messages: [push.message], countUnread: true, now: now() }));
        if (result && result.newPeerMessages.length) log(r.accountId, `收到新消息 ${result.newPeerMessages.length} 条`);
      });
    };
    const onClose = () => {
      if (r.page !== page) return;
      r.page = null; r.wsOpen = false;
      setState(r, 'offline', r.wanted ? '私信页被关闭，稍后自动重连' : '');
      if (r.wanted && r.reconnects < MAX_RECONNECTS) {
        r.reconnects++;
        clearTimeout(r.reconnectTimer);
        r.reconnectTimer = setTimeout(() => { if (r.wanted && !r.page) connect(r.accountId).catch(() => {}); }, reconnectMs);
        if (r.reconnectTimer.unref) r.reconnectTimer.unref();
      }
    };
    page.on('response', onResponse);
    page.on('websocket', onWebSocket);
    page.on('close', onClose);
    r.detach = () => { try { page.off('response', onResponse); page.off('websocket', onWebSocket); page.off('close', onClose); } catch (_) {} };
  }

  async function waitInit(r, timeoutMs = initTimeoutMs) {
    const until = now() + timeoutMs;
    while (now() < until) {
      const labels = new Set(r.pendingInit.map(b => b.inboxLabel));
      if (labels.has('normal') && labels.has('stranger')) return true;
      await sleep(250);
    }
    return r.pendingInit.length > 0;
  }

  function scheduleRefresh(r) {
    clearTimeout(r.refreshTimer);
    r.refreshTimer = setTimeout(() => {
      enqueue(r, async () => {
        if (!r.page) return;
        r.pendingInit = [];
        await r.page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        r.view = 'main';
        await waitInit(r, Math.min(20000, initTimeoutMs));
      });
    }, refreshDebounceMs);
    if (r.refreshTimer.unref) r.refreshTimer.unref();
  }

  async function connect(accountId) {
    const r = rt(accountId);
    r.wanted = true;
    if (r.page && !r.page.isClosed()) return { ok: true, state: r.state };
    return enqueue(r, async () => {
      if (r.page && !r.page.isClosed()) return { ok: true, state: r.state };
      setState(r, 'connecting');
      try {
        await authorize({ accountId: r.accountId, kind: 'inbox' });
        let alive = getAlive(r.accountId), page;
        if (alive && alive.page && !alive.page.isClosed()) {
          if (alive.embedded || !alive.context || typeof alive.context.newPage !== 'function') throw Object.assign(new Error('账号的内嵌浏览器窗口正在使用，请关闭该窗口后再连接私信'), { code: 'INBOX_WINDOW_BUSY' });
          page = await alive.context.newPage(); r.owned = false;
        } else {
          alive = await launchAccount(r.accountId, { headless: true, checkStopped: () => {} });
          page = alive.page; r.owned = true;
        }
        r.page = page;
        attach(r, page);
        await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        r.view = 'main';
        const ok = await waitInit(r);
        if (!ok) {
          const health = await page.evaluate(() => ({ text: (document.body && document.body.innerText || '').slice(0, 3000) })).catch(() => ({ text: '' }));
          const reason = /验证码|安全验证|滑动/.test(health.text) ? '私信页需要安全验证，请在账号窗口完成' : /扫码登录|登录后/.test(health.text) ? '账号未登录' : '私信页没有返回会话数据';
          setState(r, 'error', reason);
          return { ok: false, error: reason };
        }
        r.reconnects = 0;
        setState(r, 'online');
        log(r.accountId, '已连接，实时同步中');
        return { ok: true, state: 'online' };
      } catch (error) {
        setState(r, 'error', error.message || '连接失败');
        return { ok: false, error: error.message };
      }
    });
  }

  async function disconnect(accountId) {
    const r = rt(accountId);
    r.wanted = false;
    clearTimeout(r.reconnectTimer); clearTimeout(r.refreshTimer);
    return enqueue(r, async () => {
      const page = r.page;
      r.page = null;
      if (r.detach) r.detach();
      if (page && !r.owned) await page.close().catch(() => {});
      if (r.owned) await closeAccount(r.accountId).catch(() => {});
      setState(r, 'offline');
      return { ok: true };
    });
  }

  // 在后台页打开某个会话：陌生人会话先进“陌生人消息”；按昵称点会话行，用页面请求里的会话 ID 核对对方
  async function openOnPage(r, peerUid) {
    const conv = (store.getInbox().accounts[r.accountId] || { conversations: {} }).conversations[String(peerUid)];
    if (!conv) throw Object.assign(new Error('本地没有这个会话，请先刷新'), { code: 'CHAT_NOT_FOUND' });
    const lead = conv.peerSecUid ? store.getLeads().find(l => l.uid === conv.peerSecUid) : null;
    const nickname = conv.nickname || (lead && lead.nickname) || '';
    if (!nickname) throw Object.assign(new Error('还没取得对方昵称，无法在私信页定位这个会话；请在账号浏览器里回复'), { code: 'CHAT_NO_NICKNAME' });
    const page = r.page;
    const stranger = conv.inbox === 'stranger';
    if (stranger && r.view !== 'stranger') {
      if (r.view !== 'main') { await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }); await waitInit(r, Math.min(15000, initTimeoutMs)); }
      const folder = page.getByText(/^陌生人消息/).first();
      if (await folder.count()) { await folder.click({ timeout: 8000 }); await sleep(1500); r.view = 'stranger'; }
    } else if (!stranger && r.view !== 'main') {
      r.pendingInit = [];
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitInit(r, Math.min(15000, initTimeoutMs));
      r.view = 'main';
    }
    const rows = page.locator('[data-e2e="conversation-item"]').filter({ hasText: nickname });
    const count = Math.min(3, await rows.count());
    if (!count) throw Object.assign(new Error(`私信页里没找到“${nickname}”的会话（可能在列表较后面），请在账号浏览器里回复`), { code: 'CHAT_ROW_NOT_FOUND' });
    const want = String(peerUid), self = String(r.selfUid || '');
    for (let i = 0; i < count; i++) {
      const matched = new Promise(resolve => {
        const timer = setTimeout(() => { r.waitHistory = null; resolve(false); }, rowWaitMs);
        r.waitHistory = reqBody => {
          const body = reqBody.toString('latin1');
          if (body.includes(want) && (!self || body.includes(self))) { clearTimeout(timer); r.waitHistory = null; resolve(true); }
        };
      });
      await rows.nth(i).click({ timeout: 8000 });
      if (await matched) { r.currentPeer = want; return conv; }
    }
    r.currentPeer = '';
    throw Object.assign(new Error('点开的会话与对方核对不上，已停止，未发送'), { code: 'CHAT_RECIPIENT_UNCONFIRMED' });
  }

  async function openConversation(accountId, peerUid) {
    const r = rt(accountId);
    save(inbox => markRead(inbox, accountId, peerUid));
    if (!r.page) return { ok: false, error: '账号未连接' };
    return enqueue(r, async () => {
      try { if (r.currentPeer !== String(peerUid)) await openOnPage(r, peerUid); return { ok: true }; }
      catch (error) { return { ok: false, error: error.message, code: error.code || '' }; }
    });
  }

  async function send(accountId, peerUid, text) {
    const r = rt(accountId);
    const message = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!message) return { ok: false, error: '消息不能为空' };
    if (message.length > 1000) return { ok: false, error: '消息不能超过 1000 字' };
    if (!r.page) return { ok: false, error: '账号未连接，请先连接' };
    const localId = save(inbox => addLocalMessage(inbox, { accountId, peerUid, text: message, now: now() }));
    if (!localId) return { ok: false, error: '本地没有这个会话，请先刷新' };
    const finish = (status, reason = '') => save(inbox => updateLocalMessage(inbox, { accountId, peerUid, localId, status, reason }));
    return enqueue(r, async () => {
      let receipt = null;
      try {
        await authorize({ accountId: r.accountId, kind: 'dm' });
        const conv = await openOnPage(r, peerUid);
        const page = r.page;
        const editor = page.locator('[contenteditable="true"]:visible').last();
        if (!await editor.count()) throw Object.assign(new Error('私信输入框没有出现（可能是平台限制只能发一条），未发送'), { code: 'CHAT_EDITOR_MISSING' });
        receipt = createReceipt({ page, targetUid: conv.peerSecUid || String(peerUid), targetSecUid: conv.peerSecUid || '', targetNumericUid: String(peerUid) });
        receipt.arm({ message, attemptId: localId });
        await editor.click({ timeout: 5000 });
        const lines = message.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (i) await page.keyboard.press('Shift+Enter');
          for (const ch of lines[i]) await page.keyboard.type(ch, { delay: typeDelay() });
        }
        await sleep(400 + Math.round(Math.random() * 500));
        await page.keyboard.press('Enter');
        await receipt.waitForReceipt({ timeoutMs: 20000 });
        const outcome = receipt.getOutcome();
        if (outcome.state === 'confirmed_success') { finish('sent'); log(r.accountId, '回复已送达'); return { ok: true, state: 'sent' }; }
        const reason = outcome.reason || '平台未确认送达';
        finish(outcome.state === 'pending_verification' ? 'pending' : 'failed', reason);
        log(r.accountId, '回复未送达：' + reason);
        return { ok: false, state: outcome.state, error: reason, scope: outcome.failureScope || '' };
      } catch (error) {
        finish('failed', error.message);
        return { ok: false, error: error.message, code: error.code || '' };
      } finally { if (receipt) receipt.dispose(); }
    });
  }

  function status() {
    const out = {};
    for (const [id, r] of runtimes) out[id] = { state: r.state, reason: r.reason || '', since: r.since || 0, lastEventAt: r.lastEventAt || 0, live: !!r.wsOpen, wanted: r.wanted };
    return { version, runtimes: out };
  }

  async function shutdown() { for (const id of [...runtimes.keys()]) await disconnect(id).catch(() => {}); }

  return { connect, disconnect, openConversation, send, status, shutdown, _runtimes: runtimes };
}

module.exports = { createChatRuntime, CHAT_URL };
