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
bump('D:/B1-抖音获客/desktop/package.json', [['2.4.3', '2.4.4']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.4.3'", "version: '2.4.4'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.4.3', '2.4.4']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.4.3', '2.4.4']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.4.3'", "'2.4.4'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.4.3', '2.4.4'],
  ['2.4.4 更新：', '2.4.4 更新：AI 与线索页重排——AI 分类标签与执行按钮（批量AI判断、预检查、停止、导出）同行分区，右侧为执行区；联系状态筛选直接展开为状态标签（含待核验），去掉折叠的“高级筛选”和重复的联系状态下拉框；评论时间、状态标签、重新判断、搜索框、执行账号与执行范围分区清晰；底部一行显示筛选数量与勾选数量，清空勾选红色醒目提示；去掉冗余说明文字，保留一句 AI 判断规则。2.4.4 更新：']
]);
console.log('done 2.4.4');
