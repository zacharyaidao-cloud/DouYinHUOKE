'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createBrowserControlLease } = require('../lib/browser-control-lease');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(t, options = {}) {
  const lease = createBrowserControlLease({ isBusy: () => false, authorize: async () => ({ ok: true }), ...options });
  t.after(() => lease.dispose()); return lease;
}

test('acquire reserves synchronously through authorization and remains held until matching release', async t => {
  const auth = deferred(); let called = 0;
  const lease = fixture(t, { authorize: id => { assert.equal(id, 'nav-a'); called++; return auth.promise; } });
  const acquiring = lease.acquire('nav-a');
  assert.equal(lease.isHeld(), true); assert.equal(called, 1);
  await assert.rejects(lease.acquire('nav-b'), { code: 'BROWSER_CONTROL_HELD' });
  assert.equal(called, 1); assert.equal(lease.release('wrong-id'), false); assert.equal(lease.isHeld(), true);
  auth.resolve({ ok: true }); assert.deepEqual(await acquiring, { ok: true, leaseId: 'nav-a' });
  assert.equal(lease.isHeld(), true);
  assert.equal(lease.release('nav-a'), true); assert.equal(lease.release('nav-a'), false); assert.equal(lease.isHeld(), false);
});

test('busy task rejects before authorization and does not leave a lock behind', async t => {
  let authorized = 0, busy = true;
  const lease = fixture(t, { isBusy: () => busy, authorize: async () => { authorized++; return { ok: true }; } });
  await assert.rejects(lease.acquire('blocked'), { code: 'BROWSER_CONTROL_BUSY' });
  assert.equal(authorized, 0); assert.equal(lease.isHeld(), false);
  busy = false; await lease.acquire('available'); assert.equal(authorized, 1);
});

test('task becoming busy while authorization is pending rejects and releases its own lease', async t => {
  const auth = deferred(); let busy = false;
  const lease = fixture(t, { isBusy: () => busy, authorize: () => auth.promise });
  const acquiring = lease.acquire('nav-a'); busy = true; auth.resolve({ ok: true });
  await assert.rejects(acquiring, { code: 'BROWSER_CONTROL_BUSY' }); assert.equal(lease.isHeld(), false);
});

test('TTL expires a pending authorization promptly; its late success cannot unlock a new lease', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const oldAuth = deferred(), freshAuth = deferred();
  const lease = fixture(t, { ttlMs: 20, authorize: id => id === 'old' ? oldAuth.promise : freshAuth.promise });
  const old = lease.acquire('old'), expired = assert.rejects(old, { code: 'BROWSER_CONTROL_EXPIRED' });
  t.mock.timers.tick(21); assert.equal(lease.isHeld(), false);
  const fresh = lease.acquire('fresh'); assert.equal(lease.isHeld(), true);
  oldAuth.resolve({ ok: true }); await expired;
  assert.equal(lease.isHeld(), true); assert.equal(lease.release('old'), false);
  freshAuth.resolve({ ok: true }); await fresh; assert.equal(lease.isHeld(), true);
  assert.equal(lease.release('fresh'), true);
});

test('manual release settles the pending waiter and an old failure cannot release a reused id', async t => {
  const oldAuth = deferred(), freshAuth = deferred(); let calls = 0;
  const lease = fixture(t, { authorize: () => ++calls === 1 ? oldAuth.promise : freshAuth.promise });
  const old = lease.acquire('same-id'), cancelled = assert.rejects(old, { code: 'BROWSER_CONTROL_CANCELLED' });
  assert.equal(lease.release('same-id'), true);
  const fresh = lease.acquire('same-id');
  oldAuth.reject(new Error('private old authorization payload'));
  await cancelled; assert.equal(lease.isHeld(), true);
  freshAuth.resolve({ ok: true }); assert.deepEqual(await fresh, { ok: true, leaseId: 'same-id' });
  assert.equal(lease.isHeld(), true);
});

test('successful leases also expire and their old timers do not shorten the next lease', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const lease = fixture(t, { ttlMs: 30 });
  await lease.acquire('first'); t.mock.timers.tick(10); lease.release('first'); await lease.acquire('second');
  t.mock.timers.tick(21); assert.equal(lease.isHeld(), true);
  t.mock.timers.tick(10); assert.equal(lease.isHeld(), false);
});

test('deadline is checked after authorization even when the timeout callback has not run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const auth = deferred(), lease = fixture(t, { ttlMs: 20, authorize: () => auth.promise });
  const acquiring = lease.acquire('deadline');
  t.mock.timers.setTime(1021); auth.resolve({ ok: true });
  await assert.rejects(acquiring, { code: 'BROWSER_CONTROL_EXPIRED' }); assert.equal(lease.isHeld(), false);
});

test('authorization denial, throw and malformed results expose only safe errors and release the lock', async t => {
  for (const authorize of [() => ({ ok: false, error: 'private-token' }), () => false, () => undefined,
    () => ({ ok: 'true' }), () => { throw new Error('private-token'); }, async () => { throw new Error('private-token'); },
    () => ({ get ok() { throw new Error('private-token'); } })]) {
    const lease = fixture(t, { authorize });
    await assert.rejects(lease.acquire('private-request-id'), failure => failure.code === 'BROWSER_CONTROL_AUTH_FAILED'
      && !/private-token|private-request-id/.test(failure.message));
    assert.equal(lease.isHeld(), false);
  }
});

test('unknown task state fails closed without leaking provider details', async t => {
  for (const isBusy of [() => { throw new Error('private-state'); }, () => undefined]) {
    let authorized = false;
    const lease = fixture(t, { isBusy, authorize: () => { authorized = true; return { ok: true }; } });
    await assert.rejects(lease.acquire('state-check'), failure => failure.code === 'BROWSER_CONTROL_STATE' && !failure.message.includes('private-state'));
    assert.equal(lease.isHeld(), false); assert.equal(authorized, false);
  }
});

test('dispose is idempotent, cancels pending authorization, and permanently rejects new leases', async t => {
  const auth = deferred(), lease = fixture(t, { authorize: () => auth.promise });
  const acquiring = lease.acquire('pending'), rejected = assert.rejects(acquiring, { code: 'BROWSER_CONTROL_DISPOSED' });
  lease.dispose(); lease.dispose(); await rejected;
  auth.resolve({ ok: true }); assert.equal(lease.isHeld(), false); assert.equal(lease.release('pending'), false);
  await assert.rejects(lease.acquire('new'), { code: 'BROWSER_CONTROL_DISPOSED' });
});

test('invalid ids and configuration do not reserve a lease or echo rejected input', async t => {
  const lease = fixture(t);
  for (const id of ['', null, 1, ' private ', 'x\nprivate', 'x'.repeat(257)]) {
    await assert.rejects(lease.acquire(id), { code: 'BROWSER_CONTROL_INVALID_ID' }); assert.equal(lease.isHeld(), false);
  }
  for (const ttlMs of [0, -1, 1.5, Infinity, 2147483648]) {
    assert.throws(() => createBrowserControlLease({ isBusy: () => false, authorize: () => ({ ok: true }), ttlMs }), { code: 'BROWSER_CONTROL_CONFIG' });
  }
});

test('a held lease timer is unrefed and does not keep an otherwise finished process alive', () => {
  const modulePath = require.resolve('../lib/browser-control-lease');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).createBrowserControlLease({isBusy:()=>false,authorize:async()=>({ok:true}),ttlMs:60000}).acquire('child').then(()=>process.stdout.write('ready'));`],
    { timeout: 5000, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stdout, 'ready');
});
