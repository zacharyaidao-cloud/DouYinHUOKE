'use strict';
const fs = require('node:fs');
for (const file of ['desktop/package.json', 'desktop/preload.js', 'build-tools/setup.iss']) {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('2.3.3', '2.3.4'));
}
const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')));
edit('desktop/使用说明.txt', s => s.replaceAll('2.3.3', '2.3.4')
  .replace('2.3.4 修复：', '2.3.4 修复：当前抖音聊天只比较目标主页与活动聊天顶部的完整昵称，不再核对头像或聊天 UID，不等待头像加载；表情保留，读取完整昵称而非视觉省略号，同名列表有歧义时不选首行。原 2.3.3 修复继续保留：')
  .replace('仅选择有可靠目标身份依据的唯一会话行，不选首行，也不只凭昵称猜人；进入后再次核对活动聊天头。', '仅选择完整昵称与主页一致的唯一会话行，不选首行；进入后再次比较活动聊天顶部昵称。')
  .replace(/^本版修复了私信按钮位于主页.*$/m, '本版接收人核对只比较完整昵称，不以头像、聊天 UID 或头像加载状态作为通过条件。主页与聊天昵称不同、缺失或列表存在多个同名候选时，记录未发送；这与“私信历史未知时按首发”的规则不同。'));
edit('build-tools/generate-field-guide.js', s => {
  const lines = {
    avatarReadiness: "nameReadiness: '在主页入口点击前取得完整昵称；不读取或等待头像，不要求聊天UID；聊天标题和输入框就绪立即继续，不增加固定间隔',",
    messageList: "messageList: '入口点击后可能先显示消息列表；完成目标主页私信入口原生点击后，捕获昵称仍与当前主页一致时，只选择可见活动列表中完整昵称一致的唯一会话行一次；多个同名候选不选择，不选首行。进入后再次比较活动聊天头昵称；头像和UID不参与当前StackLayout会话识别',",
    recipient: "recipient: '所有新建和复用输入框先核对完整昵称：完成目标主页入口原生点击后，比较主页h1与唯一可见StackLayout活动聊天标题；只比较昵称，不核对头像或聊天UID。填写前和发送前重新核对昵称、绑定元素及消息全文；昵称不一致或缺失保持未发送',",
    emojiName: "emojiName: '主页Twemoji图片按资源码点核对alt后还原，与聊天文字表情按完整顺序比较；支持纯表情和组合表情，保留连接符及肤色修饰，不删除表情后模糊匹配。缺少alt或未知图片不能退化为剩余文字匹配；读取完整DOM昵称，不受视觉省略号影响',",
    recipientEvidence: "recipientEvidence: { explicit_uid: '其他旧式页面结构的既有明确ID依据；当前StackLayout流程不使用', dom_profile_name: '目标主页与当前活动聊天顶部完整昵称一致；不核对头像或聊天UID，不等同于平台UID认证' },",
    privacy: "privacy: '界面诊断仅记录入口/会话/发送阶段、白名单错误码、控件计数及explicit_uid或dom_profile_name依据类型，不记录实际昵称、UID、头像地址、页面全文、私信正文、选择器或凭据',",
    validation: "validation: '隔离测试复现旧头像路径误暂停、无头像、表情、重复昵称和会话切换；不代表本次发布已完成真实账号发送或生产安装验收'"
  };
  // Update only this entryFlow block (other sections also use common keys).
  const a = s.indexOf('      entryFlow: {'), b = s.indexOf('      unknownReceipt:', a);
  let block = s.slice(a, b);
  for (const [key, value] of Object.entries(lines)) block = block.replace(new RegExp('^        ' + key + ':.*$', 'm'), '        ' + value);
  s = s.slice(0, a) + block + s.slice(b);
  const start = s.indexOf("  '<section id=\"dm-entry\"");
  const end = s.indexOf(" + infoTable([", start);
  if (start < 0 || end < 0) throw Error('Missing guide section');
  s = s.slice(0, start) + "  '<section id=\"dm-entry\"><h2>先进入目标聊天，再填写与发送</h2><h3>2.3.4：只核对完整昵称</h3><p>已复现旧版误暂停：某些头像地址不含 aweme-avatar 路径，被旧规则误判无效。按用户最新要求，当前 StackLayout 会话只比较目标主页昵称和活动聊天顶部昵称，不再读取头像或要求聊天 UID，也不等待头像加载。</p><p>只点击目标主页内的私信入口。网页可能先出现消息列表，再自动进入聊天；聊天已就绪时直接继续。停在列表时，只点击与主页完整昵称一致的唯一会话行一次；多个同名候选不选择，不选首行。进入聊天后再次核对顶部昵称，消息列表中的名字不能代替当前聊天标题。</p><p>文字和图片表情按原顺序读取，支持纯表情昵称；长昵称读取 DOM 中的完整文字，不受视觉省略号影响。主页或聊天昵称变化、缺失时保持未发送。输入框、停止操作、历史防重、发送回执检查继续保留；昵称相同不代表平台 UID 认证。</p>'" + s.slice(end);
  s = s.replace('可在已捕获且当前一致的主页身份约束下，用昵称与标准化头像资源同时唯一匹配活动目标行，绑定原生点击一次。明确 UID 冲突拒绝，不能选择首行或只按昵称匹配；', '在已捕获且当前一致的主页昵称约束下，用完整昵称唯一匹配活动目标行，绑定原生点击一次。多个同名候选不选择，不选首行；');
  return s.replaceAll('explicit_uid / dom_profile_identity', 'explicit_uid / dom_profile_name');
});
edit('build-tools/verify-field-guide.js', s => s.split('\n').map(line => {
  if (line.startsWith('assert.match(dictionary.workflow.outreach.entryFlow.messageList,')) return 'assert.match(dictionary.workflow.outreach.entryFlow.messageList,/原生点击.*当前主页一致.*完整昵称一致的唯一会话行.*多个同名候选.*不选首行.*活动聊天头昵称/);';
  if (line.startsWith('assert.match(dictionary.workflow.outreach.entryFlow.recipient,')) return 'assert.match(dictionary.workflow.outreach.entryFlow.recipient,/所有新建和复用输入框.*完整昵称.*只比较昵称，不核对头像或聊天UID.*保持未发送/);';
  if (line.includes('entryFlow.avatarReadiness')) return 'assert.match(dictionary.workflow.outreach.entryFlow.nameReadiness,/不读取或等待头像.*不要求聊天UID.*就绪立即继续/);';
  if (line.includes('Object.keys(dictionary.workflow.outreach.entryFlow.recipientEvidence)')) return "assert.deepEqual(Object.keys(dictionary.workflow.outreach.entryFlow.recipientEvidence), ['explicit_uid', 'dom_profile_name']);";
  if (line.includes('entryFlow.recipientEvidence.dom_profile_identity')) return 'assert.match(dictionary.workflow.outreach.entryFlow.recipientEvidence.dom_profile_name,/完整昵称一致.*不核对头像或聊天UID.*不等同于平台UID认证/);';
  if (line.includes('不能按昵称猜收件人') || line.includes('可见活动列表中昵称和头像资源同时匹配的目标行唯一')) return 'assert.match(content,/完整昵称一致的唯一会话行.*多个同名候选不选择/);';
  return line.replaceAll('dom_profile_identity', 'dom_profile_name');
}).join('\n'));
edit('使用文档/关注私信流程与定向修复-2026-10-10.md', s => s
  .replace('对应版本：2.3.3（已打包并核对产物）', '对应版本：2.3.4')
  .replace('真实平台验收与 DOM 历史边界见第 7、8 节。', '真实平台验收与 DOM 历史边界见第 7、8 节。2.3.4 按用户要求改为完整昵称核对，替换此前昵称加头像的规则。')
  .replace('| 核对接收人 | 明确 UID 优先；没有 UID 时，使用进入前捕获的完整昵称与头像资源，并与当前主页及活动聊天头部再次比对 |', '| 核对接收人 | 当前 StackLayout 只核对进入前主页完整昵称、当前主页昵称与活动聊天顶部昵称，不核对头像或聊天 UID |')
  .replace('5. 昵称不是唯一身份凭证。没有明确 UID 时还必须匹配头像资源；头像 CDN 域名和尺寸可以不同，底层资源标识必须一致。', '5. 当前聊天只核对完整昵称，头像缺失、地址格式不同或延迟加载均不阻止操作；不要求聊天 UID。昵称可能重名，列表出现多个同名候选时不自动选择。')
  .replace('6. 明确的其他用户 UID 否决昵称／头像匹配；不能为了继续任务而放宽为“随便找到一个输入框”。', '6. 只读取当前活动聊天标题；消息列表预览不代替聊天对象。填写前和发送前仍复核昵称与输入内容；服务端回执继续按本次发送核验。')
  .replace('新增诊断仅记录 `chatNameCount`、`chatAvatarCount`、`chatNameMatches`、`chatAvatarMatches`，分别表示元素数量及匹配是否成功。', '新版昵称诊断只记录 `chatNameCount`、`chatNameMatches` 和 `dom_profile_name` 依据，表示标题数量及完整昵称匹配结果。')
  + '\n## 9. 2.3.4 本次误暂停与修改\n\n蜗牛妈妈跨境创业中的主页与聊天昵称一致，头像均为 `be0c00128432b51fed9f`，旧版只允许 `/img/aweme-avatar/`，不识别 `/img/` 形式。隔离复现得到同样的 `profile_avatar_invalid` 和 `DM_RECIPIENT_UNCONFIRMED`。\n\n按用户最终要求移除当前聊天的头像与 UID 校验，只保留完整昵称匹配。视觉省略号不截断 DOM 昵称；表情图片还原后比较。昵称就绪即继续，不等头像。当前网页自动从列表切换聊天时，识别已就绪聊天，避免多点列表造成超时。\n\n本轮只运行受影响的昵称/聊天与历史测试，以及打包检查，不重复全程序回归，也不发送真实私信。原有历史防重、接收人级拒绝不计异常及成功状态回写逻辑保留。UID 与 sec_uid 为不同表示，当前提供的主页 HTML、聊天头 HTML 均没有可直接对照的双方 UID。\n');
