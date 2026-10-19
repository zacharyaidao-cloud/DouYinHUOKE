'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { userMetadata, identifier } = require('../lib/user-metadata');

test('评论内用户资料保留真实零值、精确UID和公开链接，不臆造主页访问', () => {
  const result = userMetadata({ sec_uid: 'fixture-user', uid: '7693579483274183025', nickname: '客户', signature: '业务签名', follower_count: 0, following_count: 2, total_favorited: 0 }, { sourcePath: '/aweme/v1/web/comment/list/', capturedAt: 'fixture-time' });
  assert.equal(result.UID, '7693579483274183025');
  assert.equal(result.followerCount, 0); assert.equal(result.favoritedCount, 0);
  assert.equal(result.signature, '业务签名');
  assert.equal(result.homepage, 'https://www.douyin.com/user/fixture-user');
  assert.deepEqual(result.userFieldSources.signature, { path: '/aweme/v1/web/comment/list/', at: 'fixture-time' });
  assert.equal(result.profileCapturedAt, undefined); assert.equal(result.profileSourcePath, undefined);
});

test('不接受已失精度的数值UID或不可信来源路径，缺失字段保持未知', () => {
  assert.equal(identifier(7693579483274183025), '');
  assert.equal(identifier(12345), '12345');
  const result = userMetadata({ sec_uid: 'fixture', uid: 7693579483274183025, signature: '', follower_count: null }, { sourcePath: '/aweme/v1/web/comment/list/?token=private', capturedAt: 'fixture-time' });
  assert.equal(result.UID, undefined); assert.equal(result.signature, undefined); assert.equal(result.followerCount, undefined);
  assert.equal(result.userSourcePath, undefined); assert.equal(result.userFieldSources, undefined);
  assert.deepEqual(userMetadata(null), {}); assert.deepEqual(userMetadata([]), {});
});

function profileFixture() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const start = source.indexOf('function applyProfileData(');
  const end = source.indexOf('/* ===================== 线索状态', start);
  assert.ok(start >= 0 && end > start);
  const leads = [{ id: 1, uid: 'target', signature: '已有签名', status: 'followed_dm', aiReason: '已有判断', followedAt: 'old-follow', dmCount: 1, userFieldSources: { signature: { path: '/aweme/v1/web/comment/list/', at: 'old' } } }, { id: 2, uid: 'other' }];
  let writes = 0;
  const context = { URL, userMetadata, identifier, store: { getLeads: () => leads, setLeads() { writes++; }, nowStr: () => 'new-time' } };
  vm.runInNewContext(source.slice(start, end), context);
  return { leads, context, writes: () => writes };
}

test('实际主页响应补齐同UID线索，空签名不覆盖已有值，保留AI和触达状态', async () => {
  const f = profileFixture();
  await f.context.passiveProfileResponse({ url: () => 'https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=target&msToken=private', json: async () => ({ status_code: 0, user: { sec_uid: 'target', nickname: '新昵称', follower_count: 0, signature: '' } }) });
  assert.equal(f.writes(), 1); const [a, b] = f.leads;
  assert.equal(a.signature, '已有签名'); assert.equal(a.followerCount, 0); assert.equal(a.nickname, '新昵称');
  assert.equal(a.status, 'followed_dm'); assert.equal(a.dmCount, 1); assert.equal(a.aiReason, '已有判断');
  assert.equal(a.profileSourcePath, '/aweme/v1/web/user/profile/other/'); assert.equal(a.profileCapturedAt, 'new-time');
  assert.equal(a.userFieldSources.signature.at, 'old'); assert.equal(a.userFieldSources.nickname.at, 'new-time');
  assert.equal(JSON.stringify(a).includes('private'), false); assert.deepEqual(b, { id: 2, uid: 'other' });
});

test('其他域、错误目标、失败响应均不能回填用户资料', async () => {
  const cases = [
    ['https://douyin.com.evil.example/aweme/v1/web/user/profile/other/?sec_user_id=target', 0, 'target'],
    ['http://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=target', 0, 'target'],
    ['https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=other', 0, 'target'],
    ['https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=target', 8, 'target'],
    ['https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=target', undefined, 'target'],
    ['https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=target', 0, 'unrelated']
  ];
  for (const [url, status, secUid] of cases) {
    const f = profileFixture();
    await f.context.passiveProfileResponse({ url: () => url, json: async () => ({ status_code: status, user: { sec_uid: secUid, follower_count: 99 } }) });
    assert.equal(f.writes(), 0, url);
    assert.equal(f.leads[0].followerCount, undefined);
  }
});
