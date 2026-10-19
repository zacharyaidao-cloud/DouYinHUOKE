'use strict';

// Startup coordination stays in process memory. Saved account status is
// historical until this run has checked the account's own browser session.
function createStartupLoginScan({ getAccounts, getFreshAccountResult = () => null, isBusy, isSessionValid, start,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const states = new Set(['authenticated', 'logged_out', 'pending', 'verification_required', 'browser_closed', 'unknown', 'stopped', 'timeout', 'checking']);
  let requested = false, owner = null, timer = null;
  let current = { phase: 'idle', total: 0, done: 0, accountId: null, message: '客户端授权登录后自动检查已有账号', accountStates: Object.create(null) };
  for (const account of getAccounts()) current.accountStates[String(account.id)] = { state: 'unknown', message: '等待本次启动自动检查，上次结果仅作记录', checked: false };

  function safeStates(input) {
    const out = Object.create(null);
    for (const [id, item] of Object.entries(input || {})) {
      if (!item || typeof item !== 'object') continue;
      out[id] = { state: states.has(item.state) ? item.state : 'unknown', message: String(item.message || ''), checked: item.checked === true };
    }
    return out;
  }
  function progress(update = {}) {
    if (current.phase !== 'running') return;
    const total = Number(update.total), done = Number(update.done);
    if (Number.isInteger(total) && total >= 0) current.total = total;
    if (Number.isInteger(done) && done >= 0) current.done = Math.min(done, current.total);
    current.accountId = update.accountId == null ? null : String(update.accountId);
    if (typeof update.message === 'string') current.message = update.message;
    Object.assign(current.accountStates, safeStates(update.accountStates));
  }
  function cancel(message = '自动登录检查已停止，未检查的账号可点击“检查”确认') {
    if (timer != null) clearTimer(timer);
    timer = null;
    if (['queued', 'running'].includes(current.phase)) {
      current.phase = 'stopped'; current.message = message; current.accountId = null;
      for (const item of Object.values(current.accountStates)) if (!item.checked) {
        item.state = 'unknown'; item.message = '本次启动检查未完成，请点击“检查”确认';
      }
    }
    owner = null;
  }
  function schedule(delay = 0) {
    if (current.phase !== 'queued' || timer != null) return;
    timer = setTimer(() => { timer = null; attempt(); }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function attempt() {
    if (current.phase !== 'queued') return;
    if (!isSessionValid(owner)) {
      cancel('客户端授权已失效，自动登录检查已停止；重新授权后可手动检查账号');
      owner = null; return;
    }
    if (isBusy()) {
      current.message = '等待当前任务结束后自动检查账号登录状态';
      schedule(1000); return;
    }
    try {
      // start reserves the normal task slot before scheduling engine work.
      start(owner, async () => {
        if (current.phase !== 'queued') return { ok: true };
        current.phase = 'running'; current.message = '正在自动检查账号登录状态';
        try {
          const result = await owner.run({ onProgress: progress });
          if (current.phase !== 'running') return { ok: true };
          progress(result);
          current.phase = result && result.ok === true ? 'completed' : 'stopped';
          current.accountId = null;
          current.message = result?.message || (current.phase === 'completed' ? '本次启动的账号登录检查已完成' : '自动登录检查未完成，请手动检查剩余账号');
          if (current.phase === 'stopped') for (const item of Object.values(current.accountStates)) if (!item.checked) {
            item.state = 'unknown'; item.message = '本次启动检查未完成，请点击“检查”确认';
          }
          return { ok: true };
        } catch (_) {
          cancel('自动登录检查遇到异常，未检查的账号可点击“检查”确认');
          return { ok: true };
        } finally { owner = null; }
      });
    } catch (_) {
      if (isBusy()) schedule(1000);
      else { cancel('自动登录检查未能启动，请手动检查账号'); owner = null; }
    }
  }
  function request(session, run) {
    if (requested) return;
    requested = true;
    const accounts = getAccounts();
    current.total = accounts.length;
    current.done = 0;
    for (const account of accounts) current.accountStates[String(account.id)] = { state: 'unknown', message: '等待本次启动自动检查，上次结果仅作记录', checked: false };
    if (!accounts.length) {
      current.phase = 'completed'; current.message = '暂无已有账号；添加账号后扫码登录即可'; return;
    }
    // 重启客户端很常见（改设置、装新版）。若所有账号在 10 分钟内刚验证过，
    // 再顺序启动 4 个浏览器既慢又会把帐号页锁住，直接沿用刚取得的证据。
    const FRESH_MS = 10 * 60 * 1000;
    const recentlyVerified = account => {
      if (account.loginStatus !== 'authenticated') return false;
      const text = String(account.loginCheckedAt || '').trim();
      if (!text) return false;
      const at = Date.parse(text.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(text) ? '' : '+08:00'));
      return Number.isFinite(at) && Date.now() - at >= 0 && Date.now() - at < FRESH_MS;
    };
    if (accounts.every(recentlyVerified)) {
      current.phase = 'completed'; current.total = accounts.length; current.done = accounts.length;
      for (const account of accounts) current.accountStates[String(account.id)] = { state: 'authenticated', message: '最近 10 分钟内已确认登录，未重复检查', checked: true };
      current.message = '最近 10 分钟内已确认全部账号登录，本次启动未重复检查';
      return;
    }
    // Session and the engine callback are private and never included in state.
    owner = { session, run };
    current.phase = 'queued'; current.message = '等待自动检查已有账号登录状态';
    schedule();
  }
  function refreshFreshAccount(account) {
    const id = String(account.id), record = current.accountStates[id];
    if (current.phase === 'running' && current.accountId === id && record && !record.checked) return;
    const fresh = getFreshAccountResult(id);
    if (!fresh) return;
    current.accountStates[id] = { state: states.has(fresh.state) ? fresh.state : 'unknown', message: String(fresh.message || ''), checked: true };
  }
  function readState() {
    for (const account of getAccounts()) refreshFreshAccount(account);
    return JSON.parse(JSON.stringify(current));
  }
  function projectAccount(account) {
    refreshFreshAccount(account);
    const record = current.accountStates[String(account.id)];
    if (!record || record.checked) return { ...account };
    return { ...account, loginStatus: record.state, loginState: record.state === 'checking' ? '检查中' : '登录待确认',
      loginMessage: record.message, loginCheckedAt: null };
  }
  function cancelSession(session) { if (owner?.session === session) cancel('已退出客户端，自动登录检查已停止'); }
  return { request, readState, projectAccount, cancel, cancelSession };
}

module.exports = { createStartupLoginScan };
