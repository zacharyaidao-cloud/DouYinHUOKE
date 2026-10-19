'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const AI=require('../ai');
const {TaskStopError}=require('../scheduler');
const settings=()=>({ai:{enabled:true,batchMode:'auto',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'mock-key-no-network',prompt:'依据业务相关咨询判断可考虑联系',businessDesc:'测试账户咨询',targetCustomers:'卖家',clearNeeds:'相关问题',misjudgments:'明确不相关',batchMaxChars:100,batchMaxCount:1}});
const lead=id=>({id,UID:'mock-UID-'+id,uid:'mock-sec-'+id,nickname:'测试用户',demand:'相关测试问题'+id,time:'2026-10-08',videoLink:'https://www.douyin.com/video/'+(id%2?'123':'456')});
const liveCapacity={model:'deepseek-flash',contextWindow:1048576,maxOutputTokens:393216,sourceKind:'live',source:'https://api.deepseek.com/models',fetchedAt:'2026-10-08T00:00:00Z'};

test('自动模式忽略旧20/100条及3000字符提前切批，按完整system与包装预留输出预算',()=>{
  const config=settings(),rows=Array.from({length:107},(_,i)=>lead(i+1)), videos={'123':{desc:'作品A'.repeat(100)},'456':{desc:'作品B'.repeat(100)}};
  const plan=AI.planJudgeBatches(config,rows,videos,liveCapacity);assert.equal(plan.mode,'auto');assert.equal(plan.batches.length,1);assert.equal(plan.batches[0].leads.length,107);
  const request=AI.buildJudgeRequest(config,rows,videos), budget=plan.batches[0].budget;
  assert.equal(budget.inputTokensEstimate,Buffer.byteLength(JSON.stringify(request.messages),'utf8')+128+request.messages.length*32);
  assert.equal(budget.outputTokensReserved,256+107*200);assert.equal(budget.totalTokensEstimate,budget.inputTokensEstimate+budget.outputTokensReserved);
  assert.equal(budget.targetTokens,Math.floor(liveCapacity.contextWindow*.75));assert.equal(budget.targetRatio,.75);assert.equal(budget.withinBudget,true);assert.match(budget.estimateMethod,/保守估算/);
  assert.deepEqual(plan.batches[0].leads.map(x=>x.id),rows.map(x=>x.id));assert.equal(request.workCount,2);
});

test('手动条数与界面配置一致，101条不会被隐藏的100条限制提前切批',()=>{
  const config=settings();Object.assign(config.ai,{batchMode:'manual',batchMaxChars:60000,batchMaxCount:101});
  const rows=Array.from({length:101},(_,i)=>lead(i+1));
  const plan=AI.planJudgeBatches(config,rows,{},liveCapacity);
  assert.equal(plan.maxCount,101);assert.equal(plan.batches.length,1);assert.equal(plan.batches[0].leads.length,101);
});

test('自动预算75%、50%、30%重新完整装批，最后最多200条且不由时限提前切批',()=>{
  const config=settings(),rows=Array.from({length:5223},(_,i)=>lead(i+1));
  config.ai.requestTimeoutSec=60;
  const plan=AI.planJudgeBatches(config,rows,{},liveCapacity);
  assert.equal(plan.targetRatio,.75);assert(plan.batches[0].leads.length>200);
  assert.deepEqual(plan.batches.flatMap(batch=>batch.leads.map(row=>row.id)),rows.map(row=>row.id));
  assert(plan.batches.every(batch=>batch.budget.withinBudget));
  const sizes=[];
  for(const strategy of AI.AUTOMATIC_BATCH_STRATEGIES.slice(0,3)) {
    const tier=AI.planJudgeBatches(config,rows,{},liveCapacity,strategy);sizes.push(tier.batches[0].leads.length);
    assert(tier.batches.every(batch=>batch.budget.withinBudget&&batch.budget.targetRatio===strategy.targetRatio));
    assert.deepEqual(tier.batches.flatMap(batch=>batch.leads.map(row=>row.id)),rows.map(row=>row.id));
  }
  assert(sizes[0]>sizes[1]&&sizes[1]>sizes[2]);
  config.ai.requestTimeoutSec=120;
  assert.deepEqual(AI.planJudgeBatches(config,rows,{},liveCapacity).batches.map(b=>b.leads.length),plan.batches.map(b=>b.leads.length));
  const fallback=AI.planJudgeBatches(config,rows,{},liveCapacity,AI.AUTOMATIC_BATCH_STRATEGIES[3]);
  assert.equal(fallback.executionMaxCount,200);assert.deepEqual(fallback.batches.map(b=>b.leads.length),[...Array(26).fill(200),23]);
});

test('接近模型75%预算顺序贪心切分，保留混合作品范围次序，输出上限同样约束',()=>{
  const config=settings(),rows=Array.from({length:7},(_,i)=>lead(i+1)), videos={'123':{desc:'甲'},'456':{desc:'乙'}};
  const three=AI.estimateRequestBudget(AI.buildJudgeRequest(config,rows.slice(0,3),videos).messages,3,liveCapacity);
  const capacity={...liveCapacity,contextWindow:Math.ceil(three.totalTokensEstimate/.75),maxOutputTokens:3000};
  const plan=AI.planJudgeBatches(config,rows,videos,capacity);
  assert.deepEqual(plan.batches.map(x=>x.leads.length),[3,3,1]);assert.deepEqual(plan.batches.flatMap(x=>x.leads.map(y=>y.id)),[1,2,3,4,5,6,7]);
  assert.ok(plan.batches.every(x=>x.budget.totalTokensEstimate<=x.budget.targetTokens));
  const outputLimited=AI.planJudgeBatches(config,rows,videos,{...liveCapacity,maxOutputTokens:700});assert.deepEqual(outputLimited.batches.map(x=>x.leads.length),[2,2,2,1]);
});

test('介绍单独超预算明确拒绝；超限单线索不强制发送而保留未判，其余线索继续',()=>{
  const config=settings();assert.throws(()=>AI.planJudgeBatches(config,[lead(1)],{}, {...liveCapacity,contextWindow:100,maxOutputTokens:100}),/介绍与判断要求已超过模型75%预算/);
  const rows=[lead(1),{...lead(2),demand:'很长'.repeat(5000)},lead(3)], first=AI.estimateRequestBudget(AI.buildJudgeRequest(config,[rows[0],rows[2]],{}).messages,2,liveCapacity);
  const capacity={...liveCapacity,contextWindow:Math.ceil((first.totalTokensEstimate+100)/.75)};
  const plan=AI.planJudgeBatches(config,rows,{},capacity);assert.equal(plan.rejected.length,1);assert.equal(plan.rejected[0].lead.id,2);assert.equal(plan.oversizeCount,1);
  assert.deepEqual(plan.batches.flatMap(x=>x.leads.map(l=>l.id)),[1,3]);assert.match(plan.rejected[0].reason,/未发请求/);
});

test('模型容量使用实时元数据；缺字段只允许有日期来源的官方已知fallback',()=>{
  const config=settings();const source={models:[{id:'deepseek-flash',contextWindow:16000,maxOutputTokens:4000}],source:'https://api.deepseek.com/models',fetchedAt:'mock-time'};
  const capacity=AI.modelCapacity(config,source);assert.equal(capacity.sourceKind,'live');assert.equal(capacity.contextWindow,16000);assert.equal(capacity.maxOutputTokens,4000);
  const fallback=AI.modelCapacity(config,{models:[{id:'deepseek-flash'}]});assert.equal(fallback.sourceKind,'official_document_fallback');assert.equal(fallback.documentCheckedAt,'2026-10-08');assert.match(fallback.source,/api-docs\.deepseek\.com/);
  config.ai.model='unknown-model';assert.throws(()=>AI.modelCapacity(config,{models:[{id:'unknown-model',contextWindow:16000}]}),/未返回完整上下文容量/);
});

test('长度截断即使正文看似合法也未成功；只返回真实usage整数，模型额外字段不泄漏',async()=>{
  const config=settings(), usage=[];
  await assert.rejects(AI.judgeOne(config,lead(1),{}, {onUsage:x=>usage.push(x),fetchImpl:async(url,options)=>options.method==='GET'?{ok:true,status:200,url:'https://api.deepseek.com/models',json:async()=>({data:[{id:'deepseek-flash',context_window:1048576,max_output_tokens:393216}]})}:{ok:true,status:200,url:'https://api.deepseek.com/chat/completions',json:async()=>({choices:[{finish_reason:'length',message:{content:'[{"i":1,"need":"是","reason":"相关"}]'}}],usage:{prompt_tokens:2345,completion_tokens:456,total_tokens:2801,privateKey:'must-not-appear'}})}}),error=>error.code==='AI_OUTPUT_LENGTH');
  assert.equal(usage.length,1);assert.deepEqual(usage[0].usage,{prompt_tokens:2345,completion_tokens:456,total_tokens:2801});assert.ok(!JSON.stringify(usage).includes('must-not-appear'));
});

test('请求超过实时模型90%预算或未知容量不发聊天，模型发现仍保留逐次授权',async()=>{
  const config=settings();let posts=0,auth=0;
  await assert.rejects(AI.judgeOne(config,lead(1),{}, {authorize:async()=>{auth++;return {ok:true};},fetchImpl:async(url,options)=>{if(options.method==='POST')posts++;return {ok:true,status:200,url:'https://api.deepseek.com/models',json:async()=>({data:[{id:'deepseek-flash',context_window:100,max_output_tokens:100}]})};}}),/超过模型90%/);
  assert.equal(posts,0);assert.equal(auth,1);
});

test('增量转义预算由最终完整序列化复核，换行引号和Unicode不漏算且大批规划可停止',async()=>{
  const config=settings(),rows=Array.from({length:107},(_,i)=>({...lead(i+1),demand:'引号"\\换行\n😀测试'+i})),videos={'123':{desc:'正文"\\\n😀'.repeat(300)},'456':{desc:'另一作品\r\n'}};
  const asyncPlan=await AI.planJudgeBatchesAsync(config,rows,videos,liveCapacity);assert.equal(asyncPlan.batches.length,1);
  const full=AI.estimateRequestBudget(AI.buildJudgeRequest(config,rows,videos).messages,rows.length,liveCapacity,.75);assert.deepEqual(asyncPlan.batches[0].budget,full);
  let stopped=false;const timer=setTimeout(()=>{stopped=true;},0);
  try {await assert.rejects(AI.planJudgeBatchesAsync(config,Array.from({length:5000},(_,i)=>lead(i+1)),videos,liveCapacity,{checkStopped:()=>{if(stopped)throw new TaskStopError();}}),error=>error instanceof TaskStopError);}finally{clearTimeout(timer);}
});
