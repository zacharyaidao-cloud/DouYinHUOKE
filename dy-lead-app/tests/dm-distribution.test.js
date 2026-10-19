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

function makeFixture({ responses = {}, trackCalls = null, onSetTask = null } = {}) {
  const taskState = { running: false, stopRequested: false, distributionActive: false, stopEpoch: 0, status: '', errors: [] };
  const setTask = patch => { Object.assign(taskState, patch); if (onSetTask) onSetTask(patch, taskState); };
  const failTask = msg => { taskState.status = msg; return { ok: false, error: msg }; };
  const checkpoint = () => {};
  const calls = [];
  let lastBatchSize = 3;
  const createPlan = (accountId, kind, options) => {
    calls.push(['plan', accountId, options && options.leadIds]);
    lastBatchSize = (options && options.leadIds || []).length;
    return { id: 'plan-' + accountId + '-' + calls.length, planId: 'plan-' + accountId + '-' + calls.length, accountId: String(accountId), kind: 'outreach', crossAccount: true, actions: { follow: false, dm: true }, dmTemplate: options.dmTemplate || '话术' };
  };
  const runOutreach = async (accountId, options) => {
    const key = String(accountId);
    if (trackCalls) trackCalls.push(key);
    const scripted = responses[key];
    if (Array.isArray(scripted) && scripted.length) return scripted.shift();
    return { ok: true, dmCount: lastBatchSize, pendingCount: 0, failedCount: 0, skipped: 0 };
  };
  const dist = createDmDistribution({ store, taskState, setTask, failTask, checkpoint, createPlan, runOutreach, getSignal: () => null });
  return { taskState, calls, dist, runOutreach };
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
  assert.equal(classifyAccountSignal('', '服务端拒绝本次私信：消息检查未通过（检查码：2）'), 'frequent');
  assert.equal(classifyAccountSignal('', '对方仅自己可见，无法私信'), 'recipient');
  assert.equal(classifyAccountSignal('', '无法归类的未知文案'), null);
  assert.equal(classifyAccountSignal(null, ''), null);
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
