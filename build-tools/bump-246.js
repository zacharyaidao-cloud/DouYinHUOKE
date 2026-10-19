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
bump('D:/B1-抖音获客/desktop/package.json', [['2.4.5', '2.4.6']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.4.5'", "version: '2.4.6'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.4.5', '2.4.6']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.4.5', '2.4.6']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.4.5'", "'2.4.6'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.4.5', '2.4.6'],
  ['2.4.6 更新：', '2.4.6 更新：名单表格优化——只在数据、排序或勾选真正变化时重绘，空闲轮询不再每 2.5 秒整表刷新，解决“表格一直刷新”和“全选/编号点击不中”的问题。2.4.6 更新：']
]);
console.log('done 2.4.6');
