'use strict';

// Isolated manufactured pages only. The loopback rejecting proxy plus routing
// prevent all real platform/account access, including background requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, process.argv.includes('--build') ? 'dy-lead-app-release' : 'dy-lead-app');
const adapter = require(path.join(APP, 'lib/outreach-browser.js'));
const { chromium } = require(path.join(APP, 'node_modules/playwright-core'));
const manifest = require(path.join(APP, 'node_modules/playwright-core/browsers.json'));
const revision = manifest.browsers.find(item => item.name === 'chromium').revision;
const executablePath = path.join(APP, 'node_modules/playwright-core/.local-browsers', `chromium-${revision}`, 'chrome-win64/chrome.exe');
const lead = uid => ({ uid, homepage: 'https://www.douyin.com/user/' + uid });
const A = lead('qa_target_alpha'), B = lead('qa_target_beta');
const message = '仅在封网测试页面验证，不联系真实用户。';

function html({ wrongAfterOpen = false, unknownExtra = false, bothTargets = false } = {}) {
  return `<!doctype html><meta charset="utf-8"><style>section{padding:10px}textarea{width:300px;height:40px}</style>
    <section data-e2e="user-info"><button id="follow">关注</button><button id="open">私信</button></section>
    <div id="panels"></div><script>
      window.actions = []; window.inputs = []; window.opened = 0; window.followClicks = [];
      document.querySelector('[data-e2e="user-info"]').addEventListener('click', e => {
        if (e.target.id==='follow') window.followClicks.push({trusted:e.isTrusted});
      });
      window.createPanel = function(id, recipient) {
        const panel = document.createElement('section'); panel.setAttribute('role','dialog'); panel.id=id;
        panel.innerHTML = '<div data-e2e="chat-header">'+(recipient ? '<a href="/user/'+recipient+'">当前收件人</a>' : '未确认收件人')+'</div><textarea></textarea><button aria-label="发送消息">发送</button>';
        panel.querySelector('textarea').value = id==='old' ? '旧会话草稿' : '';
        panel.querySelector('textarea').addEventListener('input', e=>window.inputs.push({id,trusted:e.isTrusted}));
        panel.querySelector('button').addEventListener('click', e=>window.actions.push({id,trusted:e.isTrusted,recipient:panel.querySelector('a')?.getAttribute('href')}));
        document.getElementById('panels').append(panel); return panel;
      };
      window.createPanel('old', '${A.uid}');
      document.getElementById('open').addEventListener('click', () => {
        window.opened++;
        if (!document.getElementById('current')) window.createPanel('current','${wrongAfterOpen ? A.uid : B.uid}');
        ${unknownExtra ? "window.createPanel('unknown','');" : ''}
        ${bothTargets ? `window.createPanel('duplicate','${B.uid}');` : ''}
      });
    </script>`;
}

(async () => {
  let blocker, browser;
  const passed = [];
  try {
    assert(fs.existsSync(executablePath), 'Bundled Chromium must be available');
    blocker = net.createServer(socket => socket.destroy());
    await new Promise((resolve,reject) => { blocker.once('error',reject); blocker.listen(0,'127.0.0.1',resolve); });
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, proxy:{server:'http://127.0.0.1:'+blocker.address().port} });
    async function fixture(options) {
      const context = await browser.newContext({ serviceWorkers:'block' });
      await context.route('**/*', route => {
        const r=route.request(), u=new URL(r.url());
        return r.isNavigationRequest() && u.origin==='https://www.douyin.com' && /^\/user\/qa_[a-z_]+$/.test(u.pathname)
          ? route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html(options)}) : route.abort();
      });
      const page=await context.newPage(); await page.goto(B.homepage); return {context,page};
    }
    async function test(name, fn) { await fn(); passed.push(name); process.stdout.write('PASS '+name+'\n'); }
    await test('Follow node replacement on same profile re-resolves once before native click', async()=>{
      const {context,page}=await fixture();
      try {
        const follow=await adapter.prepareFollow(page,B); assert.equal(follow.state,'ready');
        await page.locator('#follow').evaluate(element=>element.replaceWith(element.cloneNode(true)));
        assert.equal(await follow.click(),true);
        assert.deepEqual(await page.evaluate(()=>window.followClicks),[{trusted:true}]);
        await assert.rejects(follow.click(),e=>e.actionNotStarted===true && e.code==='FOLLOW_PREPARATION_CONSUMED');
        assert.equal((await page.evaluate(()=>window.followClicks)).length,1);
      } finally { await context.close(); }
    });
    await test('Follow path changes on same profile resolve to the fresh unique control', async()=>{
      const {context,page}=await fixture();
      try {
        const follow=await adapter.prepareFollow(page,B);
        await page.locator('#follow').evaluate(element=>{ const label=document.createElement('span'); label.textContent='资料加载完成'; element.before(label); });
        assert.equal(await follow.click(),true);
        assert.deepEqual(await page.evaluate(()=>window.followClicks),[{trusted:true}]);
      } finally { await context.close(); }
    });
    await test('Relationship becoming already followed never toggles the control', async()=>{
      const {context,page}=await fixture();
      try {
        const follow=await adapter.prepareFollow(page,B);
        await page.locator('#follow').evaluate(element=>{ element.textContent='已关注'; });
        await assert.rejects(follow.click(),e=>e.actionNotStarted===true && e.code==='FOLLOW_ALREADY');
        assert.deepEqual(await page.evaluate(()=>window.followClicks),[]);
      } finally { await context.close(); }
    });
    await test('New duplicate follows cannot inherit a prepared action', async()=>{
      const {context,page}=await fixture();
      try {
        const follow=await adapter.prepareFollow(page,B);
        await page.locator('#follow').evaluate(element=>{ element.after(element.cloneNode(true)); });
        await assert.rejects(follow.click(),e=>e.actionNotStarted===true && e.code==='FOLLOW_CONTROL_AMBIGUOUS');
        assert.deepEqual(await page.evaluate(()=>window.followClicks),[]);
      } finally { await context.close(); }
    });
    await test('Profile identity changes still invalidate prepared follow without retries', async()=>{
      const {context,page}=await fixture();
      try {
        const follow=await adapter.prepareFollow(page,B);
        await page.evaluate(()=>history.pushState({},'', '/user/qa_target_alpha'));
        await assert.rejects(follow.click(),e=>e.actionNotStarted===true && e.code==='TARGET_MISMATCH');
        assert.deepEqual(await page.evaluate(()=>window.followClicks),[]);
      } finally { await context.close(); }
    });
    await test('An uncertain native follow click is never repeated or declared not started', async()=>{
      const {context,page}=await fixture();
      try {
        const originalLocator=page.locator.bind(page); let clicks=0;
        page.locator=(...args)=>{
          const locator=originalLocator(...args), elementHandle=locator.elementHandle.bind(locator);
          locator.elementHandle=async (...args)=>{
            const handle=await elementHandle(...args);
            if (handle) {
              const click=handle.click.bind(handle);
              handle.click=async options=>{ clicks++; await click(options); throw new Error('simulated transport loss after click'); };
            }
            return handle;
          };
          return locator;
        };
        const follow=await adapter.prepareFollow(page,B);
        await assert.rejects(follow.click(),e=>e.actionNotStarted!==true && /transport loss/.test(e.message));
        assert.equal(clicks,1); assert.deepEqual(await page.evaluate(()=>window.followClicks),[{trusted:true}]);
      } finally { await context.close(); }
    });
    await test('Known old recipient is excluded before current editor ambiguity check', async()=>{
      const {context,page}=await fixture();
      try {
        assert.equal(await adapter.openDirectMessage(page,B),true);
        assert.equal(await adapter.fillDirectMessage(page,B,message),true);
        assert.equal(await page.locator('#old textarea').inputValue(),'旧会话草稿');
        const send=await adapter.prepareSend(page,B,message); assert.equal(send.state,'ready'); assert.equal(await send.click(),true);
        assert.deepEqual(await page.evaluate(()=>window.actions),[{id:'current',trusted:true,recipient:'/user/'+B.uid}]);
      } finally { await context.close(); }
    });
    await test('Unknown additional editor remains ambiguous and untouched', async()=>{
      const {context,page}=await fixture({unknownExtra:true});
      try {
        assert.equal(await adapter.openDirectMessage(page,B),true);
        assert.equal(await adapter.fillDirectMessage(page,B,message),false);
        assert.equal(adapter.getDiagnostic(page).code,'DM_EDITOR_AMBIGUOUS');
        assert.equal(await page.locator('#current textarea').inputValue(),'');
        assert.equal(await page.locator('#unknown textarea').inputValue(),'');
        assert.deepEqual(await page.evaluate(()=>window.actions),[]);
      } finally { await context.close(); }
    });
    await test('Two current-target editors remain ambiguous', async()=>{
      const {context,page}=await fixture({bothTargets:true});
      try {
        await adapter.openDirectMessage(page,B);
        assert.equal(await adapter.fillDirectMessage(page,B,message),false);
        assert.equal(adapter.getDiagnostic(page).code,'DM_EDITOR_AMBIGUOUS');
        assert.deepEqual(await page.evaluate(()=>window.inputs),[]);
      } finally { await context.close(); }
    });
    await test('Changing current header to old recipient before click prevents send', async()=>{
      const {context,page}=await fixture();
      try {
        await adapter.openDirectMessage(page,B); assert.equal(await adapter.fillDirectMessage(page,B,message),true);
        const send=await adapter.prepareSend(page,B,message); assert.equal(send.state,'ready');
        await page.locator('#current a').evaluate(a=>a.setAttribute('href','/user/qa_target_alpha'));
        await assert.rejects(send.click(),e=>e.actionNotStarted===true);
        assert.deepEqual(await page.evaluate(()=>window.actions),[]);
      } finally { await context.close(); }
    });
    await test('Successive targets reuse one editor only after explicit recipient switch', async()=>{
      const {context,page}=await fixture();
      try {
        await page.evaluate(()=>{ document.getElementById('old').remove(); });
        await adapter.openDirectMessage(page,B); assert.equal(await adapter.fillDirectMessage(page,B,message),true);
        assert.equal(await (await adapter.prepareSend(page,B,message)).click(),true);
        await page.evaluate(()=>{
          history.pushState({},'', '/user/qa_target_alpha');
          document.getElementById('open').addEventListener('click',()=>document.querySelector('#current a').setAttribute('href','/user/qa_target_alpha'));
        });
        await adapter.openDirectMessage(page,A); assert.equal(await adapter.fillDirectMessage(page,A,message+'第二条'),true);
        assert.equal(await (await adapter.prepareSend(page,A,message+'第二条')).click(),true);
        assert.deepEqual((await page.evaluate(()=>window.actions)).map(x=>x.recipient),['/user/'+B.uid,'/user/'+A.uid]);
      } finally { await context.close(); }
    });
    await test('Click and fill remain directed to target page with another page brought to front', async()=>{
      const {context,page}=await fixture();
      try {
        const other=await context.newPage(); await other.setContent('<textarea id="other">不应改动</textarea>');
        await other.bringToFront();
        await adapter.openDirectMessage(page,B);
        await other.bringToFront();
        assert.equal(await adapter.fillDirectMessage(page,B,message),true);
        const send=await adapter.prepareSend(page,B,message); assert.equal(send.state,'ready');
        await other.bringToFront(); assert.equal(await send.click(),true);
        assert.equal(await other.locator('#other').inputValue(),'不应改动');
        assert.deepEqual(await page.evaluate(()=>window.actions),[{id:'current',trusted:true,recipient:'/user/'+B.uid}]);
        assert((await page.evaluate(()=>window.inputs)).every(x=>x.id==='current' && x.trusted));
      } finally { await context.close(); }
    });
    process.stdout.write(JSON.stringify({ok:true,count:passed.length,tests:passed})+'\n');
  } catch(error) { process.stderr.write(error.stack+'\n'); process.exitCode=1; }
  finally { if(browser) await browser.close(); if(blocker) await new Promise(resolve=>blocker.close(resolve)); }
})();
