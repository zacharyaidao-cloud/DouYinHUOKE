'use strict';

const failure = (code, message) => Object.assign(new Error(message), { code });

// Main supplies a fresh opaque id per navigation. Task entry points must check
// isHeld synchronously before marking a task running. Authorization does not
// release the lease: main releases that same id after navigating (or timing out).
function createBrowserControlLease({ isBusy, authorize, ttlMs = 15000 } = {}) {
  if (typeof isBusy !== 'function' || typeof authorize !== 'function'
    || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 2147483647) {
    throw failure('BROWSER_CONTROL_CONFIG', '浏览器手动控制租约配置无效');
  }
  let held = null, disposed = false;
  function releaseOwn(lease, reason) {
    // Object identity, rather than just the caller id, protects a new lease
    // even if an old authorization completes after that id was reused.
    if (held !== lease) return false;
    held = null; clearTimeout(lease.timer); lease.reason = reason; lease.end(reason);
    return true;
  }
  function isHeld() {
    if (held && Date.now() >= held.deadline) releaseOwn(held, 'expired');
    return !!held;
  }
  function assertIdle() {
    let busy;
    try { busy = isBusy(); } catch (_) { throw failure('BROWSER_CONTROL_STATE', '无法确认当前任务状态'); }
    if (typeof busy !== 'boolean') throw failure('BROWSER_CONTROL_STATE', '无法确认当前任务状态');
    if (busy) throw failure('BROWSER_CONTROL_BUSY', '任务正在运行，暂不能手动导航账号浏览器');
  }
  function assertCurrent(lease) {
    if (disposed) throw failure('BROWSER_CONTROL_DISPOSED', '浏览器手动控制已关闭');
    if (lease.reason === 'expired' || Date.now() >= lease.deadline) {
      releaseOwn(lease, 'expired');
      throw failure('BROWSER_CONTROL_EXPIRED', '浏览器手动控制请求已超时');
    }
    if (held !== lease) throw failure('BROWSER_CONTROL_CANCELLED', '浏览器手动控制请求已取消');
  }
  async function acquire(id) {
    if (disposed) throw failure('BROWSER_CONTROL_DISPOSED', '浏览器手动控制已关闭');
    if (typeof id !== 'string' || !id || id.length > 256 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id)) {
      throw failure('BROWSER_CONTROL_INVALID_ID', '浏览器手动控制请求标识无效');
    }
    if (isHeld()) throw failure('BROWSER_CONTROL_HELD', '另一项浏览器手动控制正在进行');
    const lease = { id, deadline: Date.now() + ttlMs, timer: null, reason: null, end: null };
    const ended = new Promise(resolve => { lease.end = resolve; });
    held = lease; // Synchronous reservation precedes every authorization await.
    lease.timer = setTimeout(() => releaseOwn(lease, 'expired'), ttlMs);
    if (typeof lease.timer.unref === 'function') lease.timer.unref();
    let accepted = false;
    try {
      assertIdle();
      let permission;
      try { permission = Promise.resolve(authorize(id)).then(value => ({ value }), () => ({ denied: true })); }
      catch (_) { throw failure('BROWSER_CONTROL_AUTH_FAILED', '浏览器手动控制授权未通过'); }
      // Expiry/release also settles a stalled authorization waiter. The late
      // authorization stays observed, so a later rejection is never unhandled.
      const result = await Promise.race([permission, ended.then(() => ({ cancelled: true }))]);
      assertCurrent(lease);
      let allowed = false;
      try { allowed = !result.denied && result.value && typeof result.value === 'object' && !Array.isArray(result.value) && result.value.ok === true; }
      catch (_) { /* Never expose an authorization provider's private error. */ }
      if (!allowed) throw failure('BROWSER_CONTROL_AUTH_FAILED', '浏览器手动控制授权未通过');
      assertIdle();
      assertCurrent(lease);
      accepted = true;
      return { ok: true, leaseId: id };
    } finally {
      if (!accepted) releaseOwn(lease, 'failed');
    }
  }
  function release(id) { return !!held && held.id === id ? releaseOwn(held, 'released') : false; }
  function dispose() { if (disposed) return; disposed = true; if (held) releaseOwn(held, 'disposed'); }
  return { acquire, release, isHeld, dispose };
}

module.exports = { createBrowserControlLease };
