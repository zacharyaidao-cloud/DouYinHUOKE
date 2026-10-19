'use strict';
// Actual obfuscated AI task/scheduler modules, in-memory records and provider
// stubs only. No store, browser, installed account or paid request is loaded.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const app = path.resolve(__dirname, '..', 'dy-lead-app-release');
for (const name of ['ai.js', 'engine-ai-tasks.js', 'scheduler.js', 'lead-query.js']) assert.match(fs.readFileSync(path.join(app, name), 'utf8'), /_0x[0-9a-f]+/i);
const AI = require(path.join(app, 'ai.js')), W = require(path.join(app, 'workflow.js'));
const Q = require(path.join(app, 'lead-query.js'));
const { createAiTasks } = require(path.join(app, 'engine-ai-tasks.js'));
const { ActionScheduler } = require(path.join(app, 'scheduler.js'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network forbidden in this fixture'); };
(async () => {
  try {
    const settings = { ai: { enabled: true, apiKey: 'local-stub-only', model: 'deepseek-flash', batchMode: 'auto', requestTimeoutSec: 60 }, human: {} };
    let rows = Array.from({ length: 401 }, (_, i) => ({ id: i+1, accountId: 'isolated-qa', demand: '本地模拟需求', nickname: '模拟用户',
      videoLink: 'https://www.douyin.com/video/7000000000000000001', status: 'dm_sent', dmSentAt: '历史发送时间' }));
    const state = { running: false, stopRequested: false }, cp = {}, logs = [], sizes = [];
    const store = { getSettings: () => settings, getLeads: () => structuredClone(rows), setLeads: value => { rows = value; },
      getVideos: () => ({}), nowStr: () => '2026-10-11 00:00:00', log: (_id, line) => logs.push(line) };
    AI.listModels = async (_settings, options) => {
      await options.authorize(); options.onRequest?.({kind:'models',method:'GET'});
      return { models: [{ id:'deepseek-flash',contextWindow:1048576,maxOutputTokens:393216 }] };
    };
    AI.judgeBatch = async (config, batch, videos, options) => {
      await options.authorize(); options.onRequest?.({kind:'completion',method:'POST'}); sizes.push(batch.length);
      if (sizes.length<=3) throw Object.assign(new Error('simulated_timeout'), { code:'AI_TIMEOUT' });
      return Object.fromEntries(batch.map((row,index) => [index+1,{need:'否',reason:'模拟结果',promptVersion:AI.getRuleSet(config).version,
        inputHash:W.aiInputHash(row,videos),baselineHash:AI.baselineHash(row)}]));
    };
    let now = 0;
    const tasks = createAiTasks({ store, taskState:state, setTask:patch=>Object.assign(state,patch), failTask:error=>({ok:false,error}),
      checkpoint:patch=>Object.assign(cp,patch), getSignal:()=>undefined,
      makeScheduler:config=>new ActionScheduler({settings:config,stopped:()=>state.stopRequested,now:()=>now,sleep:async ms=>{now+=ms;},authorize:async()=>true}) });
    const result = await tasks.aiTask({filters:{f:'all'}});
    assert.equal(result.ok,true); assert.equal(result.okCount,401); assert.equal(cp.state,'completed');
    assert.deepEqual(sizes,[401,401,401,200,200,1]); assert.equal(result.providerRetryCount,0); assert.equal(result.splitRetryCount,3);
    const events=logs.map(line=>JSON.parse(line.slice('AI_AUDIT '.length)));
    assert.deepEqual(events.filter(row=>row.event==='budget_recovery').map(row=>row.strategy),['50%','30%','200条兜底']);
    assert.equal(cp.processedLeadIds.length,401); assert.equal(new Set(cp.processedLeadIds).size,401);
    assert(rows.every(row=>row.aiDone&&row.status==='dm_sent'&&row.dmSentAt==='历史发送时间'));
    AI.judgeBatch = async () => { throw Object.assign(new Error('private-error-not-for-logs'), {status:402,code:'AI_PROVIDER_HTTP'}); };
    const denied = await tasks.aiTask({filters:{f:'all'},force:true});
    assert.equal(denied.ok,false); assert.match(denied.error,/余额不足.*HTTP 402/); assert.equal(denied.providerRetryCount,0);
    assert(!logs.join('\n').includes('private-error-not-for-logs'));
    rows = [{id:1,isAuthor:true,demand:'作者留言',aiDone:true,aiNeed:'是',dmSentAt:'历史发送时间'},
      {id:2,demand:'   '}, {id:3,demand:'作者留言',uid:'author',videoLink:'https://www.douyin.com/note/7000000000000000002'},
      {id:4,demand:'读者留言'}];
    store.getVideos=()=>({'7000000000000000002':{authorSecUid:'author'}});
    const classification={settings};
    assert.deepEqual(Q.aiFacetCounts(rows,store.getVideos(),{f:'all'},classification),
      {all:4,ai_todo:1,ai_yes:0,ai_no:0,ai_stale:0,ai_excluded:3});
    assert.deepEqual(Q.filterLeads(rows,store.getVideos(),{f:'ai_todo'},classification).map(row=>row.id),[4]);
    assert.deepEqual(Q.filterLeads(rows,store.getVideos(),{f:'ai_excluded'},classification).map(row=>row.id),[1,2,3]);
    const excludedBefore=structuredClone(rows), sizesBefore=sizes.length;
    const excluded=await tasks.aiTask({filters:{f:'ai_excluded'},force:true});
    assert.equal(excluded.ok,false); assert.match(excluded.error,/不参与 AI 判断/);
    assert.deepEqual(rows,excludedBefore); assert.equal(sizes.length,sizesBefore);
    const report = {ok:true,version:require(path.join(app,'resources/app/package.json')).version,actualObfuscatedModules:true,
      liveProviderRequests:0,productionDataRead:false,automaticStrategies:AI.AUTOMATIC_BATCH_STRATEGIES,timeoutRequestSizes:sizes,processed:401,
      laterPlannedBatchesCompleted:true,contactHistoryPreserved:true,balanceFailureNotRetried:true,
      excludedAuthorsAndEmptyCount:3,excludedNeverSentToProvider:true,excludedHistoricalResultPreserved:true};
    fs.writeFileSync(path.join(__dirname,'ai-release-verification.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
  } finally { globalThis.fetch = originalFetch; }
})().catch(error => { console.error(error.stack||error.message); process.exitCode=1; });
