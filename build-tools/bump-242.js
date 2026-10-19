const fs = require('fs');
const bump = (file, pairs) => {
  let t = fs.readFileSync(file, 'utf-8');
  for (const [from, to] of pairs) {
    if (!t.includes(from)) { console.log('跳过(未找到):', file, from.slice(0, 40)); continue; }
    t = t.split(from).join(to);
  }
  fs.writeFileSync(file, t, 'utf-8');
  console.log('ok', file);
};
bump('D:/B1-抖音获客/desktop/package.json', [['2.4.1', '2.4.2']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.4.1'", "version: '2.4.2'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.4.1', '2.4.2']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.4.1', '2.4.2']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.4.1'", "'2.4.2'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.4.1', '2.4.2'],
  ['2.4.2 更新：', '2.4.2 更新：私信账户池支持每账号独立话术（勾选账号后填写该账号专属私信话术，留空使用全局话术）；修复分发过程中“停止”在批次切换间隙失效的问题（停止现在立即生效，不再被下一批重置）；修复分发进度面板在批次执行期间被覆盖、结束后看不到汇总的问题；分发运行期间禁止启动其他任务，避免并发冲突。2.4.2 更新：']
]);
console.log('done 2.4.2');
