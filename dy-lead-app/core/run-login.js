'use strict';
/**
 * 核心流程 · 账号扫码登录（给多账号执行准备浏览器资料目录）
 *
 *   node core/run-login.js --profile=<资料目录>
 *
 * 打开该资料目录的 Chrome 窗口进入抖音首页；未登录时请在窗口里点“登录”用手机扫码。
 * 登录状态只认页面自己请求的 /user/profile/self/ 响应；确认后打印账号昵称并关闭窗口（登录信息保存在资料目录里）。
 */
const path = require('node:path');
const { Session } = require('./session');
const { createTrace } = require('./trace');

const arg = name => (process.argv.find(value => value.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const profileDir = arg('profile');
if (!profileDir) { console.error('用法：node core/run-login.js --profile=<资料目录>'); process.exit(2); }

(async () => {
  const trace = createTrace(path.join(profileDir, '..', path.basename(profileDir) + '-login-trace.jsonl'));
  const session = new Session({ profileDir, trace });
  let nickname = '';
  session.on(event => { if (event.type === 'profileSelf' && event.body?.user?.nickname) nickname = event.body.user.nickname; });
  try {
    await session.open();
    const ok = await session.ensureLogin(15 * 60 * 1000);
    await session.page.waitForTimeout(1500);
    console.log(ok ? `LOGIN_OK ${nickname || '(昵称未取到)'}` : 'LOGIN_TIMEOUT 15 分钟内未完成扫码');
    process.exitCode = ok ? 0 : 1;
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
