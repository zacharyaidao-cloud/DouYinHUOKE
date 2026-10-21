'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeDuplicateLeads, remapPlans } = require('../lib/lead-dedupe');

const key = l => [String(l.videoLink).match(/\/(?:video|note)\/(\d+)/)[1], l.uid, String(l.demand || '').trim()].join('||');
const base = { uid: 'u1', demand: '账号被停用了怎么办', videoLink: 'https://www.douyin.com/note/7325461810767727872' };

test('同作品同用户同评论合并为一行：保留有私信记录的行，其余行的关注与 AI 结果补进来', () => {
  const leads = [
    { id: 1, accountId: 'A', ...base, followState: 'confirmed_success', followedAt: '2026-10-19 10:00:00' },
    { id: 2, accountId: 'B', ...base, videoLink: base.videoLink + '?from=share', dmState: 'confirmed_success', dmLastAt: '2026-10-21 10:00:00' },
    { id: 3, accountId: 'C', ...base, aiDone: true, aiNeed: '是', aiReason: '描述自身问题' },
    { id: 4, accountId: 'A', uid: 'u2', demand: '另一个人', videoLink: base.videoLink }
  ];
  const { leads: out, idMap } = mergeDuplicateLeads(leads, key);
  assert.equal(out.length, 2);
  const kept = out[0];
  assert.equal(kept.id, 2, '私信成功的行保留');
  assert.equal(kept.accountId, 'B');
  assert.equal(kept.followState, 'confirmed_success'); assert.equal(kept.followedAt, '2026-10-19 10:00:00');
  assert.equal(kept.aiNeed, '是'); assert.equal(kept.aiReason, '描述自身问题');
  assert.equal(kept.dmLastAt, '2026-10-21 10:00:00');
  assert.deepEqual(Object.fromEntries(idMap), { 1: '2', 3: '2' });
  assert.equal(out[1].id, 4);
});

test('没有任何进度时保留编号最小（最早采到）的行，并保持原列表位置', () => {
  const leads = [{ id: 9, uid: 'x', demand: 'a', videoLink: 'https://www.douyin.com/video/1' }, { id: 5, ...base }, { id: 7, ...base, signature: '补充签名' }];
  const { leads: out } = mergeDuplicateLeads(leads, key);
  assert.deepEqual(out.map(l => l.id), [9, 5]);
  assert.equal(out[1].signature, '补充签名');
});

test('保留行已有的值不被覆盖；没有重复时原样返回', () => {
  const leads = [{ id: 1, ...base, nickname: '原昵称', followState: 'confirmed_success' }, { id: 2, ...base, nickname: '新昵称' }];
  assert.equal(mergeDuplicateLeads(leads, key).leads[0].nickname, '原昵称');
  const single = [{ id: 1, ...base }];
  const result = mergeDuplicateLeads(single, key);
  assert.deepEqual(result.leads, single); assert.equal(result.idMap.size, 0);
});

test('执行计划里对被合并行的引用改指保留行，并去掉合并后重复的 id', () => {
  const plans = [{ leadIds: ['1', '2', '4'], leads: [{ id: 1, actions: { dm: true } }, { id: 2, actions: { dm: true } }, { id: 4 }] }, { leadIds: ['4'] }];
  const changed = remapPlans(plans, new Map([['1', '2']]));
  assert.equal(changed, true);
  assert.deepEqual(plans[0].leadIds, ['2', '4']);
  assert.deepEqual(plans[0].leads.map(l => l.id), [2, 4]);
  assert.deepEqual(plans[1].leadIds, ['4']);
  assert.equal(remapPlans(plans, new Map()), false);
});
