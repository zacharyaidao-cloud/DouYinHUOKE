'use strict';
const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'..');
for(const relative of ['desktop/package.json','desktop/preload.js','desktop/使用说明.txt','dy-lead-app/server.js','build-tools/setup.iss']) {
  const filename=path.join(root,relative),source=fs.readFileSync(filename,'utf8');
  if(!source.includes('2.3.20'))throw new Error('Unexpected version: '+relative);
  let updated=source.replaceAll('2.3.20','2.3.21');
  if(relative==='desktop/使用说明.txt') {
    updated=updated.replace('2.3.21 更新：作品作者与空评论','2.3.20 更新：作品作者与空评论');
    updated=updated.replace('2.3.20 更新：作品作者与空评论','2.3.21 更新：识别私信回执check_message内的账号频繁与今日陌生人私信上限；明确拒绝时保存失败并暂停，不进入下一用户、不自动重试。识别目标聊天中的MessageBoxTipsMessage平台提示，排除普通聊天正文和其它会话。外联检查点保存本次冻结名单与关注、私信结果计数，不再沿用AI判断任务的名单和是/否统计。\r\n\r\n2.3.20 更新：作品作者与空评论');
  }
  fs.writeFileSync(filename,updated);
}
console.log('Prepared 2.3.21 version and release notes');
