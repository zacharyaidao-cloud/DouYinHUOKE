'use strict';
// Offline planning only: saved fields plus last logged live model capacity.
const fs = require('node:fs'), path = require('node:path');
const AI = require('../dy-lead-app/ai'), query = require('../dy-lead-app/lead-query');
const appDir = path.resolve(process.argv[2] || ''), dataDir = path.join(appDir,'data');
const read = name => JSON.parse(fs.readFileSync(path.join(dataDir,name),'utf8').replace(/^\uFEFF/,''));
(async () => {
  const settings=read('settings.json'),leads=read('leads.json'),videos=read('videos.json'),cp=read('task-checkpoint.json');
  const logFiles=fs.readdirSync(path.join(dataDir,'logs')).filter(name=>/^system-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort();
  const log=fs.readFileSync(path.join(dataDir,'logs',logFiles.at(-1)),'utf8');
  const capacityLine=log.split(/\r?\n/).reverse().find(line=>line.includes('AI_AUDIT ')&&line.includes('"event":"model_capacity"'));
  if(!capacityLine)throw new Error('No observed model capacity');
  const row=JSON.parse(capacityLine.slice(capacityLine.indexOf('AI_AUDIT ')+9));
  if(row.model!==settings.ai.model)throw new Error('Observed capacity differs from selected model');
  const capacity={model:row.model,contextWindow:row.contextWindow,maxOutputTokens:row.maxOutputTokens};
  const selected=query.filterLeads(leads,videos,{f:'all'},{settings,leadIds:cp.leadIds});
  const pending=selected.filter(lead=>!lead.isAuthor&&String(lead.demand||'').trim()&&!AI.isCurrentResult(lead,settings,videos));
  const strategies=[];
  for(const strategy of AI.AUTOMATIC_BATCH_STRATEGIES) {
    const plan=await AI.planJudgeBatchesAsync(settings,pending,videos,capacity,strategy);
    strategies.push({strategy:strategy.name,targetRatio:plan.targetRatio,batchCount:plan.batches.length,executionMaxCount:plan.executionMaxCount,
      batchSizes:plan.batches.map(batch=>batch.leads.length),rejected:plan.rejected.length,allWithinBudget:plan.batches.every(batch=>batch.budget.withinBudget),
      baseBudget:plan.baseBudget,firstBatch:plan.batches[0]?{count:plan.batches[0].leads.length,workCount:plan.batches[0].workCount,budget:plan.batches[0].budget}:null});
  }
  console.log(JSON.stringify({at:new Date().toISOString(),mode:'offline_plan_using_saved_fields_and_observed_capacity',liveProviderRequests:0,
    count:pending.length,strategies}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
