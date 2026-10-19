'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai');
const {TaskStopError}=require('../scheduler');

const config = () => ({ai:{baseUrl:'https://api.deepseek.com',apiKey:'mock-key-ONLY-in-mocked-transport',model:'deepseek-flash',businessDesc:'测试公司账户咨询',targetCustomers:'测试卖家',clearNeeds:'咨询自己账户问题',misjudgments:'同行广告及围观',promptPresets:[{id:'prompt-1',name:'一',prompt:'第一套独立规则'},{id:'prompt-2',name:'二',prompt:'第二套明确费用规则'},{id:'prompt-3',name:'三',prompt:''}],activePromptId:'prompt-1',prompt:'过期影子规则不得使用'}});
const modelResponse = models => ({ok:true,status:200,url:'https://api.deepseek.com/models',json:async()=>({object:'list',data:models})});
const completionResponse = content => ({ok:true,status:200,url:'https://api.deepseek.com/chat/completions',json:async()=>({choices:[{finish_reason:'stop',message:{content}}]})});
const lead = () => ({id:'mock-1',UID:'mock-numeric-12345',uid:'mock-sec-uid',nickname:'测试昵称',demand:'我的测试店铺申诉要多少费用？',time:'2026-10-08',videoLink:'https://www.douyin.com/video/12345'});
const mockProvider = calls => async (url, options) => {
  calls.push({url,method:options.method,options});
  if(options.method==='GET') return modelResponse([{id:'deepseek-flash',name:'DeepSeek-V4.1-Flash',context_window:1048576},{id:'deepseek-v4-pro',name:'DeepSeek-V4-Pro'}]);
  const data=JSON.parse(JSON.parse(options.body).messages[1].content);
  return completionResponse(JSON.stringify(data.items.map(x=>({i:x.i,need:'是',reason:'测试评论明确问服务费用'}))));
};

test('只使用激活槽，切换相同文本的槽仍更新规则版本，未激活编辑不影响当前判断',()=>{
  const first=config(), version=AI.getRuleSet(first).version;
  assert.match(AI.getRuleSet(first).prompt,/第一套/);assert.doesNotMatch(AI.getRuleSet(first).prompt,/过期影子/);
  first.ai.promptPresets[1].prompt='未启用修改';assert.equal(AI.getRuleSet(first).version,version);
  first.ai.promptPresets[1].prompt=first.ai.promptPresets[0].prompt;first.ai.activePromptId='prompt-2';assert.notEqual(AI.getRuleSet(first).version,version);
  first.ai.activePromptId='prompt-3';assert.throws(()=>AI.getRuleSet(first),/已填写的提示词/);
});

test('单条批量固定5标签一致，UID优先导出UID，线索身份改变也使旧结果失效',async()=>{
  const settings=config(), calls=[], videos={'12345':{desc:'测试视频账户申诉'}};
  const one=await AI.judgeOne(settings,lead(),videos,{fetchImpl:mockProvider(calls)});
  const batch=await AI.judgeBatch(settings,[lead(),{...lead(),id:'mock-2',UID:'mock-other'}],videos,{fetchImpl:mockProvider(calls)});
  const posts=calls.filter(c=>c.method==='POST'), a=JSON.parse(posts[0].options.body), b=JSON.parse(posts[1].options.body);
  assert.equal(a.messages[0].content,b.messages[0].content);
  const aInput=JSON.parse(a.messages[1].content).items[0], bInput=JSON.parse(b.messages[1].content).items[0];assert.deepEqual(aInput,bInput);
  assert.equal(aInput.comment,'我的测试店铺申诉要多少费用？');assert.equal(aInput.time,'2026-10-08');assert.equal(aInput.nickname,'测试昵称');
  assert.equal(aInput.workRef,JSON.parse(a.messages[1].content).works[0].id);assert.equal(JSON.parse(a.messages[1].content).works[0].videoDescription,'测试视频账户申诉');
  for(const label of ['【用户评论】','【评论时间】','【用户UID】','【用户名称】','【所在视频描述】']) assert.ok(a.messages[0].content.includes(label));
  assert.equal(aInput.uid,'mock-numeric-12345');assert.equal(one.inputHash,batch[1].inputHash);
  let records=[{...lead(),UID:'changed-mock-UID'}];
  const store={getSettings:()=>settings,getLeads:()=>records,getVideos:()=>videos,setLeads:x=>{records=x;},nowStr:()=>''};
  assert.equal(AI.applyResultPatch(store,lead(),one).skipped,true);assert.equal(records[0].aiDone,undefined);
  assert.deepEqual(a.thinking,{type:'disabled'});
});

test('模型实时发现只返回可用元数据，不泄漏provider其他字段，不自动替换当前模型',async()=>{
  const settings=config();settings.ai.model='saved-old-model';const calls=[];
  const result=await AI.listModels(settings,{forceRefresh:true,fetchImpl:async(url,options)=>{calls.push({url,options});return modelResponse([{id:'deepseek-flash',name:'最新版 Flash',context_window:1048576,privateToken:'secret-not-returned'}]);}});
  assert.equal(calls[0].url,'https://api.deepseek.com/models');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');
  assert.equal(result.selectedModel,'saved-old-model');assert.equal(settings.ai.model,'saved-old-model');assert.deepEqual(result.models,[{id:'deepseek-flash',name:'最新版 Flash',contextWindow:1048576}]);assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  const rejectCalls=[];await assert.rejects(AI.judgeOne(settings,lead(),{}, {fetchImpl:mockProvider(rejectCalls)}),/模型已不可用.*刷新模型列表/);assert.equal(rejectCalls.filter(x=>x.method==='POST').length,0);
});

test('模型发现拒绝篡改地址、跨站跳转、重复模型及异常体，错误不复制秘钥内容',async()=>{
  const settings=config(); let calls=0;
  settings.ai.baseUrl='https://untrusted.example';await assert.rejects(AI.listModels(settings,{fetchImpl:async()=>{calls++;}}),/官方 HTTPS/);assert.equal(calls,0);
  settings.ai.baseUrl='https://api.deepseek.com';
  await assert.rejects(AI.listModels(settings,{fetchImpl:async()=>({...modelResponse([{id:'deepseek-flash'}]),url:'https://untrusted.example/models'})}),/不安全跳转/);
  await assert.rejects(AI.listModels(settings,{fetchImpl:async()=>modelResponse([{id:'deepseek-flash'},{id:'deepseek-flash'}])}),/模型列表响应无效/);
  let bodyRead=false;await assert.rejects(AI.listModels(settings,{fetchImpl:async()=>({ok:false,status:401,text:async()=>{bodyRead=true;return settings.ai.apiKey;}})}),error=>!error.message.includes(settings.ai.apiKey));assert.equal(bodyRead,false);
  await assert.rejects(AI.listModels(settings,{fetchImpl:async()=>{throw new Error(settings.ai.apiKey);}}),error=>!error.message.includes(settings.ai.apiKey));
});

test('模型发现后撤销授权或停止，聊天请求均不会发出，授权错误不泄漏私有内容',async()=>{
  for(const scenario of ['revoke','stop','throw']) {
    const settings=config(), calls=[];let authorizations=0;
    const authorize=async()=>{
      authorizations++;if(authorizations===1) return {ok:true};
      if(scenario==='stop') throw new TaskStopError('已手动停止');
      if(scenario==='throw') throw new Error(settings.ai.apiKey);
      return {ok:false,error:settings.ai.apiKey};
    };
    await assert.rejects(AI.judgeOne(settings,lead(),{},{authorize,fetchImpl:mockProvider(calls)}),error=>error instanceof TaskStopError && !error.message.includes(settings.ai.apiKey));
    assert.equal(authorizations,2);assert.equal(calls.filter(c=>c.method==='GET').length,1);assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }
});

test('工作期授权等待不计入网络超时，授权返回后才发送请求',async()=>{
  const settings=config();let authorized=false,fetches=0;
  const result=await AI.listModels(settings,{timeoutMs:5,authorize:async()=>{await new Promise(resolve=>setTimeout(resolve,15));authorized=true;},fetchImpl:async()=>{assert.equal(authorized,true);fetches++;return modelResponse([{id:'deepseek-flash'}]);}});
  assert.equal(fetches,1);assert.equal(result.models[0].id,'deepseek-flash');
});

test('生成及样例测试采用草稿业务与提示词，保留3槽选择及已保存业务',async()=>{
  const settings=config(), before=structuredClone(settings), calls=[];
  const businessInput={businessDesc:'家装测试业务',targetCustomers:'装修测试客户',clearNeeds:'自家装修具体问题',misjudgments:'同行施工广告'};
  const generated=await AI.generatePromptDraft(settings,businessInput,{fetchImpl:async(url,options)=>{
    if(options.method==='GET') return modelResponse([{id:'deepseek-flash'}]);
    const body=JSON.parse(options.body);calls.push(body);return completionResponse(JSON.stringify({prompt:'根据装修业务判断，需求未明但相关咨询保留'}));
  }});
  assert.equal(generated.draft,true);assert.match(generated.prompt,/装修/);assert.deepEqual(settings,before);
  assert.deepEqual(JSON.parse(calls[0].messages[1].content),businessInput);assert.ok(!calls[0].messages[1].content.includes('mock-numeric'));
  const testCalls=[];await AI.testPromptDraft(settings,{prompt:generated.prompt,businessInput,samples:['测试装修需要多少钱']},{fetchImpl:mockProvider(testCalls)});
  const testPost=JSON.parse(testCalls.find(c=>c.method==='POST').options.body), material=JSON.parse(testPost.messages[1].content);assert.match(material.businessRules,/根据装修/);assert.doesNotMatch(testPost.messages[0].content,/根据装修|第一套独立/);assert.deepEqual(settings,before);
});
