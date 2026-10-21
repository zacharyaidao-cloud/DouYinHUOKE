'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {filterLeads}=require('../lead-query');
const {createStartupLoginScan}=require('../lib/startup-login-scan');
const {persistLoginResult}=require('../lib/account-login');
function fixture() {
  let handler,authorize; let revoked=false; const calls=[];
  let accounts=[{id:1,name:'执行号'}];
  let clock=Date.now(),timerSequence=0,startupCoordinator;
  const timers=new Map();
  const controlTimers=new Map(),processHandlers=new Map(),sentIpc=[];
  class FixtureDate extends Date { constructor(...args) { super(...(args.length?args:[clock])); } static now(){return clock;} }
  // Run the production lease against the fixture clock without replacing its
  // concurrency logic or sharing its timers with the startup-scan scheduler.
  const controlModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/browser-control-lease.js'),'utf8'),{
    module:controlModule,Date:FixtureDate,Promise,
    setTimeout:(fn,delay)=>{const timer={id:++timerSequence,delay,unref:()=>{}};controlTimers.set(timer,fn);return timer;},
    clearTimeout:timer=>controlTimers.delete(timer)
  });
  let leads=[{id:1,uid:'u1',accountId:'1',nickname:'甲',demand:'价格',trigger:'价格',aiNeed:'是'},{id:2,uid:'u2',accountId:'1',nickname:'乙',demand:'旁观',aiNeed:'否'},{id:3,uid:'u1',accountId:'2',nickname:'甲'}];
  let plans=[];
  let videos={};
  let settings={collect:{scrollIntervalSec:1,cooldownHours:1,dailyVideoLimit:3,linkIntervalSec:2,maxScrolls:10,scrollJitter:0.2,linkIntervalJitter:0.2},follow:{intervalMinSec:1,intervalMaxSec:2,dailyLimit:3},dm:{intervalMinSec:1,intervalMaxSec:2,dailyLimit:3,repeat:{intervalDays:7}},human:{preDwellMinSec:0,preDwellMaxSec:1,breakEvery:1,breakMinSec:1,breakMaxSec:2,workPeriods:[],timeZone:'Asia/Shanghai',maxConsecutiveErrors:3},ai:{baseUrl:'https://example.org',intervalSec:1,intervalJitter:0.2,batchMaxChars:1000,batchMaxCount:10,requestTimeoutSec:60},keywords:{intent:[],exclude:[]},outreach:{businessId:'default'},license:{enabled:true}};
  settings.collect.autoAiAfterCollect=true;settings.action={userIntervalSec:10,userIntervalJitter:.4,pacingVersion:1};settings.ai={...settings.ai,baseUrl:'https://api.deepseek.com',apiKey:'mock-only-not-used',model:'deepseek-flash',businessDesc:'测试业务',targetCustomers:'测试客户',clearNeeds:'明确测试问题',misjudgments:'同行广告',activePromptId:'prompt-1',promptPresets:[{id:'prompt-1',name:'提示词1',prompt:'测试规则'},{id:'prompt-2',name:'提示词2',prompt:''},{id:'prompt-3',name:'提示词3',prompt:''}]};
  settings.follow.enabled=true;settings.dm.enabled=true;settings.dm.template='您好';settings.dm.repeat.enabled=false;settings.ai.enabled=true;
  const clone=x=>JSON.parse(JSON.stringify(x));
  const store={getAccounts:()=>clone(accounts),setAccounts:x=>{accounts=clone(x);},getLeads:()=>clone(leads),setLeads:x=>{leads=clone(x);},getVideos:()=>clone(videos),getSettings:()=>clone(settings),setSettings:x=>{settings=clone(x);},getPlans:()=>clone(plans),getDailyUsage:()=>({}),nowStr:()=> '2026-10-08 12:00:00',todayStr:()=> '2026-10-08',log:()=>{},bumpDaily:(...a)=>calls.push(['daily',...a]),DATA_DIR:'qa',tailLog:()=>[]};
  store.getIndustryProfile=()=>({businessInput:{businessDesc:'公开行业业务',targetCustomers:'公开目标客户',clearNeeds:'公开相关问题',misjudgments:'公开排除规则'},prompt:'公开行业规则',keywords:{intent:['协议三'],exclude:[]}});
  const engine={taskState:{running:false},configure:x=>{authorize=x.authorize;},migrateLeads:()=>{},refreshLeadStatus:l=>{l.status=l.doNotContact?'do_not_contact':l.replied?'replied':l.dmState==='pending_verification'?'dm_pending':l.followState==='pending_verification'?'follow_pending':l.dmState==='confirmed_failure'?'dm_failed':l.followedAt&&l.dmCount?'followed_dm':l.dmCount?'dm_sent':l.followedAt?'followed':'new';},stopTask:()=>{calls.push(['stop']);return {ok:true};},createPlan:(accountId,kind,opts)=>{calls.push(['preview',opts]);const scoped=filterLeads(leads,{},opts.filters,opts);const plan={id:'plan1',planId:'plan1',accountId,kind,owner:opts.owner,actions:{follow:kind!=='dm',dm:kind!=='follow'},count:scoped.length,leads:scoped,expiresAt:new Date(Date.now()+60000).toISOString()};plans=[plan];return {ok:true,...plan};},followTask:async(...a)=>{calls.push(['follow',...a]);return {ok:true};},outreachTask:async(...a)=>{calls.push(['outreach',...a]);return {ok:true};},aiTask:async(...a)=>{calls.push(['ai',...a]);return {ok:true};}};
  let loginResult={ok:true,loggedIn:false,state:'logged_out',message:'请在手机确认登录'};
  engine.checkLogin=async id=>{calls.push(['check-login',id]);persistLoginResult(store,id,loginResult);return clone(loginResult);};
  engine.closeAccount=async id=>{calls.push(['close-account',id]);return {ok:true};};
  engine.openForLogin=async id=>{calls.push(['open-login',id]);return {ok:true};};
  let singleJudgeImplementation=async leadId=>({ok:true,leadId});
  engine.aiJudgeOne=async leadId=>{calls.push(['judge-one',leadId]);return singleJudgeImplementation(leadId);};
  let scanImplementation=async({onProgress})=>{
    const ids=store.getAccounts().map(account=>String(account.id));
    const accountStates=Object.fromEntries(ids.map(id=>[id,{state:'unknown',message:'等待检查',checked:false}]));
    let done=0;
    for(const id of ids) {
      if(engine.taskState.stopRequested)return {ok:false,total:ids.length,done,accountStates,message:'已停止检查'};
      accountStates[id]={state:'checking',message:'正在检查专用浏览器',checked:false};
      onProgress({total:ids.length,done,accountId:id,accountStates,message:'正在检查专用浏览器'});
      await authorize({kind:'login_scan_check',accountId:id});
      calls.push(['scan-account',id]);persistLoginResult(store,id,loginResult);
      accountStates[id]={state:loginResult.state,message:loginResult.message,checked:true};
      onProgress({total:ids.length,done:++done,accountId:id,accountStates,message:'已完成当前账号检查'});
    }
    return {ok:true,total:ids.length,done,accountStates,message:'本次启动检查完成'};
  };
  engine.scanAccountLogins=async options=>{
    calls.push(['scan-login']);
    Object.assign(engine.taskState,{kind:'login_scan',running:true,stopRequested:false});
    try{return await scanImplementation(options);}finally{engine.taskState.running=false;}
  };
  const originalStop=engine.stopTask;
  engine.stopTask=()=>{if(engine.taskState.running)engine.taskState.stopRequested=true;return originalStop();};
  const license={verify:async(user,pass)=>user==='qa'&&pass==='qa-pass'?{ok:true,username:user,authContext:{user},expiresAt:'2099-01-01'}:{ok:false,error:'无有效授权'},validateContext:()=>({ok:!revoked}),assertActionAllowed:async()=>{if(revoked)throw new Error('已停用');return {ok:true};},clearSession:()=>{},syncTime:async()=>{},status:()=>({enabled:true}),getLicenseConfig:()=>({enabled:true,serverUrl:'https://license.example.org'})};
  const defaultActionAuthorization=license.assertActionAllowed;
  const mockAi={getRuleSet:()=>({version:'current'}),listModels:async(settings,options)=>{await options.authorize();calls.push(['models',options.forceRefresh]);return {models:[{id:'deepseek-flash',name:'测试模型'}],selectedModel:settings.ai.model,fetchedAt:'2026-10-08T00:00:00Z'};},generatePromptDraft:async(settings,businessInput,options)=>{await options.authorize();calls.push(['draft',businessInput]);return {draft:true,prompt:'测试草稿'};},testPromptDraft:async(settings,input,options)=>{await options.authorize();calls.push(['prompt-test']);return {draft:true,results:[]};}};
  mockAi.inspectPromptDraft=require('../ai').inspectPromptDraft;
  mockAi.isStoredResultCurrent=require('../ai').isStoredResultCurrent;
  const deps={http:{createServer:f=>{handler=f;return {listen:(port,host,fn)=>fn(),address:()=>({port:17889}),on:()=>{},close:()=>{}};}},fs,path,crypto:require('node:crypto'),'./store':store,'./engine':engine,'./license.js':license,'./ai':mockAi,'./lead-query':require('../lead-query'),'./lib/startup-login-scan':{createStartupLoginScan:options=>{
    startupCoordinator=createStartupLoginScan({...options,setTimer:(fn,delay)=>{const timer={id:++timerSequence,delay,unref:()=>{}};timers.set(timer,fn);return timer;},clearTimer:timer=>timers.delete(timer)});
    return startupCoordinator;
  }}};
  deps['./lib/browser-control-lease']=controlModule.exports;
  const proc={env:{DY_LEAD_PORT:'0',DY_LEAD_DESKTOP_TOKEN:'desktop-qa'},connected:true,
    on:(event,fn)=>{const listeners=processHandlers.get(event)||[];listeners.push(fn);processHandlers.set(event,listeners);},
    send:message=>sentIpc.push(clone(message)),exit:code=>calls.push(['exit',code])};
  vm.runInNewContext(fs.readFileSync(process.env.DY_LEAD_QA_SERVER_PATH||path.join(__dirname,'../server.js'),'utf8'),{require:n=>deps[n]||require('node:module').createRequire(path.join(__dirname,'../server.js'))(n),__dirname:path.join(__dirname,'..'),process:proc,console:{log:()=>{},error:()=>{}},Buffer,URL,Intl,AbortController,Date:FixtureDate,setInterval:()=>({unref:()=>{}}),Promise});
  async function request(url,body,token='',nonce='desktop-qa',origin,httpMethod) {
    return new Promise((resolve,reject)=>{
      const req=new EventEmitter();Object.assign(req,{url,method:httpMethod||(body===undefined?'GET':'POST'),headers:{'x-desktop-token':nonce,'x-auth-token':token,...(origin?{origin}: {})},destroy:()=>{}});
      let code=200,headers={};const res={headersSent:false,writeHead:(c,h)=>{code=c;headers=h||{};res.headersSent=true;},end:s=>resolve({code,headers,body:Buffer.isBuffer(s)?s:JSON.parse(s||'{}')})};
      handler(req,res).catch(reject);if(body!==undefined)queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});
    });
  }
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  return {request,calls,authorize:()=>authorize,leads:()=>leads,settings:()=>clone(settings),setLeads:x=>{leads=clone(x);},setVideos:x=>{videos=clone(x);},setRunning:value=>{engine.taskState.running=value;},setTaskState:value=>Object.assign(engine.taskState,value),setLoginResult:value=>{loginResult=value;},revoke:()=>{revoked=true;},setLicenseStatus:fn=>{license.status=fn;},mockAi,
    accounts:()=>clone(accounts),setAccounts:value=>{accounts=clone(value);},recordFreshLogin:(id,result)=>persistLoginResult(store,id,result),setCloseImplementation:value=>{engine.closeAccount=value;},setScanImplementation:value=>{scanImplementation=value;},setSingleJudgeImplementation:value=>{singleJudgeImplementation=value;},taskState:()=>clone(engine.taskState),
    scanState:()=>startupCoordinator.readState(),pendingTimers:()=>[...timers.keys()].map(timer=>timer.delay),advanceClock:milliseconds=>{clock+=milliseconds;},flush,
    setTaskImplementation:(name,fn)=>{engine[name]=fn;},
    sendIpc:message=>{for(const fn of processHandlers.get('message')||[])fn(message);},
    ipcMessages:()=>clone(sentIpc),controlResults:id=>clone(sentIpc.filter(message=>message.type==='embedded:control-result'&&message.id===id)),
    setActionAuthorization:fn=>{license.assertActionAllowed=fn||defaultActionAuthorization;},
    pendingControlTimers:()=>[...controlTimers.keys()].map(timer=>timer.delay),
    fireControlTimer:async()=>{const next=controlTimers.entries().next();if(next.done)return false;const[timer,fn]=next.value;controlTimers.delete(timer);fn();await flush();return true;},
    fireNextTimer:async()=>{const next=timers.entries().next();if(next.done)return false;const[timer,fn]=next.value;timers.delete(timer);fn();await flush();return true;},
    fireNextTimerWithoutFlush:()=>{const next=timers.entries().next();if(next.done)return false;const[timer,fn]=next.value;timers.delete(timer);fn();return true;}
  };
}

async function prepareBrowserControl(f) {
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  assert.equal((await f.request('/api/accounts/1/check',{},token)).code,200);
  return token;
}

test('任务保留所属会话，结束后重新计时十分钟，空闲轮询和无关会话仍会过期',async t=>{
  for(const kind of ['ai','collect','search']) await t.test(kind,async()=>{
    const f=fixture(); let release; const gate=new Promise(resolve=>{release=resolve;});
    const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
    const unrelated=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
    f.setTaskImplementation(kind+'Task',async()=>{f.setRunning(true);await gate;f.setRunning(false);return {ok:true};});
    assert.equal((await f.request('/api/'+kind+'/start',{accountId:'1',keywords:['测试'],links:[],filters:{}},token)).code,200);
    await f.flush();f.advanceClock(660000);
    assert.equal((await f.request('/api/state',undefined,token)).code,200,'超过十分钟仍可查看运行任务');
    assert.equal((await f.request('/api/state',undefined,unrelated)).code,401,'只保持任务所属会话');
    release();await f.flush();f.advanceClock(599999);
    assert.equal((await f.request('/api/state',undefined,token)).code,200,'结束后拥有完整十分钟');
    f.advanceClock(2);
    assert.equal((await f.request('/api/state',undefined,token)).code,401,'后台轮询不会延长空闲期');
  });
});

test('单条AI和辅助AI请求期间保持会话，结束或失败后恢复空闲计时',async t=>{
  for(const kind of ['single','assist']) await t.test(kind,async()=>{
    const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});
    const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
    if(kind==='single')f.setSingleJudgeImplementation(async()=>{await gate;throw new Error('模拟任务失败');});
    else f.mockAi.generatePromptDraft=async()=>{await gate;return {prompt:'模拟提示词'};};
    const pending=f.request(kind==='single'?'/api/ai/judge-one':'/api/ai/prompt-draft',{leadId:1},token);
    await f.flush();f.advanceClock(660000);
    assert.equal((await f.request('/api/state',undefined,token)).code,200);
    release();assert.equal((await pending).code,kind==='single'?400:200);
    f.advanceClock(599999);assert.equal((await f.request('/api/state',undefined,token)).code,200);
    f.advanceClock(2);assert.equal((await f.request('/api/state',undefined,token)).code,401);
  });
});

test('运行任务不会绕过授权失效，停止仍可用',async()=>{
  const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});
  f.setTaskImplementation('aiTask',async()=>{await gate;return {ok:true};});
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  await f.request('/api/ai/start',{filters:{}},token);await f.flush();f.advanceClock(660000);f.revoke();
  assert.equal((await f.request('/api/state',undefined,token)).code,401);
  assert.equal((await f.request('/api/tasks/stop',{},token)).code,200);
  release();await f.flush();
});

test('新账号默认外部；切换只改模式并让原内核的登录成功证据失效',async()=>{
  const f=fixture(),token=await prepareBrowserControl(f);
  f.recordFreshLogin('1',{state:'authenticated',loggedIn:true,message:'已登录'});
  const beforeLeads=JSON.stringify(f.leads()), beforeSettings=JSON.stringify(f.settings());
  const changed=await f.request('/api/accounts/1',{browserMode:'embedded'},token,'desktop-qa',undefined,'PUT');
  assert.equal(changed.code,200); assert.equal(changed.body.modeChanged,true);
  assert.equal(f.accounts()[0].browserMode,'embedded');
  assert.equal(f.accounts()[0].loginStatus,'unknown');
  assert.equal((await f.request('/api/state',undefined,token)).body.accounts[0].loginStatus,'unknown');
  assert.equal(f.calls.filter(c=>c[0]==='close-account').length,1);
  await f.request('/api/accounts/1',{browserMode:'embedded'},token,'desktop-qa',undefined,'PUT');
  assert.equal(f.calls.filter(c=>c[0]==='close-account').length,1,'相同模式不关闭');
  assert.equal(JSON.stringify(f.leads()),beforeLeads); assert.equal(JSON.stringify(f.settings()),beforeSettings);
  const added=await f.request('/api/accounts',{name:'默认外部'},token);
  assert.equal(added.body.account.browserMode,'external');
});

test('模式切换等关闭时阻止任务及其他账号操作，失败保留模式和原登录证据',async()=>{
  const f=fixture(),token=await prepareBrowserControl(f);
  f.recordFreshLogin('1',{state:'authenticated',loggedIn:true,message:'已登录'});
  let rejectClose; f.setCloseImplementation(async(id,options)=>{
    assert.equal(id,'1'); assert.equal(options.strict,true);
    await new Promise((resolve,reject)=>{rejectClose=reject;});
  });
  const switching=f.request('/api/accounts/1',{browserMode:'embedded'},token,'desktop-qa',undefined,'PUT');
  await f.flush();
  assert.equal((await f.request('/api/accounts/1/open',{},token)).code,409);
  assert.equal((await f.request('/api/accounts/1',{browserMode:'external'},token,'desktop-qa',undefined,'PUT')).code,409);
  assert.equal((await f.request('/api/accounts',{name:'blocked'},token)).code,409);
  f.sendIpc({type:'embedded:control-check',id:'while-switching'}); await f.flush();
  assert.equal(f.controlResults('while-switching')[0].ok,false);
  assert.equal((await f.request('/api/tasks/stop',{},token)).code,200,'停止始终可用');
  rejectClose(new Error('fixture close failed'));
  assert.equal((await switching).code,400);
  assert.equal(f.accounts()[0].browserMode,undefined);
  assert.equal(f.accounts()[0].loginStatus,'authenticated');
  assert.equal((await f.request('/api/accounts/1/check',{},token)).code,200,'释放切换锁');
});

test('非法浏览器模式不改资料；运行任务中不能切换',async()=>{
  const f=fixture(),token=await prepareBrowserControl(f),before=JSON.stringify(f.accounts());
  for(const mode of ['auto',null,{},true]) {
    assert.equal((await f.request('/api/accounts/1',{browserMode:mode},token,'desktop-qa',undefined,'PUT')).code,400);
    assert.equal((await f.request('/api/accounts',{browserMode:mode},token)).code,400);
  }
  assert.equal(JSON.stringify(f.accounts()),before);
  f.setRunning(true);
  assert.equal((await f.request('/api/accounts/1',{browserMode:'embedded'},token,'desktop-qa',undefined,'PUT')).code,409);
  assert.equal(f.calls.some(c=>c[0]==='close-account'),false);
});

test('登录检查等待授权时先占用任务槽，切换不能让迟到结果污染新模式',async()=>{
  const f=fixture(),token=await prepareBrowserControl(f);
  let release;
  f.setActionAuthorization(()=>new Promise(resolve=>{release=resolve;}));
  const checking=f.request('/api/accounts/1/check',{},token); await f.flush();
  assert.equal((await f.request('/api/accounts/1',{browserMode:'embedded'},token,'desktop-qa',undefined,'PUT')).code,409);
  assert.equal((await f.request('/api/ai/start',{filters:{}},token)).code,400);
  release({ok:true}); assert.equal((await checking).code,200);
  assert.equal((await f.request('/api/accounts/1',{browserMode:'embedded'},token,'desktop-qa',undefined,'PUT')).code,200);
  assert.equal(f.accounts()[0].loginStatus,'unknown');
});

test('浏览器手动控制 IPC 要求已有授权上下文，并返回与请求一致的租约标识',async()=>{
  const f=fixture();
  assert.equal(f.ipcMessages().filter(message=>message.type==='ready').length,1);
  f.sendIpc({type:'embedded:control-check',id:'before-login'});await f.flush();
  assert.equal(f.controlResults('before-login')[0].ok,false);assert.deepEqual(f.pendingControlTimers(),[]);
  const token=await prepareBrowserControl(f);
  f.sendIpc({type:'embedded:control-check',id:'manual-1'});await f.flush();
  assert.deepEqual(f.controlResults('manual-1'),[{type:'embedded:control-result',id:'manual-1',ok:true,leaseId:'manual-1'}]);
  assert.deepEqual(f.pendingControlTimers(),[15000]);
  let start=await f.request('/api/ai/start',{filters:{}},token);
  assert.equal(start.code,400);assert.match(start.body.error,/网页正在切换/);
  assert.equal(f.calls.some(call=>call[0]==='ai'),false);
  f.sendIpc({type:'embedded:control-release',id:'unrelated'});
  assert.equal((await f.request('/api/ai/start',{filters:{}},token)).code,400);
  f.sendIpc({type:'embedded:control-release',id:'manual-1'});
  assert.deepEqual(f.pendingControlTimers(),[]);
  start=await f.request('/api/ai/start',{filters:{}},token);await f.flush();
  assert.equal(start.code,200);assert.equal(start.body.started,true);
  assert.equal(f.calls.filter(call=>call[0]==='ai').length,1);
});

test('手动导航授权尚未返回也预占任务槽，启动检查等待且并发导航被拒绝',async t=>{
  const f=fixture(),token=await prepareBrowserControl(f);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  t.after(async()=>{release({ok:true});f.sendIpc({type:'embedded:control-release',id:'waiting'});await f.flush();});
  f.setActionAuthorization(()=>gate);
  f.sendIpc({type:'embedded:control-check',id:'waiting'});await f.flush();
  assert.deepEqual(f.controlResults('waiting'),[]);assert.deepEqual(f.pendingControlTimers(),[15000]);
  assert.equal((await f.request('/api/ai/start',{filters:{}},token)).code,400);
  assert.equal((await f.request('/api/ai/judge-one',{leadId:1},token)).code,409);
  assert.equal((await f.request('/api/accounts/1/check',{},token)).code,409);
  await f.fireNextTimer();
  assert.equal(f.scanState().phase,'queued');assert.match(f.scanState().message,/等待当前任务结束/);
  assert.equal(f.calls.some(call=>['ai','judge-one','scan-login'].includes(call[0])),false);
  f.sendIpc({type:'embedded:control-check',id:'concurrent'});await f.flush();
  assert.equal(f.controlResults('concurrent')[0].ok,false);
  release({ok:true});await f.flush();
  assert.equal(f.controlResults('waiting')[0].ok,true);
  f.sendIpc({type:'embedded:control-release',id:'waiting'});f.setActionAuthorization();
  await f.fireNextTimer();
  assert.equal(f.scanState().phase,'completed');assert.equal(f.calls.filter(call=>call[0]==='scan-login').length,1);
});

test('运行中及尚未设置 running 的任务预占均拒绝手动导航，停止仍始终可用',async t=>{
  const f=fixture(),token=await prepareBrowserControl(f);
  f.setTaskState({running:true,kind:'collect'});
  f.sendIpc({type:'embedded:control-check',id:'running'});await f.flush();
  assert.equal(f.controlResults('running')[0].ok,false);assert.match(f.controlResults('running')[0].error,/任务正在运行/);
  assert.deepEqual(f.pendingControlTimers(),[]);
  assert.equal((await f.request('/api/tasks/stop',{})).code,200);assert.equal(f.taskState().stopRequested,true);
  f.setRunning(false);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  t.after(async()=>{release();await f.flush();});
  f.setSingleJudgeImplementation(async leadId=>{await gate;return {ok:true,leadId};});
  const judgment=f.request('/api/ai/judge-one',{leadId:1},token);await f.flush();
  assert.equal(f.taskState().running,false);
  f.sendIpc({type:'embedded:control-check',id:'reserved'});await f.flush();
  assert.equal(f.controlResults('reserved')[0].ok,false);assert.deepEqual(f.pendingControlTimers(),[]);
  assert.equal((await f.request('/api/tasks/stop',{})).code,200);
  release();assert.equal((await judgment).code,200);
});

test('手动导航授权等待超过租约后及时拒绝，迟到授权不能释放新导航租约',async t=>{
  const f=fixture(),token=await prepareBrowserControl(f);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  t.after(async()=>{release({ok:true});f.sendIpc({type:'embedded:control-release',id:'fresh'});await f.flush();});
  f.setActionAuthorization(()=>gate);
  f.sendIpc({type:'embedded:control-check',id:'expired'});await f.flush();
  f.advanceClock(15000);assert.equal(await f.fireControlTimer(),true);
  assert.equal(f.controlResults('expired')[0].ok,false);assert.match(f.controlResults('expired')[0].error,/超时/);
  assert.deepEqual(f.pendingControlTimers(),[]);
  f.setActionAuthorization();f.sendIpc({type:'embedded:control-check',id:'fresh'});await f.flush();
  assert.equal(f.controlResults('fresh')[0].ok,true);
  release({ok:true});await f.flush();
  assert.equal(f.controlResults('expired').length,1,'late authorization must never send a second successful reply');
  assert.equal((await f.request('/api/ai/start',{filters:{}},token)).code,400,'late old completion must not unlock the current navigation');
  f.sendIpc({type:'embedded:control-release',id:'expired'});
  assert.equal((await f.request('/api/ai/start',{filters:{}},token)).code,400);
  f.sendIpc({type:'embedded:control-release',id:'fresh'});
  assert.equal((await f.request('/api/ai/start',{filters:{}},token)).code,200);await f.flush();
});

test('main 主动取消待授权导航后立即允许任务，迟到授权不会重新授予租约',async t=>{
  const f=fixture(),token=await prepareBrowserControl(f);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  t.after(async()=>{release({ok:true});await f.flush();});
  f.setActionAuthorization(()=>gate);
  f.sendIpc({type:'embedded:control-check',id:'cancelled'});await f.flush();
  f.sendIpc({type:'embedded:control-release',id:'cancelled'});await f.flush();
  assert.equal(f.controlResults('cancelled')[0].ok,false);assert.match(f.controlResults('cancelled')[0].error,/取消/);
  assert.deepEqual(f.pendingControlTimers(),[]);
  assert.equal((await f.request('/api/ai/start',{filters:{}},token)).code,200);await f.flush();
  release({ok:true});await f.flush();
  assert.equal(f.controlResults('cancelled').length,1);assert.deepEqual(f.pendingControlTimers(),[]);
});

test('授权失效或异常不授予导航租约且不泄漏原始错误，停止绕过会话授权仍可用',async t=>{
  for(const kind of ['revoked','denied','thrown']) await t.test(kind,async()=>{
    const f=fixture();await prepareBrowserControl(f);
    if(kind==='revoked')f.revoke();
    if(kind==='denied')f.setActionAuthorization(async()=>({ok:false,error:'private expired license context'}));
    if(kind==='thrown')f.setActionAuthorization(async()=>{throw new Error('private authorization payload');});
    f.sendIpc({type:'embedded:control-check',id:kind});await f.flush();
    const result=f.controlResults(kind)[0];
    assert.equal(result.ok,false);assert.match(result.error,/授权未通过/);assert.doesNotMatch(result.error,/private|context|payload/);
    assert.deepEqual(f.pendingControlTimers(),[]);
    assert.equal((await f.request('/api/tasks/stop',{})).code,200);
  });
});

test('待授权和持有导航租约时停止均可用，退出会立即取消待授权并清除租约',async()=>{
  const f=fixture();await prepareBrowserControl(f);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  f.setActionAuthorization(()=>gate);
  f.sendIpc({type:'embedded:control-check',id:'shutdown-pending'});await f.flush();
  assert.equal((await f.request('/api/tasks/stop',{})).code,200);
  release({ok:true});await f.flush();assert.equal(f.controlResults('shutdown-pending')[0].ok,true);
  assert.equal((await f.request('/api/tasks/stop',{})).code,200);
  f.sendIpc({type:'embedded:control-release',id:'shutdown-pending'});
  f.setActionAuthorization(()=>new Promise(()=>{}));
  f.sendIpc({type:'embedded:control-check',id:'shutdown-cancelled'});await f.flush();
  f.sendIpc({type:'shutdown'});await f.flush();
  assert.equal(f.controlResults('shutdown-cancelled')[0].ok,false);assert.match(f.controlResults('shutdown-cancelled')[0].error,/关闭/);
  assert.deepEqual(f.pendingControlTimers(),[]);assert.deepEqual(f.calls.filter(call=>call[0]==='exit'),[['exit',0]]);
});

test('启动检查只在有效软件授权后调度一次，并将旧已登录投影为待确认直到取得新证据',async()=>{
  const f=fixture();
  f.setAccounts([{id:1,name:'主号',loginStatus:'authenticated',loginState:'已登录',loginMessage:'历史成功',loginCheckedAt:'2026-10-07 09:00:00'},
    {id:2,name:'副号',loginStatus:'authenticated',loginState:'已登录',loginMessage:'历史成功'}]);
  f.setLoginResult({ok:true,loggedIn:true,state:'authenticated',message:'本次浏览器确认登录'});
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  let state=(await f.request('/api/state',undefined,token)).body;
  assert.equal(state.accountLoginScan.phase,'queued');assert.equal(state.accountLoginScan.total,2);
  assert.equal(state.accountLoginScan.done,0);assert.deepEqual(f.pendingTimers(),[0]);
  assert.equal(state.accounts.every(account=>account.loginStatus==='unknown'&&account.loginCheckedAt===null),true);
  assert.equal(f.accounts()[0].loginStatus,'authenticated','the projection must not erase saved login history');
  const secondToken=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  assert.deepEqual(f.pendingTimers(),[0]);
  await f.fireNextTimer();
  state=(await f.request('/api/state',undefined,secondToken)).body;
  assert.equal(state.accountLoginScan.phase,'completed');assert.equal(state.accountLoginScan.done,2);
  assert.deepEqual(state.accounts.map(account=>account.loginStatus),['authenticated','authenticated']);
  assert.equal(state.accounts.every(account=>account.loginMessage==='本次浏览器确认登录'),true);
  assert.equal(Object.values(state.accountLoginScan.accountStates).every(account=>account.checked===true),true);
  assert.deepEqual(f.calls.filter(call=>call[0]==='scan-account').map(call=>call[1]),['1','2']);
  assert.equal(f.calls.filter(call=>call[0]==='scan-login').length,1);assert.deepEqual(f.pendingTimers(),[]);
  assert.deepEqual(Object.keys(state.accountLoginScan).sort(),['accountId','accountStates','done','message','phase','total']);
  assert.doesNotMatch(JSON.stringify(state.accountLoginScan),/qa-pass|authContext|session|token/);
  await f.request('/api/state',undefined,token);await f.request('/api/login',{username:'qa',password:'qa-pass'});await f.flush();
  assert.equal(f.calls.filter(call=>call[0]==='scan-login').length,1);assert.deepEqual(f.pendingTimers(),[]);
});

test('单条AI尚未返回时预占任务槽，启动检查和账号修改会等待结果完成',async t=>{
  const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});
  t.after(async()=>{release();await f.flush();});
  f.setTaskState({kind:'login',accountId:'1',running:false});
  f.setSingleJudgeImplementation(async leadId=>{await f.authorize()({kind:'ai_judge_one',leadId});await gate;return {ok:true,leadId};});
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const judgment=f.request('/api/ai/judge-one',{leadId:1},token);
  await f.flush();
  assert.equal(f.taskState().running,false);assert.deepEqual(f.calls.filter(call=>call[0]==='judge-one'),[['judge-one',1]]);
  await f.fireNextTimer();
  const waiting=(await f.request('/api/state',undefined,token)).body;
  assert.equal(waiting.accountLoginScan.phase,'queued');assert.match(waiting.accountLoginScan.message,/等待当前任务结束/);
  assert.equal(f.calls.some(call=>call[0]==='scan-login'),false);assert.deepEqual(f.pendingTimers(),[1000]);
  assert.equal((await f.request('/api/ai/judge-one',{leadId:2},token)).code,409);
  assert.equal((await f.request('/api/accounts/1/check',{},token)).code,409,'an old completed login task must not activate the manual-check concurrency exception');
  assert.equal((await f.request('/api/accounts',{name:'不应新增'},token)).code,409);
  assert.equal((await f.request('/api/settings',{action:{userIntervalSec:30}},token,'desktop-qa',undefined,'PUT')).code,409);
  assert.equal(f.settings().action.userIntervalSec,10);
  release();assert.equal((await judgment).code,200);await f.flush();
  await f.fireNextTimer();
  assert.equal((await f.request('/api/state',undefined,token)).body.accountLoginScan.phase,'completed');
  assert.deepEqual(f.calls.filter(call=>call[0]==='judge-one'),[['judge-one',1]]);
  assert.equal(f.calls.filter(call=>call[0]==='scan-login').length,1);assert.deepEqual(f.pendingTimers(),[]);
});

test('登录等待期间允许新增账号和保存设置，浏览器操作与其他任务仍被拒绝',async()=>{
  const f=fixture();
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  f.setTaskState({kind:'login',accountId:'1',running:true,status:'等待扫码或手机确认'});
  const added=await f.request('/api/accounts',{name:'登录期间新增'},token);
  assert.equal(added.code,200);
  assert.equal(added.body.account.name,'登录期间新增');
  assert.equal(f.accounts().length,2);
  assert.equal((await f.request('/api/settings',{action:{userIntervalSec:30}},token,'desktop-qa',undefined,'PUT')).code,200);
  assert.equal(f.settings().action.userIntervalSec,30);
  assert.equal((await f.request('/api/accounts/1/open',{},token)).code,409,'登录轮询期间仍不能重复打开浏览器');
  f.setTaskState({kind:'collect',running:true,accountId:'1'});
  assert.equal((await f.request('/api/accounts',{name:'采集期间不允许'},token)).code,409);
  assert.equal((await f.request('/api/settings',{action:{userIntervalSec:40}},token,'desktop-qa',undefined,'PUT')).code,409);
});

test('无授权及来源不受信任时不会消耗或触发启动检查',async()=>{
  const f=fixture();
  assert.equal((await f.request('/api/state')).code,401);
  assert.equal((await f.request('/api/login',{username:'qa',password:'invalid'})).code,401);
  assert.equal((await f.request('/api/login',{username:'qa',password:'qa-pass'},'','bad')).code,403);
  assert.equal((await f.request('/api/login',{username:'qa',password:'qa-pass'},'','desktop-qa','https://untrusted.example')).code,403);
  assert.equal(f.scanState().phase,'idle');assert.deepEqual(f.pendingTimers(),[]);
  assert.equal(await f.fireNextTimer(),false);assert.equal(f.calls.some(call=>call[0]==='scan-login'),false);
  assert.equal((await f.request('/api/login',{username:'qa',password:'qa-pass'})).code,200);
  assert.deepEqual(f.pendingTimers(),[0]);
});

test('已有执行任务时启动检查保持排队，任务结束后再检查且不会重复启动',async()=>{
  const f=fixture();f.setTaskState({kind:'collect',running:true,status:'正在采集'});
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  await f.fireNextTimer();
  const waiting=(await f.request('/api/state',undefined,token)).body;
  assert.equal(waiting.accountLoginScan.phase,'queued');assert.match(waiting.accountLoginScan.message,/等待当前任务结束/);
  assert.equal(waiting.task.kind,'collect');assert.equal(waiting.task.running,true);
  assert.equal(f.calls.some(call=>call[0]==='scan-login'),false);assert.deepEqual(f.pendingTimers(),[1000]);
  await f.fireNextTimer();assert.deepEqual(f.pendingTimers(),[1000]);
  f.setRunning(false);await f.fireNextTimer();
  assert.equal((await f.request('/api/state',undefined,token)).body.accountLoginScan.phase,'completed');
  assert.equal(f.calls.filter(call=>call[0]==='scan-login').length,1);assert.deepEqual(f.pendingTimers(),[]);
});

test('启动检查的任务预占和运行进度阻止账号并发变更，停止仍可用且随后人工核验可更新待确认账号',async t=>{
  const f=fixture();f.setAccounts([{id:1,name:'专用号',loginStatus:'authenticated',loginState:'已登录'}]);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  t.after(async()=>{release();await f.flush();});
  f.setScanImplementation(async({onProgress})=>{
    const accountStates={'1':{state:'checking',message:'正在读取专用浏览器响应',checked:false}};
    onProgress({total:1,done:0,accountId:'1',accountStates,message:'正在读取专用浏览器响应'});
    await gate;
    return {ok:false,total:1,done:0,accountStates,message:'已停止检查'};
  });
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  assert.equal(f.fireNextTimerWithoutFlush(),true);
  assert.equal(f.taskState().running,false,'the engine callback has not run yet, so reservation must guard the route');
  assert.equal(f.calls.some(call=>call[0]==='scan-login'),false);
  assert.equal((await f.request('/api/accounts/1/check',{},token)).code,409,'taskPending reserves the slot before taskState.running is set');
  await f.flush();
  const running=(await f.request('/api/state',undefined,token)).body;
  assert.equal(running.accountLoginScan.phase,'running');assert.equal(running.accountLoginScan.accountId,'1');
  assert.equal(running.accountLoginScan.done,0);assert.equal(running.accounts[0].loginStatus,'checking');
  assert.equal(running.accounts[0].loginState,'检查中');assert.equal(running.accountLoginScan.accountStates['1'].checked,false);
  for(const [url,body,method] of [
    ['/api/accounts/1/open',{},'POST'],['/api/accounts/1/check',{},'POST'],['/api/accounts/1/close',{},'POST'],
    ['/api/accounts/1',undefined,'DELETE'],['/api/accounts/1',{name:'不应修改'},'PUT'],['/api/accounts',{name:'不应新增'},'POST']
  ]) assert.equal((await f.request(url,body,token,'desktop-qa',undefined,method)).code,409,url);
  assert.deepEqual(f.accounts(),[{id:1,name:'专用号',loginStatus:'authenticated',loginState:'已登录'}]);
  assert.equal(f.calls.some(call=>['check-login','open-login','close-account'].includes(call[0])),false);
  assert.equal((await f.request('/api/tasks/stop',{})).code,200,'desktop stop does not require a valid software session');
  const stopped=(await f.request('/api/state',undefined,token)).body;
  assert.equal(stopped.accountLoginScan.phase,'stopped');assert.equal(stopped.accounts[0].loginStatus,'unknown');
  assert.equal(stopped.accountLoginScan.accountStates['1'].checked,false);assert.equal(f.taskState().stopRequested,true);
  release();await f.flush();
  f.setLoginResult({ok:true,loggedIn:true,state:'authenticated',message:'人工重新检查取得登录证据'});
  assert.equal((await f.request('/api/accounts/1/check',{},token)).body.loggedIn,true);
  const refreshed=(await f.request('/api/state',undefined,token)).body;
  assert.equal(refreshed.accountLoginScan.phase,'stopped');assert.equal(refreshed.accountLoginScan.accountStates['1'].checked,true);
  assert.equal(refreshed.accounts[0].loginStatus,'authenticated');assert.equal(refreshed.accounts[0].loginMessage,'人工重新检查取得登录证据');
  assert.equal(f.calls.filter(call=>call[0]==='scan-login').length,1);assert.deepEqual(f.pendingTimers(),[]);
});

test('启动排队期间停止、退出、授权撤销或会话过期均阻止浏览器检查',async t=>{
  for(const kind of ['stop','logout','revoked','expired']) await t.test(kind,async()=>{
    const f=fixture();const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
    if(kind==='stop') assert.equal((await f.request('/api/tasks/stop',{})).code,200);
    if(kind==='logout') assert.equal((await f.request('/api/logout',{},token)).code,200);
    if(kind==='revoked') f.revoke();
    if(kind==='expired') f.advanceClock(600001);
    await f.fireNextTimer();
    assert.equal(f.scanState().phase,'stopped');assert.deepEqual(f.pendingTimers(),[]);
    assert.equal(f.calls.some(call=>call[0]==='scan-login'),false);
    assert.equal(f.scanState().accountStates['1'].checked,false);
    if(kind!=='stop') assert.equal((await f.request('/api/state',undefined,token)).code,401);
    assert.equal((await f.request('/api/tasks/stop',{},token)).code,200);
    await f.flush();assert.equal(f.calls.some(call=>call[0]==='scan-login'),false);
  });
});

test('启动检查运行期间授权失效会终止并保持未核验账号待确认',async t=>{
  const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});
  t.after(async()=>{release();await f.flush();});
  f.setScanImplementation(async({onProgress})=>{
    onProgress({total:1,done:0,accountId:'1',accountStates:{'1':{state:'checking',checked:false,message:'检查响应等待中'}},message:'检查响应等待中'});
    await gate;await f.authorize()({kind:'login_scan_check',accountId:'1'});
    f.calls.push(['unexpected-browser-action']);return {ok:true,total:1,done:1};
  });
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  await f.fireNextTimer();assert.equal(f.scanState().phase,'running');
  f.revoke();release();await f.flush();
  assert.equal(f.scanState().phase,'stopped');assert.equal(f.scanState().accountStates['1'].checked,false);
  assert.equal(f.scanState().accountStates['1'].state,'unknown');assert.equal(f.calls.some(call=>call[0]==='unexpected-browser-action'),false);
  assert.equal((await f.request('/api/state',undefined,token)).code,401);
  assert.equal((await f.request('/api/tasks/stop',{},token)).code,200);assert.deepEqual(f.pendingTimers(),[]);
});

test('没有已有账号时启动检查直接完成，不打开浏览器或创建定时器',async()=>{
  const f=fixture();f.setAccounts([]);
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const state=(await f.request('/api/state',undefined,token)).body;
  assert.equal(state.accountLoginScan.phase,'completed');assert.equal(state.accountLoginScan.total,0);assert.equal(state.accountLoginScan.done,0);
  assert.deepEqual(state.accounts,[]);assert.deepEqual(f.pendingTimers(),[]);
  assert.equal(f.calls.some(call=>call[0]==='scan-login'),false);
});

test('客户端 state/leads 共享同一公开字段合同，旧作品正文通过 API 只读关联并保留全部全文',async()=>{
  const f=fixture(),token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const original={id:1,uid:'u1',accountId:'1',videoLink:'https://www.douyin.com/note/123',demand:'价格',unknownLegacy:'保留'};
  const desc='图文全文\n'+'内容'.repeat(9000)+'末尾证据';
  f.setLeads([original]);f.setVideos({'123':{desc,videoLink:original.videoLink,workSourcePath:'/note/123'}});
  const state=(await f.request('/api/state',undefined,token)).body;
  const listed=(await f.request('/api/leads?q=末尾证据',undefined,token)).body;
  assert.deepEqual(state.leadFields,listed.leadFields);
  assert.deepEqual(listed.leadFields.fields.slice(0,11).map(field=>field.key),['id','time','UID','nickname','aiNeed','aiScore','aiReason','trigger','demand','videoDesc','homepage']);
  assert.equal(listed.leads[0].fieldValues.videoDesc,desc);assert.equal(listed.leads[0].unknownLegacy,'保留');
  assert.deepEqual(f.leads(),[original]);
  const works=(await f.request('/api/videos',undefined,token)).body.videos;
  assert.equal(works[0].workContent,desc);assert.equal(works[0].workText,desc);assert.equal(works[0].workTextState,'available');
});
test('登录检查接口独立返回调用成功与登录结果，扫码等待中同账号可检查',async()=>{
  const f=fixture();const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  let r=await f.request('/api/accounts/1/check',{},token);assert.equal(r.code,200);assert.equal(r.body.ok,true);assert.equal(r.body.loggedIn,false);assert.equal(r.body.state,'logged_out');
  f.setTaskState({running:true,kind:'login',accountId:'1'});f.setLoginResult({ok:true,loggedIn:true,state:'authenticated',message:'已确认登录'});
  r=await f.request('/api/accounts/1/check',{},token);assert.equal(r.code,200);assert.equal(r.body.loggedIn,true);
  assert.equal((await f.request('/api/accounts/1/close',{},token)).code,409);
  f.setTaskState({running:true,kind:'collect'});assert.equal((await f.request('/api/accounts/1/check',{},token)).code,409);
});
test('扫码期间手动检查仍必须经过当前有效授权',async()=>{
  const f=fixture();const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  f.setTaskState({running:true,kind:'login',accountId:'1'});f.revoke();
  assert.equal((await f.request('/api/accounts/1/check',{},token)).code,401);
  assert.equal(f.calls.some(call=>call[0]==='check-login'),false);
  assert.equal((await f.request('/api/tasks/stop',{},token)).code,200);
});
test('桌面nonce和来源约束阻止外部页面访问本机API',async()=>{
  const f=fixture();assert.equal((await f.request('/api/login',{username:'qa',password:'qa-pass'},'','bad')).code,403);
  assert.equal((await f.request('/api/login',{username:'qa',password:'qa-pass'},'','desktop-qa','https://other.example')).code,403);
});
test('客户版管理员登录和管理接口均不可绕过授权',async()=>{
  const f=fixture();assert.equal((await f.request('/api/login',{username:'huamao',password:'anything'})).code,401);
  assert.equal((await f.request('/api/license-admin/users')).code,404);assert.equal((await f.request('/api/admin-pass',{})).code,404);
});
test('授权失效及未登录时本机停止始终可用',async()=>{
  const f=fixture();assert.equal((await f.request('/api/tasks/stop',{})).body.ok,true);
  const login=await f.request('/api/login',{username:'qa',password:'qa-pass'});f.revoke();
  assert.equal((await f.request('/api/state',undefined,login.body.token)).code,401);
  assert.equal((await f.request('/api/tasks/stop',{},login.body.token)).body.ok,true);
});
test('列表筛选与预检查同源、固定名单拒绝其他账户/任务',async()=>{
  const f=fixture();const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const listed=await f.request('/api/leads?f=ai',undefined,token);assert.deepEqual(listed.body.leads.map(l=>l.id),[1]);
  const plan=(await f.request('/api/outreach/preview',{accountId:'1',filters:{f:'ai'}},token)).body;
  assert.equal(plan.count,1);assert.equal(plan.owner,'qa');
  assert.equal((await f.request('/api/follow/start',{accountId:'1',planId:plan.planId},token)).code,400);
  assert.equal((await f.request('/api/outreach/start',{accountId:'1',planId:plan.planId},token)).body.ok,true);
  await new Promise(r=>setImmediate(r));assert.equal(f.calls.find(c=>c[0]==='outreach')[2].planId,plan.planId);
  f.revoke();await assert.rejects(f.authorize()({kind:'dm'}),/已停用/);
});
test('显式空名单保持为空，批量AI接收相同筛选范围',async()=>{
  const f=fixture();const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const plan=(await f.request('/api/follow/preview',{accountId:'1',filters:{f:'all'},leadIds:[]},token)).body;assert.equal(plan.count,0);
  await f.request('/api/ai/start',{filters:{f:'trigger'},leadIds:[1]},token);await new Promise(r=>setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[0]==='ai')[1])),{filters:{f:'trigger'},leadIds:[1]});
});
test('人工状态同步关联用户，已有AI否不能人工批准绕过',async()=>{
  const f=fixture();const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  assert.equal((await f.request('/api/leads/2/status',{status:'manual_approved'},token)).code,400);
  assert.equal((await f.request('/api/leads/1/status',{status:'do_not_contact'},token)).body.ok,true);
  assert.equal(f.leads().filter(l=>l.uid==='u1').every(l=>l.doNotContact),true);
  assert.equal((await f.request('/api/leads/1/status',{status:'dm_sent'},token)).code,400);
});
test('共享筛选支持全文视频搜索及待核验，空leadIds不会扩大',()=>{
  const leads=[{id:1,videoLink:'https://www.douyin.com/video/123',demand:'好',dmState:'pending_verification'},{id:2,demand:'其他',followedAt:'today'}];
  assert.equal(filterLeads(leads,{'123':{desc:'测试业务'}},{q:'测试业务'}).length,1);
  assert.equal(filterLeads(leads,{}, {f:'pending'}).length,1);
  assert.equal(filterLeads(leads,{}, {},{leadIds:[]}).length,0);
});

test('新分类列表与AI facets使用同一有效性及其他筛选，计数不受f或分页影响',async()=>{
  const f=fixture(),now=Date.now(),videos={'123':{desc:'同一作品说明'}};
  const common={accountId:'1',demand:'服务问题',time:new Date(now-3600000).toISOString(),videoLink:'https://www.douyin.com/video/123'};
  const valid=(id,need)=>{const row={...common,id,uid:'facet-'+id,aiNeed:need,aiDone:true,aiReason:'有效业务依据',aiPromptVersion:'current'};row.aiInputHash=require('../workflow').aiInputHash(row,videos);return row;};
  f.setVideos(videos);
  f.setLeads([{...common,id:1},valid(2,'是'),valid(3,'否'),{...valid(4,'是'),aiPromptVersion:'old'},
    {...valid(5,'是'),dmCount:1,dmState:'pending_verification'}, {...common,id:6,time:new Date(now-4*86400000).toISOString()}, {...common,id:7,demand:'无关'}]);
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const response=await f.request('/api/leads?f=ai_yes&commentDays=1&contact=new&q='+encodeURIComponent('服务')+'&limit=1',undefined,token);
  assert.equal(response.code,200);assert.equal(response.body.total,7);assert.equal(response.body.totalFiltered,1);assert.equal(response.body.aiPending,0);
  assert.deepEqual(response.body.leads.map(row=>row.id),[2]);assert.equal(response.body.leads[0].aiCategory,'ai_yes');assert.equal(response.body.leads[0].contactCategory,'new');
  assert.deepEqual(response.body.facets.ai,{all:4,ai_todo:1,ai_yes:1,ai_no:1,ai_stale:1,ai_excluded:0});
  const stale=(await f.request('/api/leads?f=ai_stale&commentDays=1&contact=new&q='+encodeURIComponent('服务'),undefined,token)).body;
  assert.deepEqual(stale.leads.map(row=>row.id),[4]);assert.equal(stale.aiPending,1);assert.deepEqual(stale.facets,response.body.facets);
  assert.equal((await f.request('/api/leads?commentDays=2',undefined,token)).code,400);
  assert.equal((await f.request('/api/leads?contact=bad',undefined,token)).code,400);
});

test('列表保持默认500与最高5000，total与facets来自未分页全集',async()=>{
  const f=fixture();f.setLeads(Array.from({length:5002},(_,i)=>({id:i+1,demand:'待判断评论'})));
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const first=(await f.request('/api/leads',undefined,token)).body;
  assert.equal(first.leads.length,500);assert.equal(first.total,5002);assert.equal(first.totalFiltered,5002);assert.equal(first.facets.ai.ai_todo,5002);
  const capped=(await f.request('/api/leads?limit=9000',undefined,token)).body;
  assert.equal(capped.leads.length,5000);assert.equal(capped.totalFiltered,5002);assert.equal(capped.facets.ai.all,5002);
});

test('不参与判断API单独统计作者和空评论，返回原因且待判断与待判数均不包含它们',async()=>{
  const f=fixture();f.setVideos({123:{authorSecUid:'cached-author'}});
  f.setLeads([{id:1,demand:'作者回复',isAuthor:true},{id:2,demand:' '},
    {id:3,demand:'缓存作者回复',uid:'cached-author',videoLink:'https://www.douyin.com/note/123'},{id:4,demand:'普通评论'}]);
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const excluded=(await f.request('/api/leads?f=ai_excluded',undefined,token)).body;
  assert.equal(excluded.total,4);assert.equal(excluded.totalFiltered,3);assert.equal(excluded.aiPending,0);
  assert(excluded.leads.every(row=>row.aiCategory==='ai_excluded'&&row.aiExclusionReason));
  assert.equal(excluded.facets.ai.ai_excluded,3);assert.equal(excluded.facets.ai.ai_todo,1);
  const todo=(await f.request('/api/leads?f=ai_todo',undefined,token)).body;
  assert.deepEqual(todo.leads.map(row=>row.id),[4]);assert.equal(todo.aiPending,1);
});

test('POST筛选和勾选仅导出相关作品，全部及旧GET保留无评论作品，空勾选不回退',async()=>{
  const f=fixture(),now=Date.now();
  f.setLeads([{id:1,nickname:'目标甲',demand:'近期服务',time:new Date(now-3600000).toISOString(),videoLink:'https://www.douyin.com/note/123'},
    {id:2,nickname:'目标乙',demand:'历史服务',time:new Date(now-5*86400000).toISOString(),videoLink:'https://www.douyin.com/video/456'}]);
  f.setVideos({'123':{desc:'甲关联作品'},'456':{desc:'乙关联作品'},'789':{desc:'孤立作品保留于全部导出'}});
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const XLSX=require('../lib/xlsx.full.min.js');
  const text=response=>{assert.equal(response.code,200);assert.match(response.headers['Content-Type'],/spreadsheetml/);const book=XLSX.read(response.body,{type:'buffer'});return JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1}));};
  const filtered=text(await f.request('/api/export',{scope:'filters',filters:{commentDays:1}},token));
  assert.match(filtered,/目标甲/);assert.match(filtered,/甲关联作品/);assert.doesNotMatch(filtered,/目标乙|乙关联作品|孤立作品/);
  const selected=text(await f.request('/api/export',{scope:'selected',leadIds:[2],filters:{commentDays:1,q:'不会匹配'}},token));
  assert.match(selected,/目标乙/);assert.match(selected,/乙关联作品/);assert.doesNotMatch(selected,/目标甲|甲关联作品|孤立作品/);
  for(const scope of [{scope:'selected',leadIds:[]},{scope:'selected'},{scope:'selected',leadIds:[999]},{scope:'invalid'},{scope:false},{scope:'filters',filters:false}]) assert.equal((await f.request('/api/export',scope,token)).code,400);
  const empty=text(await f.request('/api/export',{scope:'filters',filters:{},leadIds:[]},token));assert.doesNotMatch(empty,/目标甲|目标乙|甲关联作品|乙关联作品|孤立作品/);
  const all=text(await f.request('/api/export',{scope:'all',filters:{commentDays:1}},token));assert.match(all,/目标甲/);assert.match(all,/目标乙/);assert.match(all,/甲关联作品/);assert.match(all,/乙关联作品/);assert.match(all,/孤立作品/);
  const legacy=text(await f.request('/api/export',undefined,token));assert.match(legacy,/目标甲/);assert.match(legacy,/目标乙/);assert.match(legacy,/孤立作品/);
  f.setLeads([]);
  for(const body of [{scope:'all'},undefined]) { const worksOnly=text(await f.request('/api/export',body,token)); assert.match(worksOnly,/甲关联作品/);assert.match(worksOnly,/乙关联作品/);assert.match(worksOnly,/孤立作品/); }
  const noFilteredLeads=text(await f.request('/api/export',{scope:'filters',filters:{}},token));assert.doesNotMatch(noFilteredLeads,/甲关联作品|乙关联作品|孤立作品/);
  assert.equal((await f.request('/api/export',{scope:'all'})).code,401);
  assert.equal((await f.request('/health')).body.version,'2.5.2');
});
test('人工核验同步Outcome解除待核验锁，成功仅记一次且保留另一个动作待核验',async()=>{
  const f=fixture();f.setLeads([{id:1,uid:'u1',accountId:'1',dmState:'pending_verification',dmOutcome:'pending_verification',followState:'pending_verification',dmCount:1,dmAttemptAccountId:'1'},{id:2,uid:'u1',accountId:'2',dmState:'pending_verification',dmOutcome:'pending_verification',dmCount:1,followState:'pending_verification'}]);
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  f.setRunning(true);assert.equal((await f.request('/api/leads/1/resolve',{kind:'dm',outcome:'success',note:'尚在发送'},token)).code,409);assert.equal(f.leads()[0].dmState,'pending_verification');f.setRunning(false);
  assert.equal((await f.request('/api/leads/1/resolve',{kind:'dm',outcome:'success',note:''},token)).code,400);
  assert.equal((await f.request('/api/leads/1/resolve',{kind:'dm',outcome:'success',note:'聊天记录确认本次消息'},token)).body.ok,true);
  assert.equal(f.leads().every(l=>l.dmState==='confirmed_success'&&l.dmOutcome==='confirmed_success'&&l.dmCount===2&&l.status==='follow_pending'),true);
  assert.equal(f.calls.filter(c=>c[0]==='daily').length,1);
  assert.equal((await f.request('/api/leads/2/resolve',{kind:'dm',outcome:'success',note:'再次点击'},token)).code,400);
  assert.equal(f.calls.filter(c=>c[0]==='daily').length,1);
});

test('人工关注核验只同步实际执行账号，保留另一账号的独立历史和待核验',async()=>{
  const f=fixture();
  const other={id:3,uid:'u1',accountId:'2',followState:'pending_verification',followOutcome:'pending_verification',followAttemptAccountId:'2',followAttemptId:'other-attempt',followedAt:'其他账号旧历史'};
  f.setLeads([{id:1,uid:'u1',accountId:'1',followState:'pending_verification',followOutcome:'pending_verification',followAttemptAccountId:'1'},
    {id:2,uid:'u1',accountId:'1',followState:'pending_verification',followOutcome:'pending_verification',followAttemptAccountId:'1'},other]);
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  assert.equal((await f.request('/api/leads/1/resolve',{kind:'follow',outcome:'success',note:'当前执行账号主页确认'},token)).body.ok,true);
  assert.equal(f.leads().slice(0,2).every(row=>row.followState==='confirmed_success'&&row.followOutcome==='confirmed_success'),true);
  assert.deepEqual(f.leads()[2],other);
  assert.deepEqual(f.calls.filter(call=>call[0]==='daily'),[['daily','1','follow']]);
  f.setLeads([{id:1,uid:'u1',accountId:'1',followState:'confirmed_success',followAttemptAccountId:'1'},
    {id:2,uid:'u1',accountId:'2',followState:'pending_verification',followAttemptAccountId:'1'}]);
  assert.equal((await f.request('/api/leads/2/resolve',{kind:'follow',outcome:'success',note:'旧跨账号复制记录'},token)).code,400);
  assert.equal(f.calls.filter(call=>call[0]==='daily').length,1,'不能借旧复制记录再次核验并增加次数');
});

test('客户端状态不暴露授权地址，模型发现和草稿接口只允许有效登录且逐次授权',async()=>{
  const f=fixture();f.setLicenseStatus(()=>({enabled:true,serverUrl:'https://not-exposed.example',expiresAt:'2099-01-01'}));
  assert.equal((await f.request('/api/ai/models')).code,401);assert.equal(f.calls.filter(c=>c[0]==='models').length,0);
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const state=(await f.request('/api/state',undefined,token)).body;assert.equal(Object.hasOwn(state.settings.license,'serverUrl'),false);assert.equal(Object.hasOwn(state.license,'serverUrl'),false);
  assert.equal((await f.request('/api/ai/models',undefined,token)).body.models[0].id,'deepseek-flash');assert.deepEqual(f.calls.find(c=>c[0]==='models'),['models',true]);
  assert.equal((await f.request('/api/ai/prompt-draft',{businessInput:{businessDesc:'测试'}},token)).body.draft,true);
  assert.equal((await f.request('/api/ai/prompt-test',{prompt:'草稿'},token)).body.draft,true);
  f.revoke();assert.equal((await f.request('/api/ai/models',undefined,token)).code,401);assert.equal(f.calls.filter(c=>c[0]==='models').length,1);
});

test('行业草稿状态仅包含公开资料，旧包装协议提示冲突且读取不会改设置或调用AI',async()=>{
  const f=fixture(),token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const before=f.settings(), state=(await f.request('/api/state',undefined,token)).body;
  assert.deepEqual(Object.keys(state.aiIndustryDefaults).sort(),['businessInput','keywords','prompt']);
  assert(!JSON.stringify(state.aiIndustryDefaults).includes(before.ai.apiKey));assert.equal(state.aiPromptWarning,'');
  assert.deepEqual(f.settings(),before);assert(!f.calls.some(c=>['draft','models','prompt-test'].includes(c[0])));
  const presets=f.settings().ai.promptPresets;presets[1].prompt='只输出JSON对象，严格包含prompt一个字符串字段';
  const saved=await f.request('/api/settings',{ai:{promptPresets:presets,activePromptId:'prompt-2'}},token,'desktop-qa',undefined,'PUT');assert.equal(saved.body.ok,true);
  const legacy=(await f.request('/api/state',undefined,token)).body;
  assert.match(legacy.aiPromptWarning,/生成指令或包装/);assert.equal(legacy.settings.ai.prompt,presets[1].prompt);
  assert.equal(f.settings().ai.apiKey,before.ai.apiKey);
});

test('正式设置只保存新版节奏，拒绝非法比例、空激活槽、错误槽结构与自定义AI端点',async()=>{
  const f=fixture(), token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const put=body=>f.request('/api/settings',body,token,'desktop-qa',undefined,'PUT');
  assert.equal((await put({action:{userIntervalSec:-1}})).code,400);assert.equal(f.settings().action.userIntervalSec,10);
  assert.equal((await put({action:{userIntervalJitter:1.1}})).code,400);
  assert.equal((await put({collect:{autoAiAfterCollect:'true'}})).code,400);
  assert.equal((await put({ai:{activePromptId:'prompt-2'}})).code,400);
  assert.equal((await put({ai:{promptPresets:[null]}})).code,400);
  assert.equal((await put({ai:{baseUrl:'https://untrusted.example'}})).code,400);
  assert.equal((await put({license:{serverUrl:'https://untrusted.example'}})).code,403);
  const presets=f.settings().ai.promptPresets;presets[1].prompt='第二套规则';
  assert.equal((await put({action:{userIntervalSec:0,userIntervalJitter:.4},ai:{promptPresets:presets,activePromptId:'prompt-2'}})).body.ok,true);
  assert.equal(f.settings().ai.prompt,'第二套规则');assert.equal(f.settings().ai.activePromptId,'prompt-2');assert.equal(f.settings().ai.promptPresets.length,3);
});

test('启用开关严格为布尔值，私信话术类型和空文本在保存阶段拒绝',async()=>{
  const f=fixture(),token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const put=body=>f.request('/api/settings',body,token,'desktop-qa',undefined,'PUT');
  const original=f.settings();
  for(const group of ['follow','dm','ai']) for(const enabled of ['true','false',0,1,null,{}]) {
    const response=await put({[group]:{enabled}});
    assert.equal(response.code,400,group+' rejects '+JSON.stringify(enabled));
    assert.match(response.body.error,/开关值/);
    assert.deepEqual(f.settings(),original);
  }
  for(const enabled of ['true','false',0,1,null,{}]) {
    const response=await put({dm:{repeat:{enabled}}});
    assert.equal(response.code,400);assert.match(response.body.error,/开关值/);assert.deepEqual(f.settings(),original);
  }
  for(const intervalDays of [0,-1,.5,'7',null]) {
    const response=await put({dm:{repeat:{intervalDays}}});
    assert.equal(response.code,400);assert.match(response.body.error,/至少为1天/);assert.deepEqual(f.settings(),original);
  }
  for(const template of [null,0,false,{},['消息'],'',' \n\t ']) {
    const response=await put({dm:{template}});
    assert.equal(response.code,400);assert.match(response.body.error,/话术/);assert.deepEqual(f.settings(),original);
  }
  assert.equal((await put({follow:{enabled:false},ai:{enabled:false},dm:{enabled:false,repeat:{enabled:false},template:''}})).code,200);
  assert.equal((await put({dm:{enabled:true}})).code,400,'enabling empty message must fail');
  assert.equal(f.settings().dm.enabled,false);
  assert.equal((await put({dm:{enabled:false,template:{message:'错误类型'}}})).code,400,'disabled DM still requires text');
  assert.equal((await put({dm:{enabled:true,template:'  您好\n请问需要帮助吗？  ',repeat:{enabled:true}}})).code,200);
  assert.equal(f.settings().dm.template,'  您好\n请问需要帮助吗？  ');
});

test('采集保留零和小数间隔，负数仍拒绝且不覆盖原设置',async()=>{
  const f=fixture(),token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const put=body=>f.request('/api/settings',body,token,'desktop-qa',undefined,'PUT');
  for(const collect of [{scrollIntervalSec:0,linkIntervalSec:0},{scrollIntervalSec:.5,linkIntervalSec:1.5}]) {
    assert.equal((await put({collect})).body.ok,true);
    assert.equal(f.settings().collect.scrollIntervalSec,collect.scrollIntervalSec);
    assert.equal(f.settings().collect.linkIntervalSec,collect.linkIntervalSec);
  }
  assert.equal((await put({collect:{scrollIntervalSec:-.1}})).code,400);
  assert.equal((await put({collect:{linkIntervalSec:-1}})).code,400);
  assert.equal(f.settings().collect.scrollIntervalSec,.5);assert.equal(f.settings().collect.linkIntervalSec,1.5);
});

test('AI统计只计当前二值规则和当前内容，筛选待判断数量不混入全库或作者',async()=>{
  const f=fixture(), sourceAI=require('../ai'), hash=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
  f.mockAi.leadInput=sourceAI.leadInput;
  const lead={id:1,uid:'u1',demand:'行业相关咨询',aiDone:true,aiNeed:'是',aiReason:'咨询相关服务',aiPromptVersion:'current'};
  lead.aiInputHash=hash(sourceAI.leadInput(lead,{}));
  f.setLeads([lead,{id:2,demand:'行业历史结果',aiDone:true,aiNeed:'待确认',aiPromptVersion:'old'}, {id:3,demand:'其他咨询'}, {id:4,demand:'行业作者',isAuthor:true}]);
  const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  let state=(await f.request('/api/state',undefined,token)).body;
  assert.equal(state.stats.aiJudged,1); assert.equal(state.stats.aiYes,1); assert.equal(state.stats.aiNo,0);
  assert.equal(state.stats.aiHistoricalJudged,1); assert.equal(state.stats.aiPending,2);
  assert.equal((await f.request('/api/leads?q=行业',undefined,token)).body.aiPending,1);
  assert.equal((await f.request('/api/leads',undefined,token)).body.leads.find(row=>row.id===1).aiResultCurrent,true);
  f.setLeads([{...lead,demand:'评论已更改'}, {id:2,demand:'行业历史结果',aiDone:true,aiNeed:'待确认',aiPromptVersion:'old'}]);
  state=(await f.request('/api/state',undefined,token)).body;
  assert.equal(state.stats.aiJudged,0);assert.equal(state.stats.aiYes,0);assert.equal(state.stats.aiPending,2);
  assert.equal((await f.request('/api/leads',undefined,token)).body.leads.find(row=>row.id===1).aiResultCurrent,false);
  f.setLeads([{...lead,aiReason:''}]);
  assert.equal((await f.request('/api/leads',undefined,token)).body.aiPending,1);
});

test('停止在授权失效后仍中止模型刷新、提示词生成和样例测试，迟到结果不返回成功',async t=>{
  for(const [route,method,body] of [['models','listModels',undefined],['prompt-draft','generatePromptDraft',{}],['prompt-test','testPromptDraft',{}]]) {
    await t.test(route,async()=>{
      const f=fixture(); let signal;
      f.mockAi[method]=async(...args)=>{
        const options=args.at(-1);signal=options.signal;await options.authorize();
        await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('AI 请求已停止')),{once:true}));
        return {prompt:'不应返回的迟到结果'};
      };
      const token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
      const pending=f.request('/api/ai/'+route,body,token);await f.flush();
      assert.equal(signal.aborted,false);f.revoke();
      assert.equal((await f.request('/api/tasks/stop',{},token)).body.ok,true);
      const result=await pending;
      assert.equal(signal.aborted,true);assert.equal(result.body.ok,false);assert.match(result.body.error,/停止/);
    });
  }
});

test('自动与手动AI组批明确保存，非法模式拒绝且不覆盖既有配置',async()=>{
  const f=fixture(),token=(await f.request('/api/login',{username:'qa',password:'qa-pass'})).body.token;
  const put=body=>f.request('/api/settings',body,token,'desktop-qa',undefined,'PUT');
  assert.equal((await put({ai:{batchMode:'manual',batchMaxChars:3210,batchMaxCount:7}})).body.ok,true);
  const original=f.settings().ai;
  assert.equal((await put({ai:{batchMode:'unexpected'}})).code,400);
  assert.deepEqual(f.settings().ai,original);
  assert.equal((await put({ai:{batchMode:'auto'}})).body.ok,true);
  assert.equal(f.settings().ai.batchMode,'auto');assert.equal(f.settings().ai.batchMaxChars,3210);assert.equal(f.settings().ai.batchMaxCount,7);
  assert.equal(f.settings().ai.apiKey,original.apiKey);assert.deepEqual(f.settings().ai.promptPresets,original.promptPresets);
});
