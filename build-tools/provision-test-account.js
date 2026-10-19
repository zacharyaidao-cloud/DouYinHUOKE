/** 创建本人的普通测试账户。使用全新随机密码，不读取/复用原安装管理员密码。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const ACCOUNT_FILE = path.join(ROOT, 'license-server', '本人测试账户.txt');
function loadAdminEnvironment() {
  const text = fs.readFileSync(path.join(ROOT, 'license-server', '管理端配置.env'), 'utf8').replace(/^\uFEFF/, '');
  const environment = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) environment[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const base = new URL(environment.LICENSE_ADMIN_URL || '');
  if (base.protocol !== 'https:' || base.host !== 'huamao.xyz' || base.username || base.password ||
      base.pathname.replace(/\/+$/, '') !== '/dy-license' || base.search || base.hash) throw new Error('管理端需使用已确认的 huamao.xyz/dy-license HTTPS 地址');
  if (String(environment.LICENSE_ADMIN_KEY || '').length < 24) throw new Error('独立管理端密钥尚未准备好');
  return { base: base.href.replace(/\/+$/, ''), key: environment.LICENSE_ADMIN_KEY };
}
function loadAccount() {
  const fields = {};
  for (const line of fs.readFileSync(ACCOUNT_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^：]+)：(.*)$/); if (match) fields[match[1]] = match[2];
  }
  if (fields['用户名'] !== 'huamao' || !fields['初始密码']) throw new Error('本人测试账户文件格式无效');
  return { username: fields['用户名'], password: fields['初始密码'], expiresAt: fields['授权到期日'] };
}
async function main() {
  const admin = loadAdminEnvironment();
  const options = { redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-admin-key': admin.key }, signal: AbortSignal.timeout(12000) };
  const listing = await fetch(admin.base + '/admin/users', options);
  const users = await listing.json();
  if (!listing.ok || !users.ok) throw new Error('管理端身份验证失败；未创建账户');
  if (users.users.some(user => user.username === 'huamao')) throw new Error('云端已存在 huamao 账户，已停止创建且未覆盖原密码或授权');
  if (fs.existsSync(ACCOUNT_FILE)) throw new Error('本人测试账户文件已存在，已停止覆盖；请核对前次结果');
  const password = crypto.randomBytes(24).toString('base64url');
  const expiresAt = '2026-11-07'; // 用户时区 2026-10-08 起，30 天本人测试授权。
  const response = await fetch(admin.base + '/admin/users', { ...options, method: 'POST',
    signal: AbortSignal.timeout(12000), body: JSON.stringify({ username: 'huamao', password, expiresAt, note: '本人测试（独立客户端普通授权账户）' }) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error('测试账户创建未完成；未更改任何已有账户');
  fs.writeFileSync(ACCOUNT_FILE, '本人测试用普通授权账户\n用户名：huamao\n初始密码：' + password + '\n授权到期日：' + expiresAt +
    '\n角色：普通用户（无客户版管理员入口）\n授权地址：https://huamao.xyz/dy-license\n请妥善保管该文件，不随客户程序包发送。\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log('PASS: 本人普通测试账户已创建，授权到 2026-11-07；凭据单独保存，未进入客户包或工具输出');
}
if (require.main === module) main().catch(() => { console.error('账户迁移未完成。请核对管理端部署、同名账户及独立凭据文件；未覆盖既有账户。'); process.exitCode = 1; });
module.exports = { loadAccount, loadAdminEnvironment };
