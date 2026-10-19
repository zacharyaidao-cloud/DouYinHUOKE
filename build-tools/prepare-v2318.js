'use strict';
const fs = require('node:fs'), path = require('node:path'), root = path.resolve(__dirname, '..');
for (const relative of ['desktop/package.json', 'desktop/preload.js', 'desktop/使用说明.txt', 'dy-lead-app/server.js', 'build-tools/setup.iss']) {
  const filename = path.join(root, relative), source = fs.readFileSync(filename, 'utf8');
  if (!source.includes('2.3.17')) throw new Error('Unexpected version: ' + relative);
  let updated = source.replaceAll('2.3.17', '2.3.18');
  if (relative === 'desktop/使用说明.txt') {
    updated = updated.replace('2.3.18 更新：修复成功的评论', '2.3.17 更新：修复成功的评论');
    updated = updated.replace('2.3.17 更新：修复成功的评论', '2.3.18 更新：修复自动AI仅按模型容量组出近2000条大批，60秒超时后原批重复请求的问题。自动组批同时受90%容量预算和请求时限约束（60秒最多200条，120秒最多400条）；多条请求超时立即缩批，每个成功子批保存后继续后续计划批。连续异常保护保留最近实际原因，余额不足、限流及超时明确显示，已判断结果与触达历史保留。日志补充时限条数上限和超时子批信息。\r\n\r\n2.3.17 更新：修复成功的评论');
  }
  fs.writeFileSync(filename, updated);
}
const guideFile = path.join(root, 'build-tools/generate-field-guide.js');
let guide = fs.readFileSync(guideFile, 'utf8');
const replacements = [
  ['按选定顺序逐条装批。手动额外', '按选定顺序逐条装批，自动另按请求时限限制单批（60秒最多200条，120秒400条），多条超时缩批。手动额外'],
  ['自动模式按模型预算装批', '自动模式按模型预算及请求时限装批（60秒最多200条，120秒400条；超时自动缩批）'],
  ['实时模型容量的90%，包含完整介绍', '实时模型容量的90%及请求时限（60秒最多200条，120秒400条），包含完整介绍'],
  ['、网络失败、超时及 HTTP 传输响应异常，同一请求最多', '、网络失败及 HTTP 传输响应异常，以及单条判断/模型查询超时，同一请求最多'],
  ["表示格式问题缩批；", "表示格式问题或多条超时缩批；"],
  ['只有临时接口异常才有界退避', '多条超时缩批，单条及其他临时接口异常有界退避']
];
for (const [before, after] of replacements) {
  if (!guide.includes(before)) throw new Error('Missing guide phrase: ' + before);
  guide = guide.replaceAll(before, after);
}
fs.writeFileSync(guideFile, guide);
console.log('Prepared 2.3.18 version, release notes and AI guide');
