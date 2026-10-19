/** 打包后台真实 HTTPS 授权验收；不启动浏览器、不采集、不请求AI、不发送任何私信。 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { loadAccount } = require('./provision-test-account');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'dy-lead-app-release');
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-live-license-'));
const desktopToken = crypto.randomBytes(32).toString('hex');
let child;
let stage = 'load_credentials';
async function main() {
  const account = loadAccount();
  stage = 'start_backend';
  child = spawn(path.join(APP, 'node.exe'), [path.join(APP, 'server.js')], { cwd: APP, windowsHide: true,
    env: { ...process.env, DY_LEAD_DATA_DIR: fixture, DY_LEAD_PORT: '0', DY_LEAD_DESKTOP_TOKEN: desktopToken, DY_LEAD_NO_OPEN: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('隔离后台启动超时')), 30000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('隔离后台启动失败')); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('隔离后台提前退出')); });
    child.on('message', message => { if (message?.type === 'ready') { clearTimeout(timeout); resolve(message.port); } });
  });
  const base = 'http://127.0.0.1:' + port;
  let token = '';
  const request = async (endpoint, body) => {
    const response = await fetch(base + '/api' + endpoint, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-desktop-token': desktopToken, ...(token ? { 'x-auth-token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return { status: response.status, ...(await response.json()) };
  };
  stage = 'https_login';
  const login = await request('/login', { username: account.username, password: account.password });
  assert(login.ok && login.token && login.role === 'user', '普通账户真实 HTTPS 登录');
  assert(!login.authContext && !login.refreshToken, '刷新凭证不能下发给界面');
  token = login.token;
  stage = 'state';
  const state = await request('/state');
  assert(state.ok && state.role === 'user' && state.loginUser === 'huamao', '打包后台普通用户状态');
  assert(state.license.protocolVersion === 4 && !state.license.configurationError && state.license.cache?.leaseUntil, '签名 v4 租约有效');
  assert(state.license.serverUrl.replace(/\/+$/, '') === 'https://huamao.xyz/dy-license', '正式 HTTPS 授权地址');
  assert(!JSON.stringify(state).includes('refreshToken') && !Object.hasOwn(state.settings.license, 'adminKey'), '状态无管理密钥/刷新凭证');
  assert((await request('/license-admin/users')).status === 404, '客户版管理员入口不存在');
  assert((await request('/tasks/stop', {})).ok, '停止始终可用');
  stage = 'cache';
  const cache = JSON.parse(fs.readFileSync(path.join(fixture, 'license-cache.json'), 'utf8'));
  assert(cache.version === 4 && cache.lease.username === 'huamao' && !cache.refreshToken, '签名租约写入隔离缓存');
  stage = 'logout';
  assert((await request('/logout', {})).ok, '正常退出登录');
  assert((await request('/state')).status === 401, '退出后的授权会话失效');
  const report = { ok: true, version: '2.0.0', username: 'huamao', role: 'user', protocolVersion: 4,
    serverUrl: 'https://huamao.xyz/dy-license', expiresAt: account.expiresAt,
    checks: ['真实 HTTPS 登录', 'RSA v4 签名租约', '客户版无管理员', '状态无管理密钥/刷新凭证', '停止可用', '退出会话失效'],
    businessOperations: 0 };
  fs.writeFileSync(path.join(__dirname, 'live-license-verification.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('PASS: 打包后台真实 HTTPS 登录、RSA 签名租约、普通用户状态、无管理员、停止及退出；业务操作 0 次');
}
main().catch(() => { console.error('真实 HTTPS 授权验收未通过（阶段：' + stage + '）；未执行平台或 AI 业务操作。'); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) {
    if (child.connected) child.send({ type: 'shutdown' });
    await new Promise(resolve => { const timeout = setTimeout(() => { child.kill(); resolve(); }, 10000); child.once('exit', () => { clearTimeout(timeout); resolve(); }); });
  }
  if (path.dirname(fixture) === __dirname && path.basename(fixture).startsWith('qa-live-license-')) fs.rmSync(fixture, { recursive: true, force: true });
});
