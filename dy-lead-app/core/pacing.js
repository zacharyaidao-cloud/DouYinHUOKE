'use strict';
/**
 * 核心流程 · 节奏配置（集中一处，运行时可覆盖）
 *
 * 两类等待要分开看：
 *   - 等响应：等平台返回结果，收到立即继续；只设上限（xxxWaitMs），不是固定耗时。
 *   - 节奏停顿：人为间隔（[最小, 最大] 毫秒，随机取值），只放在“换一个对象”的地方：
 *     换关键词、换作品、换用户、连续发送若干条后的休息。同一个对象内部的连续动作之间不加停顿。
 *
 * 2026-10-21 调整（实测 9 人、7 条私信、6 次关注未触发频繁/上限）：
 *   用户间隔 25–40 秒 → 15–25 秒；连发休息“每 5 条 90–180 秒” → “每 10 条 45–90 秒”；
 *   关注后到私信的 2–4 秒停顿去掉；作品间 8–15 秒 → 5–10 秒；翻评论 1.8–3.5 秒 → 1–2 秒；
 *   关键词间 30–60 秒 → 15–30 秒。触发频繁时由平台提示决定停止，不靠加长间隔规避。
 */
const DEFAULT_PACING = {
  search: { firstPageWaitMs: 40000, pageWaitMs: 10000, betweenPages: [1000, 2000], betweenKeywords: [15000, 30000] },
  collect: { afterOpen: [800, 1500], betweenWorks: [5000, 10000], betweenScrolls: [1000, 2000], roundWaitMs: 8000 },
  outreach: { profileWaitMs: 10000, betweenUsers: [15000, 25000], restEvery: 10, rest: [45000, 90000], followReceiptWaitMs: 10000, dmReceiptWaitMs: 30000 }
};

function mergePacing(overrides = {}) {
  const merged = JSON.parse(JSON.stringify(DEFAULT_PACING));
  for (const [group, values] of Object.entries(overrides || {})) {
    if (merged[group] && values && typeof values === 'object') Object.assign(merged[group], values);
  }
  return merged;
}

const between = (page, [min, max]) => page.waitForTimeout(min + Math.round(Math.random() * Math.max(0, max - min)));

module.exports = { DEFAULT_PACING, mergePacing, between };
