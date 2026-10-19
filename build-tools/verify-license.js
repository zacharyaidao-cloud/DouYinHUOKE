/** 本地隔离授权回归；只用生成的测试密钥/测试数据，不接真实授权服务器。 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createRequire } = require('module');
const { createLicenseServer } = require('../license-server/license-server');
const dir = fs.mkdtempSync(path.join(__dirname, 'qa-license-'));
let timestamp = Date.now(), ticks = 0, transportMode = 'online', requests = 0, loginPosts = 0;
const mac = 'AA:BB:CC:DD:EE:FF';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const otherPublicKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).publicKey;
const config = { license: { enabled: false, serverUrl: 'https://license.test', allowedHosts: ['license.test'], publicKey: keys.publicKey } };
const service = createLicenseServer({ dataDir: path.join(dir, 'server'), keys, adminKey: 'test-administrator-key-32-characters', now: () => timestamp });
const actualFetch = fetch;
const settings = { license: { enabled: false, serverUrl: 'http://evil.test', adminKey: 'must-not-leak' } };
async function run() {
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + service.server.address().port;
  const request = async (endpoint, payload, admin = false) => {
    const response = await actualFetch(local + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(admin ? { 'x-admin-key': 'test-administrator-key-32-characters' } : {}) }, body: JSON.stringify(payload) });
    return { status: response.status, ...(await response.json()) };
  };
  let count = 0;
  function check(value, message) { assert(value, message); count++; }
  const corruptDir = path.join(dir, 'corrupt-key'); fs.mkdirSync(corruptDir);
  fs.writeFileSync(path.join(corruptDir, 'keys.json'), '{invalid-key-file', 'utf8');
  assert.throws(() => createLicenseServer({ dataDir: corruptDir, adminKey: 'test-administrator-key-32-characters' }), /拒绝覆盖/); count++;
  check(fs.readFileSync(path.join(corruptDir, 'keys.json'), 'utf8') === '{invalid-key-file', '损坏原密钥不覆盖');
  const realRequire = createRequire(path.join(__dirname, '..', 'dy-lead-app', 'license.js'));
  const TestDate = class extends Date { static now() { return timestamp; } };
  const context = { module: { exports: {} }, Buffer, URL, AbortSignal, console, __dirname: path.join(dir, 'client'), Date: TestDate,
    require: name => name === './store' ? { DATA_DIR: path.join(dir, 'client'), getConfig: () => config, getSettings: () => settings } :
      name === 'os' ? { networkInterfaces: () => ({ test: [{ internal: false, mac }] }) } :
      name === 'perf_hooks' ? { performance: { now: () => ticks } } : realRequire(name),
    fetch: async (url, options) => {
      if (new URL(url).pathname === '/login' && options.method === 'POST') loginPosts++;
      requests++; check(url.startsWith('https://license.test/'), '只访问 HTTPS 固定域名');
      check(options.redirect === 'error', '不接受重定向');
      if (transportMode === 'offline') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      if (transportMode === 'tls') throw Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
      const response = await actualFetch(local + new URL(url).pathname, options);
      if (new URL(url).pathname === '/publickey' && ['wrong-protocol', 'wrong-key', 'html-route'].includes(transportMode)) {
        if (transportMode === 'html-route') return { ok: true, json: async () => { throw new Error('HTML route'); } };
        const result = await response.json();
        if (transportMode === 'wrong-protocol') result.protocolVersion = 3;
        else result.publicKey = otherPublicKey;
        return { ok: true, json: async () => result };
      }
      if (transportMode === 'forged') { const result = await response.json(); if (result.lease) result.lease.offlineUntil += 1000; return { ok: response.ok, json: async () => result }; }
      return response;
    } };
  fs.mkdirSync(context.__dirname, { recursive: true });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'dy-lead-app', 'license.js'), 'utf8'), context);
  const lic = context.module.exports;
  check(lic.getLicenseConfig().enabled, '本机禁用配置不绕过授权');
  check(!Object.hasOwn(lic.getLicenseConfig(), 'adminKey'), '客户无管理密钥');
  let result = await request('/admin/users', { username: 'testuser', password: 'password123', expiresAt: '2099-12-31' }, true);
  check(result.ok, '独立管理端建测试账户');
  check((await request('/admin/users', { username: 'bad-date', password: 'password123', expiresAt: '2026-99-99' }, true)).status === 400, '无效到期日期明确拒绝');
  result = await request('/login', { username: 'testuser', password: 'password123', mac });
  check(result.status === 426, '旧协议需升级');
  check(!JSON.parse(fs.readFileSync(path.join(dir, 'server', 'users.json'), 'utf8'))[0].mac, '旧协议拒绝时不修改电脑绑定');
  result = await lic.verify('testuser', 'password123'); check(result.ok, 'v4 签名登录');
  const active = result.authContext, until = active.lease.offlineUntil;
  check((await lic.assertActionAllowed(active)).ok, '每动作校验');
  const cache = JSON.parse(fs.readFileSync(path.join(context.__dirname, 'license-cache.json'), 'utf8'));
  check(!JSON.stringify(cache).includes('refreshToken'), '刷新凭证不写缓存');
  const previousPosts = loginPosts;
  for (const mode of ['wrong-protocol', 'wrong-key', 'html-route']) {
    transportMode = mode;
    check(!(await lic.verify('testuser', 'password123')).ok, '错误服务身份拒绝：' + mode);
    check(loginPosts === previousPosts, '错误服务身份不发送密码：' + mode);
  }
  transportMode = 'online';
  check((await lic.verify('testuser', 'wrong-password')).ok === false, '错误密码不能走离线回退');
  result = await lic.verify('testuser', 'password123'); check(result.ok, '重新登录');
  transportMode = 'offline';
  const offlineLogin = await lic.verify('testuser', 'password123'); check(offlineLogin.ok && offlineLogin.offline, '有效离线租约可用');
  timestamp += 2 * 60000; ticks += 2 * 60000;
  check((await lic.heartbeat(result.authContext, true)).ok, '网络失败保留固定离线窗口');
  check(result.authContext.lease.offlineUntil === until, '本地会话与失败心跳不延长离线期限');
  timestamp += 14 * 60000; ticks += 14 * 60000;
  check(!(await lic.heartbeat(result.authContext, true)).ok, '离线窗口耗尽停止');
  await assert.rejects(lic.assertActionAllowed(result.authContext), { code: 'LICENSE_REQUIRED' }); count++;
  transportMode = 'online'; result = await lic.verify('testuser', 'password123'); check(result.ok, '联网重新签发');
  transportMode = 'tls'; check(!(await lic.verify('testuser', 'password123')).ok, '证书过期不能降级离线');
  transportMode = 'online'; result = await lic.verify('testuser', 'password123'); check(result.ok, '证书恢复后登录');
  transportMode = 'forged'; check(!(await lic.heartbeat(result.authContext, true)).ok, '篡改签名载荷拒绝');
  transportMode = 'online'; result = await lic.verify('testuser', 'password123');
  await request('/admin/update', { username: 'testuser', enabled: false }, true);
  check(!(await lic.heartbeat(result.authContext, true)).ok && result.authContext.revoked, '在线停用撤销并停止');
  await request('/admin/update', { username: 'testuser', enabled: true }, true);
  config.license.serverUrl = 'http://license.test'; const before = requests;
  check(!(await lic.verify('testuser', 'password123')).ok && requests === before, 'HTTP 配置不发送任何凭证');
  config.license.serverUrl = 'https://evil.test';
  check(!(await lic.verify('testuser', 'password123')).ok && requests === before, '非可信域名不发送任何凭证');
  config.license.serverUrl = 'https://license.test'; config.license.publicKey = keys.privateKey;
  check(!(await lic.verify('testuser', 'password123')).ok && requests === before, '误填私钥配置不发凭证');
  console.log('PASS: ' + count + ' 授权安全与租约验证');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  service.server.close();
  // 路径来自工作区 mkdtemp，拒绝清理越界路径。
  if (path.dirname(dir) === __dirname && path.basename(dir).startsWith('qa-license-')) fs.rmSync(dir, { recursive: true, force: true });
});
