'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const engine = require('./engine');
const license = require('./license.js');
const ai = require('./ai');
const { filterLeads, aiFacetCounts, aiCategory, aiExclusionReason, isCommentUser, contactCategory } = require('./lead-query');
const { workIdFromLink } = require('./lib/video-links');
const { publicLeadFields, projectWork, createLeadWorkbook } = require('./lib/lead-fields');
const { createStartupLoginScan } = require('./lib/startup-login-scan');
const { getFreshLoginResult, persistLoginResult } = require('./lib/account-login');
const { createBrowserControlLease } = require('./lib/browser-control-lease');
const PORT = Number(process.env.DY_LEAD_PORT ?? 17888);
const WEB_DIR = path.join(__dirname, 'web');
const DESKTOP_TOKEN = process.env.DY_LEAD_DESKTOP_TOKEN || '';
// 无操作多少时间后需要重新登录：环境变量优先（测试用），否则读设置 session.idleLogoutMinutes（0 = 一直保持登录）
function sessionTtlMs() {
  if (process.env.DY_LEAD_SESSION_TTL_MS) return Number(process.env.DY_LEAD_SESSION_TTL_MS);
  let minutes = 10;
  try { minutes = Number(store.getSettings().session.idleLogoutMinutes); } catch (_) { minutes = 10; }
  return minutes === 0 ? Infinity : (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60000;
}
const sessions = new Map();
const aiAssistRequests = new Map();
let taskContext = null;
let taskPending = false;
// 分发任务在批次之间 running 短暂为 false，但任务槽仍被占用。
// 使用显式生命周期标志，不能用 taskState.kind：kind 是展示字段，任务结束后会保留。
const engineBusy = () => engine.taskState.running || engine.taskState.distributionActive === true;
// 打开登录窗口后，后端最多轮询 5 分钟等扫码。这期间浏览器确实被占用，
// 但“添加账号/保存设置”只写本地文件，不应被一并挡住。
const loginSessionOnly = () => engine.taskState.running === true
  && engine.taskState.kind === 'login'
  && !taskPending
  && engine.taskState.distributionActive !== true;
const browserControl = createBrowserControlLease({
  isBusy: () => engineBusy() || taskPending,
  authorize: async () => {
    if (!taskContext) throw new Error('请先登录客户端并打开账号浏览器');
    return license.assertActionAllowed(taskContext);
  }
});
let actualPort = PORT;
const json = (res, obj, code=200) => {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(obj));
};
function readBody(req) {
  return new Promise((resolve,reject) => {
    let data = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 2000000) { reject(new Error('请求内容过大')); req.destroy(); } else data += chunk; });
    req.on('end', () => { try { const body=JSON.parse(data || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); resolve(body); } catch (_) { reject(new Error('请求 JSON 无效')); } });
    req.on('error',reject); req.on('aborted',()=>reject(new Error('请求中断')));
  });
}
function getSession(req, active=true) {
  const token = String(req.headers['x-auth-token'] || new URL(req.url,'http://127.0.0.1').searchParams.get('token') || '');
  const session=sessions.get(token);
  if (!session) return null;
  if (active && !isSessionValid(session)) return null;
  if (active && req.headers['x-user-active']==='1') session.exp=Date.now()+sessionTtlMs();
  return {token,session};
}
function isSessionValid(session) {
  return !!session && (!!session.workCount || Date.now() <= session.exp) && license.validateContext(session.authContext).ok;
}
function holdSessionForWork(session) {
  // Bind activity to the initiating session. Polling alone never resets idle
  // expiry; completion gives the user a fresh idle window.
  session.workCount=(session.workCount||0)+1;
  return () => {
    session.workCount--;
    session.exp=Date.now()+sessionTtlMs();
  };
}
engine.configure({ authorize: async meta => {
  if (!taskContext) throw new Error('任务没有有效授权，请重新登录');
  const result=await license.assertActionAllowed(taskContext);
  if (!result.ok) throw new Error(result.error || '授权失效，任务已暂停');
  return result;
}});
function taskError(error) {
  engine.taskState.running=false; engine.taskState.status='任务暂停：'+error.message;
  store.log('system',engine.taskState.status);
}
function startTask(session, fn) {
  if (browserControl.isHeld()) throw new Error('账号网页正在切换，请稍后启动任务');
  if (engineBusy() || taskPending) throw new Error('已有任务在运行，请停止并等待结束');
  taskContext=session.authContext;
  taskPending=true;
  const releaseSession=holdSessionForWork(session);
  Promise.resolve().then(fn).then(result=>{ if(result?.ok===false) throw new Error(result.error||'任务未启动'); }).catch(taskError).finally(()=>{taskPending=false;releaseSession();});
}
const startupLoginScan = createStartupLoginScan({
  getAccounts: () => store.getAccounts(),
  getFreshAccountResult: id => getFreshLoginResult(store, id),
  isBusy: () => engineBusy() || taskPending || browserControl.isHeld(),
  isSessionValid: owner => isSessionValid(owner?.session),
  start: (owner, fn) => startTask(owner.session, fn)
});
function requireAccount(id) {
  if (!store.getAccounts().some(a=>String(a.id)===String(id))) throw new Error('执行账号不存在');
  return String(id);
}
function isAiResultCurrent(lead, version, videos) {
  return ai.isStoredResultCurrent(lead, version, videos);
}
// /api/state 每 2.5 秒轮询一次。线索统计只在线索/作品/设置文件变化后重算，
// 避免任务进行中每次轮询都遍历全部线索、阻塞同进程里的浏览器自动化。
let statsCache = null;
function fileStamp(file) { try { const s = fs.statSync(file); return s.mtimeMs + ':' + s.size; } catch { return 'missing'; } }
function cachedLeadStats(compute) {
  if (!store.F) return compute(); // 内存存储（测试替身）没有文件可判定变化，不缓存
  const key = [store.F.leads, store.F.videos, store.F.settings].map(fileStamp).join('|');
  if (statsCache && statsCache.key === key) return statsCache.value;
  const value = compute();
  statsCache = { key, value };
  return value;
}
async function aiAssist(session, operation) {
  const controller = new AbortController();
  const releaseSession=holdSessionForWork(session);
  aiAssistRequests.set(controller, session.authContext);
  try {
    const options = { signal: controller.signal, authorize: async () => {
      if (controller.signal.aborted) throw new Error('AI 请求已停止');
      return license.assertActionAllowed(session.authContext);
    } };
    const result = await operation(options);
    if (controller.signal.aborted) throw new Error('AI 请求已停止，本次结果未应用');
    return result;
  } finally { aiAssistRequests.delete(controller); releaseSession(); }
}
function validateSettings(s) {
  for(const group of ['follow','dm','ai']) if(typeof s[group]?.enabled!=='boolean') throw new Error('启用状态必须为开关值：'+group+'.enabled');
  if(typeof s.dm.repeat?.enabled!=='boolean') throw new Error('重复私信启用状态必须为开关值');
  if(typeof s.dm.template!=='string') throw new Error('私信话术必须为文本');
  if(s.dm.enabled&&!s.dm.template.trim()) throw new Error('启用私信时请填写非空话术');
  if(s.ai.batchMode!=null&&!['auto','manual'].includes(s.ai.batchMode)) throw new Error('AI组批方式只能为auto或manual');
  for (const [group,fields] of Object.entries({collect:['scrollIntervalSec','cooldownHours','dailyVideoLimit','linkIntervalSec'],action:['userIntervalSec'],follow:['dailyLimit'],dm:['dailyLimit']})) {
    for(const field of fields) if(typeof s[group][field]!=='number'||!Number.isFinite(s[group][field])||s[group][field]<0) throw new Error('设置必须为非负数：'+group+'.'+field);
  }
  if(s.collect.worksPerAccount!=null&&(!Number.isInteger(s.collect.worksPerAccount)||s.collect.worksPerAccount<1||s.collect.worksPerAccount>200)) throw new Error('每个账号连续采集作品数需为1到200的整数');
  for(const [g,f] of [['collect','maxScrolls'],['ai','batchMaxChars'],['ai','batchMaxCount'],['human','maxConsecutiveErrors']]) if(!Number.isInteger(s[g][f])||s[g][f]<1) throw new Error('设置必须为正整数：'+g+'.'+f);
  for(const [g,f] of [['collect','scrollJitter'],['collect','linkIntervalJitter'],['action','userIntervalJitter']]) if(!Number.isFinite(s[g][f])||s[g][f]<0||s[g][f]>1) throw new Error('抖动比例必须在0到1之间');
  for(const [g,f] of [['collect','scrollIntervalSec'],['collect','linkIntervalSec'],['action','userIntervalSec']]) if(s[g][f]>86400) throw new Error('操作节奏不能超过86400秒');
  if(typeof s.collect.autoAiAfterCollect!=='boolean') throw new Error('采集后自动AI判断必须为开关值');
  const autoJudgeWindowDays = s.ai.autoJudgeWindowDays == null ? 7 : Number(s.ai.autoJudgeWindowDays);
  if(![0,1,3,7].includes(autoJudgeWindowDays)) throw new Error('采集后自动AI判断的评论时间范围只允许全部、1天、3天或7天');
  if(s.session&&![0,10,30,60,240].includes(Number(s.session.idleLogoutMinutes))) throw new Error('无操作自动退出登录只能选择 10/30/60/240 分钟或一直保持登录');
  if(s.action.pacingVersion!==1) throw new Error('请刷新后使用新版任务节奏设置');
  if(!Number.isFinite(s.dm.repeat.intervalDays)||s.dm.repeat.intervalDays<1) throw new Error('重复私信间隔至少为1天');
  const sp={count:5,pauseMinSec:300,pauseMaxSec:300,...(s.dm&&s.dm.sessionPause||{})};
  if(!sp||!Number.isInteger(sp.count)||sp.count<1||sp.count>200) throw new Error('私信强制休息的条数需为1到200的整数');
  for(const f of ['pauseMinSec','pauseMaxSec']) if(!Number.isFinite(sp[f])||sp[f]<5||sp[f]>86400) throw new Error('私信强制休息时长需在5到86400秒之间');
  if(sp.pauseMinSec>sp.pauseMaxSec) throw new Error('私信强制休息的最小时长不能超过最大时长');
  const dmd={adaptiveCap:true,frequentCooldownSec:1800,accountSwitchIntervalSec:0,batchPerAccount:5,roundRestSec:300,maxFrequentRetriesPerDay:3,sameVideoPerBatch:2,dailyResetHour:8,poolAccounts:[],...(s.dm||{})};
  if(typeof dmd.adaptiveCap!=='boolean') throw new Error('经验上限开关必须为布尔值');
  for(const [f,min,max,label] of [['frequentCooldownSec',300,7200,'频繁冷却'],['accountSwitchIntervalSec',0,3600,'账号切换间隔'],['batchPerAccount',1,50,'每批人数'],['roundRestSec',0,7200,'每轮休息'],['maxFrequentRetriesPerDay',0,10,'频繁重试上限'],['sameVideoPerBatch',1,20,'同视频每批上限'],['dailyResetHour',0,23,'每日恢复时刻']]) {
    if(!Number.isFinite(dmd[f])||dmd[f]<min||dmd[f]>max) throw new Error('私信分发设置无效：'+label);
  }
  if(!Number.isInteger(dmd.batchPerAccount)||!Number.isInteger(dmd.maxFrequentRetriesPerDay)||!Number.isInteger(dmd.sameVideoPerBatch)||!Number.isInteger(dmd.dailyResetHour)) throw new Error('私信分发设置需为整数');
  if(!Array.isArray(dmd.poolAccounts)||dmd.poolAccounts.length>50||dmd.poolAccounts.some(p=>!p||!String(p.accountId).trim()||typeof p.template!=='string')) throw new Error('私信账户池格式无效');
  const search={intervalSec:20,intervalJitter:0.3,maxPages:20,dailySearchLimit:30,minCommentCount:0,publishedWithinDays:30,...(s.search||{})};
  for(const [f,label] of [['intervalSec','搜索间隔'],['intervalJitter','搜索抖动'],['maxPages','单关键词翻页'],['dailySearchLimit','每日搜索上限'],['minCommentCount','最少评论数']]) {
    if(!Number.isFinite(search[f])) throw new Error('搜索设置必须为数字：'+label);
  }
  if(search.intervalSec<10||search.intervalSec>86400) throw new Error('搜索间隔需在10到86400秒之间');
  if(search.intervalJitter<0||search.intervalJitter>1) throw new Error('搜索抖动比例必须在0到1之间');
  if(!Number.isInteger(search.maxPages)||search.maxPages<1||search.maxPages>50) throw new Error('单关键词翻页需为1到50的整数');
  if(!Number.isInteger(search.dailySearchLimit)||search.dailySearchLimit<1||search.dailySearchLimit>200) throw new Error('每日搜索上限需为1到200的整数');
  if(!Number.isInteger(search.minCommentCount)||search.minCommentCount<0) throw new Error('最少评论数需为非负整数');
  if(!Array.isArray(s.keywords.intent)||!Array.isArray(s.keywords.exclude)||[...s.keywords.intent,...s.keywords.exclude].some(v=>typeof v!=='string')) throw new Error('关键词必须为文本列表');
  try { new Intl.DateTimeFormat('zh-CN',{timeZone:s.human.timeZone}); } catch(_) { throw new Error('时区无效'); }
  if(!Number.isFinite(s.ai.requestTimeoutSec)||s.ai.requestTimeoutSec<1||s.ai.requestTimeoutSec>120) throw new Error('AI超时需在1到120秒之间');
  if(s.ai.baseUrl !== 'https://api.deepseek.com') throw new Error('AI接口固定使用DeepSeek官方HTTPS地址');
  if(typeof s.ai.apiKey!=='string'||s.ai.apiKey.length>2000) throw new Error('DeepSeek API Key格式无效');
  if(typeof s.ai.model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(s.ai.model)) throw new Error('请选择有效的DeepSeek模型');
  for(const f of ['businessDesc','targetCustomers','clearNeeds','misjudgments']) if(typeof s.ai[f]!=='string'||s.ai[f].length>6000) throw new Error('业务说明需为6000字以内文本');
  if(!Array.isArray(s.ai.promptPresets)||s.ai.promptPresets.length!==3) throw new Error('需保留3份提示词预设');
  const expected=['prompt-1','prompt-2','prompt-3'];
  for(let i=0;i<3;i++) { const p=s.ai.promptPresets[i]; if(!p||p.id!==expected[i]||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||typeof p.prompt!=='string'||p.prompt.length>30000) throw new Error('提示词预设格式无效'); }
  const active=s.ai.promptPresets.find(p=>p.id===s.ai.activePromptId); if(!active||!active.prompt.trim()) throw new Error('请选择一份已填写的提示词保存启用');
}
function resolveLead(id,body,session) {
  const leads=store.getLeads(); const lead=leads.find(l=>String(l.id)===String(id));
  if(!lead) throw new Error('线索不存在');
  const businessId=String(lead.businessId||store.getSettings().outreach.businessId||'default');
  if(!['dm','follow'].includes(body.kind)||!['success','failed'].includes(body.outcome)||!String(body.note||'').trim()) throw new Error('请选择核验结果并填写依据');
  const followAccountId=String(lead.followAttemptAccountId||lead.accountId||'');
  if(body.kind==='follow'&&followAccountId!==String(lead.accountId||'')) throw new Error('该关注记录属于其他执行账号，请在原执行账号的线索中核验');
  const related=leads.filter(l=>String(l.uid||l.UID)===String(lead.uid||lead.UID)&&String(l.businessId||store.getSettings().outreach.businessId||'default')===businessId&&(body.kind!=='follow'||String(l.accountId)===followAccountId));
  const field=body.kind+'State';
  if(lead[field]!=='pending_verification') throw new Error('仅可核验待核验记录，刷新后重试');
  const now=store.nowStr();
  const sentCount=Math.max(0,...related.map(l=>Number(l.dmCount||0)))+1;
  for(const l of related) {
    l[field]=body.outcome==='success'?'confirmed_success':'confirmed_failure';
    l[body.kind+'Outcome']=l[field];
    l.verificationHistory=[...(l.verificationHistory||[]),{kind:body.kind,outcome:body.outcome,note:String(body.note).slice(0,1000),at:now,by:session.username,attemptId:lead[body.kind+'AttemptId']||''}];
    if(body.kind==='dm'&&body.outcome==='success') { l.dmCount=sentCount; l.dmLastAt=lead.dmAttemptAt||now; l.noDm=false; }
    if(body.kind==='follow'&&body.outcome==='success') l.followedAt=lead.followAttemptAt||now;
    engine.refreshLeadStatus(l);
  }
  store.setLeads(leads);
  if(body.outcome==='success') store.bumpDaily(lead[body.kind+'AttemptAccountId']||lead.accountId,body.kind);
  store.log(lead.accountId||'system','人工核验 '+body.kind+' '+lead.id+' '+body.outcome+' 操作者 '+session.username);
}

function exportExcel(res, options = {}) {
  const scope = options.scope == null ? 'filters' : options.scope;
  if (!['filters', 'selected', 'all'].includes(scope)) throw new Error('导出范围无效');
  const all = store.getLeads(), videos = store.getVideos(), settings = store.getSettings(), now = Date.now();
  const selection = { settings, ruleVersion: ai.getRuleSet(settings).version, now };
  if (scope === 'selected' || scope === 'filters' && Object.hasOwn(options, 'leadIds')) {
    if (!Array.isArray(options.leadIds) || options.leadIds.some(id => !['string', 'number'].includes(typeof id) || !String(id).trim())) throw new Error('导出线索编号必须为列表');
    if (scope === 'selected' && !options.leadIds.length) throw new Error('请先勾选线索再导出');
    selection.leadIds = options.leadIds;
    const existing = new Set(all.map(lead => String(lead.id)));
    if (options.leadIds.some(id => !existing.has(String(id)))) throw new Error('所选线索已不存在，请刷新后导出');
  }
  const leads = scope === 'all' ? all : filterLeads(all, videos, scope === 'selected' || options.filters === undefined ? {} : options.filters, selection);
  const workIds = new Set(leads.map(lead => workIdFromLink(lead.videoLink)).filter(Boolean));
  const exportVideos = scope === 'all' ? videos : Object.fromEntries(Object.entries(videos).filter(([id]) => workIds.has(String(id))));
  try {
    const XLSX = require(path.join(__dirname, 'lib', 'xlsx.full.min.js'));
    const book = createLeadWorkbook(XLSX, leads, exportVideos);
    const { writeLeadXlsx } = require(path.join(__dirname, 'lib', 'lead-xlsx-format.js'));
    const buf = writeLeadXlsx(XLSX, book);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`行业作品意向匹配-${store.todayStr()}.xlsx`)}`
    });
    res.end(buf);
  } catch (e) {
    json(res, { ok: false, error: '导出失败: ' + e.message }, 500);
  }
}
async function handleApi(req,res,pathname) {
  const parts=pathname.split('/').filter(Boolean); const method=req.method;
  if(['license-admin','admin-pass'].includes(parts[1])) return json(res,{ok:false,error:'客户版不提供管理员接口'},404);
  if(method==='POST'&&pathname==='/api/tasks/stop') {
    if(!DESKTOP_TOKEN&&!getSession(req,false)) return json(res,{ok:false,error:'需要本机登录会话'},401);
    startupLoginScan.cancel();
    for (const controller of aiAssistRequests.keys()) controller.abort();
    return json(res,engine.stopTask());
  }
  if(method==='POST'&&pathname==='/api/login') {
    const body=await readBody(req); const r=await license.verify(body.username,body.password);
    if(!r.ok||!r.authContext) return json(res,{ok:false,error:r.error||'授权验证失败'},401);
    const token=crypto.randomBytes(24).toString('hex');
    const session={exp:Date.now()+sessionTtlMs(),username:r.username,role:'user',authContext:r.authContext};
    sessions.set(token,session);
    startupLoginScan.request(session, options => engine.scanAccountLogins(options));
    return json(res,{ok:true,token,role:'user',username:r.username,expiresAt:r.expiresAt,offline:!!r.offline,mac:r.mac});
  }
  const auth=getSession(req); if(!auth) return json(res,{ok:false,error:'未登录或授权已失效，请重新登录',auth:false},401);
  const {session,token}=auth;
  if(method==='POST'&&pathname==='/api/logout') { startupLoginScan.cancelSession(session); if(taskContext===session.authContext) engine.stopTask(); for(const [controller,context] of aiAssistRequests) if(context===session.authContext) controller.abort(); license.clearSession(session.authContext); sessions.delete(token); return json(res,{ok:true}); }
  if(method==='GET'&&pathname==='/api/state') {
    const accounts=store.getAccounts().map(a=>({...startupLoginScan.projectAccount(a),daily:store.getDailyUsage(a.id)}));
    const settings=store.getSettings(); const aiKeySet=!!String(settings.ai.apiKey||'').trim();
    settings.license={enabled:true};
    // API Key 不随轮询下发到渲染层；界面只需要知道“是否已保存”。
    settings.ai.apiKey=''; settings.ai.apiKeySet=aiKeySet;
    const licenseStatus={...license.status()}; delete licenseStatus.serverUrl;
    const videos=store.getVideos(); const ruleVersion=ai.getRuleSet(settings).version;
    const stats={...cachedLeadStats(()=>{
      const leads=store.getLeads();
      const currentAi=leads.filter(l=>isAiResultCurrent(l,ruleVersion,videos));
      const value={total:leads.length,intent:leads.filter(l=>l.intent).length,followed:leads.filter(l=>l.followedAt).length,dmSent:leads.filter(l=>l.dmCount>0).length,newCount:leads.filter(l=>!l.followedAt&&!l.dmCount&&!l.noDm&&!l.replied&&!l.doNotContact).length,aiJudged:currentAi.length,aiYes:currentAi.filter(l=>l.aiNeed==='是').length,aiNo:currentAi.filter(l=>l.aiNeed==='否').length,aiHistoricalJudged:leads.filter(l=>l.aiDone).length-currentAi.length};
      value.aiPending=leads.filter(l=>!l.isAuthor&&String(l.demand||'').trim()&&!isAiResultCurrent(l,ruleVersion,videos)).length;
      return value;
    })};
    const activePrompt=settings.ai.promptPresets.find(p=>p.id===settings.ai.activePromptId);
    const promptInspection=ai.inspectPromptDraft(activePrompt?.prompt||'');
    const aiPromptWarning=['DRAFT_META_INSTRUCTION','DRAFT_LEGACY_PROTOCOL','DRAFT_CONTACT_POLICY_CONFLICT'].includes(promptInspection.code)?promptInspection.message:'';
    return json(res,{ok:true,accounts,settings,stats,videos,task:engine.taskState,accountLoginScan:startupLoginScan.readState(),license:licenseStatus,dataDir:store.DATA_DIR,role:'user',loginUser:session.username,aiRuleVersion:ruleVersion,leadFields:publicLeadFields(),aiIndustryDefaults:store.getIndustryProfile(),aiPromptWarning,dmAccountState:(typeof store.getDmAccountState==='function'?store.getDmAccountState():{})});
  }
  if(method==='POST'&&pathname==='/api/license/changepass') { const b=await readBody(req); return json(res,await license.changePassword(session.username,b.oldPassword,b.newPassword)); }
  if(method==='POST'&&pathname==='/api/open-data-dir') { require('child_process').spawn('explorer.exe',[store.DATA_DIR],{windowsHide:true,detached:true,stdio:'ignore'}).unref(); return json(res,{ok:true}); }
  if(method==='PUT'&&pathname==='/api/settings') {
    const body=await readBody(req); if(body.license) return json(res,{ok:false,error:'授权配置由发行方固定，客户版不可修改'},403);
    if(body.ai&&Object.hasOwn(body.ai,'baseUrl')&&body.ai.baseUrl!=='https://api.deepseek.com') return json(res,{ok:false,error:'AI接口固定使用DeepSeek官方HTTPS地址'},400);
    // 只改“无操作自动退出登录”不影响任务，任务运行中也允许保存
    const sessionOnly=Object.keys(body).length===1&&body.session&&typeof body.session==='object';
    if((engineBusy()||taskPending)&&!loginSessionOnly()&&!sessionOnly) return json(res,{ok:false,error:'请停止任务后修改规则与执行设置'},409);
    const current=store.getSettings();
    for(const k of Object.keys(body)) if(k!=='license'&&Object.hasOwn(current,k)&&body[k]&&typeof body[k]==='object'&&!Array.isArray(body[k])) current[k]={...current[k],...body[k]};
    current.dm.repeat={...store.getSettings().dm.repeat,...(body.dm?.repeat||{})};
    // 渲染层不再持有明文 Key：留空表示沿用已保存的 Key，填写则覆盖。
    if(body.ai&&typeof body.ai.apiKey==='string'&&!body.ai.apiKey.trim()) current.ai.apiKey=store.getSettings().ai.apiKey;
    delete current.ai.apiKeySet;
    try { validateSettings(current); } catch(e) { return json(res,{ok:false,error:e.message},400); }
    const active=current.ai.promptPresets.find(p=>p.id===current.ai.activePromptId); current.ai.prompt=active.prompt;
    store.setSettings(current);
    // 新的登录保持时长立即作用于当前已登录的会话
    if(body.session) for(const item of sessions.values()) item.exp=Date.now()+sessionTtlMs();
    return json(res,{ok:true});
  }
  if(parts[1]==='accounts') {
    if(method==='POST'&&parts.length===2) {
      const b=await readBody(req);
      // 登录等待期间允许新增账号：它只写 accounts.json，不触碰正在登录的浏览器。
      if(browserControl.isHeld()||taskPending||(engineBusy()&&!loginSessionOnly())) return json(res,{ok:false,error:'请先停止当前任务或等待网页切换完成'},409);
      if(b.browserMode!==undefined&&!['external','embedded'].includes(b.browserMode)) return json(res,{ok:false,error:'浏览器模式无效'},400);
      const accounts=store.getAccounts(); const account={id:Date.now(),name:String(b.name||'账号'+(accounts.length+1)),note:String(b.note||''),proxy:String(b.proxy||''),browserMode:b.browserMode||'external',loginState:'未登录',createdAt:store.nowStr()};
      accounts.push(account); store.setAccounts(accounts); return json(res,{ok:true,account});
    }
    const id=requireAccount(parts[2]);
    const checkingCurrentLogin=method==='POST'&&parts[3]==='check'&&engine.taskState.running&&engine.taskState.kind==='login'&&String(engine.taskState.accountId)===id;
    if((engineBusy()||taskPending||browserControl.isHeld())&&method!=='GET'&&!checkingCurrentLogin) return json(res,{ok:false,error:'请先停止当前任务或等待网页切换完成'},409);
    if(method==='PUT') {
      const b=await readBody(req);
      if(engineBusy()||taskPending||browserControl.isHeld()) return json(res,{ok:false,error:'请先停止当前任务或等待网页切换完成'},409);
      if(b.browserMode!==undefined&&!['external','embedded'].includes(b.browserMode)) return json(res,{ok:false,error:'浏览器模式无效'},400);
      const current=store.getAccounts().find(a=>String(a.id)===id);
      const modeChanged=b.browserMode!==undefined&&b.browserMode!==(current.browserMode||'external');
      // Reserve the same task slot before awaiting profile release. A task,
      // startup scan or manual browser navigation cannot race this switch.
      taskPending=true;
      try {
        if(modeChanged) await engine.closeAccount(id,{strict:true});
        const accounts=store.getAccounts(); const acc=accounts.find(a=>String(a.id)===id);
        for(const k of ['name','note','proxy','browserMode']) if(b[k]!=null) acc[k]=String(b[k]);
        store.setAccounts(accounts);
        if(modeChanged) {
          persistLoginResult(store,id,{state:'unknown',loggedIn:false,message:'已切换浏览器模式，请点击“打开登录”或“检查”确认当前模式的登录状态'});
          store.log(id,'浏览器模式已切换为'+(b.browserMode==='embedded'?'内嵌浏览器':'外部专用浏览器')+'，两种登录资料均保留');
        }
        return json(res,{ok:true,browserMode:acc.browserMode||'external',modeChanged});
      } finally { taskPending=false; }
    }
    if(method==='DELETE'||method==='POST'&&parts[3]==='close') {
      taskPending=true;
      try {
        await engine.closeAccount(id);
        if(method==='DELETE') store.setAccounts(store.getAccounts().filter(a=>String(a.id)!==id));
        return json(res,{ok:true});
      } finally { taskPending=false; }
    }
    if(method==='POST'&&['open','check'].includes(parts[3])) {
      const reserveCheck=parts[3]==='check'&&!checkingCurrentLogin;
      const releaseSession=holdSessionForWork(session);
      if(reserveCheck) taskPending=true;
      try {
        taskContext=session.authContext;
        const allowed=await license.assertActionAllowed(taskContext);
        if(!allowed.ok) return json(res,allowed,401);
        if(browserControl.isHeld()) return json(res,{ok:false,error:'账号网页正在切换，请稍后再检查'},409);
        if(parts[3]==='check') return json(res,await engine.checkLogin(id));
        startTask(session,()=>engine.openForLogin(id)); return json(res,{ok:true,started:true});
      } finally { if(reserveCheck) taskPending=false; releaseSession(); }
    }
  }
  if(method==='GET'&&pathname==='/api/leads') {
    const params=Object.fromEntries(new URL(req.url,'http://127.0.0.1').searchParams); const all=store.getLeads();
    const videos=store.getVideos(),settings=store.getSettings(),ruleVersion=ai.getRuleSet(settings).version,queryOptions={settings,ruleVersion,now:Date.now()};
    const filtered=filterLeads(all,videos,params,queryOptions); const limit=Math.min(5000,Math.max(1,Number(params.limit)||500)); const offset=Math.max(0,Number(params.offset)||0);
    const aiPending=filtered.filter(l=>isCommentUser(l,videos)&&!isAiResultCurrent(l,ruleVersion,videos)).length;
    const facets={ai:aiFacetCounts(all,videos,params,queryOptions)};
    return json(res,{ok:true,leads:filtered.reverse().slice(offset,offset+limit).map(lead=>({...lead,aiResultCurrent:isAiResultCurrent(lead,ruleVersion,videos),aiCategory:aiCategory(lead,videos,queryOptions),aiExclusionReason:aiExclusionReason(lead,videos),contactCategory:contactCategory(lead)})),total:all.length,totalFiltered:filtered.length,aiPending,facets,leadFields:publicLeadFields()});
  }
  if(parts[1]==='leads'&&method==='POST') {
    const b=await readBody(req); const leads=store.getLeads(); const lead=leads.find(l=>String(l.id)===parts[2]); if(!lead) return json(res,{ok:false,error:'线索不存在'},404);
    if(parts[3]==='resolve') {
      if(engineBusy()||taskPending) return json(res,{ok:false,error:'请停止或等待任务结束后核验，避免与正在执行的结果互相覆盖'},409);
      resolveLead(parts[2],b,session); return json(res,{ok:true});
    }
    if(parts[3]==='status') {
      if(!['replied','do_not_contact','manual_approved','skipped'].includes(b.status)) return json(res,{ok:false,error:'状态无效，请使用核验操作确认成功或失败'},400);
      if(b.status==='manual_approved'&&(lead.aiDone||lead.aiNeed)) return json(res,{ok:false,error:'人工批准仅适用于AI未判断线索；已有AI结果请先重新判断'},400);
      const business=String(lead.businessId||store.getSettings().outreach.businessId||'default');
      for(const l of leads.filter(l=>String(l.uid||l.UID)===String(lead.uid||lead.UID)&&String(l.businessId||store.getSettings().outreach.businessId||'default')===business)) {
        if(b.status==='manual_approved') l.manualApproved=true; else { l.status=b.status; if(b.status==='replied') l.replied=true; if(b.status==='do_not_contact'||b.status==='skipped') l.doNotContact=true; }
        l.manualUpdatedAt=store.nowStr(); l.manualUpdatedBy=session.username;
      }
      store.setLeads(leads); return json(res,{ok:true});
    }
    if(parts[3]==='open') { requireAccount(b.accountId); startTask(session,()=>engine.openLeadProfile(b.accountId,lead.id)); return json(res,{ok:true,started:true}); }
  }
  if(['follow','dm','outreach'].includes(parts[1])&&method==='POST') {
    const b=await readBody(req); requireAccount(b.accountId);
    if(parts[2]==='preview') { const plan=engine.createPlan(b.accountId,parts[1],{filters:b.filters||{},...(Object.hasOwn(b,'leadIds')?{leadIds:b.leadIds}:{}),follow:parts[1]!=='dm',dm:parts[1]!=='follow',owner:session.username,crossAccount:true}); return json(res,plan); }
    if(parts[2]==='start') {
      const plan=store.getPlans().find(p=>p.id===b.planId||p.planId===b.planId);
      if(!plan||plan.owner!==session.username||String(plan.accountId)!==String(b.accountId)||plan.kind!==parts[1]) return json(res,{ok:false,error:'预检查名单无效，请重新预检查'},400);
      if(Date.now()>new Date(plan.expiresAt).getTime()||plan.state==='consumed'||plan.consumedAt) return json(res,{ok:false,error:'名单已过期或已执行，请重新预检查'},409);
      const allowed=await license.assertActionAllowed(session.authContext); if(!allowed.ok) return json(res,allowed,401);
      startTask(session,()=>engine[parts[1]+'Task'](b.accountId,{planId:b.planId,follow:plan.actions.follow,dm:plan.actions.dm})); return json(res,{ok:true,started:true,planId:b.planId});
    }
  }
  if(parts[1]==='dm-distribution'&&method==='POST') {
    const b=await readBody(req);
    if(parts[2]==='preview') return json(res,engine.dmDistributionPreview(b));
    if(parts[2]==='start') {
      const allowed=await license.assertActionAllowed(session.authContext); if(!allowed.ok) return json(res,allowed,401);
      startTask(session,()=>engine.dmDistributionTask(b)); return json(res,{ok:true,started:true});
    }
    if(parts[2]==='clear-state') {
      if(engineBusy()||taskPending) return json(res,{ok:false,error:'请停止任务后再操作'},409);
      const accountId=requireAccount(b.accountId);
      const state=typeof store.getDmAccountState==='function'?(store.getDmAccountState()||{}):{};
      if(state[accountId]) { delete state[accountId]; if(typeof store.setDmAccountState==='function') store.setDmAccountState(state); }
      store.log(accountId, '私信分发状态已由 ' + session.username + ' 手动恢复');
      return json(res,{ok:true});
    }
  }
  // 私信实时同步（聊天界面）
  if(pathname==='/api/chat/state'&&method==='GET') {
    const query=new URL(req.url,'http://127.0.0.1').searchParams;
    const leads=store.getLeads(), bySec=new Map(); for(const l of leads) if(l.uid&&!bySec.has(l.uid)) bySec.set(l.uid,l);
    const inbox=store.getInbox(), status=engine.chat.status();
    const conversations=require('./lib/inbox-store').listChats(inbox,{accounts:store.getAccounts(),leadsBySecUid:bySec,onlyPeer:query.get('onlyPeer')==='1'});
    return json(res,{ok:true,version:status.version,runtimes:status.runtimes,conversations});
  }
  if(pathname==='/api/chat/messages'&&method==='GET') {
    const query=new URL(req.url,'http://127.0.0.1').searchParams;
    const account=store.getInbox().accounts[String(query.get('accountId')||'')];
    const conv=account&&account.conversations[String(query.get('peerUid')||'')];
    if(!conv) return json(res,{ok:false,error:'没有这个会话'},404);
    const lead=conv.peerSecUid?store.getLeads().find(l=>l.uid===conv.peerSecUid):null;
    return json(res,{ok:true,conversation:{accountId:query.get('accountId'),peerUid:conv.peerUid,peerSecUid:conv.peerSecUid||'',nickname:conv.nickname||(lead&&lead.nickname)||'',inbox:conv.inbox||'',
      followerStatus:conv.followerStatus??null,lead:lead?{id:lead.id,nickname:lead.nickname,replied:!!lead.replied,demand:String(lead.demand||'').slice(0,200),dmLastAt:lead.dmLastAt||''}:null},messages:conv.messages||[]});
  }
  if(parts[1]==='chat'&&method==='POST') {
    const b=await readBody(req);
    if(parts[2]==='connect'||parts[2]==='disconnect') {
      const ids=Array.isArray(b.accountIds)&&b.accountIds.length?[...new Set(b.accountIds.map(String))]:(store.getAccounts()||[]).map(a=>String(a.id));
      for(const id of ids) requireAccount(id);
      for(const id of ids) engine.chat[parts[2]](id).catch(()=>{});
      return json(res,{ok:true,accountIds:ids});
    }
    if(parts[2]==='open') { requireAccount(b.accountId); return json(res,await engine.chat.openConversation(String(b.accountId),String(b.peerUid||''))); }
    if(parts[2]==='send') { requireAccount(b.accountId); return json(res,await engine.chat.send(String(b.accountId),String(b.peerUid||''),String(b.text||''))); }
  }
  // 私信归集：检查（只读）、列表、标记已读
  if(method==='POST'&&pathname==='/api/inbox/scan') { const b=await readBody(req); const ids=Array.isArray(b.accountIds)&&b.accountIds.length?[...new Set(b.accountIds.map(String))]:(store.getAccounts()||[]).map(a=>String(a.id)); for(const id of ids) requireAccount(id); startTask(session,()=>engine.inboxTask(ids)); return json(res,{ok:true,started:true}); }
  if(method==='GET'&&pathname==='/api/inbox') {
    const query=new URL(req.url,'http://127.0.0.1').searchParams;
    const leads=store.getLeads(), bySec=new Map(); for(const l of leads) if(l.uid&&!bySec.has(l.uid)) bySec.set(l.uid,l);
    const inbox=store.getInbox();
    const rows=require('./lib/inbox-store').listConversations(inbox,{accounts:store.getAccounts(),leadsBySecUid:bySec,onlyPeer:query.get('all')!=='1'});
    const scanned=Object.fromEntries(Object.entries(inbox.accounts||{}).map(([id,a])=>[id,{scannedAt:a.scannedAt||0,baselineAt:a.baselineAt||0,count:Object.keys(a.conversations||{}).length}]));
    return json(res,{ok:true,rows,scanned});
  }
  if(method==='POST'&&pathname==='/api/inbox/read') { const b=await readBody(req); const inbox=store.getInbox(); const ok=require('./lib/inbox-store').markRead(inbox,b.accountId,b.peerUid); if(ok) store.setInbox(inbox); return json(res,{ok}); }
  if(method==='POST'&&pathname==='/api/collect/start') { const b=await readBody(req); const ids=Array.isArray(b.accountIds)&&b.accountIds.length?[...new Set(b.accountIds.map(String))]:[b.accountId]; for(const id of ids) requireAccount(id); startTask(session,()=>engine.collectTask(ids.length>1?ids:ids[0],b.links||b.videoUrls||b.videoUrl)); return json(res,{ok:true,started:true}); }
  if(method==='GET'&&pathname==='/api/search/results') return json(res,{ok:true,results:store.getSearchResults()});
  if(method==='GET'&&pathname==='/api/search/keyword-stats') return json(res,{ok:true,rows:require('./lib/keyword-stats').summarizeKeywords(store.getKeywordStats(),store.getLeads(),store.getVideos(),store.getSearchResults())});
  if(method==='GET'&&pathname==='/api/search/draft') return json(res,{ok:true,draft:store.getSearchDraft()});
  if(method==='POST'&&pathname==='/api/search/draft') { const b=await readBody(req); return json(res,{ok:true,draft:store.setSearchDraft(b)}); }
  if(method==='POST'&&pathname==='/api/search/start') { const b=await readBody(req); requireAccount(b.accountId); startTask(session,()=>engine.searchTask(b.accountId,b)); return json(res,{ok:true,started:true}); }
  if(method==='POST'&&pathname==='/api/search/clear') { if(engine.taskState.running||engine.taskState.distributionActive) return json(res,{ok:false,error:'任务期间不能清空搜索结果'},409); store.setSearchResults([]); return json(res,{ok:true}); }
  if(method==='GET'&&pathname==='/api/ai/models') { return json(res,{ok:true,...await aiAssist(session,options=>ai.listModels(store.getSettings(),{...options,forceRefresh:true}))}); }
  if(parts[1]==='ai'&&method==='POST') {
    const b=await readBody(req);
    if(parts[2]==='start') { startTask(session,()=>engine.aiTask({filters:b.filters||{},...(Object.hasOwn(b,'leadIds')?{leadIds:b.leadIds}:{}),...(Object.hasOwn(b,'force')?{force:b.force}:{})})); return json(res,{ok:true,started:true}); }
    if(parts[2]==='judge-one') {
      if(engineBusy()||taskPending||browserControl.isHeld()) return json(res,{ok:false,error:'请等待当前任务或网页切换结束'},409);
      taskContext=session.authContext; taskPending=true;
      const releaseSession=holdSessionForWork(session);
      try { return json(res,await engine.aiJudgeOne(b.leadId)); } finally { taskPending=false; releaseSession(); }
    }
    if(parts[2]==='prompt-draft'||parts[2]==='prompt-test') { const allowed=await license.assertActionAllowed(session.authContext); if(!allowed.ok) return json(res,allowed,401); const result=await aiAssist(session,options=>parts[2]==='prompt-draft'?ai.generatePromptDraft(store.getSettings(),b.businessInput||{},options):ai.testPromptDraft(store.getSettings(),b,options)); return json(res,{ok:true,...result}); }
  }
  if(method==='GET'&&pathname==='/api/videos') return json(res,{ok:true,videos:Object.entries(store.getVideos()).map(([id,record])=>projectWork(record,id)).sort((a,b)=>String(b.lastCollectAt||b.capturedAt||'').localeCompare(String(a.lastCollectAt||a.capturedAt||'')))});
  if(method==='DELETE'&&parts[1]==='videos'&&parts[2]) { if(engine.taskState.running||engine.taskState.distributionActive) return json(res,{ok:false,error:'任务期间不能删除视频历史'},409); const v=store.getVideos(); delete v[parts[2]]; store.setVideos(v); return json(res,{ok:true}); }
  if(method==='GET'&&parts[1]==='logs') return json(res,{ok:true,lines:store.tailLog(parts[2],100)});
  if(method==='GET'&&pathname==='/api/export') {
    // GET 默认导出全部，避免“没有筛选条件却少导数据”；需要筛选时显式传 scope=filters。
    const query=Object.fromEntries(new URL(req.url,'http://127.0.0.1').searchParams);
    return exportExcel(res,{scope:['filters','selected','all'].includes(query.scope)?query.scope:'all'});
  }
  if(method==='POST'&&pathname==='/api/export') return exportExcel(res,await readBody(req));
  return json(res,{ok:false,error:'接口不存在'},404);
}
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  try {
    const pathname=new URL(req.url||'/','http://127.0.0.1').pathname;
    if(req.method==='GET'&&pathname==='/health') return json(res,{ok:true,app:'dy-lead-app',version:'2.5.3',port:actualPort});
    if(pathname.startsWith('/api/')) {
      if(DESKTOP_TOKEN&&req.headers['x-desktop-token']!==DESKTOP_TOKEN) return json(res,{ok:false,error:'仅允许本机客户端访问'},403);
      const origin=req.headers.origin; if(origin&&origin!=='http://127.0.0.1:'+actualPort) return json(res,{ok:false,error:'来源不受信任'},403);
      return await handleApi(req,res,pathname);
    }
    const decoded=decodeURIComponent(pathname); const file=path.resolve(WEB_DIR,'.'+(decoded==='/'?'/index.html':decoded));
    if(!file.startsWith(WEB_DIR+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"}); fs.createReadStream(file).pipe(res);
  } catch(e) { if(!res.headersSent) json(res,{ok:false,error:e.message},400); else res.end(); }
});
try {
  engine.migrateLeads();
  const previous=store.getTaskCheckpoint?.();
  if(previous?.state==='running') {
    const checkpoint={...previous,state:'interrupted',stopReason:'程序上次异常退出；请核验待核验操作，再重新预检查',updatedAt:store.nowStr()};
    store.setTaskCheckpoint(checkpoint);engine.taskState.checkpoint=checkpoint;engine.taskState.status=checkpoint.stopReason;
  } else if(previous) engine.taskState.checkpoint=previous;
} catch(e) { console.error('数据迁移未完成：'+e.message); process.exitCode=1; }
server.listen(PORT,'127.0.0.1',()=>{
  actualPort=server.address().port;
  console.log(JSON.stringify({event:'ready',port:actualPort,app:'dy-lead-app',version:'2.5.3'}));
  if(process.send) process.send({type:'ready',port:actualPort,dataDir:path.resolve(store.DATA_DIR)});
  setInterval(()=>license.syncTime().catch(()=>{}),60000).unref();
});
server.on('error',e=>{ console.error('客户端服务启动失败：'+e.message); process.exit(1); });
async function shutdown() { browserControl.dispose(); startupLoginScan.cancel(); engine.stopTask(); for(const controller of aiAssistRequests.keys()) controller.abort(); if(engine.shutdown) await engine.shutdown(); for(const s of sessions.values()) license.clearSession(s.authContext); server.close(); process.exit(0); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
process.on('message',message=>{
  if(message?.type==='shutdown') shutdown();
  if(message?.type==='embedded:control-release') browserControl.release(message.id);
  if(message?.type==='embedded:control-check' && typeof message.id==='string') {
    Promise.resolve().then(async()=>{
      if(!taskContext) throw new Error('请先登录客户端并打开账号浏览器');
      return browserControl.acquire(message.id);
    }).catch(error=>({ok:false,error:error.message})).then(result=>{
      if(process.connected) process.send({type:'embedded:control-result',id:message.id,...result});
    });
  }
});

