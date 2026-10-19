/** 独立管理命令行；仅部署在服务端或管理者电脑，绝不放入客户包。 */
const fs = require('fs');
const path = require('path');
function managementConfig() {
  const local = {};
  try {
    const text = fs.readFileSync(path.join(__dirname, '管理端配置.env'), 'utf8').replace(/^\uFEFF/, '');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (match) local[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* 可改用受保护的环境变量 */ }
  return { url: process.env.LICENSE_ADMIN_URL || local.LICENSE_ADMIN_URL || '', key: process.env.LICENSE_ADMIN_KEY || local.LICENSE_ADMIN_KEY || '' };
}
async function main() {
  const [command, file] = process.argv.slice(2);
  const config = managementConfig();
  const base = new URL(config.url);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('LICENSE_ADMIN_URL 必须为 HTTPS');
  const key = config.key;
  if (key.length < 24) throw new Error('需配置管理密钥环境变量 LICENSE_ADMIN_KEY');
  const commands = { list: ['GET', '/admin/users'], create: ['POST', '/admin/users'], update: ['POST', '/admin/update'],
    unbind: ['POST', '/admin/unbind/'], delete: ['DELETE', '/admin/users/'] };
  const entry = commands[command];
  if (!entry) throw new Error('用法：node admin-cli.js list | create 账户.json | update 修改.json | unbind 用户名 | delete 用户名');
  let endpoint = entry[1], body;
  if (['create', 'update'].includes(command)) body = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (['unbind', 'delete'].includes(command)) { if (!file) throw new Error('缺少用户名'); endpoint += encodeURIComponent(file); }
  const response = await fetch(base.href.replace(/\/+$/, '') + endpoint, { method: entry[0], redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body, signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || '管理请求失败');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
