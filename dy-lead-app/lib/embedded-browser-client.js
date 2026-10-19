'use strict';

// Backend-only transport. The capability URL and header never leave this
// module except for the trusted Playwright connection; neither is renderer IPC.
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 32 * 1024 * 1024;
const MAX_PENDING = 256, MAX_ACCOUNT_PENDING = 128, TIMEOUT_MS = 30000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const error = (code, message) => Object.assign(new Error(message), { code, embeddedClientError: true });
const closedError = () => error('EMBEDDED_CLOSED', '内嵌账号浏览器已关闭');
function stringify(value, limit) {
  let json;
  try { json = JSON.stringify(value); } catch (_) { throw error('EMBEDDED_PAYLOAD_INVALID', '内嵌浏览器数据格式无效'); }
  if (typeof json !== 'string' || Buffer.byteLength(json) > limit) throw error('EMBEDDED_PAYLOAD_LIMIT', '内嵌浏览器数据超过限制');
  return json;
}

function createEmbeddedBrowserClient({ channel = process, chromium } = {}) {
  const accounts = new Map(), paths = new Map(), pending = new Map(), sockets = new Set();
  let server, wss, serverPromise, disposed = false, disposePromise, disconnected = false;
  const connected = () => !disconnected && typeof channel?.send === 'function' && channel.connected === true;
  const isAvailable = () => !disposed && process.env.DY_LEAD_EMBEDDED_BROWSER === '1' && connected();
  const current = entry => entry.active && accounts.get(entry.accountId) === entry;
  function settle(id, failure, value) {
    const item = pending.get(id); if (!item) return;
    pending.delete(id); clearTimeout(item.timer); item.entry.pending--;
    if (failure) item.reject(failure); else item.resolve(value);
  }
  function rejectEntry(entry) {
    for (const [id, item] of pending) if (item.entry === entry) settle(id, closedError());
  }
  function request(entry, op, payload = {}, closing = false) {
    if (!connected()) return Promise.reject(error('EMBEDDED_DISCONNECTED', '内嵌浏览器主进程连接已断开'));
    if (!closing && !current(entry)) return Promise.reject(closedError());
    if (closing && pending.size >= MAX_PENDING) {
      // A saturated command queue must not strand an otherwise idle account's
      // host view. Prefer closing it over retaining one in-flight CDP command.
      const victim = [...pending].find(([, item]) => item.op !== 'close');
      if (victim) settle(victim[0], error('EMBEDDED_BUSY', '内嵌浏览器待处理请求过多'));
    }
    if (pending.size >= MAX_PENDING || entry.pending >= MAX_ACCOUNT_PENDING) return Promise.reject(error('EMBEDDED_BUSY', '内嵌浏览器待处理请求过多'));
    const id = crypto.randomUUID(), envelope = { type: 'embedded:request', id, op, accountId: entry.accountId, generation: entry.generation, payload };
    try { stringify(envelope, REQUEST_LIMIT); } catch (failure) { return Promise.reject(failure); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(id, error('EMBEDDED_TIMEOUT', '内嵌浏览器请求等待超时')), TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { entry, op, resolve, reject, timer }); entry.pending++;
      try {
        channel.send(envelope, failure => {
          if (failure) settle(id, error('EMBEDDED_DISCONNECTED', '内嵌浏览器主进程连接已断开'));
        });
      } catch (_) { settle(id, error('EMBEDDED_DISCONNECTED', '内嵌浏览器主进程连接已断开')); }
    });
  }
  function closeEntry(entry, notifyHost = true) {
    if (entry.closePromise) return entry.closePromise;
    entry.active = false;
    if (accounts.get(entry.accountId) === entry) accounts.delete(entry.accountId);
    paths.delete(entry.path); rejectEntry(entry);
    entry.closePromise = Promise.resolve().then(async () => {
      const host = notifyHost && entry.openStarted && connected() ? request(entry, 'close', {}, true).catch(() => {}) : Promise.resolve();
      if (entry.ws) entry.ws.terminate();
      if (entry.browser) {
        // connectOverCDP's browser.close disconnects this browser connection.
        // Host.close is the explicit owner of this account's Electron view.
        let detachTimer;
        try { await Promise.race([entry.browser.close(), new Promise(resolve => {
          detachTimer = setTimeout(resolve, TIMEOUT_MS); if (typeof detachTimer.unref === 'function') detachTimer.unref();
        })]); } catch (_) { /* Local detach must still finish. */ }
        finally { clearTimeout(detachTimer); }
      }
      await host;
    });
    return entry.closePromise;
  }
  function sendWs(entry, value) {
    if (!current(entry) || entry.ws?.readyState !== WebSocket.OPEN) return;
    try {
      const json = stringify(value, RESPONSE_LIMIT);
      if (entry.ws.bufferedAmount + Buffer.byteLength(json) > RESPONSE_LIMIT) throw error('EMBEDDED_PAYLOAD_LIMIT', '内嵌浏览器数据超过限制');
      entry.ws.send(json, failure => { if (failure) void closeEntry(entry); });
    } catch (_) { void closeEntry(entry); }
  }
  function onMessage(message) {
    if (!record(message)) return;
    if (message.type === 'embedded:reply') {
      const item = pending.get(message.id); if (!item) return;
      if (item.op !== 'close' && !current(item.entry)) return settle(message.id, closedError());
      try { stringify(message, RESPONSE_LIMIT); } catch (failure) { return settle(message.id, failure); }
      if (message.error) return settle(message.id, error('EMBEDDED_HOST_ERROR', '内嵌浏览器主进程未完成请求'));
      if (!own(message, 'result')) return settle(message.id, error('EMBEDDED_REPLY_INVALID', '内嵌浏览器主进程返回无效结果'));
      settle(message.id, null, message.result);
    } else if (message.type === 'embedded:event') {
      const entry = accounts.get(message.accountId);
      if (!entry || !current(entry) || entry.generation !== message.generation) return;
      const event = message.event;
      if (event === 'closed' || event?.type === 'closed' || event?.method === 'Host.closed') { void closeEntry(entry, false); return; }
      if (!record(event) || typeof event.method !== 'string' || own(event, 'id')) return;
      sendWs(entry, event);
    }
  }
  function onDisconnect() {
    disconnected = true;
    for (const id of [...pending.keys()]) settle(id, error('EMBEDDED_DISCONNECTED', '内嵌浏览器主进程连接已断开'));
    for (const entry of [...accounts.values()]) void closeEntry(entry, false);
  }
  channel.on('message', onMessage); channel.on('disconnect', onDisconnect); channel.on('close', onDisconnect);
  function bindSocket(entry, ws) {
    entry.ws = ws; entry.connectedOnce = true;
    ws.on('error', () => { void closeEntry(entry); });
    ws.on('close', () => { if (current(entry)) void closeEntry(entry); });
    ws.on('message', (bytes, binary) => {
      if (!current(entry)) return;
      let command;
      try {
        if (binary || bytes.length > REQUEST_LIMIT) throw new Error();
        command = JSON.parse(bytes.toString('utf8'));
        if (!record(command) || !Number.isSafeInteger(command.id) || command.id < 0
          || typeof command.method !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(command.method)
          || command.params !== undefined && !record(command.params)
          || command.sessionId !== undefined && (typeof command.sessionId !== 'string' || !command.sessionId || command.sessionId.length > 512)
          || entry.commands.has(command.id)) throw new Error();
      } catch (_) { void closeEntry(entry); return; }
      entry.commands.add(command.id);
      void request(entry, 'command', command).then(result => {
        sendWs(entry, { id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}), result });
      }, failure => {
        sendWs(entry, { id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          error: { code: -32000, message: failure.embeddedClientError ? failure.message : '内嵌浏览器指令未完成' } });
      }).finally(() => entry.commands.delete(command.id));
    });
  }
  function ensureServer() {
    if (serverPromise) return serverPromise;
    serverPromise = new Promise((resolve, reject) => {
      server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000 }, (_req, res) => { res.writeHead(404); res.end(); });
      wss = new WebSocketServer({ noServer: true, maxPayload: REQUEST_LIMIT, perMessageDeflate: false });
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
      server.on('upgrade', (req, socket, head) => {
        const entry = paths.get(req.url);
        const countHeader = name => req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
        const auth = req.headers.authorization;
        const expected = entry ? 'Bearer ' + entry.token : '';
        if (!entry || !current(entry) || entry.connectedOnce || countHeader('origin') || countHeader('host') !== 1 || countHeader('authorization') !== 1
          || req.headers.host !== '127.0.0.1:' + server.address()?.port || typeof auth !== 'string'
          || Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
        }
        // Reserve before handleUpgrade so concurrent attempts cannot both win.
        entry.connectedOnce = true;
        try { wss.handleUpgrade(req, socket, head, ws => bindSocket(entry, ws)); }
        catch (_) { socket.destroy(); void closeEntry(entry); }
      });
      server.on('error', () => { reject(error('EMBEDDED_TRANSPORT_ERROR', '无法启动内嵌浏览器本地连接')); onDisconnect(); });
      server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); });
    });
    return serverPromise;
  }
  async function open({ accountId, name, profileDir, proxy, visible = false, checkStopped } = {}) {
    if (!isAvailable()) throw error('EMBEDDED_UNAVAILABLE', '当前环境不支持内嵌账号浏览器');
    if (typeof chromium?.connectOverCDP !== 'function') throw error('EMBEDDED_DRIVER_MISSING', '内嵌浏览器驱动不可用');
    if (typeof accountId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(accountId)) throw error('EMBEDDED_ACCOUNT_INVALID', '账号标识无效');
    if (accounts.has(accountId)) throw error('EMBEDDED_ACCOUNT_OPEN', '该账号的内嵌浏览器正在使用');
    let stoppedError;
    const check = () => {
      if (typeof checkStopped === 'function') try { checkStopped(); } catch (failure) { stoppedError = failure; throw failure; }
    };
    check();
    const entry = { accountId, generation: crypto.randomUUID(), path: '/account/' + crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'),
      active: true, pending: 0, commands: new Set(), connectedOnce: false, openStarted: false, browser: null, ws: null, closePromise: null };
    accounts.set(accountId, entry); paths.set(entry.path, entry);
    try {
      const port = await ensureServer(); check(); if (!current(entry)) throw closedError();
      entry.openStarted = true;
      const result = await request(entry, 'open', { name: String(name || ''), profileDir, proxy, visible: visible === true });
      check(); if (!current(entry)) throw closedError();
      if (!record(result) || ['pageSession', 'targetId', 'contextId'].some(key => typeof result[key] !== 'string' || !result[key] || result[key].length > 512)) throw error('EMBEDDED_REPLY_INVALID', '内嵌浏览器未返回唯一账号页面');
      const browser = await chromium.connectOverCDP('ws://127.0.0.1:' + port + entry.path, {
        headers: { Authorization: 'Bearer ' + entry.token }, timeout: TIMEOUT_MS
      });
      if (!current(entry)) { try { await browser.close(); } catch (_) { /* A late connection cannot revive a closed generation. */ } throw closedError(); }
      entry.browser = browser; check(); if (!current(entry)) throw closedError();
      const contexts = browser.contexts();
      if (contexts.length !== 1 || contexts[0].pages().length !== 1) throw error('EMBEDDED_PAGE_INVALID', '内嵌账号浏览器页面数量不符合预期');
      const context = contexts[0], page = context.pages()[0];
      if (typeof page.isClosed === 'function' && page.isClosed()) throw closedError();
      const close = () => closeEntry(entry);
      const show = async () => { if (!current(entry)) throw closedError(); await request(entry, 'show'); if (!current(entry)) throw closedError(); };
      const bringToFront = page.bringToFront.bind(page);
      page.bringToFront = async () => { await show(); return bringToFront(); };
      context.close = close;
      browser.on('disconnected', () => { if (current(entry)) void closeEntry(entry); });
      context.on('close', () => { if (current(entry)) void closeEntry(entry); });
      page.on('close', () => { if (current(entry)) void closeEntry(entry); });
      check();
      return { context, page, embedded: true, show, close };
    } catch (failure) {
      await closeEntry(entry);
      if (failure === stoppedError || failure.embeddedClientError) throw failure;
      throw error('EMBEDDED_CONNECT_FAILED', '无法连接内嵌账号浏览器');
    }
  }
  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...accounts.values()].map(entry => closeEntry(entry)));
      for (const id of [...pending.keys()]) settle(id, closedError());
      channel.removeListener('message', onMessage); channel.removeListener('disconnect', onDisconnect); channel.removeListener('close', onDisconnect);
      if (serverPromise) await serverPromise.catch(() => {});
      for (const socket of sockets) socket.destroy();
      if (wss) await new Promise(resolve => wss.close(() => resolve()));
      if (server?.listening) await new Promise(resolve => server.close(() => resolve()));
    });
    return disposePromise;
  }
  return { isAvailable, open, dispose };
}

module.exports = { createEmbeddedBrowserClient };
