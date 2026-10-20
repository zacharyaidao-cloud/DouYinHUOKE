const path=require('node:path'),assert=require('node:assert/strict');
const app=path.resolve(__dirname,'../dy-lead-app');
const {chromium}=require(path.join(app,'node_modules/playwright-core'));
const revision=require(path.join(app,'node_modules/playwright-core/browsers.json')).browsers.find(x=>x.name==='chromium').revision;
(async()=>{const browser=await chromium.launch({executablePath:path.join(app,'node_modules/playwright-core/.local-browsers',`chromium-${revision}`,'chrome-win64/chrome.exe'),headless:true,chromiumSandbox:true});try{
const page=await browser.newPage({viewport:{width:1080,height:960},colorScheme:'light'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());
await page.goto('file:///'+path.join(__dirname,'erp-list-design-preview.html').replaceAll('\\','/'));
const f=page.frameLocator('iframe'),root=f.locator('#hm-erp');await root.locator('.hm-rows tr').first().waitFor();
assert.equal(await root.locator('.hm-rows tr').count(),7);
const cells=await root.locator('.hm-rows td').evaluateAll(els=>els.map(e=>({h:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize})));
assert(cells.every(e=>e.h<=60),'Rows must remain <=60px at 15px default');assert(cells.every(e=>e.font==='15px'));
assert.equal(await root.locator('.hm-rows .hm-work').count(),7);assert.equal(await root.locator('.hm-rows .hm-body').count(),7);
const fontSizes=await root.locator('.hm-rows td *').evaluateAll(es=>[...new Set(es.filter(e=>e.tagName!=='INPUT').map(e=>getComputedStyle(e).fontSize))]);assert.deepEqual(fontSizes,['15px']);
await page.waitForTimeout(180);await page.screenshot({path:path.join(__dirname,'erp-list-leads.png'),fullPage:true});
await root.locator('[data-detail="107"]').first().click();assert.match(await root.locator('.hm-detail').textContent(),/作品完整正文/);assert.match(await root.locator('.hm-detail').textContent(),/我的店铺协议三停用了/);
await page.waitForTimeout(120);await page.screenshot({path:path.join(__dirname,'erp-list-detail.png'),fullPage:true});await root.locator('[data-close]').click();
await root.locator('[data-days="1"]').click();assert.equal(await root.locator('.hm-rows tr').count(),2);await root.locator('[data-days="0"]').click();
await root.locator('[data-ai="yes"]').click();assert.equal(await root.locator('.hm-rows tr').count(),3);await root.locator('[data-ai="all"]').click();
await root.locator('[data-page="works"]').click();assert.equal(await root.locator('.hm-work-rows tr').count(),4);
assert((await root.locator('.hm-work-rows tr').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h<=60));
await page.waitForTimeout(120);await page.screenshot({path:path.join(__dirname,'erp-list-works.png'),fullPage:true});
await root.locator('[data-page="leads"]').click();
const inner=page.frames().find(x=>x!==page.mainFrame());
for(const width of [1024,736,360,320]){await page.setViewportSize({width,height:960});assert(await inner.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+2),'outer overflow '+width);}
await page.setViewportSize({width:1080,height:960});await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(150);await page.screenshot({path:path.join(__dirname,'erp-list-dark.png'),fullPage:true});
assert.deepEqual(errors,[]);console.log('PASS: all text 15px, all populated rows <=60px, title/body and comment visible, full detail, filters, history, light/dark and responsive containment');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
