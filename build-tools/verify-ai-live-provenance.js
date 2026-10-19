'use strict';
// Offline evidence check; never calls a provider or modifies client data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),output=path.join(root,'outputs','ai-review-v2212');
const live=JSON.parse(fs.readFileSync(path.join(output,'live-semantic-check.json'),'utf8'));
const AI=require(path.join(root,'dy-lead-app','ai'));
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes=Object.fromEntries(['ai.js','lib/ai-policy.js','engine-ai-tasks.js'].map(name=>[name,digest(path.join(root,'dy-lead-app',name))]));
assert.equal(sourceHashes['lib/ai-policy.js'],live.sourceHashes['lib/ai-policy.js'],'Live-tested shared contact policy must remain unchanged');
const draftInspection=AI.inspectPromptDraft(live.generatedPrompt.prompt);
assert.equal(draftInspection.ok,true,'Actual generated draft must pass final inspection');
assert.equal(live.runs.length,3);
const runs=live.runs.map(run=>{
  assert.equal(run.scored,32);assert.equal(run.matched,32);assert.equal(run.observations.length,4);
  for(const row of run.rows)assert.equal(AI.validResult({need:row.need,reason:row.reason}),true);
  return {name:run.name,explicitSamples:run.scored,matched:run.matched,ambiguousNotScored:run.observations.length,ruleVersion:run.ruleVersion};
});
const report={ok:true,version:'2.2.12',checkedAt:new Date().toISOString(),offlineOnly:true,installedClientDataRead:false,
  liveEvidence:'live-semantic-check.json',liveRunStartedAt:live.startedAt,model:live.model,runs,
  liveSourceHashes:live.sourceHashes,finalSourceHashes:sourceHashes,sharedPolicyUnchanged:true,generatedDraftAcceptedByFinalInspector:true,
  subsequentChanges:'真实样本验证后，仅补草稿冲突验收及单条作者/空评论保护、日志与界面；已测判断政策和请求拼装没有改变。整文件哈希变化不等于重新进行真实模型测试。',
  limitation:'结果只代表本次三套提示词各32条明确样本；4条歧义样本不计分，不代表全库准确率或每次模型回复都相同。'};
fs.writeFileSync(path.join(output,'final-semantic-provenance.json'),JSON.stringify(report,null,2));
console.log('PASS 最终政策与真实验证政策一致，真实生成草稿通过最终验收；三套各32明确样本结果字段完整，4歧义样本不计分。');
