'use strict';
const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'..');
for(const relative of ['desktop/package.json','desktop/preload.js','desktop/使用说明.txt','dy-lead-app/server.js','build-tools/setup.iss']) {
  const filename=path.join(root,relative),source=fs.readFileSync(filename,'utf8');
  if(!source.includes('2.3.18'))throw new Error('Unexpected version: '+relative);
  let updated=source.replaceAll('2.3.18','2.3.19');
  if(relative==='desktop/使用说明.txt') {
    updated=updated.replace('2.3.19 更新：修复自动AI','2.3.18 更新：修复自动AI');
    updated=updated.replace('2.3.18 更新：修复自动AI','2.3.19 更新：自动AI组批改为75% → 50% → 30% → 每批最多200条。超时、回执无效或输出不完整时逐档重新规划全部剩余固定名单，后续沿用当前档位；每批成功立即保存，已保存结果不重复判断。预算包含完整介绍、要求、评论、共享作品及输出预留；200条兜底仍受75%容量与模型最大输出约束。较低预算放不下完整资料时跳过该档，字段不截短。三档恢复允许进入200条兜底，兜底仍失败则暂停，未判保留；余额、认证等永久错误直接暂停，限流、网络及服务器故障仍有限退避。界面和日志显示当前预算与恢复原因。\r\n\r\n2.3.18 更新：修复自动AI');
  }
  fs.writeFileSync(filename,updated);
}
const filename=path.join(root,'build-tools/generate-field-guide.js');let source=fs.readFileSync(filename,'utf8');
const replacements=[
  ['const sampleBudget = AI.estimateRequestBudget(sampleRequest.messages, samplePayload.items.length, sampleCapacity);','const sampleBudget = AI.estimateRequestBudget(sampleRequest.messages, samplePayload.items.length, sampleCapacity, AI.AUTOMATIC_BATCH_STRATEGIES[0].targetRatio);'],
  ['合计不超过模型上下文90%，输出另不超过模型max_output_tokens；按选定顺序逐条装批，自动另按请求时限限制单批（60秒最多200条，120秒400条），多条超时缩批。','自动初始预算75%，超时或回执失败按50%、30%重新装批，最后每批最多200条且仍受75%容量预算约束；手动合计不超过上下文90%，输出另不超过模型max_output_tokens；按选定顺序装批，降档后只重规划剩余固定名单，成功结果不重复发送。'],
  ["budget:{targetRatio:0.9,automatic:'模型上下文与输出双重预算'","budget:{targetRatio:0.75,automaticStrategies:AI.AUTOMATIC_BATCH_STRATEGIES,automatic:'75% → 50% → 30% → 最多200条（仍受75%上下文与输出预算约束）'"],
  ["errorHandling:{splitOnly:","errorHandling:{automaticRecovery:['AI_TIMEOUT','AI_TRANSPORT_RESPONSE_INVALID','AI_FORMAT_INVALID','AI_OUTPUT_LENGTH','AI_RESPONSE_INVALID','AI_OUTPUT_INCOMPLETE'],recovery:'三档各失败一次后进入200条兜底，兜底失败暂停；无法放入较低预算的完整资料转下一档，不截字段；手动格式失败仍二分',splitOnly:"],
  ['实时模型容量的90%及请求时限（60秒最多200条，120秒400条）','实时模型容量的75%，失败后50%、30%，最后每批最多200条（仍检查75%容量上限）'],
  ['按容量的90%顺序装批','按75% → 50% → 30% → 200条顺序装批'],
  ['完整输入与输出预留合计不超过模型上下文90%，输出预留另不超过模型最大输出。','自动完整输入与输出预留合计初始不超过模型上下文75%，恢复时按50%、30%，最后每批最多200条并保留75%容量上限；手动仍不超过90%。输出预留另不超过模型最大输出。'],
  ['自动模式按模型预算及请求时限装批（60秒最多200条，120秒400条；超时自动缩批）','自动模式按当前档位重新完整装批（75% → 50% → 30% → 最多200条），较低档放不下完整材料则转下一档，最后200条仍受75%容量上限约束'],
  ['仅格式合同不合规、模型输出被截断或回执不完整时，按原顺序二分缩批，必要时到单条；无效结果不写入。','自动超时、传输回执异常、格式合同不合规、模型输出截断或回执不完整时，75% → 50% → 30%各失败一次后进入200条兜底。已保存的成功批不重复发送，未发送名单重新组批，后续沿用当前档位；200条兜底仍失败则暂停。连续异常仍记录，允许三档恢复走完；手动格式问题仍按原顺序二分。无效结果不写入。'],
  ['、网络失败及 HTTP 传输响应异常，以及单条判断/模型查询超时，同一请求最多','、网络失败，以及手动传输响应异常、单条判断/模型查询超时，同一请求最多'],
  ['表示格式问题或多条超时缩批；','表示手动格式问题或多条超时缩批；budget_recovery表示自动降档与剩余名单重规划；budget_strategy_skipped表示完整材料放不下该档；'],
  ['多条超时缩批，单条及其他临时接口异常有界退避','自动超时或回执失败按75%/50%/30%/200条逐档恢复，其他临时接口异常有界退避']
];
for(const [before,after] of replacements) {if(!source.includes(before))throw new Error('Missing guide phrase: '+before);source=source.replaceAll(before,after);}
fs.writeFileSync(filename,source);
console.log('Prepared 2.3.19 version, release notes and strategy guide');
