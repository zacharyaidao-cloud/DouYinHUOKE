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
bump('D:/B1-抖音获客/desktop/package.json', [['2.3.21', '2.4.0']]);
bump('D:/B1-抖音获客/desktop/preload.js', [["version: '2.3.21'", "version: '2.4.0'"]]);
bump('D:/B1-抖音获客/build-tools/setup.iss', [['2.3.21', '2.4.0']]);
bump('D:/B1-抖音获客/dy-lead-app/server.js', [['2.3.21', '2.4.0']]);
bump('D:/B1-抖音获客/dy-lead-app/tests/server.test.js', [["'2.3.12'", "'2.4.0'"]]);
bump('D:/B1-抖音获客/desktop/使用说明.txt', [
  ['2.3.21', '2.4.0'],
  ['2.4.0 更新：', '2.4.0 更新：新增「多账号私信分发」——采集归采集、触达归触达：设置私信账户池（勾选+轮转顺序），按各账号经验日上限自动分摊，逐账号分批轮转执行；遇“私信频繁”该号冷却30分钟（逐次翻倍）并排队尾，其他账号继续，一轮结束后冷却到期自动回头重试；遇“今日私信已达上限”该号当日停用，全部停用才整体停止；每天早上8点运营日重置恢复。程序自动学习每个账号的经验日上限（到顶时记录当日已发数），界面显示今日已私信数与预计剩余。分配锁保证同一用户只由一个账号接触。搜索与采集相关修复继续保留。2.4.0 更新：']
]);
console.log('done 2.4.0');
