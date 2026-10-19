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
bump('D:/B1-抖音获客/desktop/package.json', [['2.4.0', '2.4.1']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.4.0'", "version: '2.4.1'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.4.0', '2.4.1']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.4.0', '2.4.1']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.4.0'", "'2.4.1'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.4.0', '2.4.1'],
  ['2.4.1 更新：', '2.4.1 更新：AI 判断默认只处理最近一周内的评论——线索页评论时间筛选默认“一周内”（可切换全部时间/1天/3天），批量 AI 判断遵循该范围；采集完成后自动 AI 判断新增时间范围设置（默认一周内，可在采集页切换为全部时间），超出范围的评论保留待人工筛选，避免消耗 AI 额度判断过期评论。2.4.1 更新：']
]);
console.log('done 2.4.1');
