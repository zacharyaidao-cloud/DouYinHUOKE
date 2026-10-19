/** 仅管理员初始化独立网页登录账户；不会读取客户端密码或修改客户账户。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function initializeAdmin(options = {}) {
  const dataDir = options.dataDir || process.env.ADMIN_WEB_DATA_DIR || path.join(__dirname, 'admin-data');
  const username = options.username || 'admin';
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_.@-]{1,64}$/u.test(username)) throw new Error('管理用户名无效');
  const filename = path.join(dataDir, 'admin.json');
  if (fs.existsSync(filename)) throw new Error('管理账户已经存在，已拒绝覆盖');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const password = options.password || crypto.randomBytes(24).toString('base64url');
  if (typeof password !== 'string' || password.length < 16 || password.length > 128) throw new Error('管理密码需要 16 至 128 位');
  const salt = crypto.randomBytes(16).toString('hex');
  const data = { username, salt, passwordHash: crypto.scryptSync(password, salt, 32).toString('hex'), createdAt: new Date().toISOString() };
  fs.writeFileSync(filename, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(filename, 0o600);
  const credentialsFile = options.credentialsFile || path.join(dataDir, '网页登录账户.txt');
  const text = `授权管理网页\n地址：https://huamao.xyz/dy-license/manage/\n账户：${username}\n密码：${password}\n\n此账户只供软件所有者管理授权，不能登录客户客户端。\n妥善保存此文件，不要发给客户。\n`;
  fs.writeFileSync(credentialsFile, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(credentialsFile, 0o600);
  return { dataDir, credentialsFile };
}
if (require.main === module) {
  try { const result = initializeAdmin(); console.log('已初始化独立管理账户，凭据文件：' + result.credentialsFile); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { initializeAdmin };
