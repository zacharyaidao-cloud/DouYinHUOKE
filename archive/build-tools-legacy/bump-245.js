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
bump('D:/B1-抖音获客/desktop/package.json', [['2.4.4', '2.4.5']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.4.4'", "version: '2.4.5'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.4.4', '2.4.5']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.4.4', '2.4.5']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.4.4'", "'2.4.5'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.4.4', '2.4.5'],
  ['2.4.5 更新：', '2.4.5 更新：合并“AI 与线索”和“关注与私信”为一个页面“判断与执行”——筛选、勾选、话术、预检查与执行、进度全部在同一页完成；执行范围改为自动展示（勾选则执行勾选，否则执行当前筛选），清除“忘记清空勾选”的隐患；工作流从 4 步精简为 3 步。2.4.5 更新：']
]);
console.log('done 2.4.5');
