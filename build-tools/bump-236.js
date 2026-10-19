const fs = require('fs');
const DQ = String.fromCharCode(34); // 双引号，避免 shell 转义问题
const bump = (file, pairs) => {
  let t = fs.readFileSync(file, 'utf-8');
  for (const [from, to] of pairs) {
    if (!t.includes(from)) throw new Error(file + ' 未找到: ' + from.slice(0, 40));
    t = t.split(from).join(to);
  }
  fs.writeFileSync(file, t, 'utf-8');
  console.log('ok', file);
};
bump('D:/B1-抖音获客/desktop/package.json', [['2.3.5', '2.3.6']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.3.5'", "version: '2.3.6'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.3.5', '2.3.6']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.3.5', '2.3.6']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.3.5'", "'2.3.6'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.3.5', '2.3.6'],
  ['2.3.6 更新：', '2.3.6 修复：采集过程页面发生内部跳转时，等待页面稳定后重试读取，不再中断整轮采集（原 2.3.5 功能继续保留）。2.3.5 更新：']
]);
console.log('done');
