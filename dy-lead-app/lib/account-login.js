'use strict';

const STATE_LABELS = {
  authenticated: '已登录', logged_out: '未登录', pending: '等待登录确认',
  verification_required: '需完成验证', browser_closed: '浏览器已关闭',
  unknown: '登录待确认', stopped: '检测已停止', timeout: '登录超时'
};
// Browser launch errors have fixed public messages. Never publish Playwright's
// original trace, which can contain proxy details or local session information.
const BROWSER_FAILURE_MESSAGES = Object.freeze({
  BROWSER_EMBEDDED_UNAVAILABLE: '内嵌账号浏览器连接不可用，请重启客户端后再试，账号资料已保留',
  BROWSER_RUNTIME_MISSING: '浏览器程序文件缺失或不完整，请重新安装完整安装包',
  BROWSER_PROFILE_IN_USE: '该账号浏览器资料正在被其他窗口使用，请关闭对应浏览器后重试',
  BROWSER_PROFILE_ACCESS_DENIED: '无法读写账号浏览器资料，请检查安装目录权限后重试',
  BROWSER_LAUNCH_FAILED: '账号浏览器启动失败，请重新打开登录；如仍失败，请联系管理员检查浏览器运行环境',
  BROWSER_UNSUPPORTED_SYSTEM: '当前 Windows 系统不支持内置浏览器，请升级系统后重试'
});
const currentResults = new WeakMap();

function getFreshLoginResult(store, accountId) {
  const result = currentResults.get(store)?.get(String(accountId));
  return result ? { ...result } : null;
}

// Share account-card updates with task checks without changing the task itself.
// Only the public state/message are persisted; session evidence stays in memory.
function persistLoginResult(store, accountId, result) {
  const accounts = store.getAccounts();
  const account = accounts.find(item => String(item.id) === String(accountId));
  if (!account) return;
  // A saved success label is never sufficient, and inconsistent new results
  // cannot publish success either. Keep only public results for this process.
  if (result.state === 'authenticated' && result.loggedIn !== true) result = { state: 'unknown', loggedIn: false, message: '尚未取得可靠登录证据，请在账号窗口重新检查' };
  const label = STATE_LABELS[result.state] || STATE_LABELS.unknown;
  const checkedAt = store.nowStr();
  let records = currentResults.get(store);
  if (!records) { records = new Map(); currentResults.set(store, records); }
  records.set(String(accountId), { state: result.state, loggedIn: result.state === 'authenticated' && result.loggedIn === true, message: result.message, checkedAt });
  if (account.loginState === label && account.loginStatus === result.state && account.loginMessage === result.message
    && account.loginCheckedAt === checkedAt) return;
  account.loginState = label; account.loginStatus = result.state; account.loginMessage = result.message;
  account.loginCheckedAt = checkedAt;
  if (result.state === 'authenticated' && result.loggedIn === true) account.loginAt = checkedAt;
  store.setAccounts(accounts);
}

function createAccountLoginController({ store, taskState, setTask, authorize, launchAccount, getAlive,
  getMonitor, sleep, maxPolls = 150, pollIntervalMs = 2000 }) {
  function publish(accountId, result, status = result.message) {
    persistLoginResult(store, accountId, result);
    setTask({ loginState: result.state, status, detail: result.message });
  }
  function assertNotStopped() {
    if (taskState.stopRequested) {
      const error = new Error('登录检测已停止，浏览器登录资料已保留');
      error.code = 'TASK_STOPPED'; throw error;
    }
  }
  async function inspect(accountId, alive) {
    assertNotStopped();
    await authorize({ accountId, kind: 'login_check' });
    assertNotStopped();
    const result = await getMonitor(alive).inspect();
    assertNotStopped();
    return result;
  }
  function failure(accountId, error) {
    const stopped = taskState.stopRequested || error.code === 'TASK_STOPPED';
    const browserCode = Object.hasOwn(BROWSER_FAILURE_MESSAGES, error.code) ? error.code : null;
    const closed = !stopped && !browserCode && error.code !== 'AUTH_REQUIRED' && /(?:page|context|browser).*(?:closed)|浏览器.*关闭/i.test(String(error.message || ''));
    const state = stopped ? 'stopped' : closed ? 'browser_closed' : 'unknown';
    const message = stopped ? '登录检测已停止，浏览器登录资料已保留' :
      browserCode ? BROWSER_FAILURE_MESSAGES[browserCode] :
      error.code === 'AUTH_REQUIRED' ? '软件授权已失效，登录检测已暂停，请重新登录客户端' :
      closed ? '账号浏览器窗口已关闭，请重新打开登录，登录资料已保留' :
      /timeout|超时/i.test(String(error.message || '')) ? '抖音页面加载超时，请检查网络后重新打开登录' :
      '登录检测遇到异常，请检查账号浏览器是否正常打开后重试';
    publish(accountId, { state, loggedIn: false, message });
    const publicCode = !stopped && browserCode;
    store.log(accountId, message + (publicCode ? `（${publicCode}）` : ''));
    return { ok: false, state, loggedIn: false, error: message, message, ...(publicCode ? { code: publicCode } : {}) };
  }
  function succeeded(accountId, result) {
    publish(accountId, result, '已确认抖音账号登录成功');
    store.log(accountId, '已确认抖音账号登录成功（会话与本人登录证据）');
    return { ok: true, ...result };
  }
  async function openForLogin(accountId) {
    if (taskState.running) return { ok: false, error: '已有任务在运行，请先停止当前任务' };
    setTask({ kind: 'login', running: true, accountId, loginState: 'pending', status: '正在打开账号浏览器…', done: 0, total: 0, errors: [] });
    publish(accountId, { state: 'pending', loggedIn: false, message: '正在打开账号浏览器，随后在手机扫码并确认登录' });
    let latest;
    try {
      const alive = await launchAccount(accountId);
      assertNotStopped();
      if (typeof alive.page.bringToFront === 'function') await alive.page.bringToFront();
      assertNotStopped();
      getMonitor(alive);
      // 首先复用已经打开的页面，不打断用户已完成的扫码或本人主页。
      latest = await inspect(accountId, alive);
      if (latest.loggedIn) return succeeded(accountId, latest);
      assertNotStopped();
      const currentUrl = String(alive.page.url());
      if (!/^https:\/\/(?:www\.)?douyin\.com(?:\/|$)/i.test(currentUrl)) {
        await authorize({ accountId, kind: 'login_navigate' });
        assertNotStopped();
        await alive.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(1000);
      }
      latest = await inspect(accountId, alive);
      if (latest.loggedIn) return succeeded(accountId, latest);
      if (latest.state === 'browser_closed') { publish(accountId, latest); return { ok: true, ...latest }; }
      if (latest.state !== 'verification_required') {
        await authorize({ accountId, kind: 'login_dialog' });
        assertNotStopped();
        // 只点击可见且明确的登录控件；验证码交给用户，不尝试绕过。
        await alive.page.evaluate(() => {
          const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
          const login = Array.from(document.querySelectorAll('button,a,[role="button"],[data-e2e="login-button"]'))
            .find(element => visible(element) && (element.textContent || '').trim() === '登录');
          if (login) login.click();
        });
      }
      for (let attempt = 0; attempt < maxPolls; attempt++) {
        latest = await inspect(accountId, alive);
        if (latest.loggedIn) return succeeded(accountId, latest);
        publish(accountId, latest);
        if (latest.state === 'browser_closed') return { ok: true, ...latest };
        await sleep(pollIntervalMs);
      }
      assertNotStopped();
      const result = { state: 'timeout', loggedIn: false,
        message: '5 分钟内未取得明确登录证据；如果浏览器已登录，点击“检查”重新识别，登录资料已保留' };
      publish(accountId, result); store.log(accountId, result.message);
      return { ok: true, ...result };
    } catch (error) { return failure(accountId, error); }
    finally { setTask({ running: false }); }
  }
  async function checkLogin(accountId) {
    const joiningLogin = taskState.running && taskState.kind === 'login' && String(taskState.accountId) === String(accountId);
    if (taskState.running && !joiningLogin) return { ok: false, error: '已有任务在运行，请先停止当前任务再检查登录' };
    if (!joiningLogin) setTask({ kind: 'login', running: true, accountId, loginState: 'pending', status: '正在检查账号登录状态…', done: 0, total: 0, errors: [] });
    try {
      let alive = getAlive(accountId);
      if (!alive) {
        alive = await launchAccount(accountId);
        getMonitor(alive);
        await authorize({ accountId, kind: 'check_login_navigate' });
        assertNotStopped();
        await alive.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(1000);
      }
      const result = await inspect(accountId, alive);
      publish(accountId, result);
      // ok 表示检查接口调用成功，登录结果独立放在 loggedIn/state 中。
      return { ok: true, ...result };
    } catch (error) { return failure(accountId, error); }
    finally { if (!joiningLogin) setTask({ running: false }); }
  }
  return { openForLogin, checkLogin };
}

module.exports = { createAccountLoginController, persistLoginResult, getFreshLoginResult, STATE_LABELS };
