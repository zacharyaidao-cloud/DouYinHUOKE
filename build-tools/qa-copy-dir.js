'use strict';
// Node 24 的 fs.cpSync 在含中文的 Windows 路径上会让进程无提示退出（退出码 127，不触发 exit 事件），
// QA 脚本复制浏览器目录改用逐文件复制，内容 1:1 一致。
const fs = require('node:fs');
const path = require('node:path');

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

module.exports = { copyDir };
