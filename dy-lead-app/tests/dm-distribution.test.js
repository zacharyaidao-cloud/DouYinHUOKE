'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyAccountSignal, cooldownFor } = require('../lib/dm-account-signals');
const { createDmDistribution } = require('../engine-dm-distribution');

const qaRoot = path.resolve(__dirname, '../../build-tools');
const temp = fs.mkdtempSync(path.join(qaRoot, 'qa-dm-distribution-'));
process.env.DY_LEAD_DATA_DIR = temp;

const store = require('../store');
const AI = require('../ai');
const workflow = require('../workflow');

function makeFixture({ responses = {}, trackCalls = null, onSetTask = null, guardRunning = false, fakeClock = false, recordUsage = false, closeAccount = null } = {}) {
  const taskState = { running: false, stopRequested: false, distributionActive: false, stopEpoch: 0, status: '', errors: [] };
  // fakeClock：sleep 只推进虚拟时间，账号切换间隔与冷却等待瞬间完成
  let fakeNow = Date.now();
  const clock = { now: () => fakeNow, sleep: async ms => { fakeNow += Math.max(0, ms); await new Promise(setImmediate); } };
  const setTask = patch => { Object.assign(taskState, patch); if (onSetTask) onSetTask(patch, taskState, clock); };
  const failTask = msg => { taskState.status = msg; return { ok: false, error: msg }; };
  const checkpoint = () => {};
  const calls = [];
  const batches = []; // [accountId, leadIds, result]
  let lastBatchIds = [];
  const createPlan = (accountId, kind, options) => {
    calls.push(['plan', accountId, options && options.leadIds]);
    lastBatchIds = (options && options.leadIds || []).map(String);
    return { id: 'plan-' + accountId + '-' + calls.length, planId: 'plan-' + accountId + '-' + calls.length, accountId: String(accountId), kind: 'outreach', crossAccount: true, actions: { follow: false, dm: true }, dmTemplate: options.dmTemplate || '话术' };
  };
  const runOutreach = async (accountId, options) => {
    const key = String(accountId);
    if (trackCalls) trackCalls.push(key);
    // 模拟真实 runTask 第一行的任务锁守卫：分发器必须先释放 running，否则每个批次都被拒
    if (guardRunning && taskState.running) return { ok: false, error: '已有任务在运行' };
    const scripted = responses[key];
    let result;
    if (Array.isArray(scripted) && scripted.length) {
      const next = scripted.shift();
      result = typeof next === 'function' ? next(lastBatchIds) : next;
    } else {
      result = { ok: true, dmCount: lastBatchIds.length, pendingCount: 0, failedCount: 0, skipped: 0 };
    }
    // 模拟真实 runTask 记账：成功私信计入当日用量，分配时才能看到已执行量
    if (recordUsage) for (let i = 0; i < (Number(result.dmCount) || 0); i++) { store.bumpDaily(key, 'dm'); store.bumpDaily(key, 'dmAttempts'); store.bumpDaily(key, 'profileVisits'); }
    batches.push([key, [...lastBatchIds], result]);
    return result;
  };
  const dist = createDmDistribution({ store, taskState, setTask, failTask, checkpoint, createPlan, runOutreach, getSignal: () => null, ...(fakeClock ? clock : {}), ...(closeAccount ? { closeAccount } : {}) });
  return { taskState, calls, batches, clock, dist, runOutreach };
}

function seedLeads(accounts, works) {
  const settings = store.getSettings();
  const ruleVersion = AI.getRuleSet(settings).version;
  const rows = [];
  let id = 1;
  for (const acc of accounts) {
    for (const work of works) {
      for (let i = 0; i < work.count; i++) {
        const lead = { id: id++, accountId: String(acc), uid: 'u-' + acc + '-' + work.id + '-' + i, nickname: 'n' + id, demand: '价格怎么算', aiNeed: '是', aiReason: '描述当前相关问题', aiDone: true, videoLink: 'https://www.douyin.com/video/' + work.id, businessId: 'default' };
        lead.homepage = 'https://www.douyin.com/user/' + lead.uid;
        lead.aiPromptVersion = ruleVersion;
        lead.aiInputHash = workflow.aiInputHash(lead);
        rows.push(lead);
      }
    }
  }
  store.setLeads(rows);
  store.setVideos({});
}

function freshSettings() {
  store.setAccounts([{ id: '1', name: '账号1' }, { id: '2', name: '账号2' }]);
  store.setPlans([]);
  store.setDaily({});
  store.setDmAccountState({});
  store.setAllocations({});
  const s = store.getSettings();
  s.dm.enabled = true;
  s.dm.dailyLimit = 10;
  s.dm.poolAccounts = [];
  s.dm.frequentCooldownSec = 1800;
  s.dm.batchPerAccount = 3;
  s.dm.accountSwitchIntervalSec = 1;
  s.dm.roundRestSec = 0; // 轮间休息另有专门测试
  s.dm.sameVideoPerBatch = 2;
  s.dm.adaptiveCap = false;
  s.dm.maxFrequentRetriesPerDay = 2;
  s.follow.enabled = false;
  s.ai.prompt = '规则';
  store.setSettings(s);
}

test.after(() => { if (!path.resolve(temp).startsWith(qaRoot + path.sep)) throw new Error('Unsafe QA cleanup path'); fs.rmSync(temp, { recursive: true, force: true }); });

test('账号级信号分类：频繁/上限/接收人/未知回退', () => {
  assert.equal(classifyAccountSignal('PLATFORM_RESTRICTED', '操作过于频繁，请稍后再试'), 'frequent');
  assert.equal(classifyAccountSignal('PLATFORM_DAILY_LIMIT', '今日关注或私信次数已达上限'), 'daily_limit');
  assert.equal(classifyAccountSignal('', '今日私信发送次数已达上限'), 'daily_limit');
  assert.equal(classifyAccountSignal('', '发送太频繁了，稍后再试'), 'frequent');
  // 检查码本身不说明是账号级：只有 dm-rejection 精确识别的账号级回执才算频繁/上限
  assert.equal(classifyAccountSignal('', '服务端拒绝本次私信：消息检查未通过（检查码：2）'), null);
  assert.equal(classifyAccountSignal('', '[DM_ACCOUNT_FREQUENT] 平台提示私信操作频繁'), 'frequent');
  assert.equal(classifyAccountSignal('', '[DM_ACCOUNT_DAILY_LIMIT] 平台提示今日陌生人私信已达上限'), 'daily_limit');
  assert.equal(classifyAccountSignal('', '[DM_RECIPIENT_MUTUAL_ONLY] 对方仅允许互关用户私信'), 'recipient');
  assert.equal(classifyAccountSignal('', '给陌生人发送消息过于频繁，请稍后再发送陌生人消息'), 'frequent');
  assert.equal(classifyAccountSignal('', '今日陌生人私信已达上限'), 'daily_limit');
  assert.equal(classifyAccountSignal('', '对方仅自己可见，无法私信'), 'recipient');
  assert.equal(classifyAccountSignal('', '无法归类的未知文案'), null);
  assert.equal(classifyAccountSignal(null, ''), null);
  // 泛化的“稍后再试”不再算频繁；接收人级先于频繁判断
  assert.equal(classifyAccountSignal('', '网络异常，请稍后再试'), null);
  assert.equal(classifyAccountSignal('', '对方已关闭私信，请稍后再试'), 'recipient');
  assert.equal(classifyAccountSignal('', '发送消息过于频繁，请稍后再试'), 'frequent');
});

test('冷却逐次翻倍并封顶2小时', () => {
  assert.equal(cooldownFor(1800, 0), 1800);
  assert.equal(cooldownFor(1800, 1), 3600);
  assert.equal(cooldownFor(1800, 2), 7200);
  assert.equal(cooldownFor(1800, 5), 7200);
});

test('分发：跨采集账号分配、分块执行、成功后锁消费', async () => {
  freshSettings();
  seedLeads([1], [{ id: 1001, count: 8 }]);
  const f = makeFixture();
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, true);
  assert.equal(result.done, 8);
  assert.equal(result.success, 8);
  const allocations = store.getAllocations();
  const entries = Object.values(allocations);
  assert.ok(entries.length >= 8, '每个联系人有分配锁');
  assert.ok(entries.every(e => e.consumed === true), '成功后锁已消费');
  assert.ok(entries.some(e => e.accountId === '2'), '账号2也分到了用户');
});

test('分发：账号频繁→回池换号，冷却入状态；上限→今日停用并记录经验上限', async () => {
  freshSettings();
  seedLeads([1], [{ id: 1002, count: 9 }]);
  const f = makeFixture({ responses: { '1': [{ ok: false, error: '操作频繁，请稍后再试', errorCode: 'PLATFORM_RESTRICTED' }, { ok: false, error: '今日私信已达上限', errorCode: 'PLATFORM_DAILY_LIMIT' }] } });
  // 账号1 第一块频繁→回池换号2跑；账号1冷却中，账号2 消化剩余；账号1冷却期内不再试
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, true);
  const state = store.getDmAccountState();
  assert.ok(state['1'] && state['1'].frequentUntil > Date.now(), '账号1进入频繁冷却');
  assert.equal(state['1'].frequentCountToday, 1);
  assert.ok(result.done > 0, '剩余用户由账号2完成');
  assert.equal(result.stopReason ? result.stopReason.includes('待明日') : false, result.unassigned > 0);
});

test('分发：全部账号今日停用→整体停止并提示明日8点', async () => {
  freshSettings();
  seedLeads([1], [{ id: 1003, count: 6 }]);
  const f = makeFixture({ responses: { '1': [{ ok: false, error: '今日私信发送次数已达上限', errorCode: 'PLATFORM_DAILY_LIMIT' }], '2': [{ ok: false, error: '今日私信发送次数已达上限', errorCode: 'PLATFORM_DAILY_LIMIT' }] } });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, true);
  const state = store.getDmAccountState();
  for (const id of ['1', '2']) {
    assert.ok(state[id].disabledUntil > Date.now(), '账号' + id + '今日停用');
    assert.ok(Array.isArray(state[id].capHistory) && state[id].capHistory.length === 1, '记录经验上限样本');
  }
  assert.ok(result.unassigned === 6 || result.stopReason.includes('待明日'), '剩余用户待明日');
  assert.equal(result.done, 0);
});

test('跨日自愈：昨日状态在8点新运营日清零', async () => {
  freshSettings();
  const state = { '1': { opDay: '2026-10-15', frequentCountToday: 5, frequentUntil: Date.now() - 1000, disabledUntil: Date.now() - 5000, capHistory: [{ date: '2026-10-15', sentAtCap: 40 }] } };
  store.setDmAccountState(state);
  // 通过预览触发状态自愈（readState）
  seedLeads([1], [{ id: 1004, count: 1 }]);
  const f = makeFixture();
  const preview = f.dist.dmDistributionPreview({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(preview.ok, true);
  const cleaned = store.getDmAccountState()['1'];
  assert.equal(cleaned.frequentCountToday, 0);
  assert.equal(cleaned.frequentUntil, null);
  assert.equal(cleaned.disabledUntil, null);
  assert.deepEqual(cleaned.capHistory, [{ date: '2026-10-15', sentAtCap: 40 }], '经验上限历史保留');
});

test('预览：同视频错峰与待分配统计', async () => {
  freshSettings();
  seedLeads([1], [{ id: 2001, count: 6 }, { id: 2002, count: 2 }]);
  const f = makeFixture();
  const preview = f.dist.dmDistributionPreview({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(preview.ok, true);
  assert.equal(preview.totalCandidates, 8);
  assert.equal(preview.perAccount.reduce((sum, item) => sum + item.count, 0) + preview.unassigned, 8);
  assert.ok(preview.perAccount.every(item => item.todaySent >= 0));
});

test('停止信号中断分发', async () => {
  freshSettings();
  seedLeads([1], [{ id: 2003, count: 6 }]);
  const f = makeFixture();
  f.taskState.running = true;
  f.taskState.stopRequested = true;
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(result.ok, false);
});

test('分发结束后释放任务槽，后续任务不会被误判为运行中', async () => {
  freshSettings();
  seedLeads([1], [{ id: 3001, count: 2 }]);
  const f = makeFixture();
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(result.ok, true);
  assert.equal(f.taskState.running, false);
  assert.equal(f.taskState.distributionActive, false);
  assert.equal(f.taskState.running || f.taskState.distributionActive === true, false, '分发结束后必须允许启动新任务');
});

test('账号切换间隔内停止，后续账号不再执行', async () => {
  freshSettings();
  seedLeads([1], [{ id: 3002, count: 6 }]);
  const calls = [];
  let stoppedOnce = false;
  const f = makeFixture({
    trackCalls: calls,
    onSetTask: (patch, state) => {
      if (patch.stage === 'waiting_account' && !stoppedOnce) {
        stoppedOnce = true;
        state.stopRequested = true;
        state.stopEpoch = (Number(state.stopEpoch) || 0) + 1;
      }
    }
  });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /停止/);
  assert.equal(calls.length, 1, '停止后不应再启动第二个账号');
});

test('过期分配锁不再阻塞用户', async () => {
  freshSettings();
  seedLeads([1], [{ id: 3003, count: 2 }]);
  const rows = store.getLeads();
  const key = workflow.contactKey(rows[0], store.getSettings());
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  store.setAllocations({ [key]: { accountId: '2', kind: 'dm', plannedAt: old, consumed: false } });
  const f = makeFixture();
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(result.ok, true);
  assert.equal(result.totalCandidates, 2, '过期锁不参与候选筛选');
  assert.equal(result.done, 2);
});

test('新一轮分发清除上一轮未过期的残留分配锁', async () => {
  freshSettings();
  seedLeads([1], [{ id: 3005, count: 2 }]);
  const rows = store.getLeads();
  const settings = store.getSettings();
  const key = workflow.contactKey(rows[0], settings);
  // 上一轮中断残留的锁：未消费、未过期（刚写入、指向其他账号）
  store.setAllocations({ [key]: { accountId: '2', kind: 'outreach', plannedAt: store.nowStr(), expiresAt: Date.now() + 3600 * 1000, consumed: false } });
  const f = makeFixture();
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(result.ok, true);
  assert.equal(result.totalCandidates, 2, '新一轮开始必须清除上一轮残留的未过期分配锁');
  assert.equal(result.done, 2);
});

test('预览不按残留分配锁排除：未关注未私信即重新进入候选', async () => {
  freshSettings();
  seedLeads([1], [{ id: 3105, count: 3 }]);
  const rows = store.getLeads();
  const settings = store.getSettings();
  // 3 条都有未消费、未过期的残留锁（上一轮中断）
  const locks = {};
  for (const lead of rows) locks[workflow.contactKey(lead, settings)] = { accountId: '2', kind: 'outreach', plannedAt: store.nowStr(), expiresAt: Date.now() + 3600 * 1000, consumed: false };
  store.setAllocations(locks);
  const f = makeFixture();
  const preview = f.dist.dmDistributionPreview({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(preview.ok, true);
  assert.equal(preview.totalCandidates, 3, '预览候选不因残留锁减少');
  assert.equal(preview.perAccount.reduce((sum, item) => sum + item.count, 0) + preview.unassigned, 3, '全部可分配');
  assert.ok(!(preview.exclusions || []).some(item => /已分配给其他账号执行/.test(item.reason)), '预览不应再出现“已分配给其他账号执行”');
});

test('分发批次前释放 running，runTask 的任务锁守卫不再拒绝每个批次', async () => {
  freshSettings();
  seedLeads([1], [{ id: 3100, count: 6 }]);
  // guardRunning 模拟真实 runTask 第一行：taskState.running 为 true 时直接返回“已有任务在运行”
  const f = makeFixture({ guardRunning: true });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(result.ok, true);
  assert.equal(result.done, 6, '每个批次都应通过守卫并执行完，而不是被“已有任务在运行”拒绝');
});

test('账号异常后本次分发内不再重复使用', async () => {
  freshSettings();
  seedLeads([1], [{ id: 3004, count: 3 }]);
  const calls = [];
  const f = makeFixture({ trackCalls: calls, responses: { '1': [{ ok: false, error: '登录已失效', errorCode: 'LOGIN_REQUIRED' }] } });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, true);
  assert.equal(calls.filter(id => id === '1').length, 1, '异常账号只尝试一次');
  assert.ok(result.done > 0, '剩余用户由其他账号完成');
});

test('分发预览列出被排除原因与去重数量', () => {
  freshSettings();
  seedLeads([1], [{ id: 4001, count: 3 }]);
  const rows = store.getLeads();
  rows[1].aiNeed = ''; rows[1].aiDone = false; rows[1].aiReason = ''; rows[1].aiPromptVersion = ''; rows[1].aiInputHash = '';
  store.setLeads(rows);
  const f = makeFixture();
  const p = f.dist.dmDistributionPreview({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(p.sourceRows, 3);
  assert.equal(p.totalCandidates, 2);
  assert.ok(p.exclusions.some(item => /AI|人工|判断/.test(item.reason)), JSON.stringify(p.exclusions));
  assert.equal(p.exclusions.reduce((sum, item) => sum + item.count, 0), 1);
});

/* ---------- 回池合并 / 冷却等待 / 部分处理（修复指南 7.3 M1 M2 M3 M5 M9） ---------- */

const executedOk = (batches, accountId) => batches.filter(([id, , r]) => id === accountId && r.ok).flatMap(([, ids]) => ids);

test('分发：2账号各10人、A首批频繁 → 剩余用户全部回池不丢失、重新分配不超额、冷却结束后A继续', async () => {
  freshSettings();
  seedLeads([1], [{ id: 5001, count: 10 }, { id: 5002, count: 10 }]);
  const waits = [];
  const f = makeFixture({
    fakeClock: true, recordUsage: true,
    responses: { '1': [{ ok: false, error: '操作频繁，请稍后再试', errorCode: 'PLATFORM_RESTRICTED', processedLeadIds: [] }] },
    onSetTask: (patch, state) => { if (patch.stage === 'waiting_cooldown') waits.push(patch); }
  });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.totalCandidates, 20);
  // 首次分配各 10 人
  const firstA = f.calls.find(c => c[1] === '1')[2].map(String);
  assert.equal(firstA.length, 3);
  // B 已预留 10 人、额度 10：A 回池的 10 人不能再分给 B（不超额）
  const okB = executedOk(f.batches, '2');
  assert.equal(okB.length, 10, 'B 只执行自己额度内的 10 人');
  assert.ok(f.calls.filter(c => c[1] === '2').every(c => c[2].length <= 3));
  assert.equal(store.getDailyUsage('2').dm, 10, 'B 当日私信不超过上限');
  // 只有 A 在冷却：等待冷却结束而不是结束任务，之后 A 继续执行回池用户
  assert.ok(waits.length > 0, '进入冷却等待');
  assert.match(waits[0].status, /冷却.*可随时停止/);
  assert.ok(waits[0].waitingUntil, '界面可显示倒计时');
  const okA = executedOk(f.batches, '1');
  assert.equal(okA.length, 10);
  assert.ok(firstA.every(id => okA.includes(id)), 'A 首批被频繁打断的用户在冷却后重新执行');
  // 没有用户消失：20 人每人恰好成功执行一次
  const all = [...okA, ...okB];
  assert.equal(all.length, 20);
  assert.equal(new Set(all).size, 20);
  assert.equal(result.done, 20);
  assert.equal(result.success, 20);
  assert.equal(result.unassigned, 0);
  assert.equal(result.stopReason, '');
  assert.ok(Object.values(store.getAllocations()).every(e => e.consumed === true), '没有残留未消费的分配锁');
});

test('分发：唯一账号频繁 → 等待冷却而非结束，等待中停止立即生效且用户保留待分配', async () => {
  freshSettings();
  seedLeads([1], [{ id: 5003, count: 6 }]);
  let stoppedAt = null;
  const calls = [];
  const f = makeFixture({
    fakeClock: true, trackCalls: calls,
    responses: { '1': [{ ok: false, error: '操作频繁', errorCode: 'PLATFORM_RESTRICTED', processedLeadIds: [] }] },
    onSetTask: (patch, state, clock) => {
      if (patch.stage === 'waiting_cooldown' && stoppedAt === null) {
        stoppedAt = clock.now();
        state.stopRequested = true;
        state.stopEpoch = (Number(state.stopEpoch) || 0) + 1;
      }
    }
  });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.notEqual(stoppedAt, null, '没有直接结束，而是进入冷却等待');
  assert.equal(result.ok, false);
  assert.match(result.error, /停止/);
  assert.equal(calls.length, 1, '冷却期内不再执行');
  const until = store.getDmAccountState()['1'].frequentUntil;
  assert.ok(until > f.clock.now(), '停止立即生效，没有等到冷却结束');
  assert.ok(f.clock.now() - stoppedAt <= 1000, '停止后最多一个检查周期');
  assert.equal(result.unassigned, 6, '剩余 6 人保留待分配');
  assert.equal(result.done, 0);
});

test('分发：批次第3人遇今日上限 → 汇总含前2人成功，只有后3人回池并交给其他账号', async () => {
  freshSettings();
  const s = store.getSettings(); s.dm.batchPerAccount = 5; store.setSettings(s);
  seedLeads([1], [{ id: 5004, count: 5 }, { id: 5005, count: 5 }]);
  let batchA = null;
  const f = makeFixture({
    fakeClock: true, recordUsage: true,
    responses: { '1': [ids => { batchA = ids; return { ok: false, error: '今日私信已达上限', errorCode: 'PLATFORM_DAILY_LIMIT', dmCount: 2, failedCount: 1, pendingCount: 0, skipped: 0, processedLeadIds: ids.slice(0, 2), pausedLeadId: ids[2] }; }] }
  });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, true, result.error);
  assert.equal(batchA.length, 5);
  assert.equal(result.perAccount['1'].success, 2, 'A 本批前 2 人成功计入汇总');
  assert.equal(result.perAccount['1'].count, 2, 'A 名下只保留已处理的 2 人');
  const plansB = f.calls.filter(c => c[1] === '2').map(c => c[2].map(String));
  const rePooled = plansB.flat().filter(id => batchA.includes(id));
  assert.deepEqual(rePooled.sort(), batchA.slice(2).sort(), '只有第 3～5 人回池并由 B 执行');
  assert.equal(result.success, 10);
  assert.equal(result.done, 10);
  assert.equal(result.unassigned, 0);
  const allocations = store.getAllocations();
  const settings = store.getSettings();
  const rows = store.getLeads();
  for (const id of batchA.slice(0, 2)) {
    const entry = allocations[workflow.contactKey(rows.find(l => String(l.id) === id), settings)];
    assert.equal(entry.accountId, '1'); assert.equal(entry.consumed, true);
  }
  assert.ok(store.getDmAccountState()['1'].disabledUntil > Date.now(), 'A 今日停用');
});

test('分发：用户级连续异常/无法归类的失败不作废账号，未处理用户回池后由该账号下轮继续', async () => {
  freshSettings();
  seedLeads([1], [{ id: 5006, count: 4 }, { id: 5007, count: 2 }]);
  const calls = [];
  const consecutive = ids => ({ ok: false, error: '连续 3 个用户处理异常，已保存本次结果并暂停', errorCode: 'CONSECUTIVE_ERRORS', dmCount: 0, failedCount: 1, processedLeadIds: ids.slice(0, 1) });
  const f = makeFixture({ fakeClock: true, trackCalls: calls, responses: { '1': [consecutive, consecutive] } });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.length, 4, '连续两批用户级中断后账号仍继续执行，没有被判为异常');
  assert.equal(result.done, 6);
  assert.equal(result.success, 4);
  assert.equal(result.unassigned, 0);
  assert.equal(store.getDmAccountState()['1'] && store.getDmAccountState()['1'].lastStopReason, undefined, '账号没有记异常');
});

test('分发：同一账号连续两批一个用户都没处理成才判异常，防止空转', async () => {
  freshSettings();
  seedLeads([1], [{ id: 5008, count: 6 }]);
  const calls = [];
  const broken = { ok: false, error: '浏览器启动失败', errorCode: 'BROWSER_LAUNCH_FAILED', processedLeadIds: [] };
  const f = makeFixture({ fakeClock: true, trackCalls: calls, responses: { '1': [broken, { ...broken }] } });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.filter(id => id === '1').length, 2);
  assert.equal(result.done, 6, '账号1的用户全部由账号2完成');
  assert.equal(result.unassigned, 0);
});

test('分发：授权失效（AUTH_*）整体暂停，不再换号，剩余用户保留待分配', async () => {
  freshSettings();
  seedLeads([1], [{ id: 5009, count: 6 }]);
  const calls = [];
  const f = makeFixture({ fakeClock: true, trackCalls: calls, responses: { '1': [{ ok: false, error: '授权失效，任务已暂停', errorCode: 'AUTH_REQUIRED', processedLeadIds: [] }] } });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /授权/);
  assert.deepEqual(calls, ['1']);
  assert.equal(result.unassigned, 6);
});

test('分发：切到下一个账号前关闭上一个账号浏览器；同账号连续执行不关闭；设置关闭后不关', async () => {
  for (const enabled of [true, false]) {
    freshSettings();
    const s = store.getSettings(); s.dm.closeBrowserBetweenAccounts = enabled; store.setSettings(s);
    seedLeads([1], [{ id: 5010, count: 6 }, { id: 5011, count: 3 }]);
    // 账号2今日只剩 2 条额度：账号1会连续执行多批（同账号连续执行不应关闭）
    for (let i = 0; i < 8; i++) store.bumpDaily('2', 'dm');
    const order = [];
    const f = makeFixture({
      fakeClock: true, trackCalls: order,
      closeAccount: async id => { order.push('close:' + id); }
    });
    const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
    assert.equal(result.ok, true, result.error);
    const closes = order.filter(x => x.startsWith('close:'));
    if (!enabled) { assert.deepEqual(closes, []); continue; }
    assert.ok(closes.length > 0);
    // 每次关闭都发生在切换账号之间：关闭的是上一个执行的账号，紧接着执行的是另一个账号
    order.forEach((x, i) => {
      if (!x.startsWith('close:')) return;
      const closed = x.slice(6);
      assert.equal(order[i - 1], closed, '关闭的是刚执行完的账号');
      if (order[i + 1]) assert.notEqual(order[i + 1], closed, '不关闭马上要执行的账号');
    });
    const runs = order.filter(x => !x.startsWith('close:'));
    assert.ok(runs.some((x, i) => runs[i + 1] === x), '存在同账号连续执行');
  }
});

test('分发保存账号状态时不覆盖批次中写入的强制休息计数', async () => {
  freshSettings();
  seedLeads([1], [{ id: 5012, count: 6 }]);
  const f = makeFixture({
    fakeClock: true,
    responses: { '1': [() => {
      const st = store.getDmAccountState();
      st['1'] = { ...(st['1'] || {}), dmSession: { count: 3, pauseUntil: 0, opDay: store.opDayStr() } };
      store.setDmAccountState(st);
      return { ok: false, error: '操作频繁', errorCode: 'PLATFORM_RESTRICTED', processedLeadIds: [] };
    }] }
  });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.ok, true, result.error);
  const entry = store.getDmAccountState()['1'];
  assert.ok(entry.frequentUntil > 0, '频繁冷却已记录');
  assert.equal(entry.dmSession && entry.dmSession.count, 3, 'runTask 写入的强制休息计数保留');
});

test('分发：频繁阶梯 30 分钟 → 1 小时 → 2 小时，连续试发 3 次仍频繁 → 今日停用', async () => {
  freshSettings();
  { const s = store.getSettings(); s.dm.maxFrequentRetriesPerDay = 3; store.setSettings(s); } // 新默认值（测试公共设置写的是 2）
  seedLeads([1], [{ id: 5009, count: 6 }]);
  const calls = [];
  const frequent = { ok: false, error: '操作频繁，请稍后再试', errorCode: 'PLATFORM_RESTRICTED', processedLeadIds: [] };
  const cooldowns = [];
  const f = makeFixture({ fakeClock: true, recordUsage: true, trackCalls: calls, responses: { '1': [frequent, frequent, frequent, frequent, frequent] },
    onSetTask: (patch, state, clock) => {
      const entry = store.getDmAccountState()['1'];
      if (patch.stage === 'waiting_cooldown' && entry && entry.frequentUntil && !cooldowns.some(c => c.until === entry.frequentUntil)) cooldowns.push({ until: entry.frequentUntil, minutes: Math.round((entry.frequentUntil - clock.now()) / 60000) });
    } });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  const state = store.getDmAccountState()['1'];
  assert.equal(calls.length, 4, '首次 + 到点试发 3 次');
  assert.deepEqual(cooldowns.map(c => c.minutes), [30, 60, 120]);
  assert.ok(state.disabledUntil > f.clock.now(), '今日停用');
  assert.equal(state.lastStopReason, '频繁后试发 3 次仍频繁，按今日上限停用');
  assert.equal(result.unassigned, 6, '用户全部保留待分配，明天或换号再发');
});

test('分发：试发后先发出几条再频繁 → 阶梯从 30 分钟重新开始，不停用', async () => {
  freshSettings();
  seedLeads([1], [{ id: 5010, count: 9 }]);
  const frequent = { ok: false, error: '操作频繁，请稍后再试', errorCode: 'PLATFORM_RESTRICTED', processedLeadIds: [] };
  const minutes = [];
  const f = makeFixture({ fakeClock: true, recordUsage: true, responses: { '1': [frequent, ids => ({ ok: true, dmCount: ids.length, pendingCount: 0, failedCount: 0, skipped: 0 }), frequent] },
    onSetTask: (patch, state, clock) => {
      const entry = store.getDmAccountState()['1'];
      if (patch.stage === 'waiting_cooldown' && entry && entry.frequentUntil && minutes.length < 5 && !minutes.some(m => m.until === entry.frequentUntil)) minutes.push({ until: entry.frequentUntil, m: Math.round((entry.frequentUntil - clock.now()) / 60000) });
    } });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1'], filters: { f: 'all' } });
  const state = store.getDmAccountState()['1'];
  assert.deepEqual(minutes.map(x => x.m), [30, 30], '中间恢复发出过私信，第二次频繁重新从 30 分钟开始');
  assert.ok(!state.disabledUntil || state.disabledUntil <= f.clock.now());
  assert.equal(result.success, 9);
});

test('分发：每轮各号发完一批后统一休息 roundRestSec，再开始下一轮', async () => {
  freshSettings();
  const s = store.getSettings(); s.dm.roundRestSec = 300; s.dm.accountSwitchIntervalSec = 0; store.setSettings(s);
  seedLeads([1], [{ id: 5011, count: 12 }]);
  const rests = [];
  const f = makeFixture({ fakeClock: true, recordUsage: true, onSetTask: (patch, state, clock) => { if (patch.stage === 'waiting_round' && !rests.some(r => r.until === patch.waitingUntil)) rests.push({ until: patch.waitingUntil, at: clock.now() }); } });
  const result = await f.dist.dmDistributionTask({ poolAccounts: ['1', '2'], filters: { f: 'all' } });
  assert.equal(result.success, 12);
  // 每批 3 人、2 个号：一轮 6 人，12 人共两轮 → 中间只休息 1 次（最后一轮结束无人可发不再休息）
  assert.equal(rests.length, 1);
  assert.equal(Date.parse(rests[0].until) - rests[0].at, 300000);
});
