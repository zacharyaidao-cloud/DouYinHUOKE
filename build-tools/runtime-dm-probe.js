'use strict';
// Read-only DOM structure of the user's observed platform frequency notice.
async function inspect(accountId) {
  const r=process.mainModule.require.bind(process.mainModule),engine=r('./engine.js'),store=r('./store.js'),p=r('playwright-core');
  const contexts=[...p.chromium._contexts];
  if(contexts.length!==1||String(engine.taskState.accountId)!==String(accountId))throw new Error('Account context mismatch');
  const pages=[];
  for(const page of contexts[0].pages()) {
    const url=new URL(page.url()),match=/^\/user\/([\w-]+)\/?$/.exec(url.pathname);
    if(url.protocol!=='https:'||!['www.douyin.com','douyin.com'].includes(url.hostname)||!match)continue;
    const target=store.getLeads().find(row=>row.uid===match[1]);
    const facts=await page.evaluate(()=>{
      const result=[];
      for(const e of document.querySelectorAll('p,span,div')) {
        const text=(e.textContent||'').replace(/\s/g,'').replace(/[。！!]+$/,'');
        if(e.childElementCount||!e.getClientRects().length||text!=='给陌生人发送消息过于频繁，请稍后再发送陌生人消息')continue;
        const ancestors=[];
        for(let n=e,i=0;n&&i<8;n=n.parentElement,i++)ancestors.push({tag:n.tagName,classes:n.className.slice?.(0,300),e2e:n.getAttribute('data-e2e'),stackLayer:n.getAttribute('data-stack-layer')});
        result.push({text,ancestors});if(result.length>=10)break;
      }
      return {readyState:document.readyState,frequencyNotices:result};
    });
    pages.push({targetLeadId:target?.id||null,taskLeadId:engine.taskState.currentLead?.id||null,...facts});
  }
  return {at:new Date().toISOString(),readOnly:true,pages};
}
module.exports={inspect};
