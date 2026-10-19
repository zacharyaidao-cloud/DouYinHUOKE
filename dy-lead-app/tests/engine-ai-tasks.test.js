const { test } = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai');
const W = require('../workflow');
const { createAiTasks } = require('../engine-ai-tasks');
const { ActionScheduler, TaskStopError } = require('../scheduler');

function fixture({ count = 4, authorized = true, videoDesc = '' } = {}, t) {
  const settings = { ai: { enabled: true, apiKey: 'mock-key-never-sent', prompt: '规则', batchMode:'manual', batchMaxChars: 20000, batchMaxCount: 20, intervalSec: 5 }, human: { workPeriods: [], breakEvery: 0, maxConsecutiveErrors: 3 } };
  if(t)t.mock.method(AI,'listModels',async(config,options)=>{await options.authorize();options.onRequest?.({kind:'models',method:'GET'});return {models:[{id:'deepseek-flash',contextWindow:1048576,maxOutputTokens:393216}],source:'https://api.deepseek.com/models'};});
  let leads = Array.from({ length: count }, (_, i) => ({ id: i + 1, accountId: '1', nickname: '匿名', demand: '服务需求', videoLink: 'https://www.douyin.com/video/123' }));
  const videos = { 123: { desc: videoDesc } }, state = { running: false, stopRequested: false }, savedCheckpoint = {};
  let time = 0, scheduler;const logs=[];
  const store = { getSettings: () => settings, getLeads: () => structuredClone(leads), getVideos: () => videos, setLeads: rows => { leads = rows; }, nowStr: () => '2026-10-08 10:00:00', log:(id,line)=>logs.push({id,line}) };
  const tasks = createAiTasks({ store, taskState: state, setTask: p => Object.assign(state, p), failTask: error => ({ ok: false, error }), checkpoint: p => Object.assign(savedCheckpoint, p), getSignal: () => undefined,
    makeScheduler: s => { scheduler = new ActionScheduler({ settings: s, stopped: () => state.stopRequested, now: () => time, sleep: async ms => { time += ms; }, authorize: async () => { if (!authorized) throw new TaskStopError('mock revoked', 'AUTH_REQUIRED'); } }); return scheduler; }
  });
  return { tasks, settings, store, logs, state,time:()=>time,scheduler: () => scheduler, checkpoint: savedCheckpoint, revoke:()=>{authorized=false;} };
}
test('批量格式无效按顺序二分缩批累计异常，连续第三次立即暂停', async t => {
  const f = fixture({},t); let batchCalls = 0, singleCalls = 0;
  t.mock.method(AI, 'judgeBatch', async () => { batchCalls++; return null; });
  t.mock.method(AI, 'judgeOne', async () => { singleCalls++; throw new Error('mock malformed single reply'); });
  const r = await f.tasks.aiTask({ filters: { f: 'all' } });
  assert.equal(r.ok, false); assert.match(r.error, /连续 3/);
  assert.equal(batchCalls, 3); assert.equal(singleCalls, 0);
  assert.equal(f.scheduler().aiConsecutiveErrors, 3); assert.equal(f.scheduler().consecutiveErrors,0);assert.equal(f.scheduler().actions,0);assert.equal(f.checkpoint.state, 'paused');
  assert.ok(f.store.getLeads().every(l => !l.aiDone));
});
test('授权失效立即暂停，既不请求批量也不执行逐条兜底', async t => {
  const f = fixture({ authorized: false },t); let calls = 0;
  t.mock.method(AI, 'judgeBatch', async () => { calls++; return null; });
  t.mock.method(AI, 'judgeOne', async () => { calls++; throw new Error('Must not call'); });
  const r = await f.tasks.aiTask();
  assert.equal(r.ok, false); assert.match(r.error, /mock revoked/); assert.equal(calls, 0); assert.equal(f.checkpoint.state, 'paused');
});

test('同一批AI的模型发现与判断均接入调度授权，发现后停用直接暂停且不逐条兜底',async t=>{
  const f=fixture({},t);let batches=0,singles=0;
  t.mock.method(AI,'judgeBatch',async(settings,rows,videos,options)=>{batches++;assert.equal(typeof options.authorize,'function');await options.authorize();f.revoke();await options.authorize();throw new Error('不得执行到此');});
  t.mock.method(AI,'judgeOne',async()=>{singles++;throw new Error('不得进行兜底');});
  const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.match(result.error,/mock revoked/);assert.equal(batches,1);assert.equal(singles,0);assert.equal(f.checkpoint.state,'paused');
});
test('手动超预算长单条明确拒绝，不强制发单条请求或重复兜底', async t => {
  const f = fixture({ count: 2, videoDesc: 'x'.repeat(4000) },t), sizes = [];
  f.settings.ai.batchMaxChars=3000;
  t.mock.method(AI, 'judgeBatch', async (settings, batch, videos) => {
    sizes.push(batch.length); const result = {};
    batch.forEach((l, i) => { result[i + 1] = { need: '否', reason: 'mock result', promptVersion: AI.getRuleSet(settings).version, inputHash: W.aiInputHash(l, videos), baselineHash: AI.baselineHash(l) }; });
    return result;
  });
  const r = await f.tasks.aiTask();
  assert.equal(r.ok, true); assert.equal(r.partial,true);assert.deepEqual(sizes, []); assert.equal(r.oversizeCount, 2); assert.equal(r.okCount,0);assert.equal(r.failCount,2);
  assert.equal(r.fallbackCount,0);assert.equal(f.checkpoint.state,'completed_with_errors');assert.ok(f.logs.some(x=>x.line.includes('budget_rejected')));
});

const repliesFor=(config,rows,videos)=>Object.fromEntries(rows.map((row,i)=>[i+1,{need:row.id%2?'是':'否',reason:row.id%2?'需求未明，业务相关':'明确业务无关',promptVersion:AI.getRuleSet(config).version,inputHash:W.aiInputHash(row,videos),baselineHash:AI.baselineHash(row)}]));

test('自动任务先发现实时模型容量，107条不因历史20/100上限提前拆，记录真实usage',async t=>{
  const f=fixture({count:107,videoDesc:'共享作品'.repeat(200)},t);f.settings.ai.batchMode='auto';f.settings.ai.batchMaxCount=1;f.settings.ai.batchMaxChars=100;
  let discoveries=0;const sizes=[];
  t.mock.method(AI,'listModels',async(settings,options)=>{discoveries++;assert.equal(options.forceRefresh,true);await options.authorize();return {models:[{id:'deepseek-flash',contextWindow:1048576,maxOutputTokens:393216}],source:'https://api.deepseek.com/models',fetchedAt:'mock-time'};});
  t.mock.method(AI,'judgeBatch',async(config,rows,videos,options)=>{await options.authorize();sizes.push(rows.length);options.onUsage({usage:{prompt_tokens:2345,completion_tokens:123,total_tokens:2468},inputTokensEstimate:3000,outputTokensReserved:21656,model:'deepseek-flash'});return repliesFor(config,rows,videos);});
  const result=await f.tasks.aiTask();assert.equal(result.ok,true);assert.equal(discoveries,1);assert.deepEqual(sizes,[107]);assert.equal(result.okCount,107);assert.equal(result.fallbackCount,0);
  const events=f.logs.map(x=>JSON.parse(x.line.slice('AI_AUDIT '.length)));assert.equal(events.find(x=>x.event==='model_capacity').sourceKind,'live');assert.ok(events.some(x=>x.event==='usage'&&x.usage.prompt_tokens===2345));
  assert.ok(!f.logs.map(x=>x.line).join('\n').includes('mock-key-never-sent'));
});

test('长度截断优先顺序二分4→2→2，成功叶立即保存，不退化成整批逐条',async t=>{
  const f=fixture({},t),sizes=[];
  t.mock.method(AI,'judgeBatch',async(config,rows,videos)=>{sizes.push(rows.length);if(rows.length===4){const error=new Error('截断');error.code='AI_OUTPUT_LENGTH';throw error;}return repliesFor(config,rows,videos);});
  const result=await f.tasks.aiTask();assert.equal(result.ok,true);assert.deepEqual(sizes,[4,2,2]);assert.equal(result.okCount,4);assert.equal(result.splitRetryCount,1);assert.equal(result.fallbackCount,0);assert.equal(f.store.getLeads().every(x=>x.aiDone&&x.aiScore===null),true);
  assert.ok(f.logs.some(x=>x.line.includes('模型输出被长度限制截断')));assert.ok(f.logs.some(x=>x.line.includes('"event":"retry_split"')));
});

test('缩批左半成功后右半授权停用，已经完成的有效结果保留且剩余未判',async t=>{
  const f=fixture({},t);let calls=0;
  t.mock.method(AI,'judgeBatch',async(config,rows,videos,options)=>{calls++;if(calls===1)return null;if(calls===2)return repliesFor(config,rows,videos);f.revoke();await options.authorize();throw new Error('不可到达');});
  const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.equal(result.okCount,2);assert.equal(f.store.getLeads().filter(x=>x.aiDone).length,2);assert.equal(f.checkpoint.state,'paused');
});

test('单条无效回执只发一次且不变成是，审计明确失败而非成功',async t=>{
  const f=fixture({count:1},t);let calls=0;t.mock.method(AI,'judgeBatch',async()=>{calls++;return null;});
  const result=await f.tasks.aiTask();assert.equal(calls,1);assert.equal(result.okCount,0);assert.equal(result.failCount,1);assert.equal(f.store.getLeads()[0].aiDone,undefined);assert.equal(f.store.getLeads()[0].aiNeed,undefined);
  assert.ok(f.logs.some(x=>x.line.includes('"outcome":"failed"')));
});

test('自动介绍超限或未知容量在预检明确失败，不调用判断且线索保留未判',async t=>{
  for(const mode of ['too-small','unknown']) {
    const f=fixture({},t);f.settings.ai.batchMode='auto';if(mode==='unknown')f.settings.ai.model='mock-unknown';let chats=0;
    t.mock.method(AI,'listModels',async()=>({models:[mode==='unknown'?{id:'mock-unknown',contextWindow:10000}:{id:'deepseek-flash',contextWindow:100,maxOutputTokens:100}],source:'https://api.deepseek.com/models'}));
    t.mock.method(AI,'judgeBatch',async()=>{chats++;throw new Error('不得判断');});
    const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.equal(chats,0);assert.ok(f.store.getLeads().every(x=>!x.aiDone));assert.match(result.error,mode==='unknown'?/完整上下文容量/:/介绍与判断要求/);
  }
});

test('手动单条显示完整预算和介绍基准，清除上次usage并记录本次真实usage',async t=>{
  const f=fixture({count:1},t);f.state.aiUsage={usage:{prompt_tokens:999999}};f.state.aiBudget={stale:true};
  t.mock.method(AI,'listModels',async(settings,options)=>{assert.equal(f.state.aiUsage,null);await options.authorize();return {models:[{id:'deepseek-flash',contextWindow:1048576,maxOutputTokens:393216}],source:'https://api.deepseek.com/models'};});
  t.mock.method(AI,'judgeOne',async(config,row,videos,options)=>{await options.authorize();options.onUsage({usage:{prompt_tokens:1000,completion_tokens:30,total_tokens:1030},inputTokensEstimate:2000,outputTokensReserved:456,model:'deepseek-flash'});return repliesFor(config,[row],videos)[1];});
  const result=await f.tasks.aiJudgeOne(1);assert.equal(result.ok,true);assert.equal(f.state.aiBudget.withinBudget,true);assert.equal(f.state.aiBudget.outputTokensReserved,456);assert.ok(f.state.aiBaseBudget.inputTokensEstimate>0);assert.equal(f.state.aiUsage.usage.prompt_tokens,1000);assert.ok(f.logs.some(x=>x.line.includes('"event":"usage"')));
});

test('单条请求构造异常释放任务槽且不访问接口',async t=>{
  const f=fixture({count:1},t);let models=0;
  t.mock.method(AI,'listModels',async()=>{models++;assert.fail('invalid payload must not discover models');});
  t.mock.method(AI,'buildJudgeRequest',()=>{throw new Error('待判断线索无效');});
  const result=await f.tasks.aiJudgeOne(1);assert.equal(result.ok,false);assert.equal(f.state.running,false);assert.equal(models,0);assert.match(f.state.status,/待判断线索/);
});

test('手动单条仍保留90%预算，不受自动75%初始预算误拦',async t=>{
  const f=fixture({count:1},t),row=f.store.getLeads()[0];
  const needed=AI.estimateRequestBudget(AI.buildJudgeRequest(f.settings,[row],f.store.getVideos()).messages,1,{contextWindow:1048576,maxOutputTokens:393216});
  const capacity={id:'deepseek-flash',contextWindow:Math.ceil(needed.totalTokensEstimate/.9),maxOutputTokens:393216};
  let calls=0;t.mock.method(AI,'listModels',async()=>({models:[capacity]}));
  t.mock.method(AI,'judgeOne',async(config,item,videos)=>{calls++;return repliesFor(config,[item],videos)[1];});
  const result=await f.tasks.aiJudgeOne(1);assert.equal(result.ok,true);assert.equal(calls,1);
  assert.equal(f.state.aiBudget.targetRatio,.9);assert.equal(f.state.aiBaseBudget.targetRatio,.9);
});

test('固定范围去重重复选择，新增线索不混入，全部范围不由关键词限制',async t=>{
  const f=fixture({count:3},t),targets=[];
  const initial=f.store.getLeads();initial[0].trigger='';initial[0].intent=false;initial[1].trigger='处理';initial[1].intent=true;f.store.setLeads(initial);
  t.mock.method(AI,'judgeBatch',async(config,rows,videos)=>{
    targets.push(rows.map(r=>r.id));const live=f.store.getLeads();live.push({id:99,accountId:'1',demand:'新线索'});f.store.setLeads(live);
    return repliesFor(config,rows,videos);
  });
  const result=await f.tasks.aiTask({filters:{f:'all'},leadIds:[1,'1',2,2]});
  assert.equal(result.okCount,2);assert.deepEqual(targets,[[1,2]]);assert.deepEqual(f.checkpoint.leadIds,['1','2']);assert.equal(f.store.getLeads().find(r=>r.id===99).aiDone,undefined);
});

test('严格有效结果才幂等跳过，非法need或空理由仍判断，force显式重判',async t=>{
  const f=fixture({count:3},t),rows=f.store.getLeads(),version=AI.getRuleSet(f.settings).version;
  rows.forEach(row=>Object.assign(row,{aiDone:true,aiNeed:'是',aiReason:'有效结果',aiPromptVersion:version,aiInputHash:W.aiInputHash(row,f.store.getVideos())}));
  rows[1].aiNeed='待确认';rows[2].aiReason='';f.store.setLeads(rows);
  const requests=[];t.mock.method(AI,'judgeBatch',async(config,items,videos)=>{requests.push(items.map(r=>r.id));return repliesFor(config,items,videos);});
  assert.equal((await f.tasks.aiTask()).okCount,2);assert.deepEqual(requests,[[2,3]]);
  assert.equal((await f.tasks.aiTask()).ok,false);assert.equal(requests.length,1);
  assert.equal((await f.tasks.aiTask({force:true})).okCount,3);assert.deepEqual(requests[1],[1,2,3]);
  assert.equal((await f.tasks.aiTask({force:'true'})).ok,false);
});

test('关键词范围仅取命中者，作者和空白评论不参加判断',async t=>{
  const f=fixture({count:4},t),rows=f.store.getLeads();rows[0].trigger='';rows[1].trigger='处理';rows[2].trigger='处理';rows[2].isAuthor=true;rows[3].trigger='处理';rows[3].demand='  ';f.store.setLeads(rows);
  let selected;t.mock.method(AI,'judgeBatch',async(config,items,videos)=>{selected=items.map(r=>r.id);return repliesFor(config,items,videos);});
  const result=await f.tasks.aiTask({filters:{f:'trigger'}});assert.equal(result.okCount,1);assert.deepEqual(selected,[2]);assert.equal(f.state.total,1);
});

test('缓存作者与显式作者均不进入AI固定名单，分类与任务口径相同',async t=>{
  const f=fixture({count:3},t),rows=f.store.getLeads();
  rows[0].uid='cached-author';rows[1].isAuthor=true;f.store.setLeads(rows);f.store.getVideos()[123].authorSecUid='cached-author';
  const requested=[];t.mock.method(AI,'judgeBatch',async(config,items,videos)=>{requested.push(...items.map(row=>row.id));return repliesFor(config,items,videos);});
  const result=await f.tasks.aiTask({force:true});assert.equal(result.okCount,1);assert.deepEqual(requested,[3]);
  assert.deepEqual(f.checkpoint.leadIds,['3']);assert.equal(f.store.getLeads()[0].aiDone,undefined);
});

test('仅作者或空评论的范围明确不参与，强制重判也不调用模型或伪造否',async t=>{
  const f=fixture({count:2},t),rows=f.store.getLeads();rows[0].isAuthor=true;rows[1].demand=' ';f.store.setLeads(rows);
  let requests=0;t.mock.method(AI,'listModels',async()=>{requests++;assert.fail('不得发现模型');});
  const result=await f.tasks.aiTask({force:true});assert.equal(result.ok,false);assert.match(result.error,/均不参与 AI 判断/);
  assert.equal(requests,0);assert(f.store.getLeads().every(row=>row.aiDone===undefined&&row.aiNeed===undefined));
});

test('AI任务沿用当前规则的新分类与评论时间和触达筛选，只冻结匹配线索',async t=>{
  const f=fixture({count:4},t),rows=f.store.getLeads(),now=Date.now(),version=AI.getRuleSet(f.settings).version;
  rows.forEach(row=>{row.time=new Date(now-3600000).toISOString();Object.assign(row,{aiDone:true,aiNeed:'是',aiReason:'有效需求依据',aiPromptVersion:version});});
  rows[1].time=new Date(now-4*86400000).toISOString();rows[2].dmState='pending_verification';rows[3].aiPromptVersion='old';
  rows.forEach(row=>{row.aiInputHash=W.aiInputHash(row,f.store.getVideos());});f.store.setLeads(rows);
  const batches=[];t.mock.method(AI,'judgeBatch',async(config,items,videos)=>{batches.push(items.map(row=>row.id));return repliesFor(config,items,videos);});
  const current=await f.tasks.aiTask({filters:{f:'ai_yes',commentDays:1,contact:'new'},force:true});
  assert.equal(current.ok,true);assert.equal(current.okCount,1);assert.deepEqual(batches,[[1]]);assert.deepEqual(f.checkpoint.leadIds,['1']);
  const stale=await f.tasks.aiTask({filters:{f:'ai_stale',commentDays:1,contact:'new'}});
  assert.equal(stale.ok,true);assert.equal(stale.okCount,1);assert.deepEqual(batches,[[1],[4]]);assert.deepEqual(f.checkpoint.leadIds,['4']);
});

test('接口配置中途变更不提交旧结果，不继续下批，原API Key不写日志',async t=>{
  for(const field of ['apiKey','enabled','model','batchMaxCount']) {
    const f=fixture({count:2},t);let requests=0;
    t.mock.method(AI,'judgeBatch',async(config,items,videos)=>{requests++;assert.notEqual(config,f.settings);f.settings.ai[field]=field==='enabled'?false:field==='batchMaxCount'?1:'changed-secret-value';return repliesFor(config,items,videos);});
    const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.match(result.error,/设置已变化/);assert.equal(requests,1);assert.equal(f.state.running,false);assert.ok(f.store.getLeads().every(r=>!r.aiDone));
    assert.ok(!f.logs.map(x=>x.line).join('\n').includes('changed-secret-value'));assert.ok(!f.logs.map(x=>x.line).join('\n').includes('mock-key-never-sent'));
  }
});

test('同批独立检查资料和新AI结果，安全合并不覆盖触达字段',async t=>{
  const f=fixture({count:3},t);let commits=0;const persist=f.store.setLeads;
  t.mock.method(f.store,'setLeads',rows=>{commits++;persist(rows);});
  t.mock.method(AI,'judgeBatch',async(config,items,videos)=>{
    const live=f.store.getLeads();live[0].demand='采集又补充的新资料';
    Object.assign(live[1],{aiDone:true,aiNeed:'否',aiReason:'新的有效结果',aiPromptVersion:AI.getRuleSet(config).version,aiInputHash:W.aiInputHash(live[1],videos),aiJudgedAt:'new-result'});
    live[2].followedAt='new-follow';live[2].dmCount=7;live[2].doNotContact=true;f.store.setLeads(live);
    return repliesFor(config,items,videos);
  });
  const result=await f.tasks.aiTask(),saved=f.store.getLeads();assert.equal(result.okCount,1);assert.equal(result.skipped,2);assert.equal(f.state.done,3);assert.equal(commits,2);
  assert.equal(saved[0].aiDone,undefined);assert.equal(saved[1].aiReason,'新的有效结果');assert.equal(saved[1].aiJudgedAt,'new-result');assert.equal(saved[2].followedAt,'new-follow');assert.equal(saved[2].dmCount,7);assert.equal(saved[2].doNotContact,true);
});

test('后续目标被删除或作品更新明示跳过，固定总数完成不静默缩水',async t=>{
  const f=fixture({count:4},t);f.settings.ai.batchMaxCount=2;let requests=0;
  t.mock.method(AI,'judgeBatch',async(config,items,videos)=>{requests++;const replies=repliesFor(config,items,videos);if(requests===1){f.store.setLeads(f.store.getLeads().filter(r=>r.id!==3));f.store.getVideos()['123'].desc='更新作品';}return replies;});
  const result=await f.tasks.aiTask();assert.equal(requests,1);assert.equal(result.skipped,4);assert.equal(result.okCount,0);assert.equal(f.state.done,4);assert.equal(f.state.total,4);assert.equal(f.checkpoint.processedLeadIds.length,4);
  assert.ok(f.logs.some(x=>x.line.includes('线索已删除')));assert.ok(f.logs.some(x=>x.line.includes('作品资料已变化')));
});

test('停止在32条提交块之间生效，已经提交的结果保留，剩余未判',async t=>{
  const f=fixture({count:65},t);f.settings.ai.batchMaxCount=100;
  const persist=f.store.setLeads;let writes=0;
  t.mock.method(f.store,'setLeads',rows=>{persist(rows);writes++;if(writes===1)f.state.stopRequested=true;});
  t.mock.method(AI,'judgeBatch',async(config,items,videos)=>repliesFor(config,items,videos));
  const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.equal(result.okCount,32);assert.equal(f.store.getLeads().filter(r=>r.aiDone).length,32);assert.equal(writes,1);assert.equal(f.state.done,32);assert.equal(f.state.running,false);assert.equal(f.checkpoint.state,'paused');
});

test('401和403直接暂停不拆批，日志仅记录安全状态码',async t=>{
  for(const status of [401,403]) {
    const f=fixture({},t);let calls=0;
    t.mock.method(AI,'judgeBatch',async(config,rows,videos,options)=>{calls++;options.onRequest({kind:'completion',method:'POST',model:'deepseek-flash'});throw Object.assign(new Error('raw sensitive mock-key-never-sent'),{code:'AI_PROVIDER_HTTP',status});});
    const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.equal(calls,1);assert.equal(result.completionRequestCount,1);assert.equal(result.splitRetryCount,0);assert.equal(result.providerRetryCount,0);assert.match(result.error,new RegExp('HTTP '+status));assert.equal(f.checkpoint.state,'paused');assert.ok(!f.logs.map(x=>x.line).join('\n').includes('mock-key-never-sent'));
  }
});

test('429同批有界退避重试，真实POST计数准确，成功请求无浏览器间隔',async t=>{
  const f=fixture({},t);f.settings.ai.intervalSec=86400;Object.assign(f.settings.human,{workPeriods:[{start:'23:00',end:'23:01'}],breakEvery:1,breakMinSec:999,breakMaxSec:999});let calls=0;
  t.mock.method(AI,'judgeBatch',async(config,rows,videos,options)=>{await options.authorize();options.onRequest({kind:'completion',method:'POST',model:'deepseek-flash'});calls++;if(calls===1)throw Object.assign(new Error('429'),{code:'AI_PROVIDER_HTTP',status:429});return repliesFor(config,rows,videos);});
  const result=await f.tasks.aiTask();assert.equal(result.ok,true);assert.equal(calls,2);assert.equal(result.providerRetryCount,1);assert.equal(result.completionRequestCount,2);assert.equal(result.modelRequestCount,1);assert.equal(result.splitRetryCount,0);assert.equal(f.time(),1000);assert.equal(f.scheduler().actions,0);assert.equal(f.scheduler().consecutiveErrors,0);assert.equal(f.scheduler().aiConsecutiveErrors,0);
  assert.ok(f.logs.some(x=>x.line.includes('"event":"provider_retry"')));assert.equal(f.logs.filter(x=>x.line.includes('"event":"request_sent"')&&x.line.includes('"kind":"completion"')).length,2);
});

test('持续网络异常最多三次请求，两次退避且不二分缩批',async t=>{
  const f=fixture({},t);let calls=0;t.mock.method(AI,'judgeBatch',async()=>{calls++;throw Object.assign(new Error('network'),{code:'AI_NETWORK_ERROR'});});
  const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.equal(calls,3);assert.equal(result.providerRetryCount,2);assert.equal(result.splitRetryCount,0);assert.equal(f.time(),3000);assert.ok(f.store.getLeads().every(r=>!r.aiDone));assert.match(result.error,/AI 连续 3/);
});

test('三档失败后确实进入200条兜底，成功保存后继续全部剩余任务并保留触达记录',async t=>{
  const f=fixture({count:401},t);Object.assign(f.settings.ai,{batchMode:'auto',requestTimeoutSec:60});
  f.store.setLeads(f.store.getLeads().map(row=>({...row,status:'dm_sent',dmSentAt:'原私信时间'})));
  const sizes=[],ratios=[];
  t.mock.method(AI,'judgeBatch',async(config,rows,videos,options)=>{
    await options.authorize();options.onRequest({kind:'completion',method:'POST'});sizes.push(rows.length);ratios.push(options.targetRatio);
    if(sizes.length<=3) {assert(f.store.getLeads().every(row=>!row.aiDone));throw Object.assign(new Error('timeout'),{code:'AI_TIMEOUT'});}
    return repliesFor(config,rows,videos);
  });
  const result=await f.tasks.aiTask();
  assert.equal(result.ok,true);assert.equal(result.okCount,401);assert.equal(result.batchCount,3);
  assert.deepEqual(sizes,[401,401,401,200,200,1]);assert.equal(result.completionRequestCount,6);
  assert.deepEqual(ratios,[.75,.5,.3,.75,.75,.75]);
  assert.equal(result.providerRetryCount,0);assert.equal(result.splitRetryCount,3);assert.equal(f.time(),0);
  assert.equal(f.checkpoint.processedLeadIds.length,401);assert.equal(new Set(f.checkpoint.processedLeadIds).size,401);
  assert(f.store.getLeads().every(row=>row.aiDone&&row.status==='dm_sent'&&row.dmSentAt==='原私信时间'));
  assert(f.logs.some(row=>row.line.includes('"event":"budget_recovery"')&&row.line.includes('"strategy":"200条兜底"')));
});

test('真实完整字段预算降低时缩小批次，重规划剩余全名单且已成功的首批不再发送',async t=>{
  const f=fixture({count:1000},t);Object.assign(f.settings.ai,{batchMode:'auto',requestTimeoutSec:60});
  f.store.setLeads(f.store.getLeads().map(row=>({...row,demand:'完整评论'.repeat(200)})));
  const sizes=[],ratios=[],committed=new Set();
  t.mock.method(AI,'judgeBatch',async(config,rows,videos,options)=>{
    sizes.push(rows.length);ratios.push(options.targetRatio);assert(rows.every(row=>!committed.has(row.id)));
    if([2,3,4].includes(sizes.length))throw Object.assign(new Error('timeout'),{code:'AI_TIMEOUT'});
    rows.forEach(row=>committed.add(row.id));return repliesFor(config,rows,videos);
  });
  const result=await f.tasks.aiTask();
  assert.equal(result.ok,true);assert.equal(result.okCount,1000);assert.equal(committed.size,1000);
  assert.deepEqual(ratios.slice(0,5),[.75,.75,.5,.3,.75]);assert(sizes[1]>sizes[2]&&sizes[2]>sizes[3]);
  assert(sizes.slice(4).every(size=>size<=200));assert.equal(result.providerRetryCount,0);
  assert.equal(new Set(f.checkpoint.processedLeadIds).size,1000);
});

test('200条兜底仍失败则暂停，三次保护不会提前挡住兜底且不虚报已判断',async t=>{
  const f=fixture({count:200},t);f.settings.ai.batchMode='auto';const sizes=[];
  t.mock.method(AI,'judgeBatch',async(config,rows)=>{sizes.push(rows.length);throw Object.assign(new Error('timeout'),{code:'AI_TIMEOUT'});});
  const result=await f.tasks.aiTask();
  assert.equal(result.ok,false);assert.deepEqual(sizes,[200,200,200,200]);assert.equal(result.okCount,0);
  assert.match(result.error,/连续 4/);assert.match(result.error,/最近原因：AI 请求超时/);
  assert(f.store.getLeads().every(row=>!row.aiDone));assert.equal(f.checkpoint.state,'paused');
});

test('低预算放不下完整介绍时直接转200条档，不截字段、不把未判标成失败',async t=>{
  const f=fixture({count:401},t);f.settings.ai.batchMode='auto';const sizes=[],ratios=[];
  t.mock.method(AI,'listModels',async()=>({models:[{id:'deepseek-flash',contextWindow:20000,maxOutputTokens:20000}]}));
  t.mock.method(AI,'judgeBatch',async(config,rows,videos,options)=>{
    sizes.push(rows.length);ratios.push(options.targetRatio);
    if(sizes.length<=2)throw Object.assign(new Error('timeout'),{code:'AI_TIMEOUT'});
    assert(rows.every(row=>row.demand==='服务需求'));return repliesFor(config,rows,videos);
  });
  const result=await f.tasks.aiTask();assert.equal(result.ok,true);assert.equal(result.okCount,401);assert.equal(result.failCount,0);
  assert(ratios.every(r=>r===.75||r===.5));assert(f.logs.some(row=>row.line.includes('budget_strategy_skipped')));
});

test('单条超时保留有界重试，HTTP402立即给出余额原因且不缩批重试',async t=>{
  for(const count of [1,4]) {
    const f=fixture({count},t);let calls=0;
    t.mock.method(AI,'judgeBatch',async()=>{calls++;throw Object.assign(new Error('private-provider-content'),count===1?{code:'AI_TIMEOUT'}:{code:'AI_PROVIDER_HTTP',status:402});});
    const result=await f.tasks.aiTask();assert.equal(result.ok,false);
    assert.equal(calls,count===1?3:1);assert.equal(result.providerRetryCount,count===1?2:0);
    assert.equal(result.splitRetryCount,0);assert.match(result.error,count===1?/AI 请求超时/:/余额不足.*HTTP 402/);
    assert(!f.logs.map(row=>row.line).join('\n').includes('private-provider-content'));
  }
});

test('接口退避期间停止不再发下一次请求',async t=>{
  const f=fixture({},t);let calls=0;
  t.mock.method(AI,'judgeBatch',async()=>{calls++;const previous=f.scheduler().sleep;f.scheduler().sleep=async ms=>{await previous(ms);f.state.stopRequested=true;};throw Object.assign(new Error('429'),{code:'AI_PROVIDER_HTTP',status:429});});
  const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.equal(calls,1);assert.equal(f.time(),250);assert.equal(f.state.running,false);assert.equal(f.checkpoint.state,'paused');assert.ok(f.store.getLeads().every(r=>!r.aiDone));
});

test('正常多批没有人为等待，完成清除过期暂停原因和计数',async t=>{
  const f=fixture({count:40},t);f.checkpoint.stopReason='old failure';f.settings.ai.intervalSec=86400;f.settings.human.breakEvery=1;f.settings.human.breakMinSec=10000;f.settings.human.breakMaxSec=10000;
  t.mock.method(AI,'judgeBatch',async(config,rows,videos)=>repliesFor(config,rows,videos));
  const result=await f.tasks.aiTask();assert.equal(result.okCount,40);assert.equal(result.batchCount,2);assert.equal(f.time(),0);assert.equal(f.scheduler().actions,0);assert.equal(f.checkpoint.stopReason,null);assert.equal(f.checkpoint.state,'completed');assert.equal(f.checkpoint.processedLeadIds.length,40);assert.deepEqual(f.checkpoint.counts,{yes:20,no:20,failed:0,skipped:0});
});

test('明确输出拒绝和HTTP200接口error只暂停一次，不缩批或泄漏远端说明',async t=>{
  for(const code of ['AI_OUTPUT_REFUSED','AI_PROVIDER_ERROR']) {
    const f=fixture({},t);let calls=0;t.mock.method(AI,'judgeBatch',async()=>{calls++;throw Object.assign(new Error('remote mock-key-never-sent'),{code});});
    const result=await f.tasks.aiTask();assert.equal(result.ok,false);assert.equal(calls,1);assert.equal(result.splitRetryCount,0);assert.equal(result.providerRetryCount,0);assert.match(result.error,code==='AI_OUTPUT_REFUSED'?/模型拒绝/:/接口报告/);assert.ok(!f.logs.map(x=>x.line).join('\n').includes('mock-key-never-sent'));
  }
});

test('回应到达后补识别作品作者，跳过该项但不影响同批其他线索',async t=>{
  const f=fixture({count:2},t);
  t.mock.method(AI,'judgeBatch',async(config,rows,videos)=>{const current=f.store.getLeads();current[0].isAuthor=true;f.store.setLeads(current);return repliesFor(config,rows,videos);});
  const result=await f.tasks.aiTask();assert.equal(result.okCount,1);assert.equal(result.skipped,1);assert.equal(f.store.getLeads()[0].aiDone,undefined);assert.equal(f.store.getLeads()[1].aiDone,true);assert.equal(f.state.done,2);
});

test('单条已识别作者和空主评论与批量一致，不发现模型、不发判断请求',async t=>{
  for(const patch of [{isAuthor:true},{demand:'  \n '}]) {
    const f=fixture({count:1},t),rows=f.store.getLeads();Object.assign(rows[0],patch);f.store.setLeads(rows);
    const before=structuredClone(rows);let discoveries=0,judgments=0;
    t.mock.method(AI,'listModels',async()=>{discoveries++;assert.fail('excluded single must not discover models');});
    t.mock.method(AI,'judgeOne',async()=>{judgments++;assert.fail('excluded single must not request judgment');});
    const result=await f.tasks.aiJudgeOne(1);
    assert.equal(result.ok,false);assert.match(result.error,patch.isAuthor?/作品作者/:/评论为空/);
    assert.equal(discoveries,0);assert.equal(judgments,0);assert.equal(f.state.running,false);assert.deepEqual(f.store.getLeads(),before);
  }
});

test('单条回应到达后成为作品作者，跳过保存且保留历史AI字段及业务记录',async t=>{
  const f=fixture({count:1},t),initial=f.store.getLeads();
  Object.assign(initial[0],{aiNeed:'否',aiReason:'旧判断理由',aiDone:true,aiScore:77,aiJudgedAt:'旧时间',aiPromptVersion:'old-version',aiInputHash:'old-hash',dmCount:1,note:'保留备注'});
  f.store.setLeads(initial);const before=structuredClone(initial[0]);
  t.mock.method(AI,'judgeOne',async(config,row,videos,options)=>{
    await options.authorize();const current=f.store.getLeads();current[0].isAuthor=true;f.store.setLeads(current);
    return repliesFor(config,[row],videos)[1];
  });
  const result=await f.tasks.aiJudgeOne(1);
  assert.equal(result.ok,false);assert.equal(result.skipped,true);assert.match(result.error,/作品作者/);
  assert.deepEqual(f.store.getLeads()[0],{...before,isAuthor:true});assert.equal(f.state.running,false);assert.equal(f.state.done,0);
  assert.ok(f.logs.some(item=>item.line.includes('"outcome":"skipped"')));
});
