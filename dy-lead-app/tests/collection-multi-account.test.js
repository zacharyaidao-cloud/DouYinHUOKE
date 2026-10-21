'use strict';
// 多账号轮换采集 + 强制重采中途暂停后的续采。纯依赖夹具：不启动浏览器、不访问平台。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollectionTasks } = require('../engine-collection-tasks');
const { TaskStopError } = require('../scheduler');
const { parseVideoLinks } = require('../lib/video-links');

const ids = Array.from({ length: 9 }, (_, i) => '76930000000000000' + String(i).padStart(2, '0'));
const bj = ms => new Date(ms + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19); // 北京时间字符串，与 store.nowStr 同格式

function harness({ behavior = () => null, worksPerAccount = 2, dailyVideoLimit = 240, usage = {}, videos = {}, alive = {} } = {}) {
  const state = { running: false, stopRequested: false };
  const logs = [], order = [], launched = [], closed = [], perUsage = structuredClone(usage);
  let works = structuredClone(videos);
  const settings = { collect: { autoAiAfterCollect: false, dailyVideoLimit, cooldownHours: 24, worksPerAccount }, ai: { enabled: false } };
  const store = {
    getSettings: () => structuredClone(settings), getLeads: () => [], setLeads() {},
    getVideos: () => structuredClone(works), setVideos: value => { works = structuredClone(value); },
    getDailyUsage: id => ({ ...(perUsage[id] || {}) }),
    bumpDaily: (id, field) => { perUsage[id] = perUsage[id] || {}; perUsage[id][field] = (perUsage[id][field] || 0) + 1; },
    nowStr: () => bj(Date.now()), log: (id, line) => logs.push(`[${id}] ${line}`)
  };
  const tasks = createCollectionTasks({ store, taskState: state,
    setTask: patch => { if (patch.running === true) state.stopRequested = false; Object.assign(state, patch); },
    failTask: error => ({ ok: false, error }), parseVideoList: input => parseVideoLinks(input), checkpoint: () => {},
    makeScheduler: () => ({ checkStopped() { if (state.stopRequested) throw new TaskStopError(); }, scheduleBoundary() {} }),
    getAlive: id => alive[id] || null,
    launchAccount: async id => { launched.push(id); return { page: { account: id } }; },
    closeAccount: async id => { closed.push(id); },
    collectOne: async (accountId, page, item, _settings, _scheduler, beforeCollect) => {
      const work = { ...item };
      const skip = beforeCollect(work);
      if (skip) return { skipped: true, skipReason: skip, newLeads: 0, work };
      assert.equal(page.account || accountId, accountId, '用当前账号自己的窗口采集');
      order.push([accountId, work.id]);
      const outcome = behavior(accountId, work, order.length);
      if (outcome instanceof Error) {
        const v = store.getVideos(); v[work.id] = { ...(v[work.id] || {}), collectionState: 'interrupted', collectionReason: outcome.message }; store.setVideos(v);
        throw outcome;
      }
      const v = store.getVideos(); v[work.id] = { ...(v[work.id] || {}), awemeId: work.id, collectionState: 'complete' }; store.setVideos(v);
      return { newLeads: 0, complete: true, work };
    }
  });
  return { tasks, state, logs, order, launched, closed, usage: perUsage, works: () => works };
}
const links = (n, extra = {}) => ids.slice(0, n).map(id => ({ url: 'https://www.douyin.com/video/' + id, ...extra }));

test('多账号：每个账号连续采 worksPerAccount 个作品后交给下一个，轮完一圈再回到第一个；切换时关掉本次打开的窗口', async () => {
  const h = harness({ worksPerAccount: 2 });
  const result = await h.tasks.collectTask(['A', 'B', 'C'], links(7));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(h.order.map(([account]) => account).join(''), 'AABBCCA');
  assert.deepEqual(h.closed, ['A', 'B', 'C']);
  assert.deepEqual(result.accounts.map(a => [a.accountId, a.collected]), [['A', 3], ['B', 2], ['C', 2]]);
  assert.equal(result.completed, 7);
});

test('多账号：某账号登录失效 → 本次不再用它，下一个账号接着采同一个作品，其余照常', async () => {
  const h = harness({ worksPerAccount: 2, behavior: (account, work) => account === 'B' ? new TaskStopError('抖音账号已退出登录', 'LOGIN_REQUIRED') : null });
  const result = await h.tasks.collectTask(['A', 'B', 'C'], links(5));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(h.order.map(([account, id]) => account + id.slice(-1)), ['A0', 'A1', 'B2', 'C2', 'C3', 'A4']);
  assert.equal(result.completed, 5);
  assert.equal(result.accounts.find(a => a.accountId === 'B').unusable, '抖音账号已退出登录');
  assert.equal(h.works()[ids[2]].collectionState, 'complete', 'B 中断的作品由 C 采完整');
});

test('多账号：达到每日作品上限的账号换下一个；全部账号都不可用才停止', async () => {
  const h = harness({ worksPerAccount: 5, dailyVideoLimit: 3, usage: { A: { videos: 3 } } });
  const result = await h.tasks.collectTask(['A', 'B'], links(6));
  assert.equal(result.ok, true);
  assert.deepEqual(h.order.map(([account]) => account).join(''), 'BBB');
  assert.equal(h.state.collectionSummary.stopReason.includes('所有采集账号'), true);
});

test('单账号：行为不变——登录失效暂停整个队列', async () => {
  const h = harness({ behavior: () => new TaskStopError('抖音账号已退出登录', 'LOGIN_REQUIRED') });
  const result = await h.tasks.collectTask('A', links(3));
  assert.equal(result.ok, false);
  assert.equal(h.order.length, 1);
});

test('强制重采中途暂停后再开始：勾选之后已采完整的作品跳过，其余继续强制采', async () => {
  const tickedAt = Date.now() - 3600000;
  const videos = {
    [ids[0]]: { collectionState: 'complete', lastCollectAt: bj(tickedAt + 600000) },  // 本轮已采完（暂停前）
    [ids[1]]: { collectionState: 'complete', lastCollectAt: bj(tickedAt - 600000) },  // 勾选前采的 → 仍要强制重采
    [ids[2]]: { collectionState: 'interrupted', lastCollectAt: bj(tickedAt + 900000) } // 本轮没采完 → 继续采
  };
  const h = harness({ videos });
  const result = await h.tasks.collectTask('A', links(3, { force: true, forceAt: tickedAt }));
  assert.equal(result.ok, true);
  assert.deepEqual(h.order.map(([, id]) => id), [ids[1], ids[2]]);
  assert.equal(result.skipped, 1);
  assert(h.logs.some(line => line.includes('本轮强制重采已采完整')));
});

test('强制重采没有勾选时间（旧版界面）时保持原行为：全部强制采', async () => {
  const videos = { [ids[0]]: { collectionState: 'complete', lastCollectAt: bj(Date.now() - 60000) } };
  const h = harness({ videos });
  const result = await h.tasks.collectTask('A', links(1, { force: true }));
  assert.equal(result.ok, true);
  assert.equal(h.order.length, 1);
});
