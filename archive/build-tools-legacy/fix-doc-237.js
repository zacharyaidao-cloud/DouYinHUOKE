const fs = require('fs');
const file = 'D:/B1-抖音获客/desktop/使用说明.txt';
let t = fs.readFileSync(file, 'utf-8');
if (!t.includes('2.3.6')) throw new Error('已无 2.3.6 锚点');
t = t.split('2.3.6').join('2.3.7');
t = t.split('2.3.7 修复：').join('2.3.7 更新：关键词搜索翻页实时显示进度；搜索页未返回响应时明确提示可能触发平台验证/限流并保留历史结果；连续翻页无新响应自动停止避免空转。2.3.7 修复：');
fs.writeFileSync(file, t, 'utf-8');
console.log('使用说明.txt 已更新:', t.includes('2.3.7 更新：'));
