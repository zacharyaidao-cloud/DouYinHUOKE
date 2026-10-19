'use strict';
// 仅使用隔离数据和本地假后端，不调用真实平台或付费AI。
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {spawn,spawnSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..'),SOURCE=path.join(ROOT,'dy-lead-app');
const expectedVersion=JSON.parse(fs.readFileSync(path.join(ROOT,'desktop','package.json'),'utf8')).version;
const tests=fs.readdirSync(path.join(SOURCE,'tests')).filter(n=>n.endsWith('.test.js')&&n!=='ui.test.js').map(n=>path.join(SOURCE,'tests',n));
const suite=spawnSync(path.join(SOURCE,'node.exe'),['--test',...tests],{stdio:'inherit',windowsHide:true});
if(suite.status!==0) process.exit(suite.status||1);
async function smoke(appDir) {
  const fixture=fs.mkdtempSync(path.join(__dirname,'qa-service-'));
  const child=spawn(path.join(SOURCE,'node.exe'),[path.join(appDir,'server.js')],{cwd:appDir,windowsHide:true,env:{...process.env,DY_LEAD_DATA_DIR:fixture,DY_LEAD_PORT:'0',DY_LEAD_DESKTOP_TOKEN:'qa-private-desktop'},stdio:['ignore','pipe','pipe','ipc']});
  let errors='';child.stderr.on('data',d=>errors+=d);
  try {
    const port=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('服务启动超时 '+errors)),15000);
      child.on('message',m=>{if(m?.type==='ready') {clearTimeout(timeout);resolve(m.port);}});
      child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',c=>{clearTimeout(timeout);reject(new Error('服务提前退出 '+c+' '+errors));});
    });
    const base='http://127.0.0.1:'+port;
    const request=(url,body,nonce='qa-private-desktop')=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-desktop-token':nonce},body:body===undefined?undefined:JSON.stringify(body)});
    const health=await request('/health').then(r=>r.json());assert.equal(health.version,expectedVersion);assert.equal(health.port,port);
    assert.equal((await request('/api/state',undefined,'wrong')).status,403);
    assert.equal((await request('/api/state')).status,401);
    assert.equal((await request('/api/license-admin/users')).status,404);
    assert.equal((await request('/api/tasks/stop',{})).status,200);
    const html=await fetch(base).then(r=>r.text());assert.ok(html.includes('login-layer'));assert.ok(!html.includes('lic-admin-box'));
    assert.equal(fs.existsSync(path.join(fixture,'本机管理员密码.txt')),false);
    for(const name of ['index.html','app.js','style.css']) assert.equal(fs.readFileSync(path.join(appDir,'web',name),'utf8'),fs.readFileSync(path.join(SOURCE,'web',name),'utf8'));
    console.log('PASS 服务启动、随机端口、API隔离、无管理员、停止可用及静态资源一致：'+path.basename(appDir));
  } finally {
    if(child.connected) child.send({type:'shutdown'});
    if(child.exitCode===null) await new Promise(resolve=>{ const timer=setTimeout(()=>{child.kill();resolve();},10000); child.once('exit',()=>{clearTimeout(timer);resolve();}); });
  }
}
(async()=>{await smoke(SOURCE);await smoke(path.join(ROOT,'dy-lead-app-release'));})().catch(e=>{console.error(e.stack);process.exitCode=1;});

