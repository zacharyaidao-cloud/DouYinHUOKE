/** 独立授权管理网页；所有管理密钥只存在于本服务，客户程序不打包本目录。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const COOKIE = '__Secure-dyAdmin';
const BASE_PATH = '/dy-license/manage/';
const USERNAME = /^[\p{L}\p{N}_.@-]{1,64}$/u;
const ADMIN_USERNAME = /^[\p{L}\p{N}_.@-]{1,64}$/u;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function secureEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(value + 'T00:00:00+08:00');
  return Number.isFinite(ms) && new Date(ms + 8 * 3600000).toISOString().slice(0, 10) === value;
}
function privateFile(filename) { fs.chmodSync(filename, 0o600); }
function readEnv(filename) {
  const result = {};
  if (!filename) return result;
  const source = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return result;
}
function loadCredential(filename) {
  const credentials = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  if (typeof credentials.username !== 'string' || !ADMIN_USERNAME.test(credentials.username || '') || !/^[a-f0-9]{32,64}$/.test(credentials.salt || '') ||
      !/^[a-f0-9]{64}$/.test(credentials.passwordHash || '')) throw new Error('管理账户配置无效，请使用 init-admin.js 初始化');
  return credentials;
}
function shanghaiTime(ms) {
  return new Date(ms + 8 * 3600000).toISOString().replace('Z', '+08:00');
}
function createAdminWebServer(options = {}) {
  const dataDir = options.dataDir || process.env.ADMIN_WEB_DATA_DIR || path.join(__dirname, 'admin-data');
  const webDir = options.webDir || path.join(__dirname, 'web');
  const credential = options.credentials || loadCredential(path.join(dataDir, 'admin.json'));
  if (typeof credential.username !== 'string' || !ADMIN_USERNAME.test(credential.username || '') || !/^[a-f0-9]{32,64}$/.test(credential.salt || '') ||
      !/^[a-f0-9]{64}$/.test(credential.passwordHash || '')) throw new Error('管理账户配置无效');
  const env = readEnv(options.managementConfig || process.env.ADMIN_MANAGEMENT_CONFIG);
  const adminKey = options.adminKey || process.env.LICENSE_ADMIN_KEY || env.LICENSE_ADMIN_KEY || '';
  if (adminKey.length < 24) throw new Error('服务端缺少独立管理密钥');
  const licensePort = Number(options.licensePort || process.env.ADMIN_LICENSE_PORT || 18765);
  if (!Number.isInteger(licensePort) || licensePort < 1 || licensePort > 65535) throw new Error('本机授权服务端口无效');
  const publicOrigin = options.publicOrigin || process.env.ADMIN_PUBLIC_ORIGIN || 'https://huamao.xyz';
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) throw new Error('管理网页必须配置准确的 HTTPS Origin');
  const now = options.now || Date.now;
  const idleMs = options.idleMs || 30 * 60000;
  const absoluteMs = options.absoluteMs || 12 * 3600000;
  const maxSessions = options.maxSessions || 500;
  const sessions = new Map();
  const rate = new Map();
  const maxRateEntries = options.maxRateEntries || 2000;
  const trustProxy = options.trustProxy !== false;
  let pendingLogins = 0;
  let pendingWrites = 0;
  let writeQueue = Promise.resolve();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const auditFile = path.join(dataDir, 'audit.jsonl');
  const auditPrevious = path.join(dataDir, 'audit.previous.jsonl');
  function audit(actor, action, target, result) {
    const event = { timestamp: shanghaiTime(now()), actor: String(actor).slice(0, 64), action,
      target: USERNAME.test(target || '') ? target : '', result };
    if (fs.existsSync(auditFile) && fs.statSync(auditFile).size > 5 * 1024 * 1024) {
      fs.renameSync(auditFile, auditPrevious);
      privateFile(auditPrevious);
    }
    fs.appendFileSync(auditFile, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
    privateFile(auditFile);
  }
  function auditEvents() {
    const events = [];
    for (const filename of [auditPrevious, auditFile]) {
      if (!fs.existsSync(filename)) continue;
      for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
        if (!line || line.length > 2000) continue;
        try {
          const event = JSON.parse(line);
          if (typeof event.timestamp === 'string' && typeof event.action === 'string') {
            events.push({ timestamp: event.timestamp, actor: String(event.actor || '').slice(0, 64),
              action: String(event.action).slice(0, 64), target: String(event.target || '').slice(0, 64), result: String(event.result || '').slice(0, 32) });
          }
        } catch { /* 忽略未完成的最后一行 */ }
      }
    }
    return events.slice(-100).reverse();
  }
  function headers(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
  function json(res, status, result) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  }
  function setCookie(res, value, clear = false) {
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=${BASE_PATH}; Secure; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.floor(absoluteMs / 1000)}`);
  }
  function pruneSessions() {
    for (const [key, session] of sessions) if (now() >= session.absoluteUntil || now() - session.lastUsed >= idleMs) sessions.delete(key);
  }
  function getSession(req) {
    pruneSessions();
    const matches = String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE + '='));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const session = sessions.get(key);
    if (!session) return null;
    session.lastUsed = now();
    return { key, ...session };
  }
  function ip(req) {
    const remote = req.socket.remoteAddress || '';
    if (trustProxy && LOOPBACK.has(remote)) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (/^[a-fA-F0-9:.]{3,64}$/.test(forwarded)) return forwarded;
    }
    return remote;
  }
  function limited(key, limit, windowMs) {
    const time = now();
    for (const [entry, state] of rate) if (state.until <= time) rate.delete(entry);
    let state = rate.get(key);
    if (!state) {
      if (rate.size >= maxRateEntries) return true;
      state = { count: 0, until: time + windowMs }; rate.set(key, state);
    }
    state.count++;
    return state.count > limit;
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('请使用 JSON 请求'), { status: 415 });
    if (Number(req.headers['content-length']) > 16384) {
      req.resume();
      throw Object.assign(new Error('请求内容过大'), { status: 413 });
    }
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) throw Object.assign(new Error('请求内容过大'), { status: 413 });
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('请求格式错误'), { status: 400 }); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Object.assign(new Error('请求格式错误'), { status: 400 });
    return result;
  }
  function rejectFields(value, allowed) {
    if (Object.keys(value).some(key => !allowed.includes(key))) throw Object.assign(new Error('请求包含不支持的字段'), { status: 400 });
  }
  function text(value, max, field, optional = false) {
    if (value === undefined && optional) return undefined;
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw Object.assign(new Error(field + '格式无效'), { status: 400 });
    return value;
  }
  function password(value) {
    const result = text(value, 128, '密码');
    if (result.length < 8) throw Object.assign(new Error('密码至少需要 8 位'), { status: 400 });
    return result;
  }
  function licenseRequest(method, pathname, payload) {
    const permitted = (method === 'GET' && pathname === '/admin/users') ||
      (method === 'POST' && ['/admin/users', '/admin/update', '/admin/reset-password'].includes(pathname)) ||
      (method === 'POST' && /^\/admin\/unbind\/[^/]+$/.test(pathname)) ||
      (method === 'DELETE' && /^\/admin\/users\/[^/]+$/.test(pathname));
    if (!permitted) throw new Error('内部管理路径未获允许');
    return new Promise((resolve, reject) => {
      const encoded = payload ? JSON.stringify(payload) : '';
      const request = http.request({ hostname: '127.0.0.1', port: licensePort, method, path: pathname,
        headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { response.destroy(); reject(new Error('管理服务响应过大')); } else chunks.push(chunk); });
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode >= 300 || !result || result.ok !== true) {
              const status = [404, 409].includes(response.statusCode) ? response.statusCode : 503;
              return reject(Object.assign(new Error(status === 404 ? '账户不存在' : status === 409 ? '账户已存在' : '授权服务暂不可用，请稍后重试'), { status }));
            }
            resolve(result);
          } catch { reject(Object.assign(new Error('授权服务暂不可用，请稍后重试'), { status: 503 })); }
        });
        response.on('error', reject);
      });
      request.setTimeout(10000, () => request.destroy(new Error('管理服务超时')));
      request.on('error', () => reject(Object.assign(new Error('授权服务暂不可用，请稍后重试'), { status: 503 })));
      request.end(encoded);
    });
  }
  function serializeWrite(session, work) {
    if (pendingWrites >= 50) throw Object.assign(new Error('管理请求较多，请稍后重试'), { status: 503 });
    pendingWrites++;
    const guarded = async () => {
      try {
        const current = sessions.get(session.key);
        if (!current || now() >= current.absoluteUntil || now() - current.lastUsed >= idleMs) {
          sessions.delete(session.key);
          throw Object.assign(new Error('管理登录已过期，请重新登录'), { status: 401 });
        }
        return await work();
      } finally { pendingWrites--; }
    };
    const next = writeQueue.then(guarded, guarded);
    writeQueue = next.catch(() => {});
    return next;
  }
  const server = http.createServer(async (req, res) => {
    headers(res);
    let actor = 'anonymous'; let action = ''; let target = '';
    try {
      const rawPath = (req.url || '/').split('?')[0];
      let route = rawPath.startsWith(BASE_PATH) ? rawPath.slice(BASE_PATH.length - 1) : rawPath;
      if (route === '/api/login' && req.method === 'POST') {
        action = 'login';
        if (req.headers.origin !== publicOrigin) return json(res, 403, { ok: false, error: '请求来源验证失败' });
        const value = await body(req); rejectFields(value, ['username', 'password']);
        const username = text(value.username, 64, '用户名'); target = USERNAME.test(username) ? username : '';
        const pass = text(value.password, 128, '密码');
        const ipLimited = limited('ip:' + ip(req), 10, 5 * 60000);
        const nameLimited = limited('name:' + crypto.createHash('sha256').update(username).digest('hex'), 5, 10 * 60000);
        if (ipLimited || nameLimited || pendingLogins >= 8) {
          audit('anonymous', 'login', target, 'rate_limited');
          res.setHeader('Retry-After', '600');
          return json(res, 429, { ok: false, error: '登录尝试过多，请 10 分钟后重试' });
        }
        pendingLogins++;
        let hash;
        try { hash = await scrypt(pass, credential.salt, 32); } finally { pendingLogins--; }
        const usernameMatches = secureEqual(username, credential.username);
        const passwordMatches = crypto.timingSafeEqual(hash, Buffer.from(credential.passwordHash, 'hex'));
        if (!usernameMatches || !passwordMatches) {
          audit('anonymous', 'login', target, 'failed');
          return json(res, 401, { ok: false, error: '用户名或密码错误' });
        }
        pruneSessions();
        if (sessions.size >= maxSessions) { audit('anonymous', 'login', target, 'capacity'); return json(res, 503, { ok: false, error: '登录会话暂不可用，请稍后重试' }); }
        // 登录时撤销当前浏览器的旧会话，避免会话固定与重复占用。
        const old = getSession(req); if (old) sessions.delete(old.key);
        const token = crypto.randomBytes(32).toString('base64url');
        const csrfToken = crypto.randomBytes(32).toString('base64url');
        sessions.set(crypto.createHash('sha256').update(token).digest('hex'), {
          username: credential.username, csrfToken, lastUsed: now(), absoluteUntil: now() + absoluteMs
        });
        setCookie(res, token); audit(credential.username, 'login', credential.username, 'success');
        return json(res, 200, { ok: true, username: credential.username, csrfToken });
      }
      if (route.startsWith('/api/')) {
        const session = getSession(req);
        if (req.method === 'GET' && route === '/api/me') return json(res, 200,
          session ? { ok: true, authenticated: true, username: session.username, csrfToken: session.csrfToken } : { ok: true, authenticated: false });
        if (!session) { setCookie(res, '', true); return json(res, 401, { ok: false, error: '管理登录已过期，请重新登录' }); }
        actor = session.username;
        if (req.method !== 'GET') {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '不支持此请求方法' });
          if (req.headers.origin !== publicOrigin || !secureEqual(req.headers['x-csrf-token'] || '', session.csrfToken)) return json(res, 403, { ok: false, error: '请求来源或安全验证失败，请刷新页面' });
        }
        if (req.method === 'GET' && route === '/api/users') {
          const result = await licenseRequest('GET', '/admin/users');
          if (!Array.isArray(result.users)) throw Object.assign(new Error('授权服务暂不可用，请稍后重试'), { status: 503 });
          return json(res, 200, { ok: true, users: result.users.map(u => ({ username: String(u.username || '').slice(0, 64),
            mac: String(u.mac || '').slice(0, 64), expiresAt: String(u.expiresAt || '').slice(0, 10),
            enabled: u.enabled === true, expired: u.expired === true, note: String(u.note || '').slice(0, 1000),
            createdAt: String(u.createdAt || '').slice(0, 40) })) });
        }
        if (req.method === 'GET' && route === '/api/audit') return json(res, 200, { ok: true, events: auditEvents() });
        if (req.method === 'POST' && route === '/api/logout') {
          const value = await body(req); rejectFields(value, []);
          sessions.delete(session.key); setCookie(res, '', true); audit(actor, 'logout', actor, 'success');
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && route === '/api/users') {
          action = 'create'; const value = await body(req); rejectFields(value, ['username', 'password', 'expiresAt', 'note']);
          if (typeof value.username !== 'string' || !USERNAME.test(value.username || '')) throw Object.assign(new Error('用户名仅支持中英文、数字及 _ . @ -，长度 1 至 64'), { status: 400 });
          target = value.username;
          const payload = { username: target, password: password(value.password), expiresAt: value.expiresAt, note: text(value.note, 1000, '备注', true) || '' };
          if (!validDate(payload.expiresAt)) throw Object.assign(new Error('请选择有效的到期日期'), { status: 400 });
          await serializeWrite(session, () => licenseRequest('POST', '/admin/users', payload));
          audit(actor, action, target, 'success'); return json(res, 200, { ok: true, username: target });
        }
        const match = route.match(/^\/api\/users\/([^/]+)\/(update|unbind|reset-password|delete)$/);
        if (req.method === 'POST' && match) {
          try { target = decodeURIComponent(match[1]); } catch { throw Object.assign(new Error('用户名无效'), { status: 400 }); }
          if (!USERNAME.test(target)) throw Object.assign(new Error('用户名无效'), { status: 400 });
          action = match[2]; const value = await body(req);
          let method = 'POST', endpoint, payload;
          if (action === 'update') {
            rejectFields(value, ['expiresAt', 'enabled', 'note']);
            if (!Object.keys(value).length) throw Object.assign(new Error('请填写需要修改的内容'), { status: 400 });
            payload = { username: target };
            if (value.expiresAt !== undefined) { if (!validDate(value.expiresAt)) throw Object.assign(new Error('请选择有效的到期日期'), { status: 400 }); payload.expiresAt = value.expiresAt; }
            if (value.enabled !== undefined) { if (typeof value.enabled !== 'boolean') throw Object.assign(new Error('启用状态无效'), { status: 400 }); payload.enabled = value.enabled; }
            if (value.note !== undefined) payload.note = text(value.note, 1000, '备注');
            endpoint = '/admin/update';
          } else if (action === 'unbind') {
            rejectFields(value, []); endpoint = '/admin/unbind/' + encodeURIComponent(target);
          } else if (action === 'reset-password') {
            rejectFields(value, ['newPassword']); payload = { username: target, newPassword: password(value.newPassword) }; endpoint = '/admin/reset-password';
          } else {
            rejectFields(value, ['confirmation']);
            if (value.confirmation !== target) throw Object.assign(new Error('请输入完整用户名确认删除'), { status: 400 });
            method = 'DELETE'; endpoint = '/admin/users/' + encodeURIComponent(target);
          }
          await serializeWrite(session, () => licenseRequest(method, endpoint, payload));
          audit(actor, action, target, 'success'); return json(res, 200, { ok: true });
        }
        return json(res, 404, { ok: false, error: '管理接口不存在' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: '不支持此请求方法' });
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'application/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
      const asset = assets[route];
      if (!asset) return json(res, 404, { ok: false, error: '页面不存在' });
      try {
        const content = fs.readFileSync(path.join(webDir, asset[0]));
        res.setHeader('Content-Type', asset[1]); res.statusCode = 200; res.end(req.method === 'HEAD' ? undefined : content);
      } catch { return json(res, 404, { ok: false, error: '页面尚未部署' }); }
    } catch (error) {
      if (action) { try { audit(actor, action, target, 'failed'); } catch { /* 返回统一错误，不输出密钥和请求体 */ } }
      const status = [400, 401, 413, 415, 404, 409, 503].includes(error.status) ? error.status : 503;
      return json(res, status, { ok: false, error: error.status ? error.message : '管理服务暂不可用，请稍后重试' });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return { server, dataDir };
}
if (require.main === module) {
  try {
    const { server } = createAdminWebServer();
    const port = Number(process.env.ADMIN_WEB_PORT || 18766);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('管理网页端口无效');
    server.listen(port, '127.0.0.1', () => console.log('[admin-web] 已监听 127.0.0.1:' + port));
    server.on('error', () => { console.error('管理网页启动失败，请检查服务端配置或端口'); process.exitCode = 1; });
  } catch { console.error('管理网页配置无效，请检查独立管理账户和服务端密钥'); process.exitCode = 1; }
}
module.exports = { createAdminWebServer, loadCredential, validDate, BASE_PATH };
