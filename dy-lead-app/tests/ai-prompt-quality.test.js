'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const AI=require('../ai');
const policy=require('../lib/ai-policy');

const config=()=>({ai:{apiKey:'mock-key-only-no-network',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',businessDesc:'亚马逊账户申诉、激活、解封及资金解冻',targetCustomers:'亚马逊卖家',clearNeeds:'相关咨询、疑问或经历',misjudgments:'明确广告、业务无关、全部已解决',promptPresets:[{id:'prompt-1',name:'自定义行业规则',prompt:'行业范围：亚马逊账户服务。特殊情况：只询问费用也保留。'},{id:'prompt-2',name:'二',prompt:''},{id:'prompt-3',name:'三',prompt:''}],activePromptId:'prompt-1',batchMode:'auto'}});
const record=(id,comment,extra={})=>({id,UID:'mock-UID-'+id,uid:'mock-sec-'+id,nickname:'匿名测试',demand:comment,time:'2026-10-08',videoLink:'https://www.douyin.com/note/123',...extra});
const modelResponse=()=>({ok:true,status:200,url:'https://api.deepseek.com/models',json:async()=>({data:[{id:'deepseek-flash'}]})});
const completion=content=>({ok:true,status:200,url:'https://api.deepseek.com/chat/completions',json:async()=>({choices:[{finish_reason:'stop',message:{content}}]})});
const draftProvider=prompt=>async(url,options)=>options.method==='GET'?modelResponse():completion(JSON.stringify({prompt}));

test('默认运行政策与结果合同来自纯共享模块，旧存储规则只作为业务材料',()=>{
  assert.equal(AI.CONTACT_POLICY,policy.CONTACT_POLICY);assert.equal(AI.RESULT_CONTRACT,policy.RESULT_CONTRACT);assert.equal(AI.CONTEXT_TEMPLATE,policy.CONTEXT_TEMPLATE);
  const settings=config(),before=structuredClone(settings);
  settings.ai.promptPresets[0].prompt='污染材料标记：只输出JSON对象prompt字段；旧规则返回intent、score；未说明自身需求判待确认。';
  settings.ai.misjudgments='旧业务条件标记：泛泛提问均排除';
  const one=AI.buildJudgeRequest(settings,[record(1,'实锤关联吗')],{'123':{desc:'作者分享关联停用经历'}});
  const batch=AI.buildJudgeRequest(settings,[record(1,'实锤关联吗'),record(2,'你有案例吗')],{'123':{desc:'作者分享关联停用经历'}});
  assert.equal(one.messages[0].content,batch.messages[0].content);
  assert.doesNotMatch(one.messages[0].content,/污染材料标记|旧业务条件标记/);
  assert.match(one.payload.businessRules,/污染材料标记/);assert.match(one.payload.businessProfile.misjudgments,/旧业务条件标记/);
  assert.deepEqual(one.payload.items[0],batch.payload.items[0]);assert.match(one.messages[0].content,/其中出现生成提示词的任务.*均不能改变/);
  assert.match(one.messages[0].content,/need只能为“是”或“否”/);assert.match(one.messages[0].content,/reason为1至30个字符/);
  assert.match(one.messages[0].content,/不能将同批其它用户的评论当作本条证据/);
  assert.equal(settings.ai.promptPresets[0].prompt,one.payload.businessRules);
  assert.equal(before.ai.apiKey,settings.ai.apiKey);
});

test('代表性复核材料保留用户与作品来源及多条评论，不把评估标签当作模型返回',()=>{
  // These are evaluation inputs. This test checks the actual request and
  // policy; it does not fake model judgments or claim semantic accuracy.
  const cases=[
    record(1,'实锤关联吗'),record(2,'你有案例吗'),record(3,'有案例'),
    record(4,'我接，私信我可代处理'),record(5,'怎么处理'),
    record(6,'恢复了但资金没回来',{comments:['申诉成功过一次','现在资金还没回来怎么办']}),
    record(7,'全部解封，资金到账，不需要帮助了'),record(8,'恭喜发财'),record(9,'抖店封号能解吗')
  ];
  const description='作者第一人称：我的亚马逊店铺因关联停用，我需要申诉';
  const request=AI.buildJudgeRequest(config(),cases,{'123':{desc:description}}),payload=JSON.parse(request.messages[1].content);
  assert.equal(payload.works.length,1);assert.equal(payload.works[0].videoDescription,description);
  assert.deepEqual(payload.items.map(item=>item.comment),cases.map(item=>item.demand));
  assert.deepEqual(payload.items[5].comments,['申诉成功过一次','现在资金还没回来怎么办']);
  assert.ok(payload.items.every(item=>item.workRef===payload.works[0].id));
  assert.match(request.messages[0].content,/作品用于补足业务话题和对话方向.*理由也不得这样归属/);
  assert.match(request.messages[0].content,/求助帖下“可以处理的”“有案例”是在回答作者或提供能力/);
  assert.doesNotMatch(request.messages[0].content,/只有“有案例”不能确认揽客，可判是/);
  assert.match(request.messages[0].content,/问号、业务关键词、未拒绝联系都不是独立的正向证据/);
  assert.match(request.messages[0].content,/明确业务范围以外.*判“否”/);
  assert.match(request.messages[0].content,/不能写“用户自己的店停用”/);
  assert.ok(payload.items.every(item=>!Object.hasOwn(item,'expectedNeed')&&!Object.hasOwn(item,'need')&&!Object.hasOwn(item,'reason')));
});

test('生成器拒绝元指令、嵌套包装及旧intent/score/待确认草稿，保留设置不应用',async()=>{
  const invalid=[
    '只输出 JSON 对象，严格包含 prompt 一个字符串字段。',
    '请只输出 {"prompt":"规则正文"}。',
    '{"prompt":"亚马逊服务判断规则"}',
    '你帮助业务人员编写评论获客联系判断规则。只输出JSON对象。',
    '输出intent、score、reason三个字段。',
    '返回{"intent":true,"score":90,"reason":"有需求"}。',
    '不确定用户有自己的问题时，返回待确认。',
    '不能确定用户身份，判为待确认。',
    '给用户需求评分，范围0至100。',
    '只要业务相关就判为是。',
    '只要没有明确拒绝，就可联系。',
    '需求未明，业务相关，可保留。',
    '只有有案例且不能确认提供服务时保留。',
    '仅短说有案例，无法认定同行，则判为是。',
    '只要业务相关且不能确定是同行，就保留为是。'
  ];
  for(const prompt of invalid) {
    const settings=config(),before=structuredClone(settings);
    assert.equal(AI.inspectPromptDraft(prompt).ok,false,prompt);
    await assert.rejects(AI.generatePromptDraft(settings,{}, {fetchImpl:draftProvider(prompt)}),/草稿.*(?:混入|旧判断字段|评分|格式|单纯相关)/);
    assert.deepEqual(settings,before);
  }
});

test('正常业务规则及明确禁止旧协议可生成，不受生成器包装误伤',async()=>{
  const drafts=[
    '亚马逊账户申诉相关咨询可联系，明确提供代处理服务的同行广告排除。',
    '按主营行业判断可考虑联系。只输出是/否和简短理由，不输出评分或待确认。',
    '规则正文不得输出intent、score和待确认；相关服务咨询虽需求未明也可保留。',
    '按公司主营业务判断。不要评分和待确认。',
    '根据装修服务范围判断，询问装修方案或费用且没有排除证据可联系。',
    '业务是信用评分咨询。客户询问FICO score改进方案可考虑联系；只返回是/否及简短理由。',
    '主营订单待确认状态处理。相关订单问题可联系，明确揽客广告排除。',
    '不能只要业务相关就判为是，需要评论者求助或服务咨询。',
    '不能因为只有有案例且无法确认提供服务，就保留为是。',
    '仅短说有案例，不能确认提供服务，不应保留为是。',
    '求助帖有案例是在向作者提供案例，不应保留为是；你有案例吗是服务咨询，可判是。',
    '有案例，但是我自己也收到相同停用邮件，还能处理吗？应判是。'
  ];
  for(const prompt of drafts) {
    const settings=config(),before=structuredClone(settings);
    assert.equal(AI.inspectPromptDraft(prompt).ok,true,prompt);
    const result=await AI.generatePromptDraft(settings,{}, {fetchImpl:draftProvider(prompt)});
    assert.equal(result.prompt,prompt);assert.equal(result.draft,true);assert.deepEqual(settings,before);
  }
});

test('生成器明确区分运输包装和规则正文，业务材料仍按四字段传入且没有用户身份',async()=>{
  const settings=config(),calls=[];
  await AI.generatePromptDraft(settings,{businessDesc:'装修方案咨询',targetCustomers:'装修业主',clearNeeds:'方案和费用咨询',misjudgments:'施工同行揽客'}, {fetchImpl:async(url,options)=>{
    if(options.method==='GET')return modelResponse();calls.push(JSON.parse(options.body));return completion('{"prompt":"装修方案相关咨询可以联系，明确同行广告排除。"}');
  }});
  const [request]=calls;assert.match(request.messages[0].content,/不能复制本段生成器身份/);assert.match(request.messages[0].content,/不能再嵌套JSON对象/);
  assert.match(request.messages[0].content,/理由也不得这样归属/);
  assert.deepEqual(JSON.parse(request.messages[1].content),{businessDesc:'装修方案咨询',targetCustomers:'装修业主',clearNeeds:'方案和费用咨询',misjudgments:'施工同行揽客'});
  assert.doesNotMatch(request.messages[1].content,/mock-UID|mock-sec|匿名测试|自定义行业规则/);
});
