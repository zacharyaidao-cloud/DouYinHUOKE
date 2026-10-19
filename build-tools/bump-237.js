const fs = require('fs');
const bump = (file, pairs) => {
  let t = fs.readFileSync(file, 'utf-8');
  for (const [from, to] of pairs) {
    if (!t.includes(from)) throw new Error(file + ' 未找到: ' + from.slice(0, 40));
    t = t.split(from).join(to);
  }
  fs.writeFileSync(file, t, 'utf-8');
  console.log('ok', file);
};
bump('D:/B1-抖音获客/desktop/package.json', [['2.3.6', '2.3.7']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.3.6'", "version: '2.3.7'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.3.6', '2.3.7']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.3.6', '2.3.7']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.3.6'", "'2.3.7'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.3.6', '2.3.7'],
  ['2.3.7 更新：', '2.3.7 更新：关键词搜索翻页实时显示进度；搜索页未返回响应时明确提示可能触发平台验证/限流并保留历史结果；连续翻页无新响应自动停止避免空转（原 2.3.6 采集跳转容错继续保留）。2.3.6 修复：']
]);
console.log('done 2.3.7');
