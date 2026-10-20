const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),app=path.join(root,'dy-lead-app');
const {chromium}=require(path.join(app,'node_modules/playwright-core'));
const revision=require(path.join(app,'node_modules/playwright-core/browsers.json')).browsers.find(x=>x.name==='chromium').revision;
const executablePath=path.join(app,'node_modules/playwright-core/.local-browsers',`chromium-${revision}`,'chrome-win64/chrome.exe');
(async()=>{
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true});
 try {
 const page=await browser.newPage({viewport:{width:1080,height:1100},colorScheme:'light'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());
 await page.goto('file:///'+path.join(__dirname,'list-design-preview.html').replaceAll('\\','/'));
 const frame=page.frameLocator('iframe'),table=frame.locator('[data-layout="table"]');
 await table.locator('tbody tr').first().waitFor();
 assert.equal(await table.locator('.hm-leads tbody tr').count(),7);
 await table.locator('[data-days="1"]').click();assert.equal(await table.locator('.hm-leads tbody tr').count(),2);
 await table.locator('[data-days="3"]').click();assert.equal(await table.locator('.hm-leads tbody tr').count(),4);
 await table.locator('[data-days="0"]').click();await table.locator('[data-ai="yes"]').click();assert.equal(await table.locator('.hm-leads tbody tr').count(),3);
 await table.locator('[data-detail="107"]').click();assert.equal(await table.locator('.hm-detail').isVisible(),true);await table.locator('[data-close]').click();
 await table.locator('[data-select="107"]').check();await table.locator('[data-ai="no"]').click();assert.match(await table.locator('.hm-scope').textContent(),/已勾选 1/);
 await table.locator('[data-act="clear"]').click();await table.locator('[data-ai="all"]').click();
 await page.screenshot({path:path.join(__dirname,'list-design-leads.png'),fullPage:true});
 await table.locator('[data-page="works"]').click();assert.equal(await table.locator('.hm-works tbody tr').count(),4);
 await page.screenshot({path:path.join(__dirname,'list-design-works.png'),fullPage:true});
 await table.locator('[data-page="leads"]').click();
 const inner=page.frames().find(f=>f!==page.mainFrame());
 for(const width of [1024,736,360,320]){
   await page.setViewportSize({width,height:1100});
   assert.equal(await inner.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+2),true,'root overflow at '+width);
 }
 await page.setViewportSize({width:1080,height:1100});
 await inner.evaluate(()=>{const sections=document.querySelectorAll('[data-variant]');sections[0].hidden=true;sections[1].hidden=false;});
 const records=frame.locator('[data-layout="records"]');assert.equal(await records.locator('.hm-record').count(),7);
 await records.locator('[data-days="1"]').click();assert.equal(await records.locator('.hm-record').count(),2);
 await records.locator('[data-days="0"]').click();
 await page.screenshot({path:path.join(__dirname,'list-design-records.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: prototype filters, details, retained selection, both layouts, history, and 320/360/736/1024 width containment; no live data');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
