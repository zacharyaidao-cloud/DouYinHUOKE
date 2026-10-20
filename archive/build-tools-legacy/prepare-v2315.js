'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const relative of ['desktop/package.json', 'desktop/preload.js', 'desktop/使用说明.txt', 'dy-lead-app/server.js', 'build-tools/setup.iss']) {
  const filename = path.join(root, relative), source = fs.readFileSync(filename, 'utf8');
  if (!source.includes('2.3.14')) throw new Error('Unexpected version: ' + relative);
  let updated = source.replaceAll('2.3.14', '2.3.15');
  if (relative === 'desktop/使用说明.txt') {
    // Keep the earlier release description's original version label.
    updated = updated.replace('2.3.15 更新：综合搜索', '2.3.14 更新：综合搜索');
    const marker = '2.3.14 更新：综合搜索';
    const note = '2.3.15 更新：修复评论接口正常返回 comments=null、has_more=0 的空末页被丢弃，导致图文或视频连续三轮无进展误暂停的问题；严格核对HTTP、业务状态、空页字段与游标，晚到旧页仍不能确认完成，保留此前评论总数。日志增加末页确认、目标响应未采纳原因与暂停时最后采纳的分页状态。\r\n\r\n';
    updated = updated.replace(marker, note + marker);
  }
  fs.writeFileSync(filename, updated);
}
console.log('Prepared 2.3.15 version and release notes');
