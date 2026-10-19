'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLicenseServer } = require('../license-server');
const adminKey = 'test-admin-key-with-at-least-24-characters';
function fixture(t) {
  const fixturePrefix = path.join(path.resolve(__dirname, '../../build-tools'), 'qa-admin-reset-');
  const dir = fs.mkdtempSync(fixturePrefix);
  const created = createLicenseServer({ adminKey, dataDir: dir, now: () => Date.parse('2026-10-08T00:00:00+08:00') });
  const handler = created.server.listeners('request')[0];
  t.after(() => { created.server.close(); assert(path.resolve(dir).startsWith(fixturePrefix)); fs.rmSync(dir, { recursive: true, force: true }); });
  function begin(endpoint, body, key = adminKey) {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url: endpoint, headers: { 'x-admin-key': key }, destroy() {} });
    let status;
    let send;
    const response = new Promise((resolve, reject) => {
      const res = { writeHead(code) { status = code; }, end(content) { resolve({ status, body: JSON.parse(content) }); } };
      handler(req, res).catch(reject);
      send = () => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); };
    });
    return { response, send };
  }
  async function request(endpoint, body, key = adminKey) {
    const pending = begin(endpoint, body, key);
    queueMicrotask(pending.send);
    return pending.response;
  }
  const records = () => JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  return { request, begin, records, publicKey: created.publicKey };
}
test('管理重置密码需要管理权限，拒绝无效密码且保留账户记录', async t => {
  const f = fixture(t);
  const created = await f.request('/admin/users', { username: 'sample', password: 'original-password', expiresAt: '2026-11-07', note: 'preserved' });
  assert.equal(created.status, 200, created.body.error);
  const before = f.records();
  assert.equal((await f.request('/admin/reset-password', { username: 'sample', newPassword: 'new-password' }, 'wrong-key')).status, 403);
  for (const newPassword of ['short', 12345678, 'a'.repeat(129)]) {
    assert.equal((await f.request('/admin/reset-password', { username: 'sample', newPassword })).status, 400);
    assert.deepEqual(f.records(), before);
  }
  assert.equal((await f.request('/admin/reset-password', { username: 'unknown', newPassword: 'new-password' })).status, 404);
  assert.deepEqual(f.records(), before);
});
test('延迟管理请求不会覆盖同期客户绑定或新建账户', async t => {
  const f = fixture(t), mac = 'AA:BB:CC:DD:EE:FF';
  assert.equal((await f.request('/admin/users', { username: 'sample', password: 'original-password', expiresAt: '2026-11-07' })).status, 200);
  const delayedUpdate = f.begin('/admin/update', { username: 'sample', note: 'changed after binding' });
  assert.equal((await f.request('/login', { username: 'sample', password: 'original-password', clientVersion: 4, mac })).status, 200);
  delayedUpdate.send(); assert.equal((await delayedUpdate.response).status, 200);
  assert.equal(f.records().find(u => u.username === 'sample').mac, mac);
  const delayedCreate = f.begin('/admin/users', { username: 'later', password: 'later-password', expiresAt: '2026-11-07' });
  assert.equal((await f.request('/admin/users', { username: 'earlier', password: 'earlier-password', expiresAt: '2026-11-07' })).status, 200);
  delayedCreate.send(); assert.equal((await delayedCreate.response).status, 200);
  assert.deepEqual(f.records().map(u => u.username).sort(), ['earlier', 'later', 'sample']);
});
test('重置密码加盐保存，撤销已有续租且新密码保持RSA签名与绑定资料', async t => {
  const f = fixture(t), mac = 'AA:BB:CC:DD:EE:FF';
  const created = await f.request('/admin/users', { username: 'sample', password: 'original-password', expiresAt: '2026-11-07', note: 'preserved' });
  assert.equal(created.status, 200, created.body.error);
  const login = await f.request('/login', { username: 'sample', password: 'original-password', clientVersion: 4, mac });
  assert.equal(login.status, 200);
  const before = f.records()[0];
  assert.equal((await f.request('/admin/reset-password', { username: 'sample', newPassword: 'fresh-password' })).status, 200);
  const after = f.records()[0];
  assert.notEqual(after.salt, before.salt);
  assert.notEqual(after.passHash, before.passHash);
  assert.equal(after.passHash, crypto.scryptSync('fresh-password', after.salt, 32).toString('hex'));
  assert.equal(after.mac, mac); assert.equal(after.expiresAt, before.expiresAt); assert.equal(after.note, before.note);
  assert.equal(after.revision, before.revision + 1);
  assert.equal((await f.request('/lease', { username: 'sample', mac, refreshToken: login.body.refreshToken })).status, 403);
  assert.equal((await f.request('/login', { username: 'sample', password: 'original-password', clientVersion: 4, mac })).status, 401);
  const fresh = await f.request('/login', { username: 'sample', password: 'fresh-password', clientVersion: 4, mac });
  assert.equal(fresh.status, 200);
  const { leasePayload } = require('../license-server');
  assert.equal(crypto.verify('sha256', Buffer.from(leasePayload(fresh.body.lease)), f.publicKey, Buffer.from(fresh.body.sig, 'base64')), true);
});
