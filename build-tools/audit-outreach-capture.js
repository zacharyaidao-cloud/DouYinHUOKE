'use strict';
// Read-only joins of sanitized capture facts and persisted outcome fields.
const fs=require('node:fs'),path=require('node:path');
const sample=path.resolve(process.argv[2]),app=path.resolve(process.argv[3]);
const events=fs.readFileSync(path.join(sample,'events.jsonl'),'utf8').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
const read=name=>JSON.parse(fs.readFileSync(path.join(app,'data',name+'.json'),'utf8').replace(/^\uFEFF/,''));
const leads=read('leads'),cp=read('task-checkpoint'),requests=new Map(events.filter(e=>e.type==='request').map(e=>[e.requestId,e]));
const safeLead=row=>row?{leadId:row.id,status:row.status,followState:row.followState,followedAt:row.followedAt,followAttemptAt:row.followAttemptAt,
  dmState:row.dmState,dmSentAt:row.dmSentAt,dmAttemptAt:row.dmAttemptAt,dmCount:row.dmCount,dmFailedReason:row.dmFailedReason,dmEvidence:row.dmEvidence}:null;
const sends=[],follows=[];
for(const e of events.filter(e=>e.type==='response')) {
  const req=requests.get(e.requestId);if(!req)continue;
  if(e.family==='follow') follows.push({at:e.at,requestId:e.requestId,leadId:req.leadId,httpStatus:e.httpStatus,business:e.business,
    persisted:safeLead(leads.find(row=>String(row.id)===String(req.leadId)))});
  if(e.family!=='im'||req.path!=='/v1/message/send')continue;
  let check;try{const value=JSON.parse(e.im?.checkMessage||'');check={statusCode:value.status_code,tips:value.tips,nestedTips:value.status_msg?.msg_content?.tips};}catch{check={text:e.im?.checkMessage};}
  const next=events.find(row=>row.eventId>e.eventId&&row.type==='task_state'&&row.leadId&&String(row.leadId)!==String(req.leadId));
  sends.push({at:e.at,requestId:e.requestId,leadId:req.leadId,httpStatus:e.httpStatus,sequenceMatched:e.requestSequenceMatched,
    sendStatus:e.im?.sendStatus,serverMessageIdPresent:e.im?.serverMessageIdPresent,checkCode:e.im?.checkCode,check,
    correlatedOutcome:e.correlatedOutcome,nextLead:next?{at:next.at,leadId:next.leadId,stage:next.stage,running:next.running}:null,
    persisted:safeLead(leads.find(row=>String(row.id)===String(req.leadId)))});
}
const given=['MS4wLjABAAAAQdKJaLxa4LuDyuWeVak04O8OsdsO1bYIuuYu7wjsiirNHrGF3M3i1jFkVH1OTyOu',
  'MS4wLjABAAAAqHI8fo2VJP3GD5pMMioFOZsTy2LYnCKR3sjm-0hxFzI'];
const cases=given.map((uid,i)=>({case:i+1,records:leads.filter(row=>row.uid===uid||String(row.profileUrl||'').endsWith('/'+uid)).map(safeLead)}));
const plans=read('plans'),plan=Array.isArray(plans)?plans.find(row=>row.id===cp.planId):null;
const ids=new Set((plan?.leadIds||cp.leadIds||[]).map(String)),scope=leads.filter(row=>ids.has(String(row.id)));
const counts=key=>scope.reduce((out,row)=>{const value=row[key]||'unattempted';out[value]=(out[value]||0)+1;return out;},{});
const report={at:new Date().toISOString(),readOnly:true,networkRequests:0,sampleFolder:sample,
  currentTask:{id:cp.id,kind:cp.kind,state:cp.state,currentLeadId:cp.currentLeadId,processed:cp.processedLeadIds?.length,
    total:plan?.leadIds?.length,stopReason:cp.stopReason,rawCheckpointLeadCount:cp.leadIds?.length,rawCheckpointCounts:cp.counts},
  scope:{rows:scope.length,followStates:counts('followState'),dmStates:counts('dmState')},
  cases,followResponses:follows,sendResponses:sends,systemNotices:events.filter(e=>e.type==='system_notice'),
  latestTaskState:events.filter(e=>e.type==='task_state').at(-1)};
fs.writeFileSync(path.join(sample,'关注私信核对.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
