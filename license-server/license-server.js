/** 授权服务 v4：仅监听 loopback，由 Caddy/Nginx 终止 HTTPS；管理端不进入客户包。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function hashPass(password, salt) { return crypto.scryptSync(String(password), salt, 32).toString('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function expiry(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return NaN;
  const ms = Date.parse(date + 'T23:59:59.999+08:00');
  if (!Number.isFinite(ms)) return NaN;
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10) === date ? ms : NaN;
}
function leasePayload(lease) {
  return JSON.stringify({ version: lease.version, username: lease.username, mac: lease.mac, expiresAt: lease.expiresAt,
    serverTime: lease.serverTime, leaseUntil: lease.leaseUntil, offlineUntil: lease.offlineUntil, nonce: lease.nonce });
}
function createLicenseServer(options = {}) {
  const adminKey = options.adminKey || process.env.LICENSE_ADMIN_KEY || '';
  if (adminKey.length < 24 || adminKey === 'change-me-admin-key') throw new Error('LICENSE_ADMIN_KEY 必须配置为至少 24 位的独立管理密钥');
  const dataDir = options.dataDir || path.join(__dirname, 'license-data');
  const usersFile = path.join(dataDir, 'users.json');
  const keysFile = path.join(dataDir, 'keys.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let keys = options.keys;
  if (!keys) {
    try { keys = JSON.parse(fs.readFileSync(keysFile, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('现有授权密钥文件无法读取，已拒绝覆盖；请先恢复备份'); }
    if (!keys?.privateKey || !keys?.publicKey) {
      if (fs.existsSync(keysFile)) throw new Error('现有授权密钥文件不完整，已拒绝重新生成');
      keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
  }
  const sessions = new Map();
  const now = options.now || Date.now;
  const leaseMs = Math.min(5 * 60000, Math.max(1000, Number(options.leaseMs || 5 * 60000)));
  const offlineMs = Math.min(24 * 3600000, Math.max(leaseMs, Number(options.offlineMs || process.env.LICENSE_OFFLINE_MINUTES * 60000 || 15 * 60000)));
  function users() {
    try { const list = JSON.parse(fs.readFileSync(usersFile, 'utf8').replace(/^\uFEFF/, '')); if (!Array.isArray(list)) throw new Error('用户文件格式错误'); return list; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function save(list) { fs.writeFileSync(usersFile + '.tmp', JSON.stringify(list, null, 2), 'utf8'); fs.renameSync(usersFile + '.tmp', usersFile); }
  function validUser(user) { return user && user.enabled !== false && Number.isFinite(expiry(user.expiresAt)) && now() < expiry(user.expiresAt); }
  function sign(user) {
    const serverTime = now();
    const lease = { version: 4, username: user.username, mac: user.mac, expiresAt: user.expiresAt, serverTime,
      leaseUntil: Math.min(serverTime + leaseMs, expiry(user.expiresAt)),
      offlineUntil: Math.min(serverTime + offlineMs, expiry(user.expiresAt)), nonce: crypto.randomBytes(16).toString('hex') };
    return { lease, sig: crypto.sign('sha256', Buffer.from(leasePayload(lease)), keys.privateKey).toString('base64') };
  }
  function body(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; if (data.length > 65536) { reject(new Error('请求过大')); req.destroy(); } });
      req.on('error', reject);
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('JSON 格式错误')); } });
    });
  }
  function json(res, result, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  }
  function invalidate(username) { for (const [key, session] of sessions) if (session.username === username) sessions.delete(key); }
  const server = http.createServer(async (req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'GET' && pathname === '/publickey') return json(res, { ok: true, publicKey: keys.publicKey, protocolVersion: 4 });
      if (req.method === 'GET' && pathname === '/time') return json(res, { ok: true, serverTime: now() });
      if (pathname.startsWith('/admin/')) {
        if (!safeEqual(req.headers['x-admin-key'] || '', adminKey)) return json(res, { ok: false, error: '管理员身份验证失败' }, 403);
        let list = users();
        const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (req.method === 'GET' && pathname === '/admin/users') return json(res, { ok: true, users: list.map(u => ({
          username: u.username, mac: u.mac || '', expiresAt: u.expiresAt, enabled: u.enabled !== false,
          expired: !Number.isFinite(expiry(u.expiresAt)) || now() >= expiry(u.expiresAt), note: u.note || '', createdAt: u.createdAt
        })) });
        if (req.method === 'POST' && pathname === '/admin/users') {
          const b = await body(req); list = users(); const username = String(b.username || '').trim();
          if (!username || String(b.password || '').length < 8 || !Number.isFinite(expiry(b.expiresAt))) return json(res, { ok: false, error: '需填写用户名、至少 8 位密码和有效到期日期' }, 400);
          if (list.some(u => u.username === username)) return json(res, { ok: false, error: '账户已存在' }, 409);
          const salt = crypto.randomBytes(16).toString('hex');
          list.push({ username, salt, passHash: hashPass(b.password, salt), mac: String(b.mac || '').toUpperCase(),
            enabled: true, expiresAt: b.expiresAt, note: String(b.note || ''), revision: 1, createdAt: new Date(now()).toISOString() });
          save(list); return json(res, { ok: true, username });
        }
        if (req.method === 'DELETE' && parts[1] === 'users' && parts[2]) {
          invalidate(parts[2]); save(list.filter(u => u.username !== parts[2])); return json(res, { ok: true });
        }
        if (req.method === 'POST' && parts[1] === 'unbind' && parts[2]) {
          const u = list.find(x => x.username === parts[2]);
          if (!u) return json(res, { ok: false, error: '账户不存在' }, 404);
          u.mac = ''; u.revision = Number(u.revision || 0) + 1; invalidate(u.username); save(list); return json(res, { ok: true });
        }
        if (req.method === 'POST' && pathname === '/admin/reset-password') {
          const b = await body(req);
          if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.newPassword !== 'string' || b.newPassword.length < 8 || b.newPassword.length > 128) {
            return json(res, { ok: false, error: '新密码需为8到128位文本' }, 400);
          }
          list = users();
          const u = list.find(x => x.username === String(b.username || ''));
          if (!u) return json(res, { ok: false, error: '账户不存在' }, 404);
          u.salt = crypto.randomBytes(16).toString('hex');
          u.passHash = hashPass(b.newPassword, u.salt);
          u.revision = Number(u.revision || 0) + 1;
          invalidate(u.username); save(list);
          return json(res, { ok: true, username: u.username });
        }
        if (req.method === 'POST' && ['/admin/extend', '/admin/update'].includes(pathname)) {
          const b = await body(req); list = users(); const u = list.find(x => x.username === String(b.username || ''));
          if (!u) return json(res, { ok: false, error: '账户不存在' }, 404);
          if (b.expiresAt !== undefined && !Number.isFinite(expiry(b.expiresAt))) return json(res, { ok: false, error: '到期日期无效' }, 400);
          if (b.expiresAt !== undefined) u.expiresAt = b.expiresAt;
          if (b.enabled !== undefined) u.enabled = b.enabled === true;
          if (b.note !== undefined) u.note = String(b.note);
          u.revision = Number(u.revision || 0) + 1; invalidate(u.username); save(list);
          return json(res, { ok: true, expiresAt: u.expiresAt, enabled: u.enabled !== false });
        }
        return json(res, { ok: false, error: 'unknown admin api' }, 404);
      }
      if (req.method === 'POST' && pathname === '/login') {
        const b = await body(req);
        // 拒绝旧协议时不修改电脑绑定，也不继续下发旧三天离线签名。
        if (b.clientVersion !== 4) return json(res, { ok: false, error: '请升级到新版独立客户端' }, 426);
        const list = users(), u = list.find(x => x.username === String(b.username || ''));
        if (!u || !safeEqual(hashPass(b.password || '', u.salt), u.passHash)) return json(res, { ok: false, error: '账户不存在或密码错误' }, 401);
        if (!validUser(u)) return json(res, { ok: false, error: '账户已停用或授权到期，请联系管理员' }, 403);
        const mac = String(b.mac || '').toUpperCase();
        if (!/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(mac)) return json(res, { ok: false, error: '无法识别电脑标识' }, 400);
        if (u.mac && u.mac !== mac) return json(res, { ok: false, error: '账户绑定其他电脑，请联系管理员解绑' }, 403);
        if (!u.mac) { u.mac = mac; save(list); }
        const refreshToken = crypto.randomBytes(32).toString('base64url');
        for (const [key, entry] of sessions) if (entry.until <= now()) sessions.delete(key);
        sessions.set(crypto.createHash('sha256').update(refreshToken).digest('hex'), {
          username: u.username, mac, revision: Number(u.revision || 0), until: Math.min(now() + 12 * 3600000, expiry(u.expiresAt))
        });
        return json(res, { ok: true, ...sign(u), refreshToken });
      }
      if (req.method === 'POST' && pathname === '/lease') {
        const b = await body(req), key = crypto.createHash('sha256').update(String(b.refreshToken || '')).digest('hex');
        const session = sessions.get(key), u = users().find(x => x.username === String(b.username || ''));
        if (!session || session.until <= now() || session.username !== b.username || session.mac !== String(b.mac || '').toUpperCase() ||
            !validUser(u) || session.mac !== u.mac || session.revision !== Number(u.revision || 0)) {
          sessions.delete(key); return json(res, { ok: false, error: '授权已失效，请重新登录或联系管理员' }, 403);
        }
        return json(res, { ok: true, ...sign(u) });
      }
      if (req.method === 'POST' && pathname === '/changepass') {
        const b = await body(req), list = users(), u = list.find(x => x.username === String(b.username || ''));
        if (!u || !safeEqual(hashPass(b.oldPassword || '', u.salt), u.passHash)) return json(res, { ok: false, error: '账户或当前密码错误' }, 401);
        if (!validUser(u) || u.mac !== String(b.mac || '').toUpperCase()) return json(res, { ok: false, error: '账户不可用或电脑标识不符' }, 403);
        if (String(b.newPassword || '').length < 8) return json(res, { ok: false, error: '新密码至少 8 位' }, 400);
        u.salt = crypto.randomBytes(16).toString('hex'); u.passHash = hashPass(b.newPassword, u.salt);
        u.revision = Number(u.revision || 0) + 1; invalidate(u.username); save(list); return json(res, { ok: true });
      }
      return json(res, { ok: false, error: 'not found' }, 404);
    } catch (error) { return json(res, { ok: false, error: error.message }, 500); }
  });
  return { server, publicKey: keys.publicKey, dataDir, leaseMs, offlineMs };
}
if (require.main === module) {
  const { server } = createLicenseServer();
  server.listen(Number(process.env.LICENSE_PORT || 17889), '127.0.0.1', () => {
    console.log('[license] v4 已监听 127.0.0.1:' + server.address().port + '，公网必须经 HTTPS 反向代理');
  });
}
module.exports = { createLicenseServer, leasePayload };
