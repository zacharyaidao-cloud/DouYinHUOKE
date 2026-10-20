'use strict';
// Explicit, bounded live semantic check. Reads the existing provider key into
// memory only; never saves settings, updates leads, or performs platform actions.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
if(!process.argv.includes('--live')) { console.log('Requires --live; no network request sent.');process.exit(0); }
const output=path.join(root,'outputs','ai-review-v2212');fs.mkdirSync(output,{recursive:true});
process.env.DY_LEAD_DATA_DIR=path.join(output,'isolated-empty-data');
const AI=require(path.join(root,'dy-lead-app','ai'));
const store=require(path.join(root,'dy-lead-app','store'));
const installedPath='D:/华贸自媒体获客/data/settings.json';
const saved=JSON.parse(fs.readFileSync(installedPath,'utf8'));
if(!saved.ai?.apiKey||saved.ai.baseUrl!=='https://api.deepseek.com') throw Error('需要已保存的官方 DeepSeek 配置');
const report={version:'2.2.12',startedAt:new Date().toISOString(),model:saved.ai.model,scope:'36条匿名化语义样本，含32条明确期望和4条歧义观察；不是全库准确率',installedDataWritten:false,platformActions:false,runs:[]};
const fileHash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
report.sourceHashes=Object.fromEntries(['ai.js','lib/ai-policy.js'].map(name=>[name,fileHash(path.join(root,'dy-lead-app',name))]));
const audit=JSON.parse(fs.readFileSync(path.join(root,'outputs','ai-audit-2026-10-08','comparison.json'),'utf8'));
const ids=[1,3,66,67,69,73,75,76,78,79,80,81,82,83,86,87,88,91,93,107,68,74,92,98];
const ambiguous=new Set([68,74,92,98]);
const samples=ids.map(id=>{const r=audit.rows.find(x=>x.auditNo===id);return {name:'复核'+id,comment:r.comment,videoDescription:r.videoDescription,expected:ambiguous.has(id)?null:r.reviewNeed};});
const context=ref=>audit.rows.find(r=>r.workRef===ref).videoDescription;
const pairs=[
 ['供给回答','可以处理的','work-4','否'],['省略求助','可以处理吗？','work-4','是'],
 ['提供案例','有案例','work-4','否'],['咨询案例','你有通过案例吗？','work-1','是'],
 ['推荐渠道','我认识的人可以解决','work-4','否'],['替朋友求助','朋友的店铺停用了，能处理吗？','work-4','是'],
 ['既往成功','之前申诉成功过，十来天','work-4','否'],['新的求助','自己申诉过又停用了，怎么办？','work-4','是'],
 ['分析作者','这是店铺关联了吧','work-6','否'],['本人当前问题','我的店铺关联了，有什么办法？','work-6','是'],
 ['评论明确其它平台','抖店的货款被冻结怎么处理？','work-1','否'],['主营资金问题','亚马逊资金被冻结了，多久能处理？','work-1','是'],
];
for(const [name,comment,work,expected] of pairs)samples.push({name,comment,videoDescription:context(work),expected});
const leads=samples.map((s,i)=>({id:'isolated-'+(i+1),demand:s.comment,videoDescription:s.videoDescription}));
const defaults=store.getSettings();
const tuned={...defaults,ai:{...defaults.ai,enabled:true,apiKey:saved.ai.apiKey,model:saved.ai.model,requestTimeoutSec:120}};
const existing={...saved,ai:{...saved.ai,requestTimeoutSec:120}};
const reportPath=path.join(output,'live-semantic-check.json');
const persist=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
let requestCount=0;
const networkFetch=globalThis.fetch;
globalThis.fetch=async(address,options)=>{
 const url=new URL(String(address));
 if(url.origin!=='https://api.deepseek.com'||!['/models','/chat/completions'].includes(url.pathname))throw Error('测试阻止非官方接口');
 if(++requestCount>10)throw Error('测试请求次数已达到上限');
 return networkFetch(address,options);
};
async function judge(name,settings) {
 const usage=[],requests=[];console.log(JSON.stringify({phase:'request',name,samples:samples.length}));
 const result=await AI.judgeBatch(settings,leads,{}, {signal:AbortSignal.timeout(130000),onRequest:item=>requests.push(item),onUsage:item=>usage.push(item)});
 if(!result)throw Error('真实回执未通过严格格式检查');
 const rows=samples.map((sample,i)=>({...sample,need:result[i+1].need,reason:result[i+1].reason,match:sample.expected===null?null:sample.expected===result[i+1].need}));
 const run={name,ruleVersion:AI.getRuleSet(settings).version,usage,requestCount:requests.length,total:rows.length,scored:rows.filter(r=>r.match!==null).length,matched:rows.filter(r=>r.match===true).length,observations:rows.filter(r=>r.match===null),mismatches:rows.filter(r=>r.match===false),rows};
 report.runs.push(run);persist();console.log(JSON.stringify({phase:'complete',name,scored:run.scored,matched:run.matched,mismatches:run.mismatches.map(r=>({name:r.name,comment:r.comment,need:r.need,reason:r.reason}))}));
}
(async()=>{
 try {
   await judge('新行业预设',tuned);
   await judge('保留现有自定义提示词',existing);
   console.log(JSON.stringify({phase:'generate_prompt'}));
   const profile=store.getIndustryProfile().businessInput;
   const generated=await AI.generatePromptDraft(tuned,profile,{signal:AbortSignal.timeout(130000)});
   report.generatedPrompt={inspection:AI.inspectPromptDraft(generated.prompt),prompt:generated.prompt};persist();
   const generatedSettings={...tuned,ai:{...tuned.ai,prompt:generated.prompt,activePromptId:'prompt-1',promptPresets:tuned.ai.promptPresets.map(p=>p.id==='prompt-1'?{...p,prompt:generated.prompt}:p)}};
   await judge('AI生成的行业预设',generatedSettings);
   report.finishedAt=new Date().toISOString();report.requestCount=requestCount;persist();
   console.log(JSON.stringify({phase:'all_completed',runs:report.runs.length,requestCount,reportPath}));
 } catch(error) {report.error={code:error.code||'',message:String(error.message||error).slice(0,400)};report.requestCount=requestCount;persist();console.error(JSON.stringify({phase:'failed',...report.error}));process.exitCode=1;}
 finally {globalThis.fetch=networkFetch;}
})();
