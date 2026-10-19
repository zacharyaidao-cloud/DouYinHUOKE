'use strict';

const { persistLoginResult } = require('./account-login');

const SELF_URL = 'https://www.douyin.com/user/self';
const TERMINAL = new Set(['authenticated', 'logged_out', 'verification_required', 'browser_closed']);
const PUBLIC_MESSAGES = {
  authenticated: '已确认抖音账号登录',
  logged_out: '抖音账号尚未登录，请打开账号窗口扫码并在手机上确认',
  verification_required: '抖音要求安全验证，请打开账号窗口人工完成验证',
  browser_closed: '账号浏览器窗口已关闭，请重新打开登录',
  pending: '正在等待扫码或手机确认，请打开账号窗口继续登录',
  unknown: '尚未取得可靠登录证据，请打开账号窗口后重新检查',
  stopped: '启动登录检查已停止，账号登录资料已保留'
};

function scanError(code, message) { return Object.assign(new Error(message), { code }); }
function publicResult(value) {
  const state = value && Object.hasOwn(PUBLIC_MESSAGES, value.state) ? value.state : 'unknown';
  // An authenticated label alone must never become a persisted success.
  const confirmed = state !== 'authenticated' || value.loggedIn === true;
  return { state: confirmed ? state : 'unknown', loggedIn: confirmed && state === 'authenticated',
    message: PUBLIC_MESSAGES[confirmed ? state : 'unknown'] };
}

function createAccountLoginScan({ store, taskState, setTask, authorize, launchAccount,
  getAlive, getMonitor, getSignal, navigationTimeoutMs = 15000, inspectTimeoutMs = 5000,
  responseWaitMs = 3000, pollIntervalMs = 250, closeTimeoutMs = 3000 }) {
  return async function scanAccountLogins({ onProgress } = {}) {
    if (taskState.running) return { ok: false, error: '已有任务在运行，启动登录检查稍后进行' };
    const accounts = store.getAccounts().map(account => ({ id: String(account.id) }));
    const total = accounts.length;
    const accountStates = Object.fromEntries(accounts.map(account => [account.id,
      { state: 'unknown', message: '等待启动登录检查', checked: false }]));
    let done = 0, currentId = null, currentScope = null, stopping = false;
    setTask({ kind: 'login_scan', running: true, accountId: null, done: 0, total,
      loginState: 'unknown', status: total ? '正在自动检查账号登录状态…' : '没有账号需要检查', errors: [] });
    const signal = getSignal && getSignal();
    const assertNotStopped = () => {
      if (stopping || taskState.stopRequested || signal && signal.aborted) throw scanError('TASK_STOPPED', PUBLIC_MESSAGES.stopped);
    };
    const report = message => {
      if (typeof onProgress !== 'function') return;
      try { onProgress({ phase: 'running', total, done, accountId: currentId, message,
        accountStates: structuredClone(accountStates) }); } catch (_) { /* UI observers cannot change login evidence. */ }
    };
    const closeOwned = (scope = currentScope) => {
      if (!scope || !scope.owned) return Promise.resolve();
      if (scope.closePromise) return scope.closePromise;
      const closing = scope.owned;
      // Never look up and close an account by ID: its browser may have changed.
      try { if (closing.loginMonitor) closing.loginMonitor.dispose(); } catch (_) { /* continue closing */ }
      scope.closePromise = Promise.resolve().then(() => closing.context.close()).catch(() => {});
      return scope.closePromise;
    };
    const onAbort = () => { stopping = true; if (currentScope) currentScope.cancelled = true; closeOwned(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // Race each async browser read against stop and a deadline. A late browser
    // launch is still closed, but a late read can never persist a login result.
    const step = (operation, timeoutMs, onLateValue) => new Promise((resolve, reject) => {
      let settled = false, cancelled = false, timer;
      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', aborted);
        ok ? resolve(value) : reject(value);
      };
      const aborted = () => { cancelled = true; finish(false, scanError('TASK_STOPPED', PUBLIC_MESSAGES.stopped)); };
      try { assertNotStopped(); } catch (error) { finish(false, error); return; }
      if (signal) signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => {
        cancelled = true;
        finish(false, scanError('LOGIN_SCAN_TIMEOUT', '启动登录检查等待超时，请打开账号窗口后重新检查'));
      }, timeoutMs);
      Promise.resolve().then(() => { assertNotStopped(); return operation(); }).then(value => {
        if (cancelled) { if (onLateValue) Promise.resolve(onLateValue(value)).catch(() => {}); return; }
        try { assertNotStopped(); finish(true, value); } catch (error) {
          if (onLateValue) Promise.resolve(onLateValue(value)).catch(() => {});
          finish(false, error);
        }
      }, error => finish(false, error));
    });
    const allowed = async kind => {
      await step(() => authorize({ accountId: currentId, kind }), inspectTimeoutMs);
      assertNotStopped();
    };
    const inspect = async alive => {
      await allowed('login_scan_check');
      const value = await step(() => getMonitor(alive).inspect(), inspectTimeoutMs);
      assertNotStopped();
      return publicResult(value);
    };
    const release = async (scope = currentScope) => {
      if (scope && scope.owned) {
        let timer;
        await Promise.race([closeOwned(scope), new Promise(resolve => { timer = setTimeout(resolve, closeTimeoutMs); })]);
        clearTimeout(timer);
      }
      if (currentScope === scope) currentScope = null;
    };

    report(taskState.status);
    try {
      for (const account of accounts) {
        assertNotStopped();
        currentId = account.id;
        const accountScope = { owned: null, closePromise: null, cancelled: false };
        currentScope = accountScope;
        setTask({ accountId: currentId, status: `正在检查账号登录状态（${done + 1}/${total}）`, done });
        accountStates[currentId] = { state: 'checking', message: '正在自动检查登录状态', checked: false };
        report(taskState.status);
        let latest;
        try {
          let alive = getAlive(currentId);
          let reused = !!alive;
          if (!alive) {
            await allowed('login_scan_browser');
            alive = await step(() => launchAccount(currentId, { headless: true, checkStopped: () => {
              assertNotStopped();
              if (accountScope.cancelled) throw scanError('TASK_STOPPED', PUBLIC_MESSAGES.stopped);
            },
              onCreated: created => {
                accountScope.owned = created;
                if (accountScope.cancelled || stopping || signal && signal.aborted) closeOwned(accountScope);
              } }), navigationTimeoutMs,
              late => {
                if (!late || !late.context || accountScope.owned?.context !== late.context) return;
                return closeOwned(accountScope);
              });
            reused = accountScope.owned?.context !== alive.context;
            assertNotStopped();
            if (!reused) {
              getMonitor(alive); // Register response observation before navigation.
              await allowed('login_scan_navigate');
              await step(() => alive.page.goto(SELF_URL, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }), navigationTimeoutMs);
              assertNotStopped();
            }
          }
          // Existing windows are inspected in place: do not navigate or close
          // the page that the user is currently viewing.
          latest = await inspect(alive);
          if (!reused) {
            const deadline = Date.now() + responseWaitMs;
            while (!TERMINAL.has(latest.state) && Date.now() < deadline) {
              await step(() => new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))), inspectTimeoutMs);
              assertNotStopped();
              latest = await inspect(alive);
            }
          }
          assertNotStopped();
          persistLoginResult(store, currentId, latest);
          accountStates[currentId] = { state: latest.state, message: latest.message, checked: true };
        } catch (error) {
          if (error.code === 'AUTH_REQUIRED' || error.code === 'TASK_STOPPED') throw error;
          assertNotStopped();
          latest = publicResult({ state: 'unknown' });
          if (error.code === 'LOGIN_SCAN_TIMEOUT') latest.message = '启动登录检查等待超时，请打开账号窗口后重新检查';
          persistLoginResult(store, currentId, latest);
          accountStates[currentId] = { state: latest.state, message: latest.message, checked: true };
          setTask({ errors: [...taskState.errors || [], { accountId: currentId, error: latest.message }] });
        } finally { accountScope.cancelled = true; await release(accountScope); }
        assertNotStopped();
        done++;
        setTask({ done, loginState: latest.state, status: `已检查账号登录状态（${done}/${total}）` });
        report(taskState.status);
      }
      const message = total ? `启动登录检查完成，共检查 ${done} 个账号` : '没有账号需要检查';
      setTask({ running: false, accountId: null, done, status: message });
      return { ok: true, total, done, accountStates, message };
    } catch (error) {
      const stopped = error.code === 'TASK_STOPPED' || taskState.stopRequested || signal && signal.aborted;
      const state = stopped ? 'stopped' : 'unknown';
      const message = stopped ? PUBLIC_MESSAGES.stopped : error.code === 'AUTH_REQUIRED'
        ? '软件授权已失效，启动登录检查已暂停，请重新登录客户端' : '启动登录检查遇到异常，请稍后重试';
      if (currentId && !accountStates[currentId].checked) accountStates[currentId] = { state, message, checked: false };
      setTask({ running: false, accountId: null, done, loginState: state, status: message });
      return { ok: false, state, error: message, message, total, done, accountStates };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      await release();
    }
  };
}

module.exports = { createAccountLoginScan };
