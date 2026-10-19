'use strict';
const fs = require('node:fs'), path = require('node:path'), root = path.resolve(__dirname, '..');
for (const relative of ['desktop/package.json', 'desktop/preload.js', 'desktop/使用说明.txt', 'dy-lead-app/server.js', 'build-tools/setup.iss']) {
  const filename = path.join(root, relative), source = fs.readFileSync(filename, 'utf8');
  if (!source.includes('2.3.16')) throw new Error('Unexpected version: ' + relative);
  let updated = source.replaceAll('2.3.16', '2.3.17');
  if (relative === 'desktop/使用说明.txt') {
    updated = updated.replace('2.3.17 更新：修复同作品', '2.3.16 更新：修复同作品');
    updated = updated.replace('2.3.16 更新：修复同作品', '2.3.17 更新：修复成功的评论空末页仍保留作品评论总数（例如 total=35）时被拒绝，导致连续三轮无进展误暂停的问题。明确末页以 has_more=0 和成功状态、目标与游标校验确认，总评论数只用于统计；保留总数归零时的已有统计和旧响应保护。末页日志补充总评论数。\r\n\r\n2.3.16 更新：修复同作品');
  }
  fs.writeFileSync(filename, updated);
}
console.log('Prepared 2.3.17 version and release notes');
