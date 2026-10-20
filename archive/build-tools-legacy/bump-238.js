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
bump('D:/B1-抖音获客/desktop/package.json', [['2.3.7', '2.3.8']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.3.7'", "version: '2.3.8'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.3.7', '2.3.8']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.3.7', '2.3.8']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.3.7'", "'2.3.8'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.3.7', '2.3.8'],
  ['2.3.8 更新：', '2.3.8 更新：关键词搜索改为首页搜索框真人式输入（点击搜索框→逐字输入→回车→按范围点页签），不再直接跳转搜索地址；搜索框不可用或未进入结果页时明确提示并跳过该关键词。2.3.8 更新：']
]);
console.log('done 2.3.8');
