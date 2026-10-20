'use strict';
// Temporary, localhost-only Node inspector attachment. Never enables Debugger
// or pauses the program. The inspector is closed after each command.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { WebSocket } = require('../dy-lead-app/node_modules/ws');
const [operation, rawPid, appDir, outputDir, accountId] = process.argv.slice(2);
const pid = Number(rawPid);
if (!['probe', 'start', 'work-probe', 'comment-probe', 'collection-probe', 'dm-probe'].includes(operation) || !Number.isInteger(pid) || pid < 1 || !path.isAbsolute(appDir)) throw new Error('Invalid capture arguments');
function discovery() {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:9229/json/list', response => {
      let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(new Error('Inspector discovery limit')); });
      response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    req.setTimeout(1500, () => req.destroy(new Error('Inspector discovery timeout'))); req.on('error', reject);
  });
}
(async () => {
  let occupied = false;
  try { await discovery(); occupied = true; } catch (_) {}
  if (occupied) throw new Error('Inspector port already in use; refusing to attach to an unknown process');
  process._debugProcess(pid);
  let targets;
  for (let i = 0; i < 30; i++) {
    try { targets = await discovery(); break; } catch (_) { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!targets || targets.length !== 1) throw new Error('Cannot discover the selected backend inspector');
  const endpoint = new URL(targets[0].webSocketDebuggerUrl);
  if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== '9229') throw new Error('Unexpected inspector address');
  const socket = new WebSocket(endpoint.href);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let id = 0; const pending = new Map();
  socket.on('message', message => {
    let item; try { item = JSON.parse(message); } catch (_) { return; }
    const pair = pending.get(item.id); if (!pair) return; pending.delete(item.id); clearTimeout(pair.timer);
    if (item.error || item.result?.exceptionDetails) pair.reject(new Error('Backend evaluation failed: ' + (item.error?.message || item.result.exceptionDetails.exception?.description?.slice(0, 400) || item.result.exceptionDetails.text)));
    else pair.resolve(item.result?.result?.value);
  });
  function evaluate(expression) {
    return new Promise((resolve, reject) => {
      const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Backend evaluation timeout')); }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }
  let verified = false;
  try {
    const identity = await evaluate(`({pid:process.pid,main:process.mainModule&&process.mainModule.filename})`);
    if (identity.pid !== pid || path.resolve(identity.main).toLowerCase() !== path.join(path.resolve(appDir), 'server.js').toLowerCase()) throw new Error('Selected backend identity does not match');
    verified = true;
    const result = await evaluate(`(()=>{const r=process.mainModule.require.bind(process.mainModule);const e=r('./engine.js');const p=r('playwright-core');return {version:r('./resources/app/package.json').version,task:{running:e.taskState.running,kind:e.taskState.kind,accountId:e.taskState.accountId},contexts:[...p.chromium._contexts].map(c=>({pages:c.pages().length,profile:c._browser&&c._browser._options&&c._browser._options.userDataDir||null}))};})()`);
    if (!['2.3.13', '2.3.14', '2.3.15', '2.3.16', '2.3.17', '2.3.18', '2.3.19', '2.3.20', '2.3.21'].includes(result.version)) throw new Error('Capture expects an inspected 2.3.13–2.3.21 release');
    if (operation === 'start') {
      if (!path.isAbsolute(outputDir) || !/^[\w-]{1,100}$/.test(accountId)) throw new Error('Invalid capture destination/account');
      const helper = path.join(__dirname, 'runtime-passive-capture.js');
      if (!fs.existsSync(helper)) throw new Error('Missing passive capture helper');
      const options = { appDir: path.resolve(appDir), outputDir: path.resolve(outputDir), accountId, version: result.version, durationMs: 60 * 60000 };
      const started = await evaluate(`process.mainModule.require(${JSON.stringify(helper)}).start(${JSON.stringify(options)})`);
      console.log(JSON.stringify({ ok: true, operation, version: result.version, ...started }));
    } else if (operation === 'dm-probe') {
      if (!/^[\w-]{1,100}$/.test(accountId) || String(result.task.accountId) !== accountId || result.contexts.length !== 1) throw new Error('Selected account/context does not match');
      const helper = path.join(__dirname, 'runtime-dm-probe.js');
      const facts = await evaluate(`process.mainModule.require(${JSON.stringify(helper)}).inspect(${JSON.stringify(accountId)})`);
      if (outputDir && path.isAbsolute(outputDir)) fs.writeFileSync(path.join(outputDir,'私信频繁提示DOM结构.json'),JSON.stringify(facts,null,2));
      console.log(JSON.stringify({ok:true,operation,version:result.version,...facts}));
    } else if (operation === 'collection-probe') {
      if (!/^[\w-]{1,100}$/.test(accountId) || result.task.accountId !== accountId || result.contexts.length !== 1) throw new Error('Selected account/context does not match');
      const helper = path.join(__dirname, 'runtime-collection-probe-v2.js');
      const facts = await evaluate(`process.mainModule.require(${JSON.stringify(helper)}).inspect(${JSON.stringify(accountId)})`);
      console.log(JSON.stringify({ ok: true, operation, version: result.version, ...facts }));
    } else if (operation === 'comment-probe') {
      if (!/^[\w-]{1,100}$/.test(accountId) || result.task.accountId !== accountId || result.contexts.length !== 1) throw new Error('Selected account/context does not match');
      const helper = path.join(__dirname, 'runtime-comment-probe.js');
      const facts = await evaluate(`process.mainModule.require(${JSON.stringify(helper)}).inspect(${JSON.stringify(accountId)})`);
      console.log(JSON.stringify({ ok: true, operation, version: result.version, ...facts }));
    } else if (operation === 'work-probe') {
      if (!/^[\w-]{1,100}$/.test(accountId) || result.task.accountId !== accountId || result.contexts.length !== 1) throw new Error('Selected account/context does not match');
      const facts = await evaluate(`(async()=>{const r=process.mainModule.require.bind(process.mainModule),e=r('./engine.js'),p=r('playwright-core'),c=[...p.chromium._contexts][0];const pages=[];for(const page of c.pages()){const u=new URL(page.url()),m=/^\\/(video|note)\\/(\\d{1,24})\\/?$/.exec(u.pathname);pages.push({closed:page.isClosed(),trusted:['www.douyin.com','douyin.com'].includes(u.hostname)&&u.protocol==='https:',work:m?{type:m[1],id:m[2]}:null,commentProbe:await page.evaluate(r('./lib/collection-browser').openComments,{probe:true}).catch(()=>({state:'unreadable'})),document:await page.evaluate(()=>({readyState:document.readyState,commentMarkers:document.querySelectorAll('[data-e2e="comment-item"],[data-e2e="comment-level-1"]').length})).catch(()=>({readyState:'unreadable'}))});}return{at:new Date().toISOString(),running:e.taskState.running,stage:e.taskState.stage,currentWork:e.taskState.currentWork,pages};})()`);
      console.log(JSON.stringify({ ok: true, operation, version: result.version, ...facts }));
    } else console.log(JSON.stringify({ ok: true, operation, ...result }));
  } finally {
    // setImmediate runs after this response is sent, so no endpoint is left
    // available while the operator performs the real website workflow.
    if (verified) try { await evaluate(`setImmediate(()=>process.mainModule.require('node:inspector').close());({inspectorClosing:true})`); } catch (_) {}
    socket.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
