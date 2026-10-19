'use strict';

// Execute collectOne and dedupeKey taken directly from the current engine source.
// Everything outside those functions is an in-memory fixture. This suite does
// not load engine/store, open profiles, launch a browser or send any requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeVideoLink, workIdFromLink } = require('../lib/video-links');
const { selectWorkDetail, workDescription } = require('../lib/work-metadata');
const { userMetadata, identifier } = require('../lib/user-metadata');
const { commentEvidence } = require('../lib/comment-evidence');

function fixture({ responses = [], healthResponses = [], openResponses = [], scrollResponses = [], existingLeads = [], existingVideos = {}, pageMetadata = { descriptionState: 'missing' }, pageResponses = [], workType = 'note', readTimeoutMs = 15000, feedbackDelayMs = 0, maxScrolls = 1, panelState = 'ready', probeStates = [], waitHook, onScroll, onOpen, healthHook, beforeSetLeads, beforeSetVideos } = {}) {
  const engineSource = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const start = engineSource.indexOf('async function collectOne(');
  const end = engineSource.indexOf('/** 多链接队列采集', start);
  const dedupeStart = engineSource.indexOf('function dedupeKey(');
  const dedupeEnd = engineSource.indexOf('function matchIntent(', dedupeStart);
  assert(start >= 0 && end > start && dedupeStart >= 0 && dedupeEnd > dedupeStart, 'Read actual collection functions from the source engine');
  const workId = '7000000000000000123';
  const canonicalUrl = `https://www.douyin.com/${workType}/${workId}`;
  let responseListener = null, scrolls = 0, openings = 0, probes = 0, metadataReads = 0, feedbackTimeouts = 0, healthChecks = 0, notifyJsonStarted;
  const sleeps = [], statuses = [], capturedIds = [], capturedBatches = [], boundaries = [], checkpoints = [], logs = [];
  const jsonStarted = new Promise(resolve => { notifyJsonStarted = resolve; });
  const controller = new AbortController();
  class FixtureTaskStopError extends Error {
    constructor(message = '用户停止任务', code = 'TASK_STOPPED') { super(message); this.code = code; }
  }
  const store = {
    leads: structuredClone(existingLeads), videos: structuredClone(existingVideos),
    getLeads() { return structuredClone(this.leads); }, setLeads(leads) { if (beforeSetLeads) beforeSetLeads(leads, this); this.leads = structuredClone(leads); },
    getVideos() { return structuredClone(this.videos); }, setVideos(videos) { if (beforeSetVideos) beforeSetVideos(videos, this); this.videos = structuredClone(videos); },
    nowStr() { return '2026-10-08 12:00:00'; }, log(_accountId, message) { logs.push(message); }
  };
  const page = {
    on(event, listener) { assert.equal(event, 'response'); responseListener = listener; },
    off(event, listener) { assert.equal(event, 'response'); assert.equal(responseListener, listener); responseListener = null; },
    url() { return canonicalUrl; },
    async evaluate(callback, argument) {
      if (callback === context.readPageWorkMetadata) {
        metadataReads++; pageResponses.forEach(emitResponse); return typeof pageMetadata === 'function' ? pageMetadata(metadataReads) : pageMetadata;
      }
      if (callback === context.openComments) {
        if (argument && argument.probe) {
          probes++;
          return { state: probeStates[probes - 1] || (panelState === 'opened' ? 'available' : panelState) };
        }
        if (onOpen) onOpen({ emitResponse });
        openings++; openResponses.forEach(emitResponse); return { state: panelState };
      }
      scrolls++;
      if (onScroll) onScroll({ scrolls, emitResponse });
      const next = scrollResponses[scrolls - 1];
      if (next) (Array.isArray(next) ? next : [next]).forEach(emitResponse);
      return { state: 'scrolled', moved: true };
    }
  };
  const emitResponse = response => responseListener({
    status: () => response.httpStatus == null ? 200 : response.httpStatus,
    url: () => `https://www.douyin.com/aweme/v1/web/${response.kind === 'detail' ? 'aweme/detail' : 'comment/list'}/?aweme_id=${response.workId || workId}&cursor=${response.requestCursor || 0}&${new URLSearchParams(response.params || {})}`,
    json: () => { notifyJsonStarted(); return response.json ? response.json() : Promise.resolve(structuredClone(response.body)); }
  });
  let healthResponsesEmitted = false;
  const context = {
    URL, Promise, setTimeout: (callback, ms) => setTimeout(() => {
      if (ms === 200) {
        feedbackTimeouts++;
        if (waitHook) waitHook({ ms, emitResponse, abort: () => { context.taskState.stopRequested = true; controller.abort(); } });
      }
      callback();
    }, ms === 15000 ? readTimeoutMs : ms === 200 ? feedbackDelayMs : ms), clearTimeout, normalizeVideoLink, workIdFromLink, selectWorkDetail, workDescription, userMetadata, identifier, commentEvidence, store,
    workflow: { businessId: () => 'default' },
    matchIntent: () => ({ kw: '', hit: false, excluded: false }), fmtTs: () => '', checkpoint(patch) { checkpoints.push(structuredClone(patch)); },
    taskState: { stopRequested: false }, taskAbort: controller, setTask(status) { statuses.push(status); }, authorize: async () => true,
    checkAccountPageHealth: async () => {
      healthChecks++;
      if (healthHook) await healthHook({ checks: healthChecks, TaskStopError: FixtureTaskStopError });
      if (!healthResponsesEmitted) { healthResponsesEmitted = true; healthResponses.forEach(emitResponse); }
    }, isLoggedIn: async () => true, openComments() {}, scrollComments() {}, readPageWorkMetadata() {},
    SLEEP: async ms => { sleeps.push(ms); if (waitHook) waitHook({ ms, emitResponse, abort: () => { context.taskState.stopRequested = true; controller.abort(); } }); },
    landingWork: raw => ({ ...normalizeVideoLink(raw), needsCanonicalNavigation: false }),
    async navigateCollectionPage() {
      responses.forEach(emitResponse);
    },
    TaskStopError: FixtureTaskStopError
  };
  vm.runInNewContext(engineSource.slice(dedupeStart, dedupeEnd), context, { filename: 'actual-engine-dedupe-fixture.js' });
  const collectOne = vm.runInNewContext('(' + engineSource.slice(start, end) + ')', context, { filename: 'actual-engine-collection-fixture.js' });
  const settings = { collect: { skipEmptyText: true, maxScrolls }, keywords: {} };
  const scheduler = { scheduleBoundary: kind => boundaries.push(kind), async run(_meta, operation) { this.checkStopped(); return operation(); }, checkStopped() { if (context.taskState.stopRequested) throw new FixtureTaskStopError(); } };
  return {
    workId, store, page,
    run: () => collectOne('fixture-account', page, { ...normalizeVideoLink(canonicalUrl), force: true }, settings, scheduler, () => '', (ids, counts) => { capturedIds.push(...ids); capturedBatches.push(structuredClone({ ids, counts })); }, 'run-fixture'),
    listener: () => responseListener, scrolls: () => scrolls, openings: () => openings, probes: () => probes, metadataReads: () => metadataReads, feedbackTimeouts: () => feedbackTimeouts, healthChecks: () => healthChecks, jsonStarted, sleeps, statuses, capturedIds, capturedBatches, boundaries, checkpoints, logs,
    abort() { context.taskState.stopRequested = true; controller.abort(); }
  };
}

function comment(uid, text = '本地隔离评论') {
  return { level: 1, text, create_time: 0, user: { uid: uid + '-numeric', sec_uid: uid, nickname: '隔离测试用户' } };
}

test('现场图文两组分页重叠：20→30→40→50 的定位列表追赶仍为进展，六轮取得末页', async () => {
  const image = { pc_img_format: 'webp', count: '10', item_type: '0' };
  const located = { ...image, insert_ids: '' };
  const rows = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => ({ ...comment('parallel-' + (start + index)), cid: 'cid-' + (start + index) }));
  const page = (requestCursor, cursor, params, comments) => ({ requestCursor, params, body: { status_code: 0, comments, has_more: 1, cursor, total: 212 } });
  const f = fixture({ maxScrolls: 120, responses: [
    page(20, 40, { count: '20', item_type: '0' }, rows(21, 38)),
    page(0, 10, located, rows(1, 10)), page(10, 20, located, rows(11, 20))
  ], scrollResponses: [
    page(40, 50, image, rows(41, 50)), page(20, 30, located, rows(21, 28)),
    page(30, 40, located, rows(29, 38)), page(40, 50, located, rows(41, 50)),
    page(50, 60, image, rows(51, 60)),
    { requestCursor: 60, params: image, body: { status_code: 0, comments: null, has_more: 0, cursor: 70, total: 0 } }
  ] });
  const result = await f.run();
  assert.equal(result.complete, true); assert.equal(f.scrolls(), 6); assert.equal(result.lastCursor, 70);
  assert.equal(f.store.leads.length, 58); assert.equal(result.newLeads, 58); assert.equal(result.lastTotal, 212);
  const checkpoint = f.store.videos[f.workId].collectionCheckpoint;
  assert.equal(checkpoint.paginationSourceCount, 3); assert.equal(checkpoint.noProgressRounds, 0);
  assert(f.logs.some(message => message.includes('请求游标 20，返回游标 30') && message.includes('仍属本来源有效进展')));
  assert(f.logs.some(message => message.includes('请求游标 30，返回游标 40') && message.includes('仍属本来源有效进展')));
  assert(!f.logs.some(message => message.includes('暂停诊断'))); assert.equal(f.listener(), null);
});

test('页大小、鉴权字段或定位值变化不凭空建立分页来源，重复同页仍三轮暂停', async () => {
  const body = { status_code: 0, comments: [{ ...comment('repeated-source'), cid: 'repeated-cid' }], has_more: 1, cursor: 10, total: 212 };
  const f = fixture({ maxScrolls: 120,
    responses: [{ params: { pc_img_format: 'webp', insert_ids: 'first', count: '20', msToken: 'initial' }, body }],
    scrollResponses: [1, 2, 3].map(index => ({ params: { pc_img_format: 'webp', insert_ids: 'changed-' + index, count: '10', msToken: 'changed-' + index }, body }))
  });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_NO_PROGRESS');
  assert.equal(f.scrolls(), 3); assert.equal(f.store.leads.length, 1);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.paginationSourceCount, 1);
  assert.equal(f.checkpoints.at(-1).noProgressRounds, 3, 'Task checkpoint agrees with final pause diagnostics');
  assert(!f.logs.join('\n').includes('changed-')); assert.equal(f.listener(), null);
});

test('其他分页来源较旧的完成反馈不能覆盖高游标尚有更多评论或重置停滞次数', async () => {
  const older = { requestCursor: 0, params: { pc_img_format: 'webp', insert_ids: '' }, body: { status_code: 0, comments: null, has_more: 0, cursor: 10, total: 0 } };
  const f = fixture({ maxScrolls: 120,
    responses: [{ requestCursor: 60, body: { status_code: 0, comments: [comment('higher-active-page')], has_more: 1, cursor: 70, total: 137 } }],
    scrollResponses: [older, older, older]
  });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_NO_PROGRESS');
  const checkpoint = f.store.videos[f.workId].collectionCheckpoint;
  assert.equal(checkpoint.lastHasMore, 1); assert.equal(checkpoint.lastCursor, 70); assert.equal(checkpoint.noProgressRounds, 3);
  assert.equal(f.scrolls(), 3); assert.equal(f.store.leads.length, 1); assert.equal(f.listener(), null);
  assert(!f.logs.some(message => message.includes('末页已确认')));
});

test('现场 cursor70→80 的 null 末页确认完成，保留已有评论与之前总量且不额外等待三轮', async () => {
  for (const workType of ['note', 'video']) {
    const f = fixture({ workType, maxScrolls: 120,
      responses: [{ requestCursor: 60, body: { status_code: 0, comments: [comment('before-null-terminal')], has_more: 1, cursor: 70, total: 137 } }],
      scrollResponses: [{ requestCursor: 70, body: { status_code: 0, comments: null, has_more: 0, cursor: 80, total: 0 } }]
    });
    const result = await f.run();
    assert.equal(result.complete, true); assert.equal(result.newLeads, 1);
    assert.equal(result.lastCursor, 80); assert.equal(result.lastTotal, 137); assert.equal(f.scrolls(), 1);
    const checkpoint = f.store.videos[f.workId].collectionCheckpoint;
    assert.equal(checkpoint.lastHasMore, 0); assert.equal(checkpoint.commentResponseCount, 2); assert.equal(checkpoint.noProgressRounds, 0);
    assert.equal(f.store.videos[f.workId].collectionState, 'complete'); assert.equal(f.listener(), null);
    assert(f.logs.some(message => message.includes('末页已确认') && message.includes('null（空列表）')));
    assert(!f.logs.some(message => message.includes('暂停诊断')));
  }
});

test('无评论作品的明确 null 空末页以及字符串零反馈可以完成', async () => {
  for (const zero of [0, '0']) {
    const f = fixture({ responses: [{ body: { status_code: zero, comments: null, has_more: zero, cursor: zero, total: zero } }] });
    assert.equal((await f.run()).complete, true); assert.equal(f.scrolls(), 0); assert.equal(f.openings(), 0);
    assert.equal(f.store.leads.length, 0); assert.equal(f.listener(), null);
  }
});

test('2.3.16 现场视频 0→5→15→25→35：null 末页保留 total35，已有线索回填后正常结束', async () => {
  const workId = '7000000000000000123';
  const rows = (start, count) => Array.from({ length: count }, (_, index) => comment('retained-' + (start + index)));
  const batches = [rows(1, 5), rows(6, 8), rows(14, 9)];
  const existingLeads = batches.flat().map((row, index) => ({
    id: index + 1, accountId: 'fixture-account', videoLink: `https://www.douyin.com/video/${workId}`,
    uid: row.user.sec_uid, demand: row.text, status: 'dm_sent', dmSentAt: '原私信时间'
  }));
  const image = { pc_img_format: 'webp', count: '10', item_type: '0' };
  const f = fixture({ workType: 'video', existingLeads, maxScrolls: 120,
    responses: [{ requestCursor: 0, params: { count: '5', item_type: '0' }, body: { status_code: 0, comments: batches[0], has_more: 1, cursor: 5, total: 35 } }],
    scrollResponses: [
      { requestCursor: 5, params: image, body: { status_code: 0, comments: batches[1], has_more: 1, cursor: 15, total: 35 } },
      { requestCursor: 15, params: image, body: { status_code: 0, comments: batches[2], has_more: 1, cursor: 25, total: 35 } },
      { requestCursor: 25, params: image, body: { status_code: 0, comments: null, has_more: 0, cursor: 35, total: 35 } }
    ]
  });
  const result = await f.run();
  assert.equal(result.complete, true); assert.equal(result.lastCursor, 35); assert.equal(result.lastTotal, 35);
  assert.equal(result.newLeads, 0); assert.equal(f.store.leads.length, 22); assert.equal(f.scrolls(), 3);
  assert(f.store.leads.every(lead => lead.status === 'dm_sent' && lead.dmSentAt === '原私信时间'));
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.commentResponseCount, 4);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.noProgressRounds, 0);
  assert(f.logs.some(message => message.includes('末页已确认') && message.includes('总评论 35')));
  assert(!f.logs.some(message => message.includes('暂停诊断'))); assert.equal(f.listener(), null);
});

test('视频与图文 null 末页不以总评论数判断完成，有效统计更新、缺失或异常统计保留原值', async () => {
  for (const workType of ['video', 'note']) {
    for (const total of [41, '41', undefined, null, false, 'invalid']) {
      const f = fixture({ workType, maxScrolls: 120,
        responses: [{ requestCursor: 15, body: { status_code: 0, comments: [comment('before-retained-total')], has_more: 1, cursor: 25, total: 35 } }],
        scrollResponses: [{ requestCursor: 25, body: { status_code: 0, comments: null, has_more: 0, cursor: 35, total } }]
      });
      const result = await f.run();
      assert.equal(result.complete, true); assert.equal(result.lastTotal, total === 41 || total === '41' ? 41 : 35);
      assert.equal(result.lastCursor, 35); assert.equal(f.scrolls(), 1); assert.equal(f.store.leads.length, 1);
      assert.equal(f.listener(), null);
    }
  }
});

test('null 评论缺少明确成功、无更多或合法游标时不能当成完成', async () => {
  const terminal = { status_code: 0, comments: null, has_more: 0, cursor: 80, total: 0 };
  const invalid = [
    ...[null, '', false, undefined, 1].map(status_code => ({ ...terminal, status_code })),
    ...[null, '', false, undefined, 1].map(has_more => ({ ...terminal, has_more })),
    ...[null, '', false, undefined, -1, 'invalid'].map(cursor => ({ ...terminal, cursor })),
    { status_code: 0, has_more: 0, cursor: 80, total: 0 },
    { ...terminal, comments: {} }, { ...terminal, comments: [null] }
  ];
  for (const body of invalid) {
    const f = fixture({ responses: [{ body }] });
    await assert.rejects(f.run(), error => error.code === 'COMMENT_RESPONSE_MISSING');
    assert.equal(f.store.videos[f.workId].collectionState, 'interrupted');
    assert.equal(f.store.videos[f.workId].collectionCheckpoint.commentResponseCount, 0); assert.equal(f.listener(), null);
    assert(f.logs.some(message => message.includes('目标评论响应未采纳')));
  }
});

test('后到旧请求的非零总数 null 空末页不能覆盖较新的 has_more=1', async () => {
  const old = { requestCursor: 0, body: { status_code: 0, comments: null, has_more: 0, cursor: 20, total: 35 } };
  const f = fixture({ maxScrolls: 120,
    responses: [{ requestCursor: 60, body: { status_code: 0, comments: [comment('current-null-guard')], has_more: 1, cursor: 70, total: 137 } }],
    scrollResponses: [old, old, old]
  });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_NO_PROGRESS');
  const checkpoint = f.store.videos[f.workId].collectionCheckpoint;
  assert.equal(checkpoint.lastCursor, 70); assert.equal(checkpoint.lastHasMore, 1); assert.equal(checkpoint.lastTotal, 137);
  assert.equal(f.store.leads.length, 1); assert.equal(f.scrolls(), 3); assert.equal(f.listener(), null);
  assert(!f.logs.some(message => message.includes('末页已确认')));
  assert(f.logs.some(message => message.includes('暂停诊断') && message.includes('最后游标 70')));
});

test('HTTP502 或非 JSON 的目标评论响应不会伪报完整，拒绝原因去重且不记录响应正文', async () => {
  for (const response of [
    { httpStatus: 502, body: { status_code: 0, comments: null, has_more: 0, cursor: 80, total: 0 } },
    { json: () => Promise.reject(new Error('private-response-body')) }
  ]) {
    const f = fixture({ responses: [response, response] });
    await assert.rejects(f.run(), error => error.code === 'COMMENT_RESPONSE_MISSING');
    assert.equal(f.logs.filter(message => message.includes('目标评论响应未采纳')).length, 1);
    assert(!f.logs.join('\n').includes('private-response-body')); assert.equal(f.listener(), null);
  }
});

test('null、空串、false 的 has_more 不得被当成接口确认采集完整', async () => {
  for (const hasMore of [null, '', false, undefined]) {
    const f = fixture({ responses: [{ body: { status_code: 0, comments: [comment('invalid-enum')], has_more: hasMore, cursor: 20, total: 2 } }] });
    const result = await f.run();
    assert.equal(result.newLeads, 1, 'A valid comment is retained even when completion feedback is unknown');
    assert.equal(result.complete, false, String(hasMore));
    assert.equal(f.store.videos[f.workId].collectionState, 'partial');
    assert.equal(f.store.videos[f.workId].collectionCheckpoint.lastHasMore, null);
    assert.equal(f.listener(), null);
  }
});

test('明确数值或字符串 0 才能确认完成，其他作品响应不影响目标作品', async () => {
  for (const hasMore of [0, '0']) {
    const f = fixture({ responses: [
      { workId: '7000000000000000999', body: { status_code: 0, comments: [comment('other-work')], has_more: 1, cursor: 999, total: 99 } },
      { body: { status_code: 0, comments: [comment('target-work')], has_more: hasMore, cursor: 20, total: 1 } }
    ] });
    const result = await f.run();
    assert.equal(result.complete, true); assert.equal(result.newLeads, 1);
    assert.equal(f.store.leads[0].uid, 'target-work');
    assert.equal(result.lastCursor, 20);
    assert.equal(f.store.videos[f.workId].collectionState, 'complete');
    assert.equal(f.listener(), null);
  }
});

test('初始响应 body 较晚完成，后续分页完成反馈和两页评论均保留', async () => {
  const first = { status_code: 0, comments: [comment('first-page')], has_more: 1, cursor: 20, total: 2 };
  const final = { status_code: 0, comments: [comment('final-page')], has_more: 0, cursor: 40, total: 2 };
  const f = fixture({ responses: [
    { requestCursor: 0, json: () => new Promise(resolve => setTimeout(() => resolve(first), 10)) },
    { requestCursor: 20, body: final }
  ] });
  const result = await f.run();
  assert.equal(result.newLeads, 2); assert.deepEqual(f.store.leads.map(lead => lead.uid).sort(), ['final-page', 'first-page']);
  assert.equal(result.complete, true);
  assert.equal(result.lastCursor, 40);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.lastHasMore, 0);
  assert.equal(f.store.videos[f.workId].collectionState, 'complete');
  assert.equal(f.scrolls(), 0, 'Captured completion evidence prevents an unnecessary first scroll');
  assert.equal(f.listener(), null);
});

test('已有 video 查询参数历史，再以 note 重采同作品同评论不会重复入库', async () => {
  const workId = '7000000000000000123';
  const existing = { id: 1, accountId: 'fixture-account', videoLink: `https://www.douyin.com/video/${workId}?from=old-client`, uid: 'same-user', demand: '同一条真实评论', nickname: '旧历史昵称', status: 'dm_sent', aiIntent: true, aiScore: 98, aiReason: '旧AI结论', fetchTime: '旧采集时间', dmSentAt: '旧私信发送时间', followedAt: '旧关注时间' };
  const f = fixture({ existingLeads: [existing], responses: [{ body: { status_code: 0, comments: [comment('same-user', '同一条真实评论')], has_more: 0, cursor: 20, total: 1 } }] });
  const result = await f.run();
  assert.equal(result.newLeads, 0); assert.equal(f.store.leads.length, 1);
  for (const field of ['id', 'accountId', 'videoLink', 'uid', 'demand', 'status', 'aiIntent', 'aiScore', 'aiReason', 'fetchTime', 'dmSentAt', 'followedAt']) assert.equal(f.store.leads[0][field], existing[field], 'Retain the existing business history: ' + field);
  assert.equal(f.store.leads[0].userSourcePath, '/aweme/v1/web/comment/list/');
  assert.deepEqual(f.capturedIds, ['1']);
  assert.equal(f.store.leads[0].collectionRunId, 'run-fixture');
  assert.equal(f.store.videos[workId].videoLink, `https://www.douyin.com/note/${workId}`);
  assert.equal(f.store.videos[workId].collectionState, 'complete');
});

test('响应 body 永不结束时，用户停止会释放采集等待且不会晚写评论', { timeout: 1500 }, async () => {
  let releaseBody;
  const f = fixture({ readTimeoutMs: 1000, responses: [{ json: () => new Promise(resolve => { releaseBody = resolve; }) }] });
  const collecting = f.run();
  await f.jsonStarted;
  f.abort();
  await assert.rejects(collecting, error => error.code === 'TASK_STOPPED');
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted');
  assert.equal(f.store.leads.length, 0); assert.equal(f.listener(), null);
  releaseBody({ status_code: 0, comments: [comment('too-late')], has_more: 0, cursor: 20, total: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.leads.length, 0, 'A late body must not write to a finished task');
});

test('响应读取超时暂停任务，串行后续响应不再逐个等待超时', { timeout: 1500 }, async () => {
  let secondRead = false;
  const f = fixture({ readTimeoutMs: 15, responses: [
    { json: () => new Promise(() => {}) },
    { requestCursor: 20, json: () => { secondRead = true; return new Promise(() => {}); } }
  ] });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_RESPONSE_TIMEOUT');
  assert.equal(secondRead, false, 'The first body timeout prevents another stalled read');
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted');
  assert.match(f.store.videos[f.workId].collectionReason, /响应读取超时/);
  assert.equal(f.store.leads.length, 0); assert.equal(f.listener(), null);
});

test('最后清理监听阶段才超时的晚到 body 同样暂停，不能保留完整成功状态', { timeout: 1500 }, async () => {
  const f = fixture({ readTimeoutMs: 15,
    responses: [{ body: { status_code: 0, comments: [comment('already-captured')], has_more: 0, cursor: 20, total: 1 } }],
    healthResponses: [{ json: () => new Promise(() => {}) }]
  });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_RESPONSE_TIMEOUT');
  assert.equal(f.store.leads.length, 1, 'Already captured comments remain available for continuation');
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted');
  assert.match(f.store.videos[f.workId].collectionReason, /响应读取超时/);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.lastHasMore, 0);
  assert.equal(f.listener(), null);
});

test('推荐作品 detail body 永不结束时，不解析它也不阻塞目标作品采集', { timeout: 1500 }, async () => {
  let unrelatedRead = false;
  const f = fixture({ readTimeoutMs: 15, responses: [
    { kind: 'detail', workId: '7000000000000000999', json: () => { unrelatedRead = true; return new Promise(() => {}); } },
    { body: { status_code: 0, comments: [comment('target-only')], has_more: 0, cursor: 20, total: 1 } }
  ] });
  const result = await f.run();
  assert.equal(unrelatedRead, false); assert.equal(result.complete, true); assert.equal(result.newLeads, 1);
  assert.equal(f.store.videos[f.workId].collectionState, 'complete');
  assert.equal(f.store.leads[0].uid, 'target-only'); assert.equal(f.listener(), null);
});

test('图文切换评论入口后才产生首屏响应，再滚动评论区取得下一页', async () => {
  const f = fixture({ panelState: 'opened',
    openResponses: [{ body: { status_code: 0, comments: [comment('note-first')], has_more: 1, cursor: 10, total: 2 } }],
    scrollResponses: [{ requestCursor: 10, body: { status_code: 0, comments: [comment('note-next')], has_more: 0, cursor: 20, total: 2 } }]
  });
  const result = await f.run();
  assert.equal(f.openings(), 1); assert.equal(f.scrolls(), 1);
  assert.equal(result.newLeads, 2); assert.equal(result.complete, true);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.commentResponseCount, 2);
  assert.equal(f.listener(), null);
});

test('打开评论但只收到其他作品响应时暂停，不累计120轮或伪报完成', async () => {
  const f = fixture({ maxScrolls: 120, panelState: 'opened', openResponses: [
    { workId: '7000000000000000999', body: { status_code: 0, comments: [comment('recommendation')], has_more: 0, cursor: 20 } }
  ] });
  await assert.rejects(f.run(), error => error.code === 'COMMENT_RESPONSE_MISSING');
  assert.equal(f.openings(), 1); assert.equal(f.scrolls(), 0); assert.equal(f.store.leads.length, 0);
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted');
  assert.equal(f.listener(), null);
});

test('没有明确评论入口时保留原线索并暂停，不盲滚页面', async () => {
  const previous = { id: 66, accountId: 'fixture-account', uid: 'existing', videoLink: 'https://www.douyin.com/video/123', demand: '历史线索', status: 'dm_pending' };
  const f = fixture({ panelState: 'missing', existingLeads: [previous], maxScrolls: 120 });
  await assert.rejects(f.run(), error => error.code === 'COMMENT_PANEL_NOT_FOUND');
  assert.equal(f.scrolls(), 0); assert.deepEqual(f.store.leads, [previous]); assert.equal(f.listener(), null);
});

test('重复同一评论页的响应不构成进展，连续3轮暂停且保留已采集评论', async () => {
  const same = { body: { status_code: 0, comments: [{ ...comment('same-page'), cid: 'same-comment' }], has_more: 1, cursor: 10, total: 30 } };
  const f = fixture({ maxScrolls: 120, responses: [same], scrollResponses: [same, same, same, same] });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_NO_PROGRESS');
  assert.equal(f.scrolls(), 3); assert.equal(f.store.leads.length, 1);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.noProgressRounds, 3);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.commentResponseCount, 4);
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted'); assert.equal(f.listener(), null);
});

test('分页推进但评论均被过滤时不误报停滞，也不以新增线索数判完整', async () => {
  const pages = Array.from({ length: 5 }, (_, index) => ({ requestCursor: index * 10, body: {
    status_code: 0, comments: [{ ...comment('image-only', ''), cid: 'image-comment-' + index }], has_more: index === 4 ? 0 : 1, cursor: (index + 1) * 10, total: 5
  } }));
  const f = fixture({ maxScrolls: 120, responses: [pages[0]], scrollResponses: pages.slice(1) });
  const result = await f.run();
  assert.equal(result.complete, true); assert.equal(result.newLeads, 0); assert.equal(f.scrolls(), 4);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.noProgressRounds, 0); assert.equal(f.listener(), null);
});

test('同游标有新的评论ID仍算进展，历史线索去重不妨碍续采', async () => {
  const pages = Array.from({ length: 5 }, (_, index) => ({ body: { status_code: 0,
    comments: [{ ...comment('same-user', ''), cid: 'new-cid-' + index }], has_more: index === 4 ? 0 : 1, cursor: 10, total: 5
  } }));
  const f = fixture({ maxScrolls: 120, responses: [pages[0]], scrollResponses: pages.slice(1) });
  assert.equal((await f.run()).complete, true); assert.equal(f.scrolls(), 4);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.noProgressRounds, 0);
});

test('等待首屏响应时可以停止，评论监听清理且不滚动', async () => {
  const f = fixture({ panelState: 'opened', maxScrolls: 120, waitHook: ({ ms, abort }) => { if (ms === 200) abort(); } });
  await assert.rejects(f.run(), error => error.code === 'TASK_STOPPED');
  assert.equal(f.openings(), 1); assert.equal(f.scrolls(), 0); assert.equal(f.listener(), null);
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted');
});

test('不明确的评论接口成功状态及畸形评论数组不能充当首屏或完整反馈', async () => {
  const invalidBodies = [
    ...[null, '', false, undefined].map(status => ({ status_code: status, comments: [], has_more: 0, cursor: 0 })),
    { status_code: 0, comments: [null], has_more: 0, cursor: 0 },
    { status_code: 0, comments: [[]], has_more: 0, cursor: 0 }
  ];
  for (const body of invalidBodies) {
    const f = fixture({ responses: [{ body }], maxScrolls: 120 });
    await assert.rejects(f.run(), error => error.code === 'COMMENT_RESPONSE_MISSING');
    assert.equal(f.store.videos[f.workId].collectionState, 'interrupted');
    assert.equal(f.store.videos[f.workId].collectionCheckpoint.commentResponseCount, 0);
    assert.equal(f.scrolls(), 0); assert.equal(f.listener(), null);
  }
});

test('明确字符串成功状态仍接受真实评论分页完成反馈', async () => {
  const f = fixture({ responses: [{ body: { status_code: '0', comments: [], has_more: '0', cursor: 0, total: 0 } }] });
  assert.equal((await f.run()).complete, true);
  assert.equal(f.store.videos[f.workId].collectionState, 'complete'); assert.equal(f.listener(), null);
});

test('后到旧请求页只保留其新评论，不回退游标、不覆盖完整反馈或重置停滞计数', async () => {
  const initial = { requestCursor: 20, body: { status_code: 0, comments: [comment('current-page')], has_more: 1, cursor: 40 } };
  const olderPages = [1, 2, 3].map(index => ({ requestCursor: 0, body: {
    status_code: 0, comments: [{ ...comment('old-page-' + index), cid: 'old-cid-' + index }], has_more: 0, cursor: 20
  } }));
  const f = fixture({ maxScrolls: 120, responses: [initial], scrollResponses: olderPages });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_NO_PROGRESS');
  const checkpoint = f.store.videos[f.workId].collectionCheckpoint;
  assert.equal(f.store.leads.length, 4, 'Useful comments from the late old pages remain available');
  assert.equal(checkpoint.lastCursor, 40); assert.equal(checkpoint.lastHasMore, 1);
  assert.equal(checkpoint.noProgressRounds, 3); assert.equal(checkpoint.commentResponseCount, 4);
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted'); assert.equal(f.listener(), null);
});

test('相同请求游标的回退响应不能覆盖较新响应，正常新请求仍可结束采集', async () => {
  const f = fixture({ maxScrolls: 120,
    responses: [{ requestCursor: 0, body: { status_code: 0, comments: [comment('newer-body')], has_more: 1, cursor: 40 } }],
    scrollResponses: [
      { requestCursor: 0, body: { status_code: 0, comments: [comment('older-body')], has_more: 0, cursor: 20 } },
      { requestCursor: 40, body: { status_code: 0, comments: [comment('final-body')], has_more: 0, cursor: 60 } }
    ]
  });
  const result = await f.run();
  assert.equal(result.complete, true); assert.equal(result.lastCursor, 60); assert.equal(result.newLeads, 3);
  assert.equal(f.scrolls(), 2); assert.equal(f.store.videos[f.workId].collectionCheckpoint.noProgressRounds, 0);
  assert.equal(f.listener(), null);
});

test('明确新请求的最终空页即使平台重置返回游标，仍可确认完成', async () => {
  const f = fixture({ maxScrolls: 120,
    responses: [{ requestCursor: 0, body: { status_code: 0, comments: [comment('before-final')], has_more: 1, cursor: 40 } }],
    scrollResponses: [{ requestCursor: 40, body: { status_code: 0, comments: [], has_more: 0, cursor: 0, total: 1 } }]
  });
  const result = await f.run();
  assert.equal(result.complete, true); assert.equal(result.lastCursor, 0); assert.equal(f.scrolls(), 1);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.lastHasMore, 0); assert.equal(f.listener(), null);
});

test('图文未发详情接口时，从当前目标页面数据补充描述并传到AI和线索查询', async () => {
  const desc = '自身亚马逊账户被停用，需要准备申诉资料';
  const f = fixture({ pageMetadata: { desc, descriptionState: 'available', descriptionSource: 'page_json' },
    responses: [{ body: { status_code: 0, comments: [comment('note-demand')], has_more: 0, cursor: 20, total: 1 } }]
  });
  assert.equal((await f.run()).complete, true); assert.equal(f.metadataReads(), 2);
  const info = f.store.videos[f.workId];
  assert.equal(info.desc, desc); assert.equal(info.descriptionSource, 'page_json');
  assert.equal(info.descriptionState, 'available'); assert.equal(info.workType, 'note');
  assert.equal(require('../ai').leadInput(f.store.leads[0], f.store.videos).videoDescription, desc);
  assert.equal(require('../lead-query').filterLeads(f.store.leads, f.store.videos, { q: '申诉资料' }).length, 1);
});

test('真实图文详情优先且后续不含描述的目标详情不得清空已有描述和统计', async () => {
  const workId = '7000000000000000123';
  const f = fixture({ responses: [
    { kind: 'detail', body: { status_code: 0, aweme_detail: { aweme_id: workId, desc: '目标图文完整正文', statistics: { digg_count: 0, comment_count: 2 }, author: { sec_uid: 'target-author', nickname: '作者' } } } },
    { kind: 'detail', body: { status_code: 0, aweme_detail: { aweme_id: workId, statistics: { comment_count: 3 } } } },
    { body: { status_code: 0, comments: [comment('target-author')], has_more: 0, cursor: 0, total: 1 } }
  ], pageMetadata: { desc: '不应读取的页面降级文案', descriptionState: 'available', descriptionSource: 'page_description' } });
  assert.equal((await f.run()).complete, true); assert.equal(f.metadataReads(), 2);
  const info = f.store.videos[workId];
  assert.equal(info.desc, '目标图文完整正文'); assert.equal(info.descriptionSource, 'api');
  assert.equal(info.diggCount, 0); assert.equal(info.commentCount, 3); assert.equal(info.authorNickname, '作者');
  assert.equal(f.store.leads[0].isAuthor, true, 'Statistics-only later details must retain the captured author identity');
});

test('页面补充后到达的有效目标API描述覆盖降级文案，相关推荐详情不串入', async () => {
  const workId = '7000000000000000123';
  const f = fixture({ pageMetadata: { desc: '页面正文', descriptionState: 'available', descriptionSource: 'page_description' },
    pageResponses: [{ kind: 'detail', json: () => new Promise(resolve => setTimeout(() => resolve({ status_code: 0, aweme_detail: { aweme_id: workId, desc: '接口最新完整正文' } }), 10)) }],
    responses: [
      { kind: 'detail', body: { status_code: 0, aweme_detail: { aweme_id: '999', desc: '相关推荐不得写入' } } },
      { body: { status_code: 0, comments: [], has_more: 0, cursor: 0, total: 0 } }
    ]
  });
  assert.equal((await f.run()).complete, true);
  assert.equal(f.store.videos[workId].desc, '接口最新完整正文'); assert.equal(f.store.videos[workId].descriptionSource, 'api');
});

test('描述缺失和平台明确空描述分开记载，不以评论采完冒充详情已获取', async () => {
  const workId = '7000000000000000123', complete = { body: { status_code: 0, comments: [], has_more: 0, cursor: 0, total: 0 } };
  const missing = fixture({ responses: [complete] }); await missing.run();
  assert.equal(missing.store.videos[workId].collectionState, 'complete'); assert.equal(missing.store.videos[workId].descriptionState, 'missing');
  const empty = fixture({ responses: [{ kind: 'detail', body: { status_code: 0, aweme_detail: { aweme_id: workId, desc: '' } } }, complete] }); await empty.run();
  assert.equal(empty.store.videos[workId].descriptionState, 'empty'); assert.equal(empty.metadataReads(), 2);
});

test('已返回完成响应的首屏立即处理，不再固定等4秒或多打开评论', async () => {
  const f = fixture({ responses: [{ body: { status_code: 0, comments: [comment('first-screen')], has_more: 0, cursor: 0 } }] });
  assert.equal((await f.run()).complete, true);
  assert.deepEqual(f.sleeps, []); assert.equal(f.probes(), 0); assert.equal(f.openings(), 0); assert.equal(f.scrolls(), 0);
});

test('慢作品详情不阻塞评论翻页，结束后取消并禁止晚写详情', { timeout: 1500 }, async () => {
  let releaseDetail, detailSettled = false;
  const workId = '7000000000000000123';
  const f = fixture({ maxScrolls: 3, pageMetadata: { desc: '当前图文已有正文', descriptionState: 'available', descriptionSource: 'page_json' },
    responses: [
      { kind: 'detail', json: () => new Promise(resolve => { releaseDetail = value => { detailSettled = true; resolve(value); }; }) },
      { body: { status_code: 0, comments: [comment('page-one')], has_more: 1, cursor: 10 } }
    ],
    scrollResponses: [{ requestCursor: 10, body: { status_code: 0, comments: [comment('page-two')], has_more: 0, cursor: 20 } }],
    onScroll: () => assert.equal(detailSettled, false, 'Comment pagination runs while the optional detail is still pending')
  });
  const result = await f.run();
  assert.equal(result.complete, true); assert.equal(result.newLeads, 2); assert.equal(f.scrolls(), 1); assert.equal(detailSettled, false);
  assert.equal(f.store.videos[workId].desc, '当前图文已有正文'); assert.equal(f.listener(), null);
  releaseDetail({ status_code: 0, aweme_detail: { aweme_id: workId, desc: '结束后禁止写入的迟到正文' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.videos[workId].desc, '当前图文已有正文');
});

test('可选详情读取超时不覆盖有效评论的完成反馈', { timeout: 1500 }, async () => {
  const f = fixture({ readTimeoutMs: 15, responses: [
    { kind: 'detail', json: () => new Promise(() => {}) },
    { body: { status_code: 0, comments: [comment('complete-without-detail')], has_more: 0, cursor: 20 } }
  ] });
  assert.equal((await f.run()).complete, true);
  assert.equal(f.store.videos[f.workId].collectionState, 'complete'); assert.equal(f.store.videos[f.workId].descriptionState, 'missing');
  assert.equal(f.store.leads.length, 1); assert.equal(f.listener(), null);
});

test('评论入口迟于文档出现时只探测就绪，实际只打开一次且不固定等250ms', async () => {
  const f = fixture({ panelState: 'opened', probeStates: ['missing', 'missing', 'available'],
    openResponses: [{ body: { status_code: 0, comments: [comment('hydrated-note')], has_more: 0, cursor: 0 } }]
  });
  assert.equal((await f.run()).complete, true);
  assert.equal(f.probes(), 3); assert.equal(f.openings(), 1); assert.equal(f.scrolls(), 0); assert.deepEqual(f.sleeps, []);
});

test('等待评论入口就绪时可立即停止，实际不点击或翻页', async () => {
  const f = fixture({ panelState: 'missing', waitHook: ({ abort }) => abort() });
  await assert.rejects(f.run(), error => error.code === 'TASK_STOPPED');
  assert.equal(f.probes(), 1); assert.equal(f.openings(), 0); assert.equal(f.scrolls(), 0); assert.equal(f.listener(), null);
});

test('已收到的评论body完成之前不会触发下一次翻页', async () => {
  let secondPageDecoded = false;
  const f = fixture({ maxScrolls: 3,
    responses: [{ body: { status_code: 0, comments: [comment('before-slow-page')], has_more: 1, cursor: 10 } }],
    scrollResponses: [
      { requestCursor: 10, json: () => new Promise(resolve => setTimeout(() => { secondPageDecoded = true; resolve({ status_code: 0, comments: [comment('slow-comment-page')], has_more: 1, cursor: 20 }); }, 20)) },
      { requestCursor: 20, body: { status_code: 0, comments: [comment('after-slow-page')], has_more: 0, cursor: 30 } }
    ],
    onScroll: ({ scrolls }) => { if (scrolls === 2) assert.equal(secondPageDecoded, true); }
  });
  const result = await f.run();
  assert.equal(result.complete, true); assert.equal(result.newLeads, 3); assert.equal(f.scrolls(), 2);
});

test('异步评论响应主动唤醒等待，无需等下一次轮询计时器', { timeout: 1500 }, async () => {
  const f = fixture({ panelState: 'opened', feedbackDelayMs: 1000,
    onOpen: ({ emitResponse }) => setTimeout(() => emitResponse({ body: { status_code: 0, comments: [comment('event-feedback')], has_more: 0, cursor: 0 } }), 15)
  });
  assert.equal((await f.run()).complete, true);
  assert.equal(f.feedbackTimeouts(), 0, 'Decoded target feedback clears the still-pending poll timer');
  assert.equal(f.openings(), 1); assert.equal(f.listener(), null);
});

test('首屏正文尚未渲染只读等待就绪，仍依据后续真实登录状态执行', async () => {
  const f = fixture({ responses: [{ body: { status_code: 0, comments: [], has_more: 0, cursor: 0 } }],
    healthHook: ({ checks, TaskStopError }) => { if (checks <= 2) throw new TaskStopError('账号页面尚未加载完成，请检查网络并保持窗口打开', checks === 1 ? 'LOGIN_PENDING' : 'LOGIN_UNCONFIRMED'); }
  });
  assert.equal((await f.run()).complete, true); assert.equal(f.healthChecks(), 3);
  assert.equal(f.probes(), 0); assert.equal(f.openings(), 0); assert.equal(f.scrolls(), 0);
  assert(f.statuses.some(status => /等待浏览器确认账号状态/.test(status.status || '')));
});

test('视频地址切换同一图文时重试被包装的读取中断，仍采到评论并保存图文地址', async () => {
  const f = fixture({ workType: 'video',
    openResponses: [{ body: { status_code: 0, comments: [comment('note-transition')], has_more: 0, cursor: 0 } }],
    healthHook: ({ checks, TaskStopError }) => {
      if (checks === 2) {
        f.page.url = () => `https://www.douyin.com/note/${f.workId}`;
        throw Object.assign(new TaskStopError('页面正在切换，登录状态尚待重新确认', 'LOGIN_UNCONFIRMED'), { pageTransition: true });
      }
    }
  });
  const result = await f.run();
  assert.equal(result.complete, true); assert.equal(result.work.type, 'note');
  assert.equal(f.sleeps.length, 1); assert.equal(f.openings(), 1);
  assert.equal(f.store.leads[0].videoLink, `https://www.douyin.com/note/${f.workId}`);
  assert.equal(f.store.videos[f.workId].workType, 'note'); assert.equal(f.listener(), null);
});

test('图文切换等待有界且可停止；恢复后目标变化或真实未登录都不打开评论', async () => {
  const stuck = fixture({ healthHook: ({ TaskStopError }) => {
    throw Object.assign(new TaskStopError('页面正在切换', 'LOGIN_UNCONFIRMED'), { pageTransition: true });
  } });
  await assert.rejects(stuck.run(), error => error.code === 'LOGIN_UNCONFIRMED');
  assert.equal(stuck.healthChecks(), 4); assert.equal(stuck.sleeps.length, 3); assert.equal(stuck.openings(), 0);
  const stopped = fixture({ healthHook: ({ TaskStopError }) => {
    throw Object.assign(new TaskStopError('页面正在切换', 'LOGIN_UNCONFIRMED'), { pageTransition: true });
  }, waitHook: ({ abort }) => abort() });
  await assert.rejects(stopped.run(), error => error.code === 'TASK_STOPPED');
  assert.equal(stopped.healthChecks(), 1); assert.equal(stopped.openings(), 0);
  for (const loggedOut of [false, true]) {
    const f = fixture({ healthHook: ({ checks, TaskStopError }) => {
      if (checks === 1) throw Object.assign(new TaskStopError('页面正在切换', 'LOGIN_UNCONFIRMED'), { pageTransition: true });
      if (loggedOut) throw new TaskStopError('请重新登录', 'LOGIN_REQUIRED');
      f.page.url = () => 'https://www.douyin.com/note/7000000000000000999';
    } });
    await assert.rejects(f.run(), error => error.code === (loggedOut ? 'LOGIN_REQUIRED' : 'TARGET_MISMATCH'));
    assert.equal(f.openings(), 0); assert.equal(f.scrolls(), 0); assert.equal(f.listener(), null);
  }
});

test('真实未登录、验证和不确定会话不按首屏加载状态重试', async () => {
  for (const [code, message] of [['LOGIN_REQUIRED', '请扫码登录'], ['PLATFORM_VERIFICATION', '账号页面尚未加载完成，需先通过安全验证'], ['LOGIN_PENDING', '正在等待扫码或手机确认'], ['LOGIN_UNCONFIRMED', '没有可靠的当前账号登录反馈']]) {
    const f = fixture({ healthHook: ({ TaskStopError }) => { throw new TaskStopError(message, code); } });
    await assert.rejects(f.run(), error => error.code === code);
    assert.equal(f.healthChecks(), 1); assert.equal(f.feedbackTimeouts(), 0);
    assert.equal(f.probes(), 0); assert.equal(f.openings(), 0); assert.equal(f.scrolls(), 0); assert.equal(f.listener(), null);
  }
});

test('等待首屏加载可停止，不打开评论也不再尝试登录检查', async () => {
  const f = fixture({ healthHook: ({ TaskStopError }) => { throw new TaskStopError('抖音页面仍在加载，请稍候', 'LOGIN_PENDING'); }, waitHook: ({ abort }) => abort() });
  await assert.rejects(f.run(), error => error.code === 'TASK_STOPPED');
  assert.equal(f.healthChecks(), 1); assert.equal(f.probes(), 0); assert.equal(f.openings(), 0); assert.equal(f.scrolls(), 0); assert.equal(f.listener(), null);
});

test('加载始终未就绪时有界暂停，不能直接沿用历史登录标记', async () => {
  const f = fixture({ healthHook: ({ TaskStopError }) => { throw new TaskStopError('账号页面尚未加载完成，请检查网络并保持窗口打开', 'LOGIN_UNCONFIRMED'); } });
  await assert.rejects(f.run(), error => error.code === 'LOGIN_UNCONFIRMED');
  assert.equal(f.healthChecks(), 40); assert.equal(f.probes(), 0); assert.equal(f.openings(), 0);
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted'); assert.equal(f.listener(), null);
});

test('图文流式详情首读缺失时结束前再补读，保留实际描述', async () => {
  const f = fixture({ pageMetadata: reads => reads === 1 ? { descriptionState: 'missing' } : { desc: '后续渲染的图文正文', descriptionState: 'available', descriptionSource: 'page_json' },
    openResponses: [{ body: { status_code: 0, comments: [], has_more: 0, cursor: 0 } }]
  });
  assert.equal((await f.run()).complete, true); assert.equal(f.metadataReads(), 2);
  assert.equal(f.store.videos[f.workId].desc, '后续渲染的图文正文'); assert.equal(f.store.videos[f.workId].descriptionSource, 'page_json');
});

test('长图文真实标题正文caption完整入作品记录，记录实际页面出处而不含查询参数', async () => {
  const desc = '业务说明与条件：\n' + '完整内容不会因表格显示截断而丢失。'.repeat(4000);
  const f = fixture({ pageMetadata: { desc, workRawText: { desc, itemTitle: '平台实际图文标题', caption: '平台实际补充文字' },
    descriptionState: 'available', descriptionSource: 'page_json', imageCount: 1, awemeType: 68 },
    responses: [{ body: { status_code: 0, comments: [comment('long-note')], has_more: 0, cursor: 0, total: 1 } }] });
  assert.equal((await f.run()).complete, true);
  const info = f.store.videos[f.workId];
  assert.equal(info.workTitle, '平台实际图文标题'); assert.equal(info.workContent, desc);
  assert.equal(info.workRawText.desc, desc); assert.equal(info.workText, '平台实际图文标题\n\n' + desc + '\n\n补充文字：\n平台实际补充文字');
  assert.equal(info.imageCount, 1); assert.equal(info.awemeType, 68);
  assert.equal(info.workSourcePath, '/note/' + f.workId); assert.equal(info.workCapturedAt, '2026-10-08 12:00:00');
  assert.deepEqual(info.workSourcePaths, ['/note/' + f.workId]);
});

test('API正文逐字段优先，页面可补缺失真实标题，晚空API不覆盖页面文字出处', async () => {
  const workId = '7000000000000000123';
  const f = fixture({ pageMetadata: { workRawText: { desc: '页面正文不得覆盖API', itemTitle: '页面补充的真实标题' }, descriptionState: 'available', descriptionSource: 'page_json' },
    responses: [{ kind: 'detail', body: { status_code: 0, aweme_detail: { aweme_id: workId, desc: 'API完整正文' } } },
      { body: { status_code: 0, comments: [], has_more: 0, cursor: 0, total: 0 } }] });
  await f.run();
  const info = f.store.videos[workId];
  assert.equal(info.workTitle, '页面补充的真实标题'); assert.equal(info.workContent, 'API完整正文');
  assert.equal(info.workRawTextSources.desc, 'api'); assert.equal(info.workRawTextSources.itemTitle, 'page_json');
  assert.deepEqual(info.workSourcePaths, ['/aweme/v1/web/aweme/detail/', '/note/' + workId]);
  const late = fixture({ pageMetadata: { workRawText: { desc: '当前页面原文' }, descriptionState: 'available', descriptionSource: 'page_json' },
    pageResponses: [{ kind: 'detail', json: () => new Promise(resolve => setTimeout(() => resolve({ status_code: 0, aweme_detail: { aweme_id: workId, desc: '', statistics: { comment_count: 2 } } }), 10)) }],
    responses: [{ body: { status_code: 0, comments: [], has_more: 0, cursor: 0, total: 0 } }] });
  await late.run();
  assert.equal(late.store.videos[workId].workContent, '当前页面原文');
  assert.equal(late.store.videos[workId].workSourcePath, '/note/' + workId);
});

test('重复评论只补实际cid、评论来源与嵌套用户资料，不访问主页或重写AI和触达业务状态', async () => {
  const workId = '7000000000000000123';
  const existing = { id: 7, accountId: 'fixture-account', uid: 'existing-user', videoLink: 'https://www.douyin.com/note/' + workId, demand: '现有评论',
    status: 'dm_sent', aiScore: 88, aiReason: '历史AI理由', fetchTime: '首次采集', dmSentAt: '首次发送', followedAt: '首次关注' };
  const entry = { ...comment('existing-user', '现有评论'), cid: '7000000000000000789', user: {
    sec_uid: 'existing-user', uid: '7000000000000000765', nickname: '当前响应昵称', signature: '响应中的实际简介', follower_count: 0, following_count: 12, unique_id: '当前抖音号'
  } };
  const f = fixture({ existingLeads: [existing], responses: [{ body: { status_code: 0, comments: [entry], has_more: 0, cursor: 0, total: 1 } }] });
  assert.equal((await f.run()).newLeads, 0); assert.equal(f.store.leads.length, 1);
  const updated = f.store.leads[0];
  for (const key of ['id', 'status', 'aiScore', 'aiReason', 'fetchTime', 'dmSentAt', 'followedAt']) assert.equal(updated[key], existing[key]);
  assert.equal(updated.commentId, entry.cid); assert.equal(updated.commentLevel, 1);
  assert.equal(updated.commentSourcePath, '/aweme/v1/web/comment/list/'); assert.equal(updated.commentCapturedAt, '2026-10-08 12:00:00');
  assert.equal(updated.UID, entry.user.uid); assert.equal(updated.signature, entry.user.signature); assert.equal(updated.followerCount, 0);
  assert.equal(updated.userSourcePath, '/aweme/v1/web/comment/list/'); assert.equal(updated.profileCapturedAt, undefined);
  assert.equal(f.scrolls(), 0); assert.equal(f.openings(), 0);
});

test('评论原始create_time以数字Unix秒保存，显示时间与同条cid对应', async () => {
  const raw = 1760000000;
  const entry = { ...comment('timed-user'), cid: 'timed-comment', create_time: String(raw) };
  const bad = { ...comment('invalid-time-user'), cid: 'untimed-comment', create_time: 'not-a-time' };
  const f = fixture({ responses: [{ body: { status_code: 0, comments: [entry, bad], has_more: 0, cursor: 0 } }] });
  assert.equal((await f.run()).newLeads, 2);
  const lead = f.store.leads.find(row => row.uid === 'timed-user');
  assert.equal(lead.commentId, entry.cid); assert.equal(lead.commentTimestamp, raw);
  assert.equal(typeof lead.commentTimestamp, 'number');
  assert.equal(lead.time, commentEvidence(entry).time);
  const invalid = f.store.leads.find(row => row.uid === 'invalid-time-user');
  assert.equal(invalid.commentId, bad.cid); assert.equal(invalid.time, '');
  assert.equal(Object.hasOwn(invalid, 'commentTimestamp'), false);
});

test('同cid重采保留已有显示时间且只补原始秒，不改首次获取及AI触达记录', async () => {
  const workId = '7000000000000000123', raw = 1760000000;
  const existing = { id: 12, accountId: 'fixture-account', uid: 'same-cid-user', videoLink: `https://www.douyin.com/video/${workId}`,
    commentId: 'same-cid', time: '历史显示时间保留', demand: '同一条评论', fetchTime: '首次获取保留',
    aiNeed: '是', aiDone: true, aiReason: '历史判断保留', aiInputHash: 'old-hash', dmCount: 3, dmState: 'confirmed_success', dmSentAt: '首次私信保留' };
  const entry = { ...comment('same-cid-user', existing.demand), cid: existing.commentId, create_time: raw };
  const f = fixture({ existingLeads: [existing], responses: [{ body: { status_code: 0, comments: [entry], has_more: 0, cursor: 0 } }] });
  assert.equal((await f.run()).newLeads, 0); assert.equal(f.store.leads.length, 1);
  const lead = f.store.leads[0];
  assert.equal(lead.commentTimestamp, raw);
  for (const field of ['id', 'commentId', 'time', 'demand', 'fetchTime', 'aiNeed', 'aiDone', 'aiReason', 'aiInputHash', 'dmCount', 'dmState', 'dmSentAt']) {
    assert.equal(lead[field], existing[field], field);
  }
});

test('同作品同用户同文案但cid变化时同步替换id与两种时间，不增加客户或改历史AI', async () => {
  const workId = '7000000000000000123', oldRaw = 1760000000, newRaw = 1760100000;
  const existing = { id: 19, accountId: 'fixture-account', uid: 'same-text-user', videoLink: `https://www.douyin.com/video/${workId}`,
    demand: '完全相同文案', ...commentEvidence({ cid: 'old-cid', create_time: oldRaw }),
    fetchTime: '首次采集保留', status: 'dm_sent', aiNeed: '是', aiReason: '既有AI理由', aiInputHash: 'keep-old-hash', dmCount: 1, dmSentAt: '历史发送保留' };
  const entry = { ...comment('same-text-user', existing.demand), cid: 'new-cid', create_time: newRaw };
  const f = fixture({ existingLeads: [existing], responses: [{ body: { status_code: 0, comments: [entry], has_more: 0, cursor: 0 } }] });
  assert.equal((await f.run()).newLeads, 0); assert.equal(f.store.leads.length, 1);
  const lead = f.store.leads[0];
  assert.equal(lead.commentId, 'new-cid'); assert.equal(lead.commentTimestamp, newRaw);
  assert.equal(lead.time, commentEvidence(entry).time); assert.notEqual(lead.time, existing.time);
  for (const field of ['id', 'demand', 'fetchTime', 'status', 'aiNeed', 'aiReason', 'aiInputHash', 'dmCount', 'dmSentAt']) {
    assert.equal(lead[field], existing[field], field);
  }
});

test('重采异cid缺合法时间不覆盖旧时间证据，未重采的历史记录不批量补写', async () => {
  const workId = '7000000000000000123';
  const existing = { id: 22, accountId: 'fixture-account', uid: 'guard-time-user', videoLink: `https://www.douyin.com/video/${workId}`,
    demand: '相同文案', ...commentEvidence({ cid: 'old-cid', create_time: 1760000000 }) };
  const untouched = { id: 23, accountId: 'fixture-account', uid: 'untouched-user', videoLink: existing.videoLink, demand: '历史客户保留', time: '旧评论时间', fetchTime: '旧获取时间', dmCount: 2 };
  const entry = { ...comment('guard-time-user', existing.demand), cid: 'invalid-new-cid', create_time: null };
  const f = fixture({ existingLeads: [existing, untouched], responses: [{ body: { status_code: 0, comments: [entry], has_more: 0, cursor: 0 } }] });
  assert.equal((await f.run()).newLeads, 0); assert.equal(f.store.leads.length, 2);
  const lead = f.store.leads.find(row => row.id === existing.id);
  for (const field of ['commentId', 'time', 'commentTimestamp']) assert.equal(lead[field], existing[field], field);
  assert.deepEqual(f.store.leads.find(row => row.id === untouched.id), untouched);
});

test('目标评论has_more=0但写盘失败必须暂停，不得确认完整或发布未写入ID', async () => {
  const f = fixture({ responses: [{ body: { status_code: 0, comments: [comment('unsaved')], has_more: 0, cursor: 10, total: 1 } }],
    beforeSetLeads() { throw new Error('local fixture disk write failed'); } });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_SAVE_FAILED');
  assert.equal(f.store.leads.length, 0); assert.deepEqual(f.capturedIds, []); assert.deepEqual(f.capturedBatches, []);
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted');
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.lastHasMore, 0);
  assert.match(f.store.videos[f.workId].collectionReason, /本地保存失败/);
  assert.equal(f.scrolls(), 0); assert.equal(f.listener(), null);
});

test('后一评论页写盘失败保留已存第一页和实写新增计数，最终状态不能被has_more=0覆写', async () => {
  let writes = 0;
  const f = fixture({ responses: [{ body: { status_code: 0, comments: [comment('saved-page')], has_more: 1, cursor: 10 } }],
    scrollResponses: [{ requestCursor: 10, body: { status_code: 0, comments: [comment('failed-page')], has_more: 0, cursor: 20 } }],
    beforeSetLeads() { if (++writes === 2) throw new Error('local second-page write failed'); } });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_SAVE_FAILED');
  assert.deepEqual(f.store.leads.map(row => row.uid), ['saved-page']); assert.deepEqual(f.capturedIds, ['1']);
  assert.deepEqual(f.capturedBatches[0].counts, { added: 1, supplemented: 0 });
  const info = f.store.videos[f.workId];
  assert.equal(info.collectionState, 'interrupted'); assert.equal(info.collectionCheckpoint.newLeads, 1);
  assert.equal(info.collectionCheckpoint.lastHasMore, 0); assert.equal(f.listener(), null);
});

test('结束清理阶段详情写盘失败同样暂停，已存评论保留且最终不得标完整', async () => {
  const workId = '7000000000000000123'; let rejectedDetails = 0;
  const f = fixture({ responses: [{ body: { status_code: 0, comments: [comment('saved-comment')], has_more: 0, cursor: 10 } }],
    pageResponses: [{ kind: 'detail', json: () => new Promise(resolve => setTimeout(() => resolve({ status_code: 0,
      aweme_detail: { aweme_id: workId, desc: 'local-detail-to-fail' } }), 10)) }],
    beforeSetVideos(videos) {
      if (videos[workId]?.desc === 'local-detail-to-fail') { rejectedDetails++; throw new Error('local detail write failed'); }
    } });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_SAVE_FAILED');
  assert(rejectedDetails > 0); assert.equal(f.store.leads.length, 1); assert.deepEqual(f.capturedIds, ['1']);
  assert.equal(f.store.videos[f.workId].collectionState, 'interrupted'); assert.match(f.store.videos[f.workId].collectionReason, /本地保存失败/);
  assert.equal(f.store.videos[f.workId].collectionCheckpoint.newLeads, 1); assert.equal(f.listener(), null);
});

test('采集回调仅在成功入库后提供原始ID与本页新增/回填计数', async () => {
  const workId = '7000000000000000123';
  const old = { id: 10, accountId: 'fixture-account', uid: 'existing-callback', demand: '原有评论', videoLink: 'https://www.douyin.com/video/' + workId };
  const f = fixture({ existingLeads: [old], responses: [{ body: { status_code: 0,
    comments: [comment('existing-callback', '原有评论'), comment('new-callback')], has_more: 0, cursor: 20, total: 2 } }] });
  const result = await f.run();
  assert.equal(result.newLeads, 1); assert.equal(f.capturedBatches.length, 1);
  assert.deepEqual(f.capturedBatches[0].counts, { added: 1, supplemented: 1 });
  assert.deepEqual(new Set(f.capturedBatches[0].ids), new Set(f.store.leads.map(row => String(row.id))));
  assert.equal(f.store.leads.length, 2); assert.equal(f.store.leads.find(row => row.id === 10).collectionRunId, 'run-fixture');
});

test('仅有缓存作者身份或字符串作者标签时采集也标记作者，AI本次范围排除这些记录', async () => {
  const workId = '7000000000000000123';
  const f = fixture({ existingVideos: { [workId]: { authorSecUid: 'cached-owner' } }, responses: [{ body: { status_code: 0,
    comments: [comment('cached-owner'), { ...comment('labelled-owner'), label_type: '1' }, comment('reader-only')], has_more: 0, cursor: 30, total: 3 } }] });
  assert.equal((await f.run()).complete, true);
  assert.equal(f.store.leads.find(row => row.uid === 'cached-owner').isAuthor, true);
  assert.equal(f.store.leads.find(row => row.uid === 'labelled-owner').isAuthor, true);
  assert.equal(f.store.leads.find(row => row.uid === 'reader-only').isAuthor, false);
  assert.deepEqual(require('../lead-query').filterLeads(f.store.leads, f.store.videos, { collectionRunId: 'run-fixture' }).map(row => row.uid), ['reader-only']);
});

test('已有平台验证异常时最终状态写盘再失败，保留原错误码与原因并附加保存失败', async () => {
  const f = fixture({ healthHook: ({ TaskStopError }) => { throw new TaskStopError('本地模拟平台要求验证', 'PLATFORM_VERIFICATION'); },
    beforeSetVideos(videos) { if (Object.values(videos).some(info => info.collectionCheckpoint)) throw new Error('local final checkpoint write failed'); } });
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'PLATFORM_VERIFICATION'); assert.match(error.message, /本地模拟平台要求验证/);
    assert.match(error.message, /采集状态也未能保存/); assert.doesNotMatch(error.message, /local final checkpoint/); return true;
  });
  assert.equal(f.listener(), null); assert.equal(f.scrolls(), 0); assert.equal(f.openings(), 0);
  assert.notEqual(f.store.videos[f.workId]?.collectionState, 'complete');
});

test('正常分页结束后仅最终状态写盘失败，也须以保存错误暂停并保留已采评论', async () => {
  const f = fixture({ responses: [{ body: { status_code: 0, comments: [comment('persisted-before-finalize')], has_more: 0, cursor: 10 } }],
    beforeSetVideos(videos) { if (Object.values(videos).some(info => info.collectionCheckpoint)) throw new Error('local final checkpoint write failed'); } });
  await assert.rejects(f.run(), error => error.code === 'COLLECTION_SAVE_FAILED' && /采集状态保存失败/.test(error.message));
  assert.equal(f.store.leads.length, 1); assert.equal(f.store.leads[0].uid, 'persisted-before-finalize');
  assert.deepEqual(f.capturedBatches[0].counts, { added: 1, supplemented: 0 });
  assert.notEqual(f.store.videos[f.workId]?.collectionState, 'complete'); assert.equal(f.listener(), null);
});
