'use strict';
const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'..');
for(const relative of ['desktop/package.json','desktop/preload.js','desktop/使用说明.txt','dy-lead-app/server.js','build-tools/setup.iss']) {
  const filename=path.join(root,relative),source=fs.readFileSync(filename,'utf8');
  if(!source.includes('2.3.19'))throw new Error('Unexpected version: '+relative);
  let updated=source.replaceAll('2.3.19','2.3.20');
  if(relative==='desktop/使用说明.txt') {
    updated=updated.replace('2.3.20 更新：自动AI','2.3.19 更新：自动AI');
    updated=updated.replace('2.3.19 更新：自动AI','2.3.20 更新：作品作者与空评论独立归入“不参与判断”，不再占用待判断/待重判数量，保留全部记录、历史AI结果及触达信息，不把排除项伪造为AI否。列表显示原因，详情的单条判断及“不参与判断”筛选下的批量判断禁用。列表分类、API待判数、批量与单条任务统一作者/空评论口径，包括作品元数据确认的作者身份；保存前再次核对作者与评论资格，资料改变后不回写旧判断。75%/50%/30%/200条恢复策略保留。\r\n\r\n2.3.19 更新：自动AI');
  }
  fs.writeFileSync(filename,updated);
}
console.log('Prepared 2.3.20 version and release notes');
