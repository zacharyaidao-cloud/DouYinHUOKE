'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const qaRoot=path.resolve(__dirname,'../../build-tools');
const dir=fs.mkdtempSync(path.join(qaRoot,'qa-store-'));
process.env.DY_LEAD_DATA_DIR=dir;
const store=require('../store');
after(()=>fs.rmSync(dir,{recursive:true,force:true}));

test('综合搜索保存每件作品实际类型；旧mixed记录按原始图文链接读取而不改写文件',()=>{
  store.setSearchResults([]);
  store.addSearchResults('本地类型测试','mixed',[
    {awemeId:'7000000000000000001',workType:'note',link:'https://www.douyin.com/note/7000000000000000001'},
    {awemeId:'7000000000000000002',workType:'video',link:'https://www.douyin.com/video/7000000000000000002'}
  ]);
  assert.deepEqual(store.getSearchResults().map(work=>work.workType),['note','video']);
  assert.deepEqual(store.getSearchResults().map(work=>work.searchType),['mixed','mixed']);
  store.setSearchResults([
    {awemeId:'7000000000000000003',workType:'mixed',link:'https://www.douyin.com/note/7000000000000000003'},
    {awemeId:'7000000000000000004',workType:'video',link:'https://www.douyin.com/note/7000000000000000004'}
  ]);
  const file=path.join(dir,'search-results.json'),before=fs.readFileSync(file,'utf8');
  assert.deepEqual(store.getSearchResults().map(work=>work.workType),['note','note']);
  assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('升级旧每日成功数会计入尝试额度，随后每次失败也增加尝试数',()=>{
  const day=store.opDayStr();store.setDaily({'1':{[day]:{follow:4,dm:3,videos:2}}});
  assert.equal(store.getDailyUsage('1').dmAttempts,3);
  store.bumpDaily('1','dmAttempts');store.bumpDaily('1','followAttempts');store.bumpDaily('1','collectAttempts');
  const usage=store.getDailyUsage('1');assert.equal(usage.dmAttempts,4);assert.equal(usage.followAttempts,5);assert.equal(usage.collectAttempts,3);assert.equal(usage.dm,3);
});
test('新版删除旧工作时段和休息设置，保留必要异常保护',()=>{
  store.setSettings({human:{workStart:'09:00',workEnd:'18:00'}});assert.equal(Object.hasOwn(store.getSettings().human,'workPeriods'),false);
  store.setSettings({human:{workStart:'09:00',workEnd:'18:00',workPeriods:[]},license:{enabled:false,adminKey:'must-not-leak'}});
  assert.deepEqual(store.getSettings().human,{timeZone:'Asia/Shanghai',maxConsecutiveErrors:3});assert.equal(store.getSettings().license.enabled,true);assert.equal(Object.hasOwn(store.getSettings().license,'adminKey'),false);
});
test('新marker保存后保留明确设置的零和小数采集间隔',()=>{
  for(const collect of [{scrollIntervalSec:0,linkIntervalSec:0},{scrollIntervalSec:.5,linkIntervalSec:1.5}]) {
    store.setSettings({collect:{...collect,autoAiAfterCollect:false},action:{pacingVersion:1,userIntervalSec:.5,userIntervalJitter:.1}});const preserved=store.getSettings();
    assert.equal(preserved.collect.scrollIntervalSec,collect.scrollIntervalSec);
    assert.equal(preserved.collect.linkIntervalSec,collect.linkIntervalSec);
    assert.equal(Object.hasOwn(preserved.human,'breakEvery'),false);assert.equal(preserved.collect.scrollJitter,.4);
    assert.equal(preserved.collect.autoAiAfterCollect,false);assert.equal(preserved.action.userIntervalSec,.5);assert.equal(preserved.action.userIntervalJitter,.1);
  }
});
test('新安装使用全新统一动作间隔和三提示词，旧设置迁移保留自定义规则',()=>{
  store.setSettings({}); const fresh=store.getSettings();
  assert.deepEqual(fresh.action,{userIntervalSec:20,userIntervalJitter:.25,pacingVersion:1});
  assert.equal(fresh.collect.scrollIntervalSec,3);assert.equal(fresh.collect.scrollJitter,.4);assert.equal(fresh.collect.linkIntervalSec,10);assert.equal(fresh.collect.linkIntervalJitter,.2);assert.equal(fresh.collect.autoAiAfterCollect,true);
  assert.equal(fresh.ai.apiKey,'');assert.equal(fresh.ai.model,'deepseek-flash');
  assert.equal(fresh.ai.batchMode,'auto');assert.equal(fresh.ai.batchMaxChars,24000);assert.equal(fresh.ai.batchMaxCount,20);
  assert.equal(fresh.ai.promptPresets.length,3);assert.equal(fresh.ai.activePromptId,'prompt-1');
  assert.equal(fresh.ai.promptPresets[1].prompt,'');assert.equal(fresh.ai.promptPresets[2].prompt,'');
  for(const field of ['businessDesc','targetCustomers','clearNeeds','misjudgments']) assert.ok(fresh.ai[field].trim());
  for(const label of ['【用户评论】{需求内容}','【评论时间】{评论时间}','【用户UID】{UID}','【用户名称】{昵称}','【所在视频描述】{视频描述}']) assert.ok(fresh.ai.prompt.includes(label));
  store.setSettings({follow:{intervalMinSec:60,intervalMaxSec:180},dm:{intervalMinSec:90,intervalMaxSec:240},ai:{baseUrl:'https://old-provider.invalid',prompt:'旧行业独立规则',positiveExamples:'明确需求样本',exclusions:'同行广告',ambiguousCases:'不明问题'}});
  const migrated=store.getSettings();assert.deepEqual(migrated.action,{userIntervalSec:20,userIntervalJitter:.25,pacingVersion:1});
  assert.equal(Object.hasOwn(migrated.follow,'intervalMinSec'),false);assert.equal(Object.hasOwn(migrated.dm,'intervalMaxSec'),false);
  assert.equal(migrated.ai.promptPresets[0].prompt,'旧行业独立规则');assert.equal(migrated.ai.clearNeeds,'明确需求样本');assert.equal(migrated.ai.misjudgments,'同行广告\n不明问题');
  assert.equal(migrated.ai.baseUrl,'https://api.deepseek.com');assert.equal(Object.hasOwn(migrated.ai,'exclusions'),false);
  const explicit={...migrated,action:{userIntervalSec:12,userIntervalJitter:.23,pacingVersion:1}};store.setSettings(explicit);assert.deepEqual(store.getSettings().action,{userIntervalSec:12,userIntervalJitter:.23,pacingVersion:1});
});
test('首次节奏迁移只重设三组节奏与自动AI，保留API规则话术额度及全部数据',()=>{
  const original={collect:{scrollIntervalSec:27,scrollJitter:.1,linkIntervalSec:90,linkIntervalJitter:.7,autoAiAfterCollect:false,maxScrolls:77,dailyVideoLimit:128,cooldownHours:12},action:{intervalMinSec:50,intervalMaxSec:190},follow:{enabled:false,dailyLimit:57},dm:{enabled:true,dailyLimit:36,template:'客户自己的话术',repeat:{enabled:true,intervalDays:15}},human:{workStart:'09:00',workEnd:'18:00',workPeriods:[{start:'10:00',end:'12:00'}],preDwellMinSec:2,preDwellMaxSec:9,breakEvery:5,breakMinSec:8,breakMaxSec:18,maxConsecutiveErrors:4,timeZone:'Asia/Shanghai'},ai:{apiKey:'fixture-no-network',model:'custom-model',intervalSec:999,intervalJitter:.9,activePromptId:'prompt-2',promptPresets:[{id:'prompt-1',name:'自定义1',prompt:'独立规则1'},{id:'prompt-2',name:'自定义2',prompt:'独立规则2'},{id:'prompt-3',name:'自定义3',prompt:'独立规则3'}]}};
  const snapshot=structuredClone(original);
  store.setLeads([{id:'keep-lead',dmCount:2,aiNeed:'是'}]);store.setAccounts([{id:'keep-account',loggedIn:true}]);store.setVideos({'keep-video':{desc:'原作品资料'}});
  const before=Object.fromEntries(['leads','accounts','videos'].map(key=>[key,fs.readFileSync(store.F[key],'utf8')]));
  store.setSettings(original);const migrated=store.getSettings();
  assert.deepEqual(original,snapshot);assert.equal(migrated.collect.scrollIntervalSec,3);assert.equal(migrated.collect.scrollJitter,.4);
  assert.equal(migrated.collect.linkIntervalSec,10);assert.equal(migrated.collect.linkIntervalJitter,.2);assert.equal(migrated.collect.autoAiAfterCollect,true);
  assert.deepEqual(migrated.action,{userIntervalSec:20,userIntervalJitter:.25,pacingVersion:1});
  for(const key of ['maxScrolls','dailyVideoLimit','cooldownHours'])assert.equal(migrated.collect[key],original.collect[key]);
  assert.equal(migrated.follow.enabled,false);assert.equal(migrated.follow.dailyLimit,57);assert.equal(migrated.dm.dailyLimit,36);
  assert.equal(migrated.dm.template,original.dm.template);assert.deepEqual(migrated.dm.repeat,original.dm.repeat);
  assert.equal(migrated.ai.apiKey,original.ai.apiKey);assert.equal(migrated.ai.model,original.ai.model);assert.equal(migrated.ai.activePromptId,'prompt-2');assert.deepEqual(migrated.ai.promptPresets,original.ai.promptPresets);
  assert.deepEqual(migrated.human,{timeZone:'Asia/Shanghai',maxConsecutiveErrors:4});
  assert.equal(Object.hasOwn(migrated.ai,'intervalSec'),false);assert.equal(Object.hasOwn(migrated.ai,'intervalJitter'),false);
  for(const key of Object.keys(before))assert.equal(fs.readFileSync(store.F[key],'utf8'),before[key]);
  assert.deepEqual(store.normalizeSettings(migrated),migrated,'新版对象重复归一化必须保持不变');
});

test('精确旧内置组合升级规则和默认预算，任何自定义prompt业务或预算保留且缺省自动模式',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../store.js'),'utf8');
  const oldPromptLiteral=source.match(/const LEGACY_BUILTIN_PROMPT = ('(?:[^'\\]|\\.)*');/)[1];
  const oldBusinessLiteral=source.match(/const LEGACY_BUILTIN_BUSINESS = (\{[\s\S]*?\n\});/)[1];
  const oldPrompt=Function('return '+oldPromptLiteral)(), oldBusiness=Function('return ('+oldBusinessLiteral+')')();
  const old=()=>({ai:{...oldBusiness,apiKey:'mock-only-preserve',model:'deepseek-v4-pro',batchMaxChars:3000,batchMaxCount:20,activePromptId:'prompt-1',promptPresets:[{id:'prompt-1',name:'亚马逊账户服务',prompt:oldPrompt},{id:'prompt-2',name:'提示词 2',prompt:''},{id:'prompt-3',name:'提示词 3',prompt:''}]}});
  store.setSettings(old());const upgraded=store.getSettings();assert.equal(upgraded.ai.batchMaxChars,24000);assert.equal(upgraded.ai.batchMode,'auto');assert.notEqual(upgraded.ai.prompt,oldPrompt);assert.match(upgraded.ai.prompt,/是否可考虑联系/);assert.equal(upgraded.ai.apiKey,'mock-only-preserve');assert.equal(upgraded.ai.model,'deepseek-v4-pro');
  for(const changed of ['prompt','business','budget','third-slot']) {
    const config=old();if(changed==='prompt')config.ai.promptPresets[0].prompt+='自定义';if(changed==='business')config.ai.businessDesc='自定义业务';if(changed==='budget')config.ai.batchMaxChars=6000;if(changed==='third-slot')config.ai.promptPresets[2].prompt='保留另一套规则';
    const expected=structuredClone(config);store.setSettings(config);const saved=store.getSettings();
    assert.equal(saved.ai.apiKey,expected.ai.apiKey);assert.equal(saved.ai.batchMaxChars,expected.ai.batchMaxChars);assert.equal(saved.ai.businessDesc,expected.ai.businessDesc);assert.equal(saved.ai.batchMode,'auto');
    if(['prompt','business'].includes(changed)) assert.equal(saved.ai.promptPresets[0].prompt,expected.ai.promptPresets[0].prompt);
    if(changed==='third-slot') assert.equal(saved.ai.promptPresets[2].prompt,'保留另一套规则');
  }
  const manual=old();manual.ai.batchMode='manual';manual.ai.batchMaxChars=5555;manual.ai.batchMaxCount=7;store.setSettings(manual);assert.equal(store.getSettings().ai.batchMode,'manual');assert.equal(store.getSettings().ai.batchMaxChars,5555);assert.equal(store.getSettings().ai.batchMaxCount,7);
});
test('未修改的默认槽可升级而保留启用的自定义槽、API、预算和其它数据',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../store.js'),'utf8');
  const oldPrompt=Function('return '+source.match(/const LEGACY_BUILTIN_PROMPT = ('(?:[^'\\]|\\.)*');/)[1])();
  const oldBusiness=Function('return ('+source.match(/const LEGACY_BUILTIN_BUSINESS = (\{[\s\S]*?\n\});/)[1]+')')();
  const custom='自定义行业材料需要完整保留';
  const sourceSettings={ai:{...oldBusiness,apiKey:'mock-preserved-only',model:'deepseek-v4-pro',activePromptId:'prompt-2',batchMode:'manual',batchMaxChars:5555,batchMaxCount:7,promptPresets:[{id:'prompt-1',name:'亚马逊账户服务',prompt:oldPrompt},{id:'prompt-2',name:'自定义规则',prompt:custom},{id:'prompt-3',name:'提示词 3',prompt:''}]}};
  const upgraded=store.normalizeSettings(sourceSettings);
  assert.equal(upgraded.ai.activePromptId,'prompt-2');assert.equal(upgraded.ai.prompt,custom);
  assert.equal(upgraded.ai.promptPresets[1].prompt,custom);assert.equal(upgraded.ai.apiKey,'mock-preserved-only');assert.equal(upgraded.ai.model,'deepseek-v4-pro');
  assert.equal(upgraded.ai.batchMaxChars,5555);assert.equal(upgraded.ai.batchMaxCount,7);assert.equal(upgraded.ai.batchMode,'manual');
  assert.equal(upgraded.ai.promptPresets[0].prompt,store.DEFAULT_SETTINGS.ai.promptPresets[0].prompt);
  assert.equal(upgraded.ai.clearNeeds,store.DEFAULT_SETTINGS.ai.clearNeeds);
  assert.equal(sourceSettings.ai.promptPresets[0].prompt,oldPrompt,'normalize must not mutate saved source');
  const profile=store.getIndustryProfile();assert.deepEqual(Object.keys(profile).sort(),['businessInput','keywords','prompt']);
  assert(!JSON.stringify(profile).includes('mock-preserved-only'));assert(!Object.hasOwn(profile.businessInput,'apiKey'));
  assert(profile.prompt.includes(require('../lib/ai-policy').CONTACT_POLICY));assert.equal(require('../ai').inspectPromptDraft(profile.prompt).ok,true);
  profile.keywords.intent.push('不可污染默认');assert(!store.getIndustryProfile().keywords.intent.includes('不可污染默认'));
});

test('计划与检查点持久保存，不合法账号路径不能越出数据目录',()=>{
  store.setPlans([{id:'qa-plan',leadIds:['1']}]);assert.equal(store.getPlans()[0].leadIds[0],'1');
  store.setTaskCheckpoint({state:'paused',processedLeadIds:['1']});assert.equal(store.getTaskCheckpoint().state,'paused');
  assert.throws(()=>store.profileDir('../outside'),/标识无效/);assert.equal(path.dirname(store.profileDir('123')),store.PROFILE_DIR);
});
test('精确旧默认关键词升级，新设置保存会同步历史粗筛并保留AI和联系记录',()=>{
  const K=require('../lib/keyword-screen');
  const original={id:1,demand:'协议三',trigger:'',intent:false,excluded:false,aiDone:true,aiNeed:'否',aiReason:'fixture-only',aiPromptVersion:'fixture-version',aiInputHash:'fixture-hash',accountId:'fixture',uid:'fixture-user',dmCount:2,followedAt:'fixture-time',doNotContact:true};
  store.setLeads([original]);
  fs.writeFileSync(store.F.settings,JSON.stringify({keywords:{intent:[...K.LEGACY_DEFAULT_INTENT],exclude:[]}}),'utf8');
  assert.deepEqual(store.getSettings().keywords,K.normalizeKeywords(K.DEFAULT_KEYWORDS));
  store.setSettings(store.getSettings());
  assert.deepEqual(store.getLeads()[0],{...original,trigger:'协议三',intent:true,excluded:false});
  store.setSettings({...store.getSettings(),keywords:{intent:['客户词','ＡＳＩＮ'],exclude:['客户排除']}});
  assert.deepEqual(store.getSettings().keywords,{intent:['客户词','asin'],exclude:['客户排除']});
  assert.deepEqual(store.getLeads()[0],original);
});
test('不相关设置或关键词换序保存不会重写线索数据',()=>{
  store.setSettings({keywords:{intent:['申诉','封店'],exclude:[]}});
  const stable={id:2,demand:'申诉',trigger:'申诉',intent:true,excluded:false};store.setLeads([stable]);
  const bytes=fs.readFileSync(store.F.leads,'utf8');
  const current=store.getSettings();current.human.breakEvery=12;current.keywords.intent.reverse();store.setSettings(current);
  assert.equal(fs.readFileSync(store.F.leads,'utf8'),bytes);
});
test('损坏数据文件会明确报错，不会静默返回空库覆盖原数据',()=>{
  fs.writeFileSync(store.F.leads,'{broken','utf8');assert.throws(()=>store.getLeads(),/读取失败/);assert.equal(fs.readFileSync(store.F.leads,'utf8'),'{broken');
  const bytes=fs.readFileSync(store.F.settings,'utf8');
  assert.throws(()=>store.setSettings({...store.getSettings(),keywords:{intent:['新增词'],exclude:[]}}),/读取失败/);
  assert.equal(fs.readFileSync(store.F.settings,'utf8'),bytes);
});
