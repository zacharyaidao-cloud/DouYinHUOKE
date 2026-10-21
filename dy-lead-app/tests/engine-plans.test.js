const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const qaRoot = path.resolve(__dirname, '../../build-tools');
const temp = fs.mkdtempSync(path.join(qaRoot, 'qa-engine-plans-'));
process.env.DY_LEAD_DATA_DIR = temp;
const store = require('../store');
const engine = require('../engine');
const W = require('../workflow');
const AI = require('../ai');
after(() => { if (!path.resolve(temp).startsWith(qaRoot + path.sep)) throw new Error('Unsafe QA cleanup path'); fs.rmSync(temp, { recursive: true, force: true }); });
function reset() {
  const s = structuredClone(store.DEFAULT_SETTINGS);
  store.setSettings(s); store.setAccounts([{ id: '1' }, { id: '2' }]); store.setPlans([]); store.setVideos({}); store.setDaily({});
  const leads = [1, 2].map(id => {
    const l = { id, accountId: '1', uid: 'user' + id, homepage: 'https://www.douyin.com/user/user' + id, nickname: id === 1 ? '目标' : '其他', demand: '自身需求', aiNeed: '是', aiReason: '描述当前相关问题', aiDone: true };
    l.aiPromptVersion = AI.getRuleSet(s).version; l.aiInputHash = W.aiInputHash(l); return l;
  });
  store.setLeads(leads); engine.taskState.running = false; engine.taskState.stopRequested = false;
  engine.configure({ authorize: async () => { throw new Error('mock license revoked; never launch browser'); } });
  return { s, leads };
}

test('失败名单重试成功后真实存储、列表状态和失败筛选同步更新', () => {
  const { s, leads } = reset();
  Object.assign(leads[0], { dmState: 'confirmed_failure', dmOutcome: 'confirmed_failure', status: 'dm_failed', dmFailedReason: '旧失败', dmCount: 0 });
  store.setLeads(leads);
  engine.saveLeadAction({ ...leads[0], dmState: 'confirmed_success', dmOutcome: 'confirmed_success', dmFailedReason: '', dmCount: 1, dmLastAt: store.nowStr(), dmEvidence: 'matched accepted response' }, 'dm', s);
  const saved = store.getLeads()[0];
  assert.equal(saved.status, 'dm_sent'); assert.equal(saved.dmFailedReason, ''); assert.equal(saved.dmCount, 1);
  const query = require('../lead-query');
  assert.equal(query.contactCategory(saved), 'sent');
  assert.equal(query.filterLeads([saved], {}, { s: 'dm_failed' }).length, 0);
  assert.equal(query.filterLeads([saved], {}, { contact: 'sent' }).length, 1);
});
test('预检查来自同一筛选，固定保存名单，显式空选择为空', () => {
  reset();
  const p = engine.createPlan('1', 'outreach', { filters: { q: '目标' }, owner: 'customer' });
  assert.deepEqual(p.leadIds, ['1']); assert.equal(store.getPlans()[0].owner, 'customer');
  assert.deepEqual(engine.createPlan('1', 'dm', { leadIds: [] }).leadIds, []);
  assert.throws(() => engine.createPlan('1', 'dm', { leadIds: [999] }), /删除|账号/);
  assert.throws(() => engine.createPlan('1', 'dm', { filters: { f: 'invalid' } }), /筛选/);
});
test('单账户执行可跨采集账号使用共享线索池', () => {
  const { leads } = reset();
  leads[0].accountId = '2'; leads[1].accountId = '2';
  store.setLeads(leads);
  const shared = engine.createPlan('1', 'outreach', { filters: { f: 'all' }, crossAccount: true });
  assert.equal(shared.count, 2);
  assert.deepEqual(shared.leadIds.sort(), ['1', '2']);
  assert.ok(shared.leads.every(lead => lead.actions.dm === true && lead.actions.follow === true), '跨采集账号同样执行关注与私信');
});
test('预检冻结每位用户话术，新版拒绝旧流程计划', async () => {
  const {s}=reset();s.dm.template='您好{昵称}';store.setSettings(s);
  const plan=engine.createPlan('1','dm');
  assert.equal(plan.schemaVersion,3);assert.equal(plan.dmTemplate,'您好{昵称}');
  assert.equal(plan.leads[0].messagePreview,'您好目标');
  const saved=store.getPlans();saved[0].schemaVersion=2;store.setPlans(saved);
  const result=await engine.dmTask('1',{planId:plan.id});assert.match(result.error,/旧流程/);
});
test('没有预检查或账号操作不匹配拒绝执行', async () => {
  reset();
  assert.equal((await engine.dmTask('1')).ok, false);
  const p = engine.createPlan('1', 'dm');
  assert.equal((await engine.followTask('1', { planId: p.id })).ok, false);
  assert.equal((await engine.dmTask('2', { planId: p.id })).ok, false);
  assert.ok(!store.getPlans()[0].consumed);
});
test('私信预检查拒绝空话术和非文本，失败不保存计划且仅关注不受影响', () => {
  for(const template of ['', ' \n\t ', null, 0, false, {}, ['消息']]) {
    const {s}=reset();s.dm.template=template;store.setSettings(s);
    assert.throws(()=>engine.createPlan('1','dm'),/话术必须为非空文本/);
    assert.throws(()=>engine.createPlan('1','outreach'),/话术必须为非空文本/);
    assert.deepEqual(store.getPlans(),[]);
    const follow=engine.createPlan('1','follow');
    assert.equal(follow.actions.dm,false);assert.equal(follow.dmTemplate,'');
    assert.ok(follow.leads.every(lead=>lead.messagePreview===''));
  }
});
test('预检查冻结去掉首尾空白的实际发送文本，代入后空消息也拒绝', () => {
  const {s}=reset();s.dm.template=' \n 您好 {昵称}\n问题：{评论内容}\n ';store.setSettings(s);
  const plan=engine.createPlan('1','dm');
  assert.equal(plan.dmTemplate,s.dm.template);
  assert.equal(plan.leads[0].messagePreview,'您好 目标\n问题：自身需求');
  assert.equal(store.getPlans()[0].leads[0].messagePreview,plan.leads[0].messagePreview);
  store.setPlans([]);s.dm.template=' {属地} ';store.setSettings(s);
  assert.throws(()=>engine.createPlan('1','dm'),/话术代入后为空/);
  assert.deepEqual(store.getPlans(),[]);
});
test('计划首次执行原子消费，授权失败后同一计划不可再运行', async () => {
  reset(); const p = engine.createPlan('1', 'dm');
  const first = await engine.dmTask('1', { planId: p.id });
  assert.equal(first.ok, false); assert.match(first.error, /mock license/);
  assert.equal(store.getPlans()[0].consumed, true);
  const second = await engine.dmTask('1', { planId: p.id });
  assert.match(second.error, /已经执行/);
});
test('规则补充业务字段或话术变化会使预检查失效', async () => {
  const { s } = reset(); const p = engine.createPlan('1', 'dm');
  s.ai.targetCustomers = 'new target'; store.setSettings(s);
  const r = await engine.dmTask('1', { planId: p.id });
  assert.match(r.error, /改变/); assert.ok(!store.getPlans()[0].consumed);
});

test('计划冻结重复规则和网页关系检查，改变规则或损坏快照均须重建', async () => {
  for (const change of [s => { s.dm.repeat.enabled = !s.dm.repeat.enabled; }, s => { s.dm.repeat.intervalDays++; }]) {
    const { s } = reset(), plan = engine.createPlan('1', 'dm');
    assert.deepEqual(plan.contactPolicy, { repeat: { enabled: false, intervalDays: 7 }, historyUnknown: 'allow_initial' });
    assert.equal(plan.requiresRelationCheck, true);
    change(s); store.setSettings(s);
    const result = await engine.dmTask('1', { planId: plan.id });
    assert.match(result.error, /重复联系规则已改变/); assert.ok(!store.getPlans()[0].consumed);
    assert.equal(plan.contactPolicy.repeat.enabled, false); assert.equal(plan.contactPolicy.repeat.intervalDays, 7);
  }
  reset(); const plan = engine.createPlan('1', 'dm'), saved = store.getPlans();
  delete saved[0].contactPolicy; store.setPlans(saved);
  assert.match((await engine.dmTask('1', { planId: plan.id })).error, /旧流程/);
});

test('关注保存仅同步实际执行账号；私信仍按当前业务UID跨账号同步', () => {
  const { s, leads } = reset(), lead = leads[0];
  const duplicate = { ...lead, id: 3 }, other = { ...lead, id: 4, accountId: '2', followedAt: '旧时间', followState: 'confirmed_success', followEvidence: '已有记录' };
  const otherBusiness = { ...lead, id: 5, businessId: 'other' };
  store.setLeads([lead, duplicate, other, otherBusiness]);
  engine.saveLeadAction({ ...lead, followAttemptAccountId: '1', followedAt: '本次时间', followState: 'confirmed_success' }, 'follow', s);
  let saved = store.getLeads();
  assert.equal(saved[0].followedAt, '本次时间'); assert.equal(saved[1].followedAt, '本次时间');
  assert.deepEqual(saved[2], other); assert.deepEqual(saved[3], otherBusiness);
  engine.saveLeadAction({ ...lead, dmCount: 1, dmLastAt: '2026-10-09 10:00:00', dmState: 'confirmed_success', dmAttemptAccountId: '1' }, 'dm', s);
  saved = store.getLeads(); assert.deepEqual(saved.slice(0, 3).map(row => row.dmCount), [1, 1, 1]); assert.equal(saved[3].dmCount, undefined);
  assert.equal(saved[2].followEvidence, '已有记录');
});

test('未点击关注恢复旧复制快照只恢复当前账号，不能覆盖其他账号的已确认结果', () => {
  const { leads, s } = reset(), current = { ...leads[0], followAttemptAccountId: '1', followState: 'pending_verification', followAttemptId: 'current' };
  const original = { ...leads[0], id: 3, accountId: '2', followAttemptAccountId: '2', followState: 'confirmed_success', followedAt: '真实已确认', followEvidence: 'confirmed-receipt' };
  store.setLeads([current, original]);
  engine.saveLeadAction({ ...current, followAttemptAccountId: '2', followAttemptId: undefined, followState: 'confirmed_failure', followedAt: undefined }, 'follow', s);
  const saved = store.getLeads();
  assert.equal(saved[0].followAttemptAccountId, '2'); assert.equal(saved[0].followState, 'confirmed_failure');
  assert.equal(Object.hasOwn(saved[0], 'followAttemptId'), false);
  assert.deepEqual(saved[1], original);
});

test('网页观察按执行账号保存且与本软件动作结果隔离，不完整或未知历史不落库', () => {
  const { leads } = reset(), lead = leads[0], now = Date.now() - 1000;
  const duplicate = { ...lead, id: 3 }, other = { ...lead, id: 4, accountId: '2' };
  store.setLeads([lead, duplicate, other]);
  const observation = { state: 'already_sent', accountId: '1', checkedAt: new Date(now).toISOString(), checkedAtMs: now, lastSentAt: now - 86400000, source: 'history_protocol', evidence: 'matched-self-sender', complete: true, privateBody: 'must-not-persist' };
  engine.saveContactObservation(1, 'dm', observation);
  let saved = store.getLeads();
  assert.equal(saved[0].dmHistoryObserved.lastSentAt, now - 86400000); assert.deepEqual(saved[0].dmHistoryObserved, saved[1].dmHistoryObserved);
  assert.equal(saved[0].dmHistoryObserved.privateBody, undefined); assert.equal(saved[0].dmHistorySentObserved.state, 'already_sent');
  for (const field of ['dmCount', 'dmState', 'dmOutcome', 'dmLastAt', 'dmAttemptId', 'status']) assert.equal(saved[0][field], undefined);
  // 私信观察跨账号共享（同一联系人键），记录自带执行账号；动作结果字段仍不产生
  assert.equal(saved[2].dmHistoryObserved.state, 'already_sent'); assert.equal(saved[2].dmHistoryObserved.accountId, '1');
  for (const field of ['dmCount', 'dmState', 'dmOutcome', 'dmLastAt', 'dmAttemptId', 'status']) assert.equal(saved[2][field], undefined);
  const before = JSON.stringify(saved);
  for (const state of ['unknown', 'no_outbound']) engine.saveContactObservation(1, 'dm', { ...observation, state, checkedAtMs: now + 1, complete: false });
  assert.equal(JSON.stringify(store.getLeads()), before);
  engine.saveContactObservation(1, 'dm', { ...observation, accountId: '2' });
  saved = store.getLeads(); assert.equal(saved[2].dmHistoryObserved.accountId, '2'); assert.equal(saved[0].dmHistoryObserved.accountId, '2');
  assert.throws(() => engine.saveContactObservation(1, 'dm', { ...observation, checkedAtMs: Date.now() + 10000 }), /时间/);
  engine.saveContactObservation(1, 'follow', { state: 'following', accountId: '1', checkedAtMs: now, source: 'profile_response', evidence: 'matched-profile' });
  saved = store.getLeads(); assert.equal(saved[0].followObserved.state, 'following'); assert.equal(saved[0].followedAt, undefined); assert.equal(saved[0].followState, undefined);
  assert.equal(saved[2].followObserved, undefined, '关注观察仅保存到执行账号所在行');
});

test('网页正向历史不会被空历史覆盖且不会倒退最近发送时间', () => {
  const { leads } = reset(), now = Date.now() - 10000;
  const positive = { state: 'already_sent', accountId: '1', checkedAtMs: now, lastSentAt: now - 1000, source: 'history_protocol', evidence: 'matched-self-sender', complete: true };
  leads[0].dmHistoryObserved = positive; store.setLeads(leads);
  engine.saveContactObservation(1, 'dm', { ...positive, state: 'no_outbound', lastSentAt: null, checkedAtMs: now + 1000 });
  let saved = store.getLeads()[0]; assert.equal(saved.dmHistoryObserved.state, 'no_outbound'); assert.deepEqual(saved.dmHistorySentObserved, positive);
  engine.saveContactObservation(1, 'dm', { ...positive, checkedAtMs: now + 2000, lastSentAt: now - 5000 });
  assert.equal(store.getLeads()[0].dmHistorySentObserved.lastSentAt, now - 1000);
  const before = JSON.stringify(store.getLeads()); engine.saveContactObservation(1, 'dm', positive);
  assert.equal(JSON.stringify(store.getLeads()), before, '过期观察不能覆盖新观察');
});
test('采集支持分享短链和图文，重复完整链接只执行一次，外域仍拒绝', () => {
  assert.deepEqual(engine.parseVideoList('https://www.douyin.com/video/123\nhttps://www.douyin.com/video/123'), [{ id: '123', type: 'video', url: 'https://www.douyin.com/video/123', force: false }]);
  assert.deepEqual(engine.parseVideoList('分享图文 https://www.douyin.com/note/456\n分享作品 https://v.douyin.com/abc/').map(item => item.type), ['note', 'short']);
  assert.throws(() => engine.parseVideoList('https://evil.example/video/123'), /第 1/);
});
test('被动资料回填按目标UID，不触发任何额外请求', () => {
  reset();
  assert.equal(engine.applyProfileData({ sec_uid: 'user1', signature: '', follower_count: 0, nickname: 'not used', user_age: 20 }), 1);
  const [a, b] = store.getLeads(); assert.equal(a.followerCount, 0); assert.equal(a.age, 20); assert.equal(b.age, undefined);
  assert.equal(engine.applyProfileData({ sec_uid: 'unrelated', follower_count: 99 }), 0);
});
test('迁移旧noDm仅保留有证据的平台结论，停止在撤销授权后仍可用', () => {
  const { leads } = reset(); leads[0].noDm = true; leads[0].status = 'no_dm'; leads[1].noDm = true; leads[1].noDmConfirmed = true;
  store.setLeads(leads); engine.migrateLeads();
  const [a, b] = store.getLeads(); assert.equal(a.noDm, false); assert.equal(b.noDm, true);
  engine.taskState.running = true;
  assert.equal(engine.stopTask().ok, true); assert.equal(engine.taskState.stopRequested, true); engine.taskState.running = false;
});
test('旧合并状态迁移后不能重发，已回复迁移只修改一次', () => {
  const { leads, s } = reset(); leads[0].status = 'followed_dm'; leads[1].status = 'replied';
  store.setLeads(leads); engine.migrateLeads();
  const [a, b] = store.getLeads(); assert.ok(a.followedAt); assert.equal(a.dmCount, 1); assert.ok(a.dmLastAt); assert.equal(b.replied, true);
  assert.equal(engine.buildDmQueue('1', s).length, 0);
  const before = fs.statSync(store.F.leads).mtimeMs; engine.migrateLeads();
  assert.equal(fs.statSync(store.F.leads).mtimeMs, before);
});
test('尝试额度耗尽的预检查名单为空，预检查不预占每日额度', () => {
  const { s } = reset(); s.follow.dailyLimit = 0; s.dm.dailyLimit = 2; store.setSettings(s);
  const daily = { '1': { [store.opDayStr()]: { dm: 0, dmAttempts: 2, profileVisits: 0 } } }; store.setDaily(daily);
  const plan = engine.createPlan('1', 'outreach');
  assert.equal(plan.matchedCount, 2); assert.equal(plan.count, 0);
  assert.deepEqual(plan.remaining, { follow: 0, dm: 0, profile: 2 });
  assert.match(plan.skippedReason, /尝试额度/); assert.equal(plan.quota.dm.used, 2);
  assert.deepEqual(store.getDaily(), daily);
});
test('组合任务按用户冻结剩余额度，部分用户只执行仍有额度的操作', () => {
  const { s } = reset(); s.follow.dailyLimit = 1; s.dm.dailyLimit = 2; store.setSettings(s);
  const plan = engine.createPlan('1', 'outreach');
  assert.equal(plan.count, 2); assert.deepEqual(plan.plannedCounts, { follow: 1, dm: 2, profile: 2 });
  assert.deepEqual(plan.leads.map(l => l.actions), [{ follow: true, dm: true }, { follow: false, dm: true }]);
  assert.deepEqual(plan.remaining, { follow: 1, dm: 2, profile: 3 });
  assert.equal(engine.createPlan('1', 'outreach').count, 2);
  assert.deepEqual(store.getDaily(), {});
});
test('组合操作只消耗一次主页预算，显式零预算不给执行名单', () => {
  const { s } = reset(); s.outreach.dailyProfileLimit = 1; store.setSettings(s);
  const first = engine.createPlan('1', 'outreach');
  assert.equal(first.count, 1); assert.deepEqual(first.plannedCounts, { follow: 1, dm: 1, profile: 1 });
  assert.match(first.warnings.join(''), /主页访问额度/);
  store.setDaily({ '1': { [store.opDayStr()]: { profileVisits: 1 } } });
  assert.equal(engine.createPlan('1', 'outreach').count, 0);
  s.outreach.dailyProfileLimit = 0; store.setSettings(s); store.setDaily({});
  const empty = engine.createPlan('1', 'outreach');
  assert.equal(empty.count, 0); assert.match(empty.skippedReason, /主页访问额度/);
});

test('一次性合并跨账号重复线索：先完整备份，执行计划改指保留行，写完成标记后不再重复执行', () => {
  const marks = store.getMigrations(); delete marks.leadDedupeV1; store.setMigrations(marks);
  const link = 'https://www.douyin.com/note/7325461810767727872';
  store.setLeads([
    { id: 1, accountId: '1', uid: 'dup-user', demand: '账号停用了', videoLink: link, followState: 'confirmed_success', followedAt: '2026-10-19 10:00:00', dmCount: 0 },
    { id: 2, accountId: '2', uid: 'dup-user', demand: '账号停用了', videoLink: link + '?from=share', dmState: 'confirmed_success', dmLastAt: '2026-10-21 10:00:00', dmCount: 1 },
    { id: 3, accountId: '1', uid: 'other-user', demand: '另一个人', videoLink: link, dmCount: 0 }
  ]);
  store.setPlans([{ id: 'p1', leadIds: ['1', '3'], leads: [{ id: 1 }, { id: 3 }] }]);
  const record = engine.dedupeStoredLeadsOnce();
  assert.equal(record.merged, 1); assert.equal(record.before, 3); assert.equal(record.after, 2);
  assert.ok(record.backup && fs.existsSync(path.join(store.DATA_DIR, record.backup)), '原文件已备份');
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, record.backup), 'utf8')).length, 3, '备份是合并前的完整数据');
  const leads = store.getLeads();
  assert.deepEqual(leads.map(l => l.id), [2, 3]);
  assert.equal(leads[0].followState, 'confirmed_success'); assert.equal(leads[0].dmState, 'confirmed_success');
  assert.deepEqual(store.getPlans()[0].leadIds, ['2', '3']);
  assert.equal(store.getMigrations().leadDedupeV1.merged, 1);
  // 再次启动：已有标记，不再执行（即使又出现重复也不动，日常采集由 dedupeKey 防止新重复）
  store.setLeads([...store.getLeads(), { id: 9, accountId: '3', uid: 'dup-user', demand: '账号停用了', videoLink: link }]);
  assert.equal(engine.dedupeStoredLeadsOnce(), null);
  assert.equal(store.getLeads().length, 3);
});
