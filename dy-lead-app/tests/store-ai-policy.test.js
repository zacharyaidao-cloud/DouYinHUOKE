'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const policy=require('../lib/ai-policy');
const fixture=fs.mkdtempSync(path.resolve(__dirname,'../../build-tools/qa-policy-store-'));
process.env.DY_LEAD_DATA_DIR=fixture;
const store=require('../store');
after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
const source=fs.readFileSync(path.resolve(__dirname,'../store.js'),'utf8');
function sourceConstant(name) {
  const match=source.match(new RegExp('const '+name+' = ([\\s\\S]*?);\\r?\\n'));
  assert(match,'Expected migration identifier '+name);
  return JSON.parse(JSON.stringify(vm.runInNewContext('('+match[1]+')',policy,{timeout:1000})));
}
const widePrompt=sourceConstant('WIDE_V2211_INDUSTRY_PROMPT');
const wideBusiness=sourceConstant('WIDE_V2211_BUILTIN_BUSINESS');
const previousPrompt=sourceConstant('PREVIOUS_INDUSTRY_PROMPT');
const previousBusiness=sourceConstant('PREVIOUS_BUILTIN_BUSINESS');
const oldSettings=()=>({
  ai:{...wideBusiness,apiKey:'synthetic-api-key-must-be-preserved',model:'deepseek-v4-pro',batchMode:'manual',batchMaxChars:3000,batchMaxCount:20,intervalSec:1.5,requestTimeoutSec:37,activePromptId:'prompt-2',promptPresets:[
    {id:'prompt-1',name:'亚马逊账户服务',prompt:widePrompt},
    {id:'prompt-2',name:'用户自定义规则二',prompt:'自定义行业条件二，保留原文'},
    {id:'prompt-3',name:'用户自定义规则三',prompt:'自定义行业条件三，保留原文'}
  ]},
  keywords:{intent:['客户自定义词'],exclude:['客户排除词']},
  action:{intervalMinSec:12,intervalMaxSec:23},collect:{dailyVideoLimit:17,maxScrolls:9},
  dm:{template:'用户已有话术',dailyLimit:13},outreach:{businessId:'customer-business'},
  human:{workPeriods:[{start:'10:00',end:'12:00'}],timeZone:'Asia/Shanghai'}
});

test('2.2.11旧宽政策字面值稳定保留，实际判断和新默认仅引用请求方向政策',()=>{
  assert.equal(crypto.createHash('sha256').update(policy.LEGACY_CONTACT_POLICY_V2211).digest('hex'),'99d47aeb5dd1839c9bab43fa7cb5f767269a35959ad93867a4bd75c34cf4fff7');
  assert.equal(policy.CONTACT_POLICY_VERSION,'contact-v4-request-direction');
  assert.notEqual(policy.CONTACT_POLICY,policy.LEGACY_CONTACT_POLICY_V2211);
  assert(widePrompt.includes(policy.LEGACY_CONTACT_POLICY_V2211));
  const defaults=store.getIndustryProfile();
  assert(defaults.prompt.includes(policy.CONTACT_POLICY));assert(!defaults.prompt.includes(policy.LEGACY_CONTACT_POLICY_V2211));
  assert.match(defaults.prompt,/不能仅因业务相关、没有拒绝或无法证明同行就保留为“是”/);
  assert.match(defaults.prompt,/作品作者的停用、冻结或求助不能代替评论者本人的需求/);
  assert.match(defaults.prompt,/仅回答求助作者/);assert.match(defaults.prompt,/纯评价/);assert.match(defaults.prompt,/分享既往经验却没有新求助或咨询/);
  assert.match(defaults.businessInput.clearNeeds,/本人或朋友当前相关问题/);
  assert.match(defaults.businessInput.clearNeeds,/不要求明确购买/);
  assert.match(defaults.prompt,/“否”表示本条未见相关求助、服务咨询或本人\/朋友当前问题证据/);
  assert.match(defaults.prompt,/具体账户问题作品下[\s\S]*已将作品描述的问题指向本人[\s\S]*判“是”/);
  assert.match(defaults.prompt,/没有相关求助、服务咨询或本人\/朋友当前问题证据时判“否”/);
  assert.match(defaults.prompt,/评论的明确对象优先于作品话题/);
  assert.match(defaults.businessInput.misjudgments,/主动表示本人或朋友遇到同样当前问题则判是/);
  assert.deepEqual(policy.RESULT_CONTRACT,{version:3,fields:['i','need','reason'],needs:['是','否'],maxReasonChars:30});
});

test('精确宽版内置槽及业务升级，保留自定义槽启用选择、API、模型、预算和其它设置',()=>{
  const original=oldSettings(),snapshot=structuredClone(original),upgraded=store.normalizeSettings(original);
  assert.deepEqual(original,snapshot,'Normalization cannot mutate the original saved object');
  assert.equal(upgraded.ai.promptPresets[0].prompt,store.DEFAULT_SETTINGS.ai.promptPresets[0].prompt);
  assert.deepEqual(upgraded.ai.promptPresets.slice(1),snapshot.ai.promptPresets.slice(1));
  assert.equal(upgraded.ai.activePromptId,'prompt-2');assert.equal(upgraded.ai.prompt,snapshot.ai.promptPresets[1].prompt);
  for(const field of ['apiKey','model','batchMode','batchMaxChars','batchMaxCount','requestTimeoutSec'])assert.equal(upgraded.ai[field],snapshot.ai[field]);
  assert.equal(Object.hasOwn(upgraded.ai,'intervalSec'),false);assert.equal(Object.hasOwn(upgraded.ai,'intervalJitter'),false);
  for(const field of ['businessDesc','targetCustomers','clearNeeds','misjudgments'])assert.equal(upgraded.ai[field],store.DEFAULT_SETTINGS.ai[field]);
  assert.deepEqual(upgraded.keywords,snapshot.keywords);assert.deepEqual(upgraded.action,{userIntervalSec:30,userIntervalJitter:.4,pacingVersion:1});
  assert.equal(upgraded.collect.dailyVideoLimit,17);assert.equal(upgraded.collect.maxScrolls,9);
  assert.equal(upgraded.dm.template,'用户已有话术');assert.equal(upgraded.dm.dailyLimit,13);
  assert.equal(upgraded.outreach.businessId,'customer-business');assert.equal(Object.hasOwn(upgraded.human,'workPeriods'),false);
  assert.deepEqual(upgraded.human,{timeZone:snapshot.human.timeZone,maxConsecutiveErrors:3});
});

test('宽版内置为启用槽时也保留后设置的3000预算，新迁移可重复且不会重置自定义槽',()=>{
  const original=oldSettings();original.ai.activePromptId='prompt-1';original.ai.promptPresets[1].prompt='';original.ai.promptPresets[2].prompt='';
  const upgraded=store.normalizeSettings(original);
  assert.equal(upgraded.ai.activePromptId,'prompt-1');assert.equal(upgraded.ai.prompt,store.DEFAULT_SETTINGS.ai.promptPresets[0].prompt);
  assert.equal(upgraded.ai.batchMaxChars,3000);assert.equal(upgraded.ai.batchMaxCount,20);assert.equal(upgraded.ai.batchMode,'manual');
  assert.deepEqual(store.normalizeSettings(upgraded),upgraded);
});

test('任何默认正文、名称或四项业务改动均不自动迁移，不跨版本拼接识别旧默认',()=>{
  const changes=['prompt','name','businessDesc','targetCustomers','clearNeeds','misjudgments','mixed-version'];
  for(const changed of changes) {
    const original=oldSettings();
    if(changed==='prompt')original.ai.promptPresets[0].prompt+='\n用户新增条件';
    else if(changed==='name')original.ai.promptPresets[0].name='用户自定义名称';
    else if(changed==='mixed-version')Object.assign(original.ai,previousBusiness);
    else original.ai[changed]+='用户新增说明';
    const before=structuredClone(original),normalized=store.normalizeSettings(original);
    assert.deepEqual(normalized.ai.promptPresets,before.ai.promptPresets,changed);
    for(const field of ['businessDesc','targetCustomers','clearNeeds','misjudgments','apiKey','model','batchMaxChars','batchMaxCount','activePromptId'])assert.equal(normalized.ai[field],before.ai[field],changed+' '+field);
  }
});

test('旧版各内置正文与对应业务成对迁移，别的自定义预设始终原样保留',()=>{
  const original=oldSettings();Object.assign(original.ai,previousBusiness);original.ai.promptPresets[0].prompt=previousPrompt;
  const upgraded=store.normalizeSettings(original);
  assert.equal(upgraded.ai.promptPresets[0].prompt,store.DEFAULT_SETTINGS.ai.promptPresets[0].prompt);
  assert.equal(upgraded.ai.prompt,original.ai.promptPresets[1].prompt);assert.deepEqual(upgraded.ai.promptPresets.slice(1),original.ai.promptPresets.slice(1));
  assert.equal(upgraded.ai.batchMaxChars,3000);assert.equal(upgraded.ai.apiKey,original.ai.apiKey);
});

test('语义迁移或默认草稿不接触线索、账号、浏览器资料和授权API',()=>{
  const leads=[{id:1,aiDone:true,aiNeed:'是',aiReason:'原回执',aiScore:null,uid:'synthetic-user',dmCount:1,followedAt:'旧记录'}];
  const accounts=[{id:'synthetic-account',loggedIn:true,profile:'synthetic-profile'}];
  store.setLeads(leads);store.setAccounts(accounts);
  fs.writeFileSync(store.F.settings,JSON.stringify(oldSettings()),'utf8');
  const leadBytes=fs.readFileSync(store.F.leads),accountBytes=fs.readFileSync(store.F.accounts);
  store.setSettings(oldSettings());
  assert.deepEqual(fs.readFileSync(store.F.leads),leadBytes);assert.deepEqual(fs.readFileSync(store.F.accounts),accountBytes);
  const defaults=store.getIndustryProfile();assert(!JSON.stringify(defaults).includes('synthetic-api-key'));
  assert.equal(Object.hasOwn(defaults.businessInput,'apiKey'),false);defaults.businessInput.clearNeeds='不能污染默认';
  assert.notEqual(store.getIndustryProfile().businessInput.clearNeeds,'不能污染默认');
});
