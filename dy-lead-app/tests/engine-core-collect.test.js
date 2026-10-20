'use strict';
// 核心采集步骤的登录复核：作品页打开后、读取评论前必须复核登录；账号级失败要抛给队列（暂停整个队列），
// 不能被采集器吞成“本作品中断”后继续下一个作品。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoreCollectOne } = require('../engine-core-collect');
const { TaskStopError } = require('../scheduler');

function fakePage() {
  const calls = [];
  return {
    calls,
    on() {}, off() {},
    async goto(url) { calls.push('goto ' + url); },
    async waitForTimeout() {},
    async waitForLoadState() { calls.push('waitForLoadState'); },
    // 页面健康读取返回 'ok'（无验证）；其余 evaluate 不应被调用到（登录复核失败时）
    async evaluate() { calls.push('evaluate'); return 'ok'; }
  };
}

function harness(checkPageHealth) {
  const logs = [], videos = {};
  const store = {
    log: (_id, text) => logs.push(text), getVideos: () => videos, setVideos() {}, getLeads: () => [], setLeads() {}, nowStr: () => '2026-10-21 12:00:00'
  };
  const collectOne = createCoreCollectOne({
    store, workflow: { businessId: () => 'b' }, setTask() {}, legacyCollectOne: async () => { throw new Error('legacy must not run'); },
    dedupeKey: lead => lead.uid, matchIntent: () => ({ hit: false, kw: '', excluded: false }), checkPageHealth, sleep: async () => {}
  });
  const scheduler = { async before() {}, checkStopped() {} };
  const settings = { collect: { maxScrolls: 5, skipEmptyText: true }, keywords: {} };
  return { collectOne, scheduler, settings, logs, videos };
}

test('作品页打开后登录失效：抛出登录错误暂停队列，不读取评论、不当作作品级中断', async () => {
  const page = fakePage();
  const checked = [];
  const { collectOne, scheduler, settings } = harness(async (current, accountId) => {
    checked.push([current === page, accountId]);
    throw new TaskStopError('抖音账号已退出登录，请在账号窗口重新登录', 'LOGIN_REQUIRED');
  });
  await assert.rejects(collectOne('acc1', page, { id: '7000000000000000001', type: 'video' }, settings, scheduler),
    error => error.code === 'LOGIN_REQUIRED' && !error.workLevel);
  assert.deepEqual(checked, [[true, 'acc1']]);
  // 打开作品页后立即复核；复核失败前只做了打开与验证页检查，没有进入评论读取
  assert.equal(page.calls[0], 'goto https://www.douyin.com/video/7000000000000000001');
  assert.ok(page.calls.filter(call => call === 'evaluate').length <= 1);
});

test('页面切换中的待确认登录：短暂等待后重新确认，确认后继续采集', async () => {
  const page = fakePage();
  let calls = 0;
  const { collectOne, scheduler, settings, logs } = harness(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new TaskStopError('抖音登录状态待确认', 'LOGIN_UNCONFIRMED'), { pageTransition: true });
    // 第二次确认成功后，用账号级错误结束本用例，避免模拟整个评论翻页
    throw new TaskStopError('stop-after-recheck', 'TASK_STOPPED');
  });
  await assert.rejects(collectOne('acc1', page, { id: '7000000000000000002', type: 'note' }, settings, scheduler), { code: 'TASK_STOPPED' });
  assert.equal(calls, 2);
  assert.ok(page.calls.includes('waitForLoadState'));
  assert.ok(logs.some(text => text.includes('重新检查登录状态（1/3）')));
});

test('真实退出登录不重试：只复核一次', async () => {
  const page = fakePage();
  let calls = 0;
  const { collectOne, scheduler, settings } = harness(async () => { calls++; throw new TaskStopError('需要验证', 'PLATFORM_VERIFICATION'); });
  await assert.rejects(collectOne('acc1', page, { id: '7000000000000000003', type: 'video' }, settings, scheduler), { code: 'PLATFORM_VERIFICATION' });
  assert.equal(calls, 1);
});

test('作品页 SPA 正文尚未就绪：按“仍在加载”等待后复核，不暂停队列', async () => {
  const page = fakePage();
  let calls = 0;
  const { collectOne, scheduler, settings } = harness(async () => {
    calls++;
    if (calls <= 2) throw new TaskStopError('抖音页面仍在加载，请稍候', 'LOGIN_PENDING');
    throw new TaskStopError('stop-after-loaded', 'TASK_STOPPED');
  });
  await assert.rejects(collectOne('acc1', page, { id: '7000000000000000004', type: 'note' }, settings, scheduler), { code: 'TASK_STOPPED' });
  assert.equal(calls, 3);
});

test('一直加载不完：40 次后按原错误停止', async () => {
  const page = fakePage();
  let calls = 0;
  const { collectOne, scheduler, settings } = harness(async () => { calls++; throw new TaskStopError('账号页面尚未加载完成', 'LOGIN_UNCONFIRMED'); });
  await assert.rejects(collectOne('acc1', page, { id: '7000000000000000005', type: 'video' }, settings, scheduler), { code: 'LOGIN_UNCONFIRMED' });
  assert.equal(calls, 40);
});

test('登录复核失败时本作品记为中断，原因与抛出的错误一致（覆盖上次的完成状态）', async () => {
  const page = fakePage();
  const { collectOne, scheduler, settings, videos } = harness(async () => { throw new TaskStopError('抖音登录状态待确认，请在账号窗口检查', 'LOGIN_UNCONFIRMED'); });
  videos['7000000000000000006'] = { awemeId: '7000000000000000006', collectionState: 'complete', collectionReason: '所有评论列表都返回 has_more=0', desc: '旧描述' };
  await assert.rejects(collectOne('acc1', page, { id: '7000000000000000006', type: 'video' }, settings, scheduler), { code: 'LOGIN_UNCONFIRMED' });
  assert.equal(videos['7000000000000000006'].collectionState, 'interrupted');
  assert.equal(videos['7000000000000000006'].collectionReason, '抖音登录状态待确认，请在账号窗口检查');
  assert.equal(videos['7000000000000000006'].desc, '旧描述');
});
