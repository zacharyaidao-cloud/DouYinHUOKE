'use strict';
const fs = require('node:fs'), path = require('node:path'), root = path.resolve(__dirname, '..');
for (const relative of ['desktop/package.json', 'desktop/preload.js', 'desktop/使用说明.txt', 'dy-lead-app/server.js', 'build-tools/setup.iss']) {
  const filename = path.join(root, relative), source = fs.readFileSync(filename, 'utf8');
  if (!source.includes('2.3.15')) throw new Error('Unexpected version: ' + relative);
  let updated = source.replaceAll('2.3.15', '2.3.16');
  if (relative === 'desktop/使用说明.txt') {
    updated = updated.replace('2.3.16 更新：修复评论接口', '2.3.15 更新：修复评论接口');
    updated = updated.replace('2.3.15 更新：修复评论接口', '2.3.16 更新：修复同作品多组评论分页共用最高游标，导致图文定位评论列表正常追赶却误判连续三轮无进展的问题；按已核验的请求类型分别记录进展，去重回填不妨碍有效翻页，重复旧页与末页确认保留原校验。日志补充分页来源推进与暂停各来源游标，任务检查点同步最后无进展轮数。\r\n\r\n2.3.15 更新：修复评论接口');
  }
  fs.writeFileSync(filename, updated);
}
console.log('Prepared 2.3.16 version and release notes');
