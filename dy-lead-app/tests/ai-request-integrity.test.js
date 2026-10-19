'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const AI=require('../ai');
const config=()=>({ai:{apiKey:'mock-private-only',model:'deepseek-flash',businessDesc:'亚马逊账号申诉、激活及资金解冻',targetCustomers:'亚马逊卖家',clearNeeds:'求助、处理可能性、费用、服务证据咨询',misjudgments:'回答作者、提供案例、转介绍、纯评价及历史经验无新的求助',prompt:'主营亚马逊账户服务，跨行业咨询不在业务范围内。',batchMode:'auto'}});
const lead=(id,comment,extra={})=>({id,UID:'same-mock-UID',uid:'same-mock-sec-UID',nickname:'同名测试',demand:comment,time:'2026-10-08',videoLink:'https://www.douyin.com/note/123',...extra});
const model=()=>({ok:true,status:200,url:'https://api.deepseek.com/models',json:async()=>({data:[{id:'deepseek-flash',context_window:1048576,max_output_tokens:393216}]})});
const completion=body=>({ok:true,status:200,url:'https://api.deepseek.com/chat/completions',json:async()=>body});
const reply=content=>({choices:[{finish_reason:'stop',message:{content}}]});
const provider=body=>async(url,options)=>options.method==='GET'?model():completion(body);
const capacity={model:'deepseek-flash',contextWindow:1048576,maxOutputTokens:393216};

test('方向成对场景保留真实评论与作品映射，系统不再硬编码边界都为是',()=>{
  // This only verifies the materials/policy sent to the model, not live model
  // classification accuracy. No expected labels are included in the request.
  const pairs=['可以处理的','可以处理吗','有案例','你有案例吗','实锤关联吗','这种关联可以处理吗','之前帮我解决了一个','另一个还没过，能帮忙吗','先别急看了一下邮件好解决','我今天也收到邮件了，怎么处理','我也是一样的问题，14天到了就停用了','这是作者吃了三封邮件啊'];
  const rows=pairs.map((text,index)=>lead(index+1,text,{videoLink:'https://www.douyin.com/note/'+(index%2?'456':'123')}));
  const works={'123':{desc:'作者求助：协议三停用了，有通过案例的来'},'456':{desc:'亚马逊店铺申诉服务介绍'}};
  const batch=AI.buildJudgeRequest(config(),rows,works),one=AI.buildJudgeRequest(config(),[rows[0]],works);
  assert.equal(batch.messages[0].content,one.messages[0].content);
  assert.deepEqual(batch.payload.items.map(item=>item.comment),pairs);
  assert.equal(batch.payload.works.length,2);
  for(let index=0;index<rows.length;index++) {
    const item=batch.payload.items[index],work=batch.payload.works.find(work=>work.id===item.workRef);
    assert.equal(item.i,index+1);assert.equal(work.videoDescription,works[index%2?'456':'123'].desc);
    assert.equal(Object.hasOwn(item,'expectedNeed'),false);assert.equal(Object.hasOwn(item,'need'),false);
  }
  assert.match(batch.messages[0].content,/没有相关求助、服务咨询或本人\/朋友当前问题证据时判“否”/);
  assert.match(batch.messages[0].content,/不要求当前问题再附求助问句/);
  assert.match(batch.messages[0].content,/具体账户问题作品下.*“我也是”.*已将作品描述的问题指向本人/);
  assert.match(batch.messages[0].content,/有效的自定义行业条件必须参与判断/);
  assert.doesNotMatch(batch.messages[0].content,/“实锤关联吗”“你有案例吗”是相关咨询或质疑，可判是|只有“有案例”不能确认揽客，可判是/);
  assert.equal(AI.getRuleSet(config()).policyVersion,'contact-v4-request-direction');
});

test('主评论与补充评论尾部和50条后的证据完整保留，超预算拒绝发送而非截短',()=>{
  const primary='业务讨论'.repeat(5000)+'，以上都是旧经历，现在完全解决，不需要服务';
  const supplemental='补充说明'.repeat(2000)+'，最后一个问题还没解决，能帮我吗';
  const record=lead(1,primary,{comments:[primary,...Array.from({length:51},(_,i)=>'旧经历'+i),supplemental]});
  const input=AI.leadInput(record,{});
  assert.equal(input.comment,primary);assert.equal(input.comments.length,52);assert.equal(input.comments.at(-1),supplemental);
  const settings=config(),regular=lead(2,'怎么处理');
  const small={...capacity,contextWindow:Math.ceil((AI.estimateRequestBudget(AI.buildJudgeRequest(settings,[regular],{}).messages,1,capacity).totalTokensEstimate+100)/.75)};
  const auto=AI.planJudgeBatches(settings,[record,regular],{},small);
  assert.equal(auto.rejected[0].lead.id,1);assert.deepEqual(auto.batches.flatMap(batch=>batch.leads.map(lead=>lead.id)),[2]);
  Object.assign(settings.ai,{batchMode:'manual',batchMaxChars:60000,batchMaxCount:20});
  const manual=AI.planJudgeBatches(settings,[record,regular],{},small);
  assert.equal(manual.rejected[0].lead.id,1);assert.ok(manual.batches.every(batch=>batch.budget.withinBudget));
});

test('manual模式保留选定顺序并按完整输入加输出90%预算切分',()=>{
  const settings=config();Object.assign(settings.ai,{batchMode:'manual',batchMaxChars:60000,batchMaxCount:20});
  const rows=Array.from({length:7},(_,i)=>lead(i+1,'问题'+i,{videoLink:'https://www.douyin.com/note/'+(i%2?'456':'123')}));
  const firstThree=AI.estimateRequestBudget(AI.buildJudgeRequest(settings,rows.slice(0,3),{}).messages,3,capacity);
  const limited={...capacity,contextWindow:Math.ceil(firstThree.totalTokensEstimate/.9),maxOutputTokens:3000};
  const plan=AI.planJudgeBatches(settings,rows,{},limited);
  assert.deepEqual(plan.batches.map(batch=>batch.leads.length),[3,3,1]);
  assert.deepEqual(plan.batches.flatMap(batch=>batch.leads.map(lead=>lead.id)),[1,2,3,4,5,6,7]);
  assert.ok(plan.batches.every(batch=>batch.budget.withinBudget&&batch.payloadChars<=60000));
  const outputLimited=AI.planJudgeBatches(settings,rows,{}, {...capacity,maxOutputTokens:700});
  assert.deepEqual(outputLimited.batches.map(batch=>batch.leads.length),[2,2,2,1]);
});

test('manual异步规划与同步一致，规划主动让出事件循环以检查停止',async()=>{
  const settings=config();Object.assign(settings.ai,{batchMode:'manual',batchMaxChars:60000,batchMaxCount:20});
  const rows=Array.from({length:107},(_,i)=>lead(i+1,'怎么处理'));
  assert.deepEqual(await AI.planJudgeBatchesAsync(settings,rows,{},capacity),AI.planJudgeBatches(settings,rows,{},capacity));
  let stopped=false;
  await assert.rejects(AI.planJudgeBatchesAsync(settings,rows,{},capacity,{onProgress:()=>{stopped=true;},checkStopped:()=>{if(stopped)throw new Error('停止规划');}}),/停止规划/);
});

test('未正常结束、空回复、拒绝和多选择即使带合法JSON也不成为判断结果',async()=>{
  const valid='[{"i":1,"need":"是","reason":"咨询处理方法"}]';
  const invalid=[
    {choices:[{finish_reason:'length',message:{content:valid}}]},
    {choices:[{finish_reason:'content_filter',message:{content:valid}}]},
    {choices:[{message:{content:valid}}]},
    {choices:[{finish_reason:'stop',message:{content:'   '}}]},
    {choices:[{finish_reason:'stop',message:{content:null}}]},
    {choices:[{finish_reason:'stop',message:{content:valid,refusal:'拒绝'}}]},
    {choices:[{finish_reason:'stop',message:{content:valid,tool_calls:[{}]}}]},
    {choices:[{finish_reason:'stop',message:{content:valid}},{finish_reason:'stop',message:{content:valid}}]},
    {...reply(valid),error:{message:'mock-private-only'}}
  ];
  for(const body of invalid) await assert.rejects(AI.judgeOne(config(),lead(1,'怎么处理'),{}, {fetchImpl:provider(body)}),error=>/^AI_(?:OUTPUT_LENGTH|OUTPUT_INCOMPLETE|RESPONSE_INVALID|OUTPUT_REFUSED|PROVIDER_ERROR)$/.test(error.code)&&!error.message.includes('mock-private-only'));
  const result=await AI.judgeOne(config(),lead(1,'怎么处理'),{}, {fetchImpl:provider(reply(valid))});
  assert.equal(result.need,'是');
});

test('模型拒绝与HTTP200错误包装分别标记永久失败，不混入可缩批格式错误',async()=>{
  const settings=config(),record=lead(1,'怎么处理');
  for(const body of [{choices:[{finish_reason:'content_filter',message:{content:'[]'}}]}, {choices:[{finish_reason:'stop',message:{content:'[]',refusal:'mock-private-only'}}]}]) {
    let posts=0;
    await assert.rejects(AI.judgeOne(settings,record,{}, {fetchImpl:async(url,options)=>{if(options.method==='GET')return model();posts++;return completion(body);}}),error=>error.code==='AI_OUTPUT_REFUSED'&&!error.message.includes('mock-private-only'));
    assert.equal(posts,1);
  }
  await assert.rejects(AI.judgeOne(settings,record,{}, {fetchImpl:provider({error:{message:'mock-private-only'}})}),error=>error.code==='AI_PROVIDER_ERROR'&&!error.message.includes('mock-private-only'));
});

test('实际请求计数在授权及预算通过后记录，HTTP分类保持私密错误体不进入日志',async()=>{
  const events=[],settings=config();
  await AI.judgeOne(settings,lead(1,'怎么处理'),{}, {onRequest:event=>events.push(event),fetchImpl:provider(reply('[{"i":1,"need":"是","reason":"询问处理方法"}]'))});
  assert.deepEqual(events,[{kind:'models',method:'GET'},{kind:'completion',method:'POST',model:'deepseek-flash'}]);
  assert.doesNotMatch(JSON.stringify(events),/mock-private|怎么处理|douyin|https/);
  const denied=[];await assert.rejects(AI.judgeOne(settings,lead(1,'怎么处理'),{}, {authorize:async()=>false,onRequest:event=>denied.push(event),fetchImpl:provider(reply('[]'))}),/授权已失效/);assert.deepEqual(denied,[]);
  let bodyRead=false;
  await assert.rejects(AI.judgeOne(settings,lead(1,'怎么处理'),{}, {fetchImpl:async()=>({ok:false,status:429,headers:{get:()=> '5'},json:async()=>{bodyRead=true;return {apiKey:'mock-private-only'};}})}),error=>error.code==='AI_PROVIDER_HTTP'&&error.status===429&&error.retryAfterMs===5000&&!error.message.includes('mock-private-only'));
  assert.equal(bodyRead,false);
});

test('当前入库结果必须同时满足二值短理由、严格done、当前规则与完整输入hash',async()=>{
  const settings=config(),record=lead(1,'怎么处理'),works={'123':{desc:'服务介绍'}};
  const judged=await AI.judgeOne(settings,record,works,{fetchImpl:provider(reply('[{"i":1,"need":"是","reason":"询问处理方法"}]'))});
  const stored={...record,aiDone:true,aiNeed:judged.need,aiReason:judged.reason,aiPromptVersion:judged.promptVersion,aiInputHash:judged.inputHash};
  assert.equal(AI.isStoredResultCurrent(stored,judged.promptVersion,works),true);
  for(const patch of [{aiDone:'true'},{aiNeed:'待确认'},{aiReason:''},{aiReason:'长'.repeat(31)},{aiPromptVersion:'old'},{aiInputHash:'wrong'},{demand:'历史已解决'},{comments:['补充新问题']}])assert.equal(AI.isStoredResultCurrent({...stored,...patch},judged.promptVersion,works),false);
  assert.equal(AI.isStoredResultCurrent(stored,judged.promptVersion,{'123':{desc:'描述已变化'}}),false);
  assert.equal(AI.isStoredResultCurrent(null,judged.promptVersion,works),false);
  assert.equal(AI.isCurrentResult(stored,{ai:{promptPresets:[],activePromptId:'missing'}},works),false);
});
