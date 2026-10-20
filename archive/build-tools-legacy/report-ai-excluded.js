'use strict';
// Offline aggregate preview only: no store module, browser or AI transport.
const fs=require('node:fs'),path=require('node:path');
const installed='D:\\华贸自媒体获客';
const read=name=>JSON.parse(fs.readFileSync(path.join(installed,'data',name+'.json'),'utf8').replace(/^\uFEFF/,''));
const query=require('../dy-lead-app/lead-query');
const AI=require('../dy-lead-app/ai');
const leads=read('leads'),videos=read('videos'),settings=read('settings'),cp=read('task-checkpoint');
const options={settings},version=AI.getRuleSet(settings).version;
const oldTodo=leads.filter(row=>!AI.isStoredResultCurrent(row,version,videos)&&!row.aiDone
  && !['aiNeed','aiReason','aiJudgedAt','aiPromptVersion','aiInputHash'].some(key=>String(row[key]||'').trim())
  && (row.aiScore==null||row.aiScore===''));
const report={at:new Date().toISOString(),readOnly:true,networkRequests:0,lastConfirmedClientVersion:'2.3.19',
  previewVersion:require('../desktop/package.json').version,
  previouslyUnjudged:{count:oldTodo.length,explicitAuthors:oldTodo.filter(row=>row.isAuthor).length,
    emptyComments:oldTodo.filter(row=>!String(row.demand||'').trim()).length,ids:oldTodo.map(row=>row.id)},
  correctedClassification:query.aiFacetCounts(leads,videos,{f:'all'},options),
  aiTask:{id:cp.id,kind:cp.kind,state:cp.state,selected:cp.leadIds?.length,processed:cp.processedLeadIds?.length,
    counts:cp.counts,completedAt:cp.completedAt},
  conclusion:'2.3.19 的待判断 18 条均为作者，属于分类展示问题。2.3.20 预览将其列入不参与判断，未改动已安装软件或真实数据。'};
fs.writeFileSync(path.join(__dirname,'../诊断采样/20261011-账号1-06-v2319/AI完成与18条排除原因.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
