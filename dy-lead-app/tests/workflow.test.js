const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../workflow');
const AI = require('../ai');
function settings() { return { ai: { prompt: '真实服务需求', businessDesc: '维修' }, follow: { enabled: true }, dm: { enabled: true, skipAuthor: true, repeat: { enabled: false } }, outreach: { businessId: 'default' } }; }
function lead(patch = {}, s = settings()) {
  const l = { id: 1, accountId: '1', uid: 'user1', homepage: 'https://www.douyin.com/user/user1', demand: '需要维修', aiNeed: '是', aiReason: '询问维修服务', aiDone: true, ...patch };
  l.aiPromptVersion = AI.getRuleSet(s).version; l.aiInputHash = W.aiInputHash(l); return l;
}
test('有效 AI 是优先关键词，AI 否和待确认禁止触达', () => {
  const s = settings(), yes = lead({ intent: false, excluded: true });
  assert.equal(W.eligibility(yes, 'dm', [yes], s).ok, true);
  for (const aiNeed of ['否', '待确认']) {
    const l = lead({ aiNeed, intent: true, manualApproved: true });
    assert.equal(W.eligibility(l, 'dm', [l], s).ok, false);
  }
});

test('AI 是仍需完整有效回执，空理由、超长理由和未完成结果均不授权触达', () => {
  const s = settings();
  for (const patch of [{aiReason:''}, {aiReason:'理由'.repeat(20)}, {aiDone:false}, {aiDone:undefined}]) {
    const l = lead({...patch,manualApproved:true});
    assert.equal(W.eligibility(l,'dm',[l],s).ok,false);
  }
  const invalid = lead({aiNeed:'',manualApproved:true});
  assert.equal(W.eligibility(invalid,'dm',[invalid],s).ok,false,'损坏AI记录不能用旧人工批准兜底');
  assert.equal(W.intentEligibility(lead(),undefined).ok,false,'缺少当前规则时不能认定AI有效');
});
test('关键词候选必须有效AI或明确人工通过，关掉旧onlyAi不改变此规则', () => {
  const s = settings(), l = lead({ aiNeed: '', aiDone: false, intent: true });
  assert.equal(W.eligibility(l, 'dm', [l], s).ok, false);
  l.manualApproved = true;
  assert.equal(W.eligibility(l, 'dm', [l], s).ok, true);
});
test('业务跨账号去重、待核验和不再联系必须动态阻止发送', () => {
  const s = settings(), l = lead(), other = lead({ accountId: '2', id: 2, dmCount: 1 });
  assert.equal(W.eligibility(l, 'dm', [l, other], s).ok, false);
  for (const patch of [{ dmState: 'pending_verification' }, { dmOutcome: 'pending_verification' }, { doNotContact: true }, { replied: true }]) {
    assert.equal(W.eligibility(l, 'dm', [l, lead({ accountId: '2', ...patch })], s).ok, false);
  }
});
test('旧未核验noDm不能永久屏蔽，明确权限结论才阻止', () => {
  const s = settings(), l = lead({ noDm: true });
  assert.equal(W.eligibility(l, 'dm', [l], s).ok, true);
  l.noDmConfirmed = true;
  assert.equal(W.eligibility(l, 'dm', [l], s).ok, false);
});
test('旧AI、业务规则变更、需求编辑和视频描述变化均需重判', () => {
  const s = settings(), l = lead();
  assert.equal(W.eligibility({ ...l, aiPromptVersion: '' }, 'dm', [l], s).ok, false);
  assert.equal(W.eligibility(l, 'dm', [l], { ...s, ai: { ...s.ai, targetCustomers: '企业' } }).ok, false);
  assert.equal(W.eligibility({ ...l, demand: '无需求' }, 'dm', [l], s).ok, false);
  const withVideo = lead({ videoLink: 'https://www.douyin.com/video/123' });
  assert.equal(W.eligibility(withVideo, 'dm', [withVideo], s, Date.now(), { 123: { desc: '变化了' } }).ok, false);
});

test('图文作品描述更新后，原 AI 意向结果不能继续执行触达', () => {
  const s = settings(), note = lead({ videoLink: 'https://www.douyin.com/note/7693579483274183025' });
  const videos = { '7693579483274183025': { desc: '自身账户维修需求' } };
  note.aiInputHash = W.aiInputHash(note, videos);
  assert.equal(W.eligibility(note, 'dm', [note], s, Date.now(), videos).ok, true);
  videos['7693579483274183025'].desc = '他人案例，暂无个人需求';
  const result = W.eligibility(note, 'dm', [note], s, Date.now(), videos);
  assert.equal(result.ok, false);
  assert.match(result.reason, /描述已变化.*重新判断/);
});
test('关注的待核验锁同样阻止重复操作', () => {
  const s = settings(), l = lead({ followState: 'pending_verification' });
  assert.equal(W.eligibility(l, 'follow', [l], s).ok, false);
});

test('关注历史只约束执行账号的待核验，旧已关注仍进入现场关系检查', () => {
  const s = settings(), l = lead(), old = lead({ id: 2, accountId: '2', followedAt: '2026-10-01 12:00:00', followState: 'pending_verification' });
  assert.equal(W.eligibility(l, 'follow', [l, old], s).ok, true);
  l.followedAt = '2026-10-01 12:00:00'; l.followState = 'confirmed_success';
  assert.equal(W.eligibility(l, 'follow', [l, old], s).ok, true, '保存的历史不能代替本次网页关系');
  old.followAttemptAccountId = '1';
  assert.equal(W.eligibility(l, 'follow', [l, old], s).ok, false, '旧跨账号复制记录仍按实际执行账号保留待核验锁');
  assert.equal(W.eligibility(old, 'follow', [old], s).ok, true, '其他账号的复制锁不能阻断当前执行账号');
  assert.equal(W.eligibility(old, 'follow', [old], s, Date.now(), {}, { accountId: '1' }).ok, false);
});

test('网页历史未知且无本地已发记录按首发；完整空历史不会抵消待核验', () => {
  const s = settings(), now = Date.parse('2026-10-09T04:00:00Z'), l = lead();
  const options = { requireObservedDmHistory: true };
  for (const observation of [undefined, { state: 'unknown' }, { state: 'no_outbound', accountId: '1', checkedAtMs: now, complete: false }]) {
    l.dmHistoryObserved = observation;
    const result = W.eligibility(l, 'dm', [l], s, now, {}, options);
    assert.equal(result.ok, true); assert.equal(result.historyState, 'unknown');
  }
  l.dmHistoryObserved = { state: 'no_outbound', accountId: '1', checkedAtMs: now, complete: true };
  assert.equal(W.eligibility(l, 'dm', [l], s, now, {}, options).historyState, 'no_outbound');
  const pending = lead({ id: 2, accountId: '2', dmState: 'pending_verification' });
  assert.match(W.eligibility(l, 'dm', [l, pending], s, now, {}, options).reason, /待核验/);
});

test('明确网页已发与本地跨账号记录合并，重复依最新可靠时间且未知时间不得自动重复', () => {
  const s = settings(), now = Date.parse('2026-10-09T04:00:00Z'), l = lead();
  const other = lead({ id: 2, accountId: '2', dmHistorySentObserved: { state: 'already_sent', accountId: '2', checkedAtMs: now - 1000, lastSentAt: now - 8 * 86400000 } });
  assert.match(W.eligibility(l, 'dm', [l, other], s, now).reason, /重复联系未开启/);
  s.dm.repeat = { enabled: true, intervalDays: 7 };
  assert.equal(W.eligibility(l, 'dm', [l, other], s, now).ok, true);
  l.dmCount = 1; l.dmLastAt = '2026-10-08 12:00:00';
  assert.match(W.eligibility(l, 'dm', [l, other], s, now).reason, /间隔/);
  l.dmLastAt = '2026-10-01 12:00:00'; other.dmHistorySentObserved.lastSentAt = null;
  assert.match(W.eligibility(l, 'dm', [l, other], s, now).reason, /时间未确认/);
  other.businessId = 'different';
  assert.equal(W.eligibility(l, 'dm', [l, other], s, now).ok, true);
  const before = JSON.stringify([l, other]); W.dmHistoryEligibility(l, [l, other], s, now, '1', { requireObserved: true });
  assert.equal(JSON.stringify([l, other]), before, '观察与资格判断不能增加本次发送次数或结果');
});

test('最近空历史不能清除历史已发证据，未知本地发送时间同样禁止重复', () => {
  const s = settings(); s.dm.repeat = { enabled: true, intervalDays: 1 };
  const now = Date.parse('2026-10-09T04:00:00Z'), l = lead({ dmCount: 1, dmHistoryObserved: { state: 'no_outbound', accountId: '1', checkedAtMs: now, complete: true } });
  assert.match(W.eligibility(l, 'dm', [l], s, now).reason, /时间未确认/);
  l.dmCount = 0; l.dmHistorySentObserved = { state: 'already_sent', lastSentAt: now - 3600000 };
  assert.match(W.eligibility(l, 'dm', [l], s, now).reason, /间隔/);
});

test('重复策略快照有确定默认值并进入指纹，非法间隔拒绝', () => {
  const s = settings(), actions = { follow: true, dm: true };
  assert.deepEqual(W.contactPolicy(s), { repeat: { enabled: false, intervalDays: 7 }, historyUnknown: 'allow_initial' });
  const fingerprint = W.settingsFingerprint(s, actions);
  s.dm.repeat.enabled = true;
  assert.notEqual(W.settingsFingerprint(s, actions), fingerprint);
  const enabled = W.settingsFingerprint(s, actions); s.dm.repeat.intervalDays = 8;
  assert.notEqual(W.settingsFingerprint(s, actions), enabled);
  for (const intervalDays of [0, -1, 0.5, '7', NaN, Infinity]) assert.throws(() => W.contactPolicy({ dm: { repeat: { intervalDays } } }), /至少为1天/);
});
test('明确重复配置需可靠历史时间和完整间隔，不能跳过待核验', () => {
  const s = settings(); s.dm.repeat = { enabled: true, intervalDays: 7 };
  const l = lead({ dmCount: 1, dmLastAt: '2026-10-01 12:00:00' });
  assert.equal(W.eligibility(l, 'dm', [l], s, Date.parse('2026-10-08T04:00:00Z')).ok, true);
  assert.equal(W.eligibility(l, 'dm', [l], s, Date.parse('2026-10-08T03:59:00Z')).ok, false);
  l.dmState = 'pending_verification';
  assert.equal(W.eligibility(l, 'dm', [l], s, Date.parse('2026-10-20T04:00:00Z')).ok, false);
});
test('主页必须https抖音并且匹配同一用户；不同业务不会去重', () => {
  const s = settings(), l = lead();
  for (const homepage of ['http://www.douyin.com/user/user1', 'https://evil.example/user/user1', 'https://www.douyin.com/user/user2']) assert.equal(W.eligibility({ ...l, homepage }, 'dm', [l], s).ok, false);
  assert.equal(W.eligibility(l, 'dm', [l, lead({ businessId: 'other', dmCount: 1 })], s).ok, true);
});
test('没有本次证据的成功回执降为待核验', () => {
  for (const r of [null, { state: 'confirmed_success' }, { state: 'success', evidence: 'unknown' }]) assert.equal(W.validateDmOutcome(r).state, 'pending_verification');
  assert.equal(W.validateDmOutcome({ state: 'confirmed_success', evidence: 'test receipt' }).state, 'confirmed_success');
});
test('额度按实际尝试计算并兼容旧成功计数，主页零预算必须保留', () => {
  const s = settings(); s.follow.dailyLimit = 5; s.dm.dailyLimit = 6;
  assert.deepEqual(W.getQuotas(s, { follow: 3, followAttempts: 4, dm: 2 }), {
    follow: { limit: 5, used: 4, remaining: 1 }, dm: { limit: 6, used: 2, remaining: 4 }, profile: { limit: 11, used: 0, remaining: 11 }
  });
  s.outreach.dailyProfileLimit = 0;
  assert.deepEqual(W.getQuotas(s, { dmAttempts: 9 }).profile, { limit: 0, used: 0, remaining: 0 });
  assert.equal(W.getQuotas(s, { dmAttempts: 9 }).dm.remaining, 0);
});
