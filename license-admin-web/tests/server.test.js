'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { createAdminWebServer, BASE_PATH, validDate } = require('../server');
const { initializeAdmin } = require('../init-admin');
const ORIGIN = 'https://huamao.xyz';
const KEY = 'test-only-gateway-key-with-32-characters';
const PASSWORD = 'test-only-new-admin-password-12345';
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
function close(server) { return new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }); }
async function fixture(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-admin-test-'));
  const webDir = path.join(dir, 'web'); fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>管理授权</title><script src="app.js" defer></script>');
  fs.writeFileSync(path.join(webDir, 'app.js'), 'document.title="管理授权";');
  const initialized = initializeAdmin({ dataDir: path.join(dir, 'private'), password: PASSWORD });
  const calls = [];
  const users = [];
  let active = 0, maxActive = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = raw ? JSON.parse(raw) : null;
    const call = { method: req.method, path: req.url, key: req.headers['x-admin-key'], payload }; calls.push(call);
    assert.equal(call.key, KEY);
    active++; maxActive = Math.max(maxActive, active);
    if (settings.delay) await new Promise(resolve => setTimeout(resolve, settings.delay));
    let status = 200, result = { ok: true };
    if (settings.upstreamFailure) { status = 500; result = { ok: false, error: 'private-secret-' + KEY + '-filesystem-path' }; }
    else if (req.method === 'GET' && req.url === '/admin/users') result = { ok: true, users };
    else if (req.method === 'POST' && req.url === '/admin/users') {
      if (users.some(u => u.username === payload.username)) { status = 409; result = { ok: false, error: '账户已存在' }; }
      else users.push({ ...payload, password: undefined, enabled: true, expired: false, mac: '', createdAt: '2026-10-08T00:00:00.000Z', salt: 'private-salt', passHash: 'private-hash' });
    } else if (req.url === '/admin/update') {
      const user = users.find(u => u.username === payload.username);
      if (!user) { status = 404; result = { ok: false }; } else Object.assign(user, payload);
    } else if (req.url.startsWith('/admin/unbind/')) {
      const user = users.find(u => u.username === decodeURIComponent(req.url.slice('/admin/unbind/'.length)));
      if (!user) { status = 404; result = { ok: false }; } else user.mac = '';
    } else if (req.url === '/admin/reset-password') {
      if (!users.some(u => u.username === payload.username)) { status = 404; result = { ok: false }; }
    } else if (req.method === 'DELETE' && req.url.startsWith('/admin/users/')) {
      const username = decodeURIComponent(req.url.slice('/admin/users/'.length));
      const index = users.findIndex(u => u.username === username); if (index >= 0) users.splice(index, 1);
    } else { status = 404; result = { ok: false }; }
    active--; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await listen(upstream);
  const app = createAdminWebServer({ dataDir: initialized.dataDir, webDir, adminKey: KEY,
    licensePort: upstream.address().port, now: settings.now, idleMs: settings.idleMs, absoluteMs: settings.absoluteMs,
    maxRateEntries: settings.maxRateEntries });
  await listen(app.server);
  t.after(async () => { await close(app.server); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = 'http://127.0.0.1:' + app.server.address().port;
  let cookie = '', csrf = '';
  async function request(route, { method = 'GET', value, origin = ORIGIN, token = csrf, useCookie = true, headers = {} } = {}) {
    const response = await fetch(address + BASE_PATH + route, { method, headers: { ...(useCookie && cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': token } : {}), ...headers },
      body: value !== undefined ? JSON.stringify(value) : undefined, redirect: 'manual' });
    const raw = await response.text();
    let result; try { result = JSON.parse(raw); } catch { result = raw; }
    return { response, result, raw };
  }
  async function login() {
    const answer = await request('api/login', { method: 'POST', value: { username: 'admin', password: PASSWORD } });
    assert.equal(answer.response.status, 200);
    cookie = answer.response.headers.get('set-cookie').split(';')[0]; csrf = answer.result.csrfToken;
    return answer;
  }
  return { app, dir, initialized, calls, users, request, login, address, get cookie() { return cookie; }, get csrf() { return csrf; }, get maxActive() { return maxActive; } };
}
test('初始化只写独立随机密码的哈希，拒绝覆盖已有账户', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-admin-init-'));
  try {
    const result = initializeAdmin({ dataDir: dir });
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'admin.json')));
    const text = fs.readFileSync(result.credentialsFile, 'utf8');
    const password = text.match(/密码：([^\r\n]+)/)[1];
    assert.equal(data.username, 'admin'); assert.ok(password.length >= 24);
    assert.equal(data.passwordHash, crypto.scryptSync(password, data.salt, 32).toString('hex'));
    assert.ok(!JSON.stringify(data).includes(password)); assert.ok(!('password' in data));
    assert.throws(() => initializeAdmin({ dataDir: dir }), /拒绝覆盖/);
    assert.equal(fs.readFileSync(result.credentialsFile, 'utf8'), text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('禁止无效日期、非 HTTPS Origin、不足管理密钥和任意上游端口', () => {
  assert.equal(validDate('2026-02-29'), false); assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2026-13-01'), false); assert.equal(validDate('2026-10-08'), true);
  const credentials = { username: 'admin', salt: 'a'.repeat(32), passwordHash: 'b'.repeat(64) };
  assert.throws(() => createAdminWebServer({ credentials, adminKey: 'short' }), /管理密钥/);
  assert.throws(() => createAdminWebServer({ credentials, adminKey: KEY, publicOrigin: 'http://huamao.xyz' }), /HTTPS/);
  assert.throws(() => createAdminWebServer({ credentials, adminKey: KEY, publicOrigin: 'https://huamao.xyz/path' }), /HTTPS/);
  assert.throws(() => createAdminWebServer({ credentials, adminKey: KEY, licensePort: 'https://evil.example' }), /端口/);
});
test('登录返回安全 cookie 和 CSRF，浏览器永远看不到管理密钥或密码哈希', async t => {
  const f = await fixture(t);
  const before = await f.request('api/me'); assert.equal(before.result.authenticated, false);
  const login = await f.login(); const cookie = login.response.headers.get('set-cookie');
  assert.match(cookie, /__Secure-dyAdmin=/); assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/dy-license\/manage\//);
  assert.equal(login.result.csrfToken.length, 43);
  const me = await f.request('api/me'); assert.equal(me.result.authenticated, true); assert.equal(me.result.username, 'admin');
  assert.ok(!me.raw.includes(KEY)); assert.ok(!me.raw.includes(PASSWORD)); assert.ok(!me.raw.includes('passwordHash'));
  assert.equal(me.response.headers.get('cache-control'), 'no-store');
});
test('未登录不能获取用户、审计或发起管理写入', async t => {
  const f = await fixture(t);
  for (const route of ['api/users', 'api/audit']) assert.equal((await f.request(route)).response.status, 401);
  assert.equal((await f.request('api/users', { method: 'POST', value: { username: 'foo' } })).response.status, 401);
  assert.equal(f.calls.length, 0);
});

test('完整 MAC 仅在已登录账户白名单中返回，未绑定保留空值且不暴露私密字段', async t => {
  const f = await fixture(t);
  f.users.push({ username: 'mac-example', mac: 'AA:BB:CC:DD:EE:FF', expiresAt: '2026-12-31', enabled: true, expired: false, note: '虚构测试账户', salt: 'not-for-browser', passHash: 'private-test-hash', refreshToken: 'private-test-token' },
    { username: 'unbound-example', expiresAt: '2026-12-31', enabled: true });
  assert.equal((await f.request('api/users')).response.status, 401);
  await f.login(); const list = await f.request('api/users');
  assert.equal(list.result.users[0].mac, 'AA:BB:CC:DD:EE:FF'); assert.equal(list.result.users[1].mac, '');
  assert.deepEqual(Object.keys(list.result.users[0]).sort(), ['createdAt', 'enabled', 'expired', 'expiresAt', 'mac', 'note', 'username']);
  assert.doesNotMatch(list.raw, /not-for-browser|private-test-hash|private-test-token/);
});
test('跨站登录、跨站写入和缺失/错误 CSRF 均被拒绝', async t => {
  const f = await fixture(t);
  const crossLogin = await f.request('api/login', { method: 'POST', origin: 'https://evil.example', value: { username: 'admin', password: PASSWORD } });
  assert.equal(crossLogin.response.status, 403);
  await f.login();
  const value = { username: 'test', password: 'new-password', expiresAt: '2026-12-31' };
  assert.equal((await f.request('api/users', { method: 'POST', origin: 'https://evil.example', value })).response.status, 403);
  assert.equal((await f.request('api/users', { method: 'POST', token: '', value })).response.status, 403);
  assert.equal((await f.request('api/users', { method: 'POST', token: 'incorrect', value })).response.status, 403);
  assert.equal(f.calls.length, 0);
});
test('创建、续期、停用、解绑、重置密码和删除只走固定本机接口，安全字段白名单', async t => {
  const f = await fixture(t); await f.login();
  const username = '测试.customer'; const encoded = encodeURIComponent(username);
  assert.equal((await f.request('api/users', { method: 'POST', value: { username, password: 'customer-password', expiresAt: '2026-11-30', note: '<img src=x onerror=alert(1)>' } })).response.status, 200);
  assert.equal((await f.request('api/users/' + encoded + '/update', { method: 'POST', value: { expiresAt: '2027-01-31', enabled: false, note: '已续期' } })).response.status, 200);
  f.users[0].mac = 'AA:BB:CC:DD:EE:FF';
  assert.equal((await f.request('api/users/' + encoded + '/unbind', { method: 'POST', value: {} })).response.status, 200);
  assert.equal((await f.request('api/users/' + encoded + '/reset-password', { method: 'POST', value: { newPassword: 'new-customer-password' } })).response.status, 200);
  const list = await f.request('api/users'); assert.equal(list.result.users.length, 1);
  assert.equal(list.result.users[0].enabled, false); assert.equal(list.result.users[0].mac, '');
  assert.ok(!list.raw.includes('private-salt')); assert.ok(!list.raw.includes('private-hash')); assert.ok(!list.raw.includes('customer-password'));
  assert.equal((await f.request('api/users/' + encoded + '/delete', { method: 'POST', value: { confirmation: 'wrong' } })).response.status, 400);
  assert.equal(f.users.length, 1);
  assert.equal((await f.request('api/users/' + encoded + '/delete', { method: 'POST', value: { confirmation: username } })).response.status, 200);
  assert.equal(f.users.length, 0);
  assert.deepEqual(f.calls.map(c => c.path), ['/admin/users', '/admin/update', '/admin/unbind/' + encoded, '/admin/reset-password', '/admin/users', '/admin/users/' + encoded]);
  const audit = await f.request('api/audit');
  assert.deepEqual(audit.result.events.slice(0, 6).map(e => e.action), ['delete', 'delete', 'reset-password', 'unbind', 'update', 'create']);
  assert.match(audit.result.events[0].timestamp, /\+08:00$/);
  const auditRaw = fs.readFileSync(path.join(f.initialized.dataDir, 'audit.jsonl'), 'utf8');
  assert.ok(!auditRaw.includes(KEY)); assert.ok(!auditRaw.includes('customer-password')); assert.ok(!auditRaw.includes(PASSWORD));
});
test('输入验证拦截假日期、短密码、路径用户名、隐含启用转换和任意 URL/key 字段', async t => {
  const f = await fixture(t); await f.login();
  const good = { username: 'customer', password: 'new-password', expiresAt: '2026-12-31' };
  for (const value of [{ ...good, expiresAt: '2026-02-29' }, { ...good, password: 'short' }, { ...good, username: '../admin' },
    { ...good, username: 123 }, { ...good, url: 'http://evil.example' }, { ...good, adminKey: 'attacker' }, { ...good, note: 'x'.repeat(1001) }, null, []]) {
    assert.equal((await f.request('api/users', { method: 'POST', value })).response.status, 400);
  }
  assert.equal((await f.request('api/users/customer/update', { method: 'POST', value: { enabled: 'false' } })).response.status, 400);
  assert.equal((await f.request('api/users/customer/update', { method: 'POST', value: {} })).response.status, 400);
  assert.equal((await f.request('api/users/customer%2Fadmin/unbind', { method: 'POST', value: {} })).response.status, 400);
  assert.equal(f.calls.length, 0);
});
test('退出立即使旧 cookie 失效', async t => {
  const f = await fixture(t); await f.login(); const old = f.cookie;
  const logout = await f.request('api/logout', { method: 'POST', value: {} });
  assert.equal(logout.response.status, 200); assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);
  const next = await f.request('api/users', { headers: { Cookie: old } }); assert.equal(next.response.status, 401);
});
test('会话闲置过期，持续使用也无法延长绝对到期时间', async t => {
  let time = 100000;
  const f = await fixture(t, { now: () => time, idleMs: 1000, absoluteMs: 3000 });
  await f.login(); time += 1001;
  assert.equal((await f.request('api/me')).result.authenticated, false);
  await f.login();
  for (let i = 0; i < 3; i++) { time += 900; assert.equal((await f.request('api/me')).result.authenticated, true); }
  time += 301; assert.equal((await f.request('api/me')).result.authenticated, false);
});
test('同一用户名跨 IP 的密码尝试仍被限速，窗口过去可以重新登录', async t => {
  let time = 100000; const f = await fixture(t, { now: () => time });
  for (let i = 0; i < 5; i++) {
    const fail = await f.request('api/login', { method: 'POST', value: { username: 'admin', password: 'wrong-pass' }, headers: { 'X-Forwarded-For': '192.0.2.' + (i + 1) } });
    assert.equal(fail.response.status, 401); assert.equal(fail.result.error, '用户名或密码错误');
  }
  const blocked = await f.request('api/login', { method: 'POST', value: { username: 'admin', password: PASSWORD }, headers: { 'X-Forwarded-For': '192.0.2.99' } });
  assert.equal(blocked.response.status, 429); assert.equal(blocked.response.headers.get('retry-after'), '600');
  time += 10 * 60000 + 1; await f.login();
});
test('同一 IP 随机用户名也被限速且限流表占满时拒绝新尝试', async t => {
  const f = await fixture(t, { maxRateEntries: 4 });
  for (let i = 0; i < 3; i++) assert.equal((await f.request('api/login', { method: 'POST', value: { username: 'unknown' + i, password: 'wrong-pass' } })).response.status, 401);
  assert.equal((await f.request('api/login', { method: 'POST', value: { username: 'new-name', password: 'wrong-pass' } })).response.status, 429);
});
test('明确请求大小和内容类型限制', async t => {
  const f = await fixture(t); await f.login();
  assert.equal((await f.request('api/users', { method: 'POST', value: { note: 'x'.repeat(20000) } })).response.status, 413);
  assert.equal((await f.request('api/users', { method: 'POST', value: {}, headers: { 'Content-Type': 'text/plain' } })).response.status, 415);
  assert.equal(f.calls.length, 0);
});
test('静态资源 CSP 无 inline/unsafe-eval，配置和私有凭据不可获取', async t => {
  const f = await fixture(t);
  const page = await f.request(''); assert.equal(page.response.status, 200);
  const csp = page.response.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/); assert.ok(!csp.includes('unsafe-inline')); assert.ok(!csp.includes('unsafe-eval'));
  assert.match(csp, /frame-ancestors 'none'/); assert.equal(page.response.headers.get('x-content-type-options'), 'nosniff');
  for (const route of ['admin-data/admin.json', 'server.js', 'init-admin.js', '%2e%2e/admin-data/admin.json', '%2e%2e%2fadmin.json', '管理端配置.env']) {
    assert.equal((await f.request(route)).response.status, 404);
  }
  assert.equal((await f.request('app.js')).response.status, 200);
});
test('上游错误统一脱敏，不给浏览器暴露密钥和服务端路径', async t => {
  const f = await fixture(t, { upstreamFailure: true }); await f.login();
  const response = await f.request('api/users'); assert.equal(response.response.status, 503);
  assert.ok(!response.raw.includes(KEY)); assert.ok(!response.raw.includes('filesystem-path'));
  assert.equal(response.result.error, '授权服务暂不可用，请稍后重试');
});
test('并发写操作在网关顺序处理，防止授权文件更新丢失', async t => {
  const f = await fixture(t, { delay: 30 }); await f.login();
  const result = await Promise.all(Array.from({ length: 5 }, (_, index) => f.request('api/users', { method: 'POST', value: {
    username: 'customer' + index, password: 'customer-password', expiresAt: '2026-12-31'
  } })));
  assert.ok(result.every(r => r.response.status === 200)); assert.equal(f.users.length, 5); assert.equal(f.maxActive, 1);
});
test('排队请求在真正调用授权服务前再次校验会话，退出后不会继续执行', async t => {
  const f = await fixture(t, { delay: 100 }); await f.login();
  const first = f.request('api/users', { method: 'POST', value: { username: 'first', password: 'customer-password', expiresAt: '2026-12-31' } });
  const second = f.request('api/users', { method: 'POST', value: { username: 'second', password: 'customer-password', expiresAt: '2026-12-31' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.request('api/logout', { method: 'POST', value: {} })).response.status, 200);
  assert.equal((await first).response.status, 200); assert.equal((await second).response.status, 401);
  assert.deepEqual(f.users.map(u => u.username), ['first']);
});
test('真实隔离 v4 授权服务集成：停用、重置密码、解绑和删除立即撤销旧租约', async t => {
  const { createLicenseServer } = require('../../license-server/license-server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-admin-v4-'));
  const dataDir = path.join(dir, 'admin'); initializeAdmin({ dataDir, password: PASSWORD });
  const license = createLicenseServer({ adminKey: KEY, dataDir: path.join(dir, 'license') });
  await listen(license.server);
  const app = createAdminWebServer({ dataDir, adminKey: KEY, licensePort: license.server.address().port });
  await listen(app.server);
  t.after(async () => { await close(app.server); await close(license.server); fs.rmSync(dir, { recursive: true, force: true }); });
  const adminAddress = 'http://127.0.0.1:' + app.server.address().port + BASE_PATH;
  const licenseAddress = 'http://127.0.0.1:' + license.server.address().port;
  let cookie, token;
  async function admin(route, value) {
    const response = await fetch(adminAddress + route, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': token } : {}) }, body: JSON.stringify(value) });
    const result = await response.json(); return { response, result };
  }
  async function client(route, value) {
    const response = await fetch(licenseAddress + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    return { response, result: await response.json() };
  }
  const authenticated = await admin('api/login', { username: 'admin', password: PASSWORD });
  assert.equal(authenticated.response.status, 200);
  cookie = authenticated.response.headers.get('set-cookie').split(';')[0]; token = authenticated.result.csrfToken;
  assert.equal((await admin('api/users', { username: 'integration', password: 'customer-old-password', expiresAt: '2099-12-31', note: '测试' })).response.status, 200);
  const login = password => client('/login', { username: 'integration', password, clientVersion: 4, mac: 'AA:BB:CC:DD:EE:FF' });
  let session = await login('customer-old-password'); assert.equal(session.response.status, 200);
  const lease = entry => client('/lease', { username: 'integration', mac: 'AA:BB:CC:DD:EE:FF', refreshToken: entry.result.refreshToken });
  assert.equal((await lease(session)).response.status, 200);
  assert.equal((await admin('api/users/integration/update', { enabled: false })).response.status, 200);
  assert.equal((await lease(session)).response.status, 403); assert.equal((await login('customer-old-password')).response.status, 403);
  assert.equal((await admin('api/users/integration/update', { enabled: true, expiresAt: '2099-11-30' })).response.status, 200);
  session = await login('customer-old-password'); assert.equal(session.response.status, 200);
  assert.equal((await admin('api/users/integration/reset-password', { newPassword: 'customer-new-password' })).response.status, 200);
  assert.equal((await lease(session)).response.status, 403); assert.equal((await login('customer-old-password')).response.status, 401);
  session = await login('customer-new-password'); assert.equal(session.response.status, 200);
  assert.equal((await admin('api/users/integration/unbind', {})).response.status, 200);
  assert.equal((await lease(session)).response.status, 403);
  session = await login('customer-new-password'); assert.equal(session.response.status, 200);
  assert.equal((await admin('api/users/integration/delete', { confirmation: 'integration' })).response.status, 200);
  assert.equal((await lease(session)).response.status, 403); assert.equal((await login('customer-new-password')).response.status, 401);
  assert.equal((await client('/login', { username: 'admin', password: PASSWORD, clientVersion: 4, mac: 'AA:BB:CC:DD:EE:FF' })).response.status, 401);
});
