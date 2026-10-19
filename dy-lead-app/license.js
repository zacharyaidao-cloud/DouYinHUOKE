/** 客户版授权：HTTPS、RSA 签名短租约、有限离线窗口。客户端不保存管理能力。 */
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const store = require('./store');
const activeContexts = new Set();
const CHECK_INTERVAL_MS = 60 * 1000;
let clockAnchor = 0;
let clockStarted = performance.now();

function cacheFile() { return path.join(store.DATA_DIR, 'license-cache.json'); }
function timeFile() { return path.join(store.DATA_DIR, 'servertime.json'); }
function getMac() {
  for (const values of Object.values(os.networkInterfaces())) {
    for (const it of values || []) {
      if (!it.internal && it.mac && it.mac !== '00:00:00:00:00:00') return it.mac.toUpperCase();
    }
  }
  return 'UNKNOWN';
}
function getLicenseConfig() {
  // 内置发行配置是唯一信任源；旧 settings.license 不可关闭授权或改信任域名。
  let lic;
  // 新发行配置每次升级覆盖；旧 config.json 的 dataDir 保留，HTTP 授权配置不延续。
  try { lic = JSON.parse(fs.readFileSync(path.join(__dirname, 'trusted-license.json'), 'utf8')); }
  catch { lic = store.getConfig()?.license || {}; }
  return { enabled: true, serverUrl: String(lic.serverUrl || ''), publicKey: String(lic.publicKey || ''),
    allowedHosts: Array.isArray(lic.allowedHosts) ? lic.allowedHosts.map(x => String(x).toLowerCase()) : [] };
}
function trustedBase(lic = getLicenseConfig()) {
  let u;
  try { u = new URL(lic.serverUrl); }
  catch { throw new Error('客户版尚未配置 HTTPS 授权域名，请联系软件提供方'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash ||
      !lic.allowedHosts.includes(u.host.toLowerCase()) || !lic.publicKey) {
    throw new Error('客户版需配置 HTTPS 授权域名、可信域名列表与 RSA 公钥，请联系软件提供方');
  }
  if (!/^\s*-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(lic.publicKey) || /PRIVATE KEY/.test(lic.publicKey)) {
    throw new Error('客户授权配置只允许 RSA 公钥，请联系软件提供方');
  }
  try { if (crypto.createPublicKey(lic.publicKey).asymmetricKeyType !== 'rsa') throw new Error(); }
  catch { throw new Error('客户授权配置中的 RSA 公钥无效'); }
  return u.href.replace(/\/+$/, '');
}
function getMaxServerTime() {
  try { return Number(JSON.parse(fs.readFileSync(timeFile(), 'utf8')).maxServerTime) || 0; } catch { return 0; }
}
function effectiveNow() {
  if (!clockAnchor) { clockAnchor = Math.max(Date.now(), getMaxServerTime()); clockStarted = performance.now(); }
  return Math.max(Date.now(), getMaxServerTime(), clockAnchor + performance.now() - clockStarted);
}
function setMaxServerTime(t) {
  const v = Math.max(effectiveNow(), Number(t) || 0);
  clockAnchor = v; clockStarted = performance.now();
  try { fs.writeFileSync(timeFile(), JSON.stringify({ maxServerTime: v }), 'utf8'); } catch { /* 内存时钟仍有效 */ }
  return v;
}
function leasePayload(lease) {
  return JSON.stringify({ version: lease.version, username: lease.username, mac: lease.mac, expiresAt: lease.expiresAt,
    serverTime: lease.serverTime, leaseUntil: lease.leaseUntil, offlineUntil: lease.offlineUntil, nonce: lease.nonce });
}
function expiresMs(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return NaN;
  const ms = Date.parse(date + 'T23:59:59.999+08:00');
  if (!Number.isFinite(ms)) return NaN;
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10) === date ? ms : NaN;
}
function signedLeaseValid(lease, sig, username) {
  try {
    if (lease?.version !== 4 || lease.username !== username || lease.mac !== getMac() ||
        !Number.isFinite(expiresMs(lease.expiresAt)) || !Number.isSafeInteger(lease.serverTime) ||
        !Number.isSafeInteger(lease.leaseUntil) || !Number.isSafeInteger(lease.offlineUntil) ||
        lease.leaseUntil <= lease.serverTime || lease.offlineUntil < lease.leaseUntil ||
        lease.offlineUntil > expiresMs(lease.expiresAt) || typeof lease.nonce !== 'string') return false;
    return crypto.verify('sha256', Buffer.from(leasePayload(lease)), getLicenseConfig().publicKey, Buffer.from(sig, 'base64'));
  } catch { return false; }
}
function validateContext(context) {
  if (!context || context.revoked || !signedLeaseValid(context.lease, context.sig, context.username)) {
    return { ok: false, error: context?.error || '授权无效，请重新登录' };
  }
  if (effectiveNow() >= context.lease.offlineUntil) return { ok: false, error: '授权租约已过期，请联网重新登录' };
  if (context.offline && Date.now() + 60000 < getMaxServerTime()) return { ok: false, error: '电脑时间发生回退，请校准时间并联网登录' };
  return { ok: true, offline: !!context.offline, expiresAt: context.lease.expiresAt,
    leaseUntil: context.lease.leaseUntil, offlineUntil: context.lease.offlineUntil };
}
async function request(endpoint, body, method = 'POST') {
  const url = trustedBase() + endpoint;
  let response;
  try {
    response = await fetch(url, { method, redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  } catch (error) {
    const cause = String(error?.cause?.code || error?.code || '');
    const blocked = /CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED|REDIRECT/i.test(cause + ' ' + error.message);
    throw Object.assign(new Error(blocked ? '授权服务器证书或连接安全校验失败' : '授权服务器暂时无法连接'), { networkUnavailable: !blocked });
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('授权服务器返回格式错误'); }
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || '授权服务器拒绝请求'), { rejected: true });
  return result;
}
async function checkServerIdentity() {
  const identity = await request('/publickey', undefined, 'GET');
  if (identity.protocolVersion !== 4 || !/^\s*-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(String(identity.publicKey || ''))) {
    throw new Error('授权服务尚未完成新版部署，请联系软件提供方；未发送登录密码');
  }
  let expected, actual;
  try {
    expected = crypto.createPublicKey(getLicenseConfig().publicKey).export({ type: 'spki', format: 'der' });
    actual = crypto.createPublicKey(identity.publicKey).export({ type: 'spki', format: 'der' });
  } catch { throw new Error('授权服务器公钥无法识别；未发送登录密码'); }
  if (!expected.equals(actual)) throw new Error('授权服务器公钥与发行配置不符；未发送登录密码');
}
function writeCache(context, password) {
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { /* 首次登录 */ }
  const passwordSalt = password !== undefined ? crypto.randomBytes(16).toString('hex') : previous.passwordSalt;
  const passwordHash = password !== undefined ? crypto.scryptSync(String(password), passwordSalt, 32).toString('hex') : previous.passwordHash;
  try { fs.writeFileSync(cacheFile(), JSON.stringify({ version: 4, lease: context.lease, sig: context.sig, passwordSalt, passwordHash }, null, 2), 'utf8'); } catch { /* 不承诺离线可用 */ }
}
function revoke(context, error) {
  if (context) { context.revoked = true; context.error = error; context.refreshToken = ''; }
  try { fs.unlinkSync(cacheFile()); } catch { /* 缓存不存在 */ }
}
function acceptResponse(result, username, refreshToken) {
  if (!signedLeaseValid(result.lease, result.sig, username)) throw new Error('授权服务器签名验证失败');
  setMaxServerTime(result.lease.serverTime);
  const context = { username, lease: result.lease, sig: result.sig, refreshToken: result.refreshToken || refreshToken || '',
    offline: false, lastCheckAt: effectiveNow(), revoked: false };
  const check = validateContext(context);
  if (!check.ok) throw new Error(check.error);
  activeContexts.add(context);
  return context;
}
async function verify(username, password) {
  try { trustedBase(); } catch (error) { return { ok: false, error: error.message }; }
  username = String(username || '').trim();
  try {
    await checkServerIdentity();
    const result = await request('/login', { username, password, mac: getMac(), clientVersion: 4 });
    const authContext = acceptResponse(result, username);
    writeCache(authContext, password);
    return { ok: true, username, mac: getMac(), expiresAt: authContext.lease.expiresAt, authContext };
  } catch (error) {
    if (!error.networkUnavailable) { revoke(null, error.message); return { ok: false, error: error.message }; }
    try {
      const cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      if (cache.version !== 4 || !cache.passwordSalt || !cache.passwordHash) throw new Error('旧缓存需联网换取新授权');
      const hash = crypto.scryptSync(String(password), cache.passwordSalt, 32).toString('hex');
      const actual = Buffer.from(hash, 'hex'), expected = Buffer.from(cache.passwordHash, 'hex');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('密码错误');
      const authContext = { username, lease: cache.lease, sig: cache.sig, refreshToken: '', offline: true, revoked: false, lastCheckAt: 0 };
      const check = validateContext(authContext);
      if (!check.ok) throw new Error(check.error);
      activeContexts.add(authContext);
      return { ok: true, username, mac: getMac(), expiresAt: cache.lease.expiresAt, offline: true, authContext };
    } catch { return { ok: false, error: '无法连接授权服务器，且无有效离线租约；请联网登录' }; }
  }
}
async function heartbeat(context, force = false) {
  const current = validateContext(context);
  if (!context || context.revoked) return current;
  if (!context.refreshToken) return current;
  if (!force && current.ok && effectiveNow() - context.lastCheckAt < CHECK_INTERVAL_MS &&
      effectiveNow() < context.lease.leaseUntil) return current;
  if (context.pending) return context.pending;
  context.pending = (async () => {
    try {
      const result = await request('/lease', { username: context.username, mac: getMac(), refreshToken: context.refreshToken });
      const next = acceptResponse(result, context.username, context.refreshToken);
      activeContexts.delete(next);
      Object.assign(context, next);
      writeCache(context);
      return validateContext(context);
    } catch (error) {
      if (error.networkUnavailable) { context.offline = true; return validateContext(context); }
      revoke(context, error.message);
      return { ok: false, error: error.message };
    } finally { context.pending = null; }
  })();
  return context.pending;
}
async function assertActionAllowed(context) {
  const result = await heartbeat(context);
  if (!result.ok) throw Object.assign(new Error(result.error), { code: 'LICENSE_REQUIRED' });
  setMaxServerTime(effectiveNow());
  return result;
}
function clearSession(context) {
  if (context) { context.refreshToken = ''; context.revoked = true; activeContexts.delete(context); }
}
async function changePassword(username, oldPassword, newPassword) {
  if (String(newPassword || '').length < 8) return { ok: false, error: '新密码至少需要 8 位' };
  try {
    await request('/changepass', { username, oldPassword, newPassword, mac: getMac() });
    for (const context of activeContexts) if (context.username === username) revoke(context, '密码已修改，请重新登录');
    return { ok: true, relogin: true };
  } catch (error) { return { ok: false, error: error.message }; }
}
async function syncTime() { await Promise.all([...activeContexts].map(context => heartbeat(context))); }
function status() {
  const lic = getLicenseConfig();
  const context = [...activeContexts].find(x => validateContext(x).ok);
  let configurationError = '';
  try { trustedBase(lic); } catch (error) { configurationError = error.message; }
  return { enabled: true, serverUrl: lic.serverUrl, mac: getMac(), configurationError, protocolVersion: 4,
    serverTime: getMaxServerTime() ? new Date(getMaxServerTime()).toISOString() : '',
    cache: context ? { username: context.username, expiresAt: context.lease.expiresAt, offline: context.offline,
      leaseUntil: context.lease.leaseUntil, offlineUntil: context.lease.offlineUntil } : null };
}
module.exports = { verify, changePassword, syncTime, getMac, status, effectiveNow, getLicenseConfig,
  assertActionAllowed, heartbeat, validateContext, clearSession, leasePayload };
