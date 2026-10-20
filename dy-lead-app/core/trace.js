'use strict';
/**
 * 核心流程 · 流水账
 * 每个事件一行 JSON：step（程序决定/动作）、response（平台响应摘要）。
 * 只记摘要字段，不落原始响应正文与凭据；用于事后核对“每一步做了什么、收到了什么”。
 */
const fs = require('node:fs');
const path = require('node:path');

function createTrace(file, { echo = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = event => {
    const line = { t: new Date().toISOString(), ...event };
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
    if (echo) console.log(line.t.slice(11, 19), event.kind === 'step' ? '▶' : '◀', event.name, JSON.stringify(event.data || {}).slice(0, 220));
  };
  return {
    file,
    step: (name, data) => write({ kind: 'step', name, data }),
    response: (name, data) => write({ kind: 'response', name, data })
  };
}

module.exports = { createTrace };
