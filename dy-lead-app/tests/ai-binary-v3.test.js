'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const AI=require('../ai');
const settings=()=>({ai:{enabled:true,baseUrl:'https://api.deepseek.com',apiKey:'mock-secret-only-never-network',model:'deepseek-flash',businessDesc:'账户咨询测试',targetCustomers:'卖家测试',clearNeeds:'账户相关',misjudgments:'业务无关广告',prompt:'旧自定义规则：需明确自身需求；不清楚为待确认；输出单对象need、score、reason。',batchMode:'manual',batchMaxChars:24000,batchMaxCount:20}});
const lead=(id=1)=>({id,UID:'mock-same-UID',uid:'mock-same-sec-UID',nickname:'测试用户',demand:'测试账户相关疑问'+id,time:'2026-10-08',videoLink:'https://www.douyin.com/note/123'});
const completion=content=>({ok:true,status:200,url:'https://api.deepseek.com/chat/completions',json:async()=>({choices:[{finish_reason:'stop',message:{content}}]})});
const provider=content=>async(url,options)=>options.method==='GET'?{ok:true,status:200,url:'https://api.deepseek.com/models',json:async()=>({data:[{id:'deepseek-flash'}]})}:completion(content);

test('旧自定义格式保留为业务材料，固定二值联系政策及协议保持系统优先级',()=>{
  const cfg=settings(), before=cfg.ai.prompt, request=AI.buildJudgeRequest(cfg,[lead()],{'123':{desc:'测试业务作品'}}), system=request.messages[0].content;
  assert.match(request.version,/^ai-v3-/);assert.equal(cfg.ai.prompt,before);
  assert.doesNotMatch(system,/旧自定义规则/);assert.match(request.payload.businessRules,/旧自定义规则/);
  assert.match(system,/判断的是“是否可考虑联系”/);
  assert.match(system,/先判断评论向谁说、谁在求助、谁在提供帮助/);
  assert.match(system,/need只能为“是”或“否”/);assert.match(system,/不得增加score/);assert.match(system,/问号、业务关键词、未拒绝联系都不是独立的正向证据/);
  assert.equal(AI.RESULT_CONTRACT.maxReasonChars,30);
});

test('理由按Unicode字符限制30字，旧待确认/评分/长理由均拒绝且不会截短成成功',async()=>{
  assert.equal(AI.parseAiReply(JSON.stringify({need:'是',reason:'😀'.repeat(30)})).reason,'😀'.repeat(30));
  for(const reply of [[{i:1,need:'待确认',reason:'需求不明'}],[{i:1,need:'是',score:90,reason:'相关'}],[{i:1,need:'是',reason:'长'.repeat(31)}]]) {
    const diagnostics=[];
    assert.equal(await AI.judgeBatch(settings(),[lead()],{}, {fetchImpl:provider(JSON.stringify(reply)),onDiagnostic:x=>diagnostics.push(x)}),null);
    assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].expectedCount,1);assert.equal(Object.hasOwn(diagnostics[0],'reply'),false);
  }
  assert.equal(AI.inspectBatchReply('[{"i":1,"need":"是","reason":"'+ '长'.repeat(31)+'"}]',1).diagnostic.code,'REASON_TOO_LONG');
});

test('共享长作品只发送一次，真实去重payload预算支持20条一批且字数与实际消息相等',()=>{
  const cfg=settings(), leads=Array.from({length:20},(_,i)=>lead(i+1)), marker='共享作品仅一次-'+ '文'.repeat(4000), videos={'123':{desc:marker}};
  const request=AI.buildJudgeRequest(cfg,leads,videos), plan=AI.planJudgeBatches(cfg,leads,videos);
  assert.equal(request.workCount,1);assert.equal(request.payload.works.length,1);assert.equal(request.payload.items.length,20);
  assert.equal(request.payloadChars,request.messages[1].content.length);
  assert.equal(request.messages[1].content.split(marker).length-1,1);
  assert.ok(request.payload.items.every(item=>item.workRef==='work-1'&&!Object.hasOwn(item,'context')&&!Object.hasOwn(item,'videoDescription')));
  assert.equal(plan.batches.length,1);assert.equal(plan.batches[0].leads.length,20);assert.equal(plan.batches[0].payloadChars,request.payloadChars);
  assert.ok(request.payloadChars<24000);
  const oldRepeatedChars=leads.reduce((n,l)=>n+JSON.stringify(AI.leadInput(l,videos)).length+24,0);assert.ok(oldRepeatedChars>request.payloadChars*5);
});

test('自定义3000预算遵守去重真实payload，末批1条及超预算独条明确说明',()=>{
  const cfg=settings();cfg.ai.batchMaxChars=3000;
  const videos={'123':{desc:'文'.repeat(1200)}}, rows=Array.from({length:8},(_,i)=>lead(i+1));
  const plan=AI.planJudgeBatches(cfg,rows,videos);assert.equal(plan.maxChars,3000);assert.equal(plan.batches.length,1);assert.equal(plan.batches[0].leads.length,8);
  cfg.ai.batchMaxChars=24000;cfg.ai.batchMaxCount=3;const tail=AI.planJudgeBatches(cfg,rows.slice(0,4),videos);
  assert.equal(tail.batches.length,2);assert.equal(tail.batches[1].singleReason,'末批剩余1条');
  cfg.ai.batchMaxChars=100;const huge=AI.planJudgeBatches(cfg,[lead()],videos);assert.equal(huge.oversizeCount,1);assert.equal(huge.batches.length,0);assert.equal(huge.rejected[0].lead.id,1);assert.match(huge.rejected[0].reason,/超过手动字符预算，未发请求/);
});

test('同UID不同评论或作品仍按本批i独立映射，反序返回正确回填且单批规则相同',async()=>{
  const cfg=settings(), first=lead(1), second={...lead(2),videoLink:'https://www.douyin.com/video/456'}, videos={'123':{desc:'相关作品甲'},'456':{desc:'无关作品乙'}};
  const request=AI.buildJudgeRequest(cfg,[first,second],videos);assert.equal(request.workCount,2);assert.notEqual(request.payload.items[0].workRef,request.payload.items[1].workRef);
  const result=await AI.judgeBatch(cfg,[first,second],videos,{fetchImpl:provider('[{"i":2,"need":"否","reason":"明确业务无关"},{"i":1,"need":"是","reason":"需求未明，业务相关"}]')});
  assert.equal(result[1].need,'是');assert.equal(result[2].need,'否');assert.equal(Object.hasOwn(result[1],'score'),false);
  assert.equal(AI.buildJudgeRequest(cfg,[first],videos).messages[0].content,request.messages[0].content);
});

test('仅重判目标归档旧评分，新结果为null，未重判历史字段和业务记录保留',async()=>{
  const cfg=settings();let rows=[{...lead(1),aiScore:77,aiNeed:'待确认',aiDone:true,aiPromptVersion:'ai-v2-old',aiJudgedAt:'旧时间',note:'必须保留',dmCount:1},{...lead(2),aiScore:66,aiNeed:'否',aiDone:true}];
  const snapshot=structuredClone(rows[0]), result=await AI.judgeOne(cfg,snapshot,{}, {fetchImpl:provider('[{"i":1,"need":"是","reason":"需求未明，业务相关"}]')});
  const store={getSettings:()=>cfg,getLeads:()=>structuredClone(rows),getVideos:()=>({}),setLeads:x=>{rows=x;},nowStr:()=> '新时间'};
  assert.equal(AI.applyResultPatch(store,snapshot,result).ok,true);assert.equal(rows[0].aiScore,null);assert.deepEqual(rows[0].aiScoreHistory,[{score:77,judgedAt:'旧时间',promptVersion:'ai-v2-old'}]);assert.equal(rows[0].note,'必须保留');assert.equal(rows[0].dmCount,1);assert.equal(rows[1].aiScore,66);
});
