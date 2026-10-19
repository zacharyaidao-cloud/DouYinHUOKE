'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCollectionTasks } = require('../engine-collection-tasks');
const { TaskStopError } = require('../scheduler');
const AI = require('../ai');
const { aiInputHash } = require('../workflow');

// Pure dependency fixtures: no browser, files, platform or provider requests.
const IDS = ['7693378601286309625', '7693579483274183025', '7693579483274183026'];
const work = (index = 0, extra = {}) => ({ id: IDS[index], url: 'https://www.douyin.com/video/' + IDS[index], type: 'video', ...extra });
const comment = (id, extra = {}) => ({ id, accountId: 'local-account', uid: 'synthetic-' + id,
  nickname: '本地样例', demand: '目前有相关问题需要处理', videoLink: work().url, trigger: '', intent: false, ...extra });

function fixture({ list = [work()], leads = [], videos = {}, collect, ai, settings: override = {}, initialUsage = {}, onTask,
  alive = { page: {} }, launch } = {}) {
  let rows = structuredClone(leads), works = structuredClone(videos);
  const settings = { collect: { autoAiAfterCollect: true, dailyVideoLimit: 240, cooldownHours: 24, ...(override.collect || {}) },
    ai: { enabled: true, apiKey: 'local-fixture-never-sent', prompt: '隔离测试规则', ...(override.ai || {}) } };
  const state = { running: false, stopRequested: false }, usage = { ...initialUsage }, logs = [], calls = [], aiCalls = [], boundaries = [], patches = [];
  const browserLaunchCalls = [], collectionPages = [];
  const savedCheckpoint = {};
  const store = { getSettings: () => structuredClone(settings), getLeads: () => structuredClone(rows),
    setLeads: value => { rows = structuredClone(value); }, getVideos: () => structuredClone(works),
    setVideos: value => { works = structuredClone(value); }, getDailyUsage: () => ({ ...usage }),
    bumpDaily: (_account, field) => { usage[field] = (usage[field] || 0) + 1; },
    nowStr: () => new Date().toISOString(), log: (_account, line) => logs.push(line) };
  const makeCurrent = (id, need = '是') => {
    const current = rows.find(row => String(row.id) === String(id));
    assert(current, 'Only a stored fixture row may receive an AI result');
    Object.assign(current, { aiDone: true, aiNeed: need, aiReason: need === '是' ? '询问相关处理方法' : '仅讨论作者案例',
      aiPromptVersion: AI.getRuleSet(settings).version, aiInputHash: aiInputHash(current, works) });
  };
  const append = values => { rows.push(...structuredClone(values)); };
  const update = (id, patch) => { Object.assign(rows.find(row => String(row.id) === String(id)), patch); };
  const context = { store, settings, state, rows: () => rows, works: () => works, makeCurrent, append, update, usage, logs, calls, aiCalls, boundaries, patches,
    browserLaunchCalls, collectionPages };
  const tasks = createCollectionTasks({ store, taskState: state,
    setTask: patch => {
      if (patch.running === true) state.stopRequested = false;
      Object.assign(state, patch); patches.push(structuredClone(patch));
      if (onTask) onTask(patch, context);
    },
    failTask: error => ({ ok: false, error }), parseVideoList: () => structuredClone(list),
    checkpoint: patch => Object.assign(savedCheckpoint, structuredClone(patch)),
    makeScheduler: () => ({ checkStopped() { if (state.stopRequested) throw new TaskStopError(); }, scheduleBoundary: kind => boundaries.push(kind) }),
    getAlive: () => alive,
    launchAccount: async (accountId, options) => {
      browserLaunchCalls.push({ accountId, hasStopCallback: typeof options?.checkStopped === 'function' });
      if (launch) return launch({ ...context, accountId, options });
      throw new Error('The fixture already has an isolated browser');
    },
    collectOne: async (_account, _page, item, _settings, _scheduler, beforeCollect, capture, runId) => {
      collectionPages.push(_page);
      calls.push({ item: structuredClone(item), runId });
      const resolved = item.id ? { ...item } : work(0, { id: item.resolvedId || IDS[0] });
      resolved.url = 'https://www.douyin.com/' + resolved.type + '/' + resolved.id;
      const skip = beforeCollect(resolved);
      if (skip) return { skipped: true, skipReason: skip, newLeads: 0, work: resolved };
      const emit = (ids, counts) => {
        for (const id of ids) update(id, { collectionRunId: runId });
        capture(ids, counts);
      };
      if (collect) return collect({ ...context, item: resolved, capture: emit, runId, index: calls.length - 1 });
      const id = 'captured-' + resolved.id;
      append([comment(id, { videoLink: resolved.url })]); emit([id], { added: 1, supplemented: 0 });
      return { newLeads: 1, complete: true, work: resolved };
    },
    runAi: async options => {
      aiCalls.push(structuredClone(options));
      if (ai) return ai({ ...context, options });
      // Simulate the actual batch engine writing validated results before its
      // completion response. A successful mock return alone is insufficient.
      for (const id of options.leadIds) makeCurrent(id);
      return { ok: true, partial: false, yesCount: options.leadIds.length, noCount: 0, failCount: 0, skipped: 0 };
    }
  });
  return { ...context, tasks, checkpoint: savedCheckpoint, summary: () => state.collectionSummary,
    run: () => tasks.collectTask('local-account', 'local fixture input') };
}

test('采集后只判断本次新采和回填的非作者非空评论，关键词未命中也参与，固定ID不扩全库', async () => {
  const f = fixture({ leads: [comment('refilled'), comment('outside')], collect: async ({ append, item, capture }) => {
    append([comment('new'), comment('author', { isAuthor: true }), comment('blank', { demand: '  ' })]);
    capture(['new', 'refilled', 'author', 'blank'], { added: 3, supplemented: 1 });
    return { newLeads: 3, complete: true, work: item };
  } });
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.aiCalls.length, 1);
  assert.deepEqual(new Set(f.aiCalls[0].leadIds), new Set(['new', 'refilled']));
  assert.deepEqual(f.aiCalls[0].filters, { f: 'all', commentDays: 7 }, '默认只判断最近一周内的评论'); assert.equal(f.aiCalls[0].force, undefined);
  assert.equal(f.rows().find(row => row.id === 'outside').aiDone, undefined);
  assert.equal(f.rows().find(row => row.id === 'author').aiDone, undefined);
  assert.equal(f.summary().commentLeadCount, 2); assert.equal(f.summary().newLeads, 3);
  assert.equal(f.summary().aiPendingCount, 0); assert.equal(f.summary().aiStatus, 'completed');
  assert.equal(f.summary().aiCounts.yes, 2); assert.equal(f.state.stage, 'review_ready');
});

test('自动判断时间范围可配置：设为全部时不过滤时间，非法值回退一周内', async () => {
  const collect = async ({ append, item, capture }) => {
    append([comment('new2')]); capture(['new2'], { added: 1, supplemented: 0 });
    return { newLeads: 1, complete: true, work: item };
  };
  const all = fixture({ leads: [], collect, settings: { ai: { autoJudgeWindowDays: 0 } } });
  const resultAll = await all.run();
  assert.equal(resultAll.ok, true);
  assert.deepEqual(all.aiCalls[0].filters, { f: 'all', commentDays: 0 }, '设为全部时间不过滤');
  const bad = fixture({ leads: [], collect, settings: { ai: { autoJudgeWindowDays: 99 } } });
  await bad.run();
  assert.deepEqual(bad.aiCalls[0].filters, { f: 'all', commentDays: 7 }, '非法值回退一周内');
});

test('本次评论已有当前有效结果时不调用AI，摘要保留其有效是/否总数', async () => {
  const f = fixture({ leads: [comment('yes'), comment('no')], collect: async ({ item, capture }) => {
    capture(['yes', 'no'], { added: 0, supplemented: 2 }); return { newLeads: 0, complete: true, work: item };
  } });
  f.makeCurrent('yes', '是'); f.makeCurrent('no', '否');
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.aiCalls.length, 0);
  assert.equal(f.summary().aiStatus, 'completed'); assert.equal(f.summary().aiPendingCount, 0);
  assert.equal(f.summary().aiCounts.yes, 1); assert.equal(f.summary().aiCounts.no, 1);
});

test('新旧结果混合只请求旧/未判断记录，完成摘要统计整次有效结果', async () => {
  const f = fixture({ leads: [comment('current'), comment('old', { aiDone: true, aiNeed: '否', aiReason: '旧规则判断', aiPromptVersion: 'obsolete', aiInputHash: 'old' })],
    collect: async ({ item, capture }) => { capture(['current', 'old'], { added: 0, supplemented: 2 }); return { newLeads: 0, complete: true, work: item }; } });
  f.makeCurrent('current', '否');
  await f.run(); assert.deepEqual(f.aiCalls[0].leadIds, ['old']);
  assert.equal(f.summary().aiCounts.yes, 1); assert.equal(f.summary().aiCounts.no, 1); assert.equal(f.summary().aiPendingCount, 0);
});

for (const stopped of [false, true]) test((stopped ? '停止' : '采集异常') + '后不自动AI，已经写入的本次新增仍计入摘要', async () => {
  const f = fixture({ collect: async ({ append, item, capture, state }) => {
    append([comment('saved-first'), comment('saved-second')]);
    capture(['saved-first'], { added: 1, supplemented: 0 }); capture(['saved-second'], { added: 1, supplemented: 0 });
    if (stopped) { state.stopRequested = true; throw new TaskStopError(); }
    throw new Error('local collection failed after save');
  } });
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(f.aiCalls.length, 0); assert.equal(f.rows().length, 2);
  assert.equal(f.summary().newLeads, 2); assert.equal(f.summary().commentLeadCount, 2);
  assert.equal(f.summary().aiStatus, 'skipped'); assert.equal(f.summary().status, stopped ? 'paused' : 'error');
  assert.equal(f.state.running, false);
});

test('正常返回时收到停止，不会因切换AI任务而清除停止状态', async () => {
  const f = fixture({ collect: async ({ append, item, capture, state }) => {
    append([comment('saved')]); capture(['saved'], { added: 1, supplemented: 0 }); state.stopRequested = true;
    return { newLeads: 1, complete: false, work: item };
  } });
  await f.run(); assert.equal(f.aiCalls.length, 0); assert.equal(f.state.stopRequested, true);
  assert.equal(f.summary().newLeads, 1); assert.equal(f.summary().status, 'paused');
});

test('采集与AI衔接处的停止不会启动新AI任务', async () => {
  const f = fixture({ onTask: (patch, context) => { if (patch.running === false && patch.stage === 'collected') context.state.stopRequested = true; } });
  await f.run(); assert.equal(f.aiCalls.length, 0); assert.equal(f.state.stopRequested, true); assert.equal(f.summary().aiStatus, 'skipped');
});

test('缺少API Key只阻止AI，不把已完成的采集改成失败', async () => {
  const f = fixture({ settings: { ai: { apiKey: '' } } });
  const result = await f.run(); assert.equal(result.ok, true); assert.equal(f.aiCalls.length, 0);
  assert.equal(f.summary().status, 'completed'); assert.equal(f.summary().aiStatus, 'blocked'); assert.equal(f.summary().newLeads, 1);
});

test('关闭自动AI后只保存本次评论，不隐式发起判断', async () => {
  const f = fixture({ settings: { collect: { autoAiAfterCollect: false } } });
  await f.run(); assert.equal(f.aiCalls.length, 0); assert.equal(f.summary().autoAi, false); assert.equal(f.summary().aiStatus, 'skipped');
});

test('AI报告成功但跳过记录仍无当前结果时须显示暂停和真实待判断数', async () => {
  const f = fixture({ ai: async () => ({ ok: true, partial: false, yesCount: 0, noCount: 0, failCount: 0, skipped: 1 }) });
  const result = await f.run(); assert.equal(result.ok, true); assert.equal(f.summary().status, 'completed');
  assert.equal(f.summary().aiStatus, 'paused'); assert.equal(f.summary().aiPendingCount, 1); assert.equal(f.state.stage, 'ai_paused');
  assert.equal(f.rows()[0].aiDone, undefined);
});

for (const thrown of [false, true]) test('AI' + (thrown ? '抛错' : '返回错误') + '保留采集成功，只暂停后续判断', async () => {
  const f = fixture({ ai: async () => { if (thrown) throw new Error('local model unavailable'); return { ok: false, error: 'local model unavailable' }; } });
  const result = await f.run(); assert.equal(result.ok, true); assert.equal(f.summary().status, 'completed');
  assert.equal(f.summary().aiStatus, 'paused'); assert.equal(f.state.stage, 'ai_paused'); assert.equal(f.rows().length, 1);
});

test('缓存作品作者身份已知时，即使本轮评论缺少作者标签也不得送AI', async () => {
  const f = fixture({ videos: { [IDS[0]]: { authorSecUid: 'cached-author' } }, collect: async ({ append, item, capture }) => {
    append([comment('cached-author-comment', { uid: 'cached-author', isAuthor: false }), comment('reader')]);
    capture(['cached-author-comment', 'reader'], { added: 2, supplemented: 0 }); return { newLeads: 2, complete: true, work: item };
  } });
  await f.run(); assert.deepEqual(f.aiCalls[0].leadIds, ['reader']); assert.equal(f.summary().commentLeadCount, 1);
  assert.equal(f.rows().find(row => row.id === 'cached-author-comment').aiDone, undefined);
});

test('明文重复和冷却作品不访问，短链实际访问后发现重复才排下一作品间隔', async () => {
  const f = fixture({ list: [work(0), work(0), work(1), { url: 'https://v.douyin.com/local-only/', resolvedId: IDS[0] }, work(2)],
    videos: { [IDS[1]]: { collectionState: 'complete', lastCollectAt: new Date().toISOString() } } });
  await f.run(); assert.equal(f.calls.length, 3); assert.equal(f.usage.collectAttempts, 3);
  assert.deepEqual(f.boundaries, ['collect', 'collect', 'collect']); assert.equal(f.summary().skipped, 3); assert.equal(f.summary().processed, 2);
  assert.equal(f.aiCalls.length, 1); assert.equal(f.aiCalls[0].leadIds.length, 2);
});

test('强制重采与可续采作品不被完整作品冷却阻挡', async () => {
  const stamp = new Date().toISOString();
  const f = fixture({ list: [work(0, { force: true }), work(1)], videos: {
    [IDS[0]]: { collectionState: 'complete', lastCollectAt: stamp }, [IDS[1]]: { collectionState: 'partial', lastCollectAt: stamp }
  } });
  await f.run(); assert.equal(f.calls.length, 2); assert.equal(f.summary().skipped, 0); assert.equal(f.summary().processed, 2);
});

test('达到每日作品上限时保存本次数据但不自动判断未完整结束的队列', async () => {
  const f = fixture({ list: [work(0), work(1)], settings: { collect: { dailyVideoLimit: 1 } } });
  await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.aiCalls.length, 0);
  assert.equal(f.summary().newLeads, 1); assert.equal(f.summary().status, 'paused'); assert.equal(f.summary().aiStatus, 'skipped');
});

test('采集摘要使用同一个runId且不暴露整批线索ID或API Key', async () => {
  const f = fixture({ list: [work(0), work(2)] });
  const result = await f.run();
  assert.match(result.runId, /^[a-f0-9-]{36}$/); assert(f.calls.every(call => call.runId === result.runId));
  assert.equal(f.summary().runId, result.runId); assert(f.rows().every(row => row.collectionRunId === result.runId));
  assert.doesNotMatch(JSON.stringify(f.summary()), /leadIds|captured-|local-fixture-never-sent/);
});

for (const [label, alive] of [
  ['尚未启动', null],
  ['页面已关闭', { page: { isClosed: () => true }, headless: false }],
  ['后台检查窗口', { page: { isClosed: () => false }, headless: true }]
]) test('采集浏览器' + label + '时恢复可见账号窗口，并只使用恢复后的页面', async () => {
  const recovered = { page: { isClosed: () => false }, headless: false };
  const f = fixture({ alive, launch: async ({ options }) => { options.checkStopped(); return recovered; } });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(f.browserLaunchCalls, [{ accountId: 'local-account', hasStopCallback: true }]);
  assert.equal(f.calls.length, 1); assert.equal(f.collectionPages[0], recovered.page);
  assert.equal(f.summary().status, 'completed');
});

test('采集复用现有可见且未关闭的账号页面，不重复启动浏览器', async () => {
  const alive = { page: { isClosed: () => false }, headless: false };
  const f = fixture({ alive });
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.browserLaunchCalls.length, 0);
  assert.equal(f.collectionPages[0], alive.page);
});

test('恢复浏览器期间收到停止，即使启动函数返回页面也不得开始采集或AI', async () => {
  const f = fixture({ alive: null, launch: async ({ state, options }) => {
    options.checkStopped(); state.stopRequested = true;
    assert.throws(options.checkStopped, TaskStopError);
    return { page: { isClosed: () => false }, headless: false };
  } });
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(f.browserLaunchCalls.length, 1);
  assert.equal(f.calls.length, 0); assert.equal(f.aiCalls.length, 0);
  assert.equal(f.summary().status, 'paused'); assert.equal(f.summary().aiStatus, 'skipped');
});
