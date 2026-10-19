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
bump('D:/B1-抖音获客/desktop/package.json', [['2.4.2', '2.4.3']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.4.2'", "version: '2.4.3'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.4.2', '2.4.3']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.4.2', '2.4.3']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.4.2'", "'2.4.3'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.4.2', '2.4.3'],
  ['2.4.3 更新：', '2.4.3 更新：执行进度优化——运行期确认“已关注且已私信”的用户不再等待用户间隔，直接进入下一位；进度面板新增逐项检查结果（关注：已关注/未关注→已关注；私信：已私信/发送成功/操作频繁/达到今日上限/待核验），六步流程（主页→关注→打开私信→填写→发送→核验）保持原有顺序；修复采集完成查看线索时评论时间范围被重置为全部时间的问题。2.4.3 更新：']
]);
console.log('done 2.4.3');
