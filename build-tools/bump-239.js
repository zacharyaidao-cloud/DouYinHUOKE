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
bump('D:/B1-抖音获客/desktop/package.json', [['2.3.8', '2.3.9']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.3.8'", "version: '2.3.9'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.3.8', '2.3.9']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.3.8', '2.3.9']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.3.8'", "'2.3.9'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.3.8', '2.3.9'],
  ['2.3.9 更新：', '2.3.9 更新：关键词搜索采用首页搜索框真人式输入（data-e2e 定位→点击→逐字输入→回车，无效时点搜索按钮兜底），页面函数置于不混淆模块；结果页 /jingxuan/search/ 正常采集。2.3.9 更新：']
]);
console.log('done 2.3.9');
