'use strict';
// 仅查看当前安装版本和运行任务，不打印配置或凭据，也不修改安装目录。
const fs=require('fs');
const path=require('path');
const dir='D:\\华贸自媒体获客';
(async()=>{
  if(!fs.existsSync(path.join(dir,'config.json'))) return console.log(JSON.stringify({installed:false}));
  const cfg=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8').replace(/^\uFEFF/,''));
  const base='http://127.0.0.1:17888';
  const health=await fetch(base+'/health',{signal:AbortSignal.timeout(1500)}).then(async r=>{try{return await r.json();}catch{return {};}}).catch(()=>null);
  if(!health) return console.log(JSON.stringify({installed:true,running:false}));
  if(!cfg.adminPassword) return console.log(JSON.stringify({installed:true,running:true,version:health.version||'legacy',taskKnown:false}));
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'huamao',password:cfg.adminPassword}),signal:AbortSignal.timeout(3000)}).then(r=>r.json());
  if(!login.ok) return console.log(JSON.stringify({installed:true,running:true,version:health.version||'legacy',taskKnown:false}));
  const state=await fetch(base+'/api/state',{headers:{'x-auth-token':login.token},signal:AbortSignal.timeout(3000)}).then(r=>r.json());
  console.log(JSON.stringify({installed:true,running:true,version:health.version||'legacy',taskKnown:!!state.task,taskRunning:!!state.task?.running,taskKind:state.task?.kind||null,accountCount:state.accounts?.length,dataDir:state.dataDir||''}));
})().catch(e=>{console.log(JSON.stringify({errorType:e.name,inspectionFailed:true}));process.exitCode=1;});
