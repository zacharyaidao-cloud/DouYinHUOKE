'use strict';

/**
 * 搜索页浏览器动作。本文件随 lib/ 原样发布、不参与根目录混淆，
 * 保证 page.evaluate 序列化后的函数自包含（不含混淆作用域引用）。
 * 定位优先使用平台稳定的 data-e2e 标识，再退回占位文案匹配。
 */

function findSearchInputRect() {
  let input = document.querySelector('input[data-e2e="searchbar-input"]');
  if (!input || input.offsetParent === null) {
    input = Array.from(document.querySelectorAll('input')).find(el => el.offsetParent !== null && /搜索你感兴趣的内容|搜索/.test(el.getAttribute('placeholder') || '')) || null;
  }
  if (!input) return null;
  const r = input.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function openSearchEntry() {
  const button = document.querySelector('button[data-e2e="searchbar-button"]');
  if (button && button.offsetParent !== null) { button.click(); return true; }
  const span = Array.from(document.querySelectorAll('span')).find(e => (e.textContent || '').trim() === '搜索' && e.offsetParent !== null);
  if (span) { span.click(); return true; }
  return false;
}

function clickSearchButton() {
  const button = document.querySelector('button[data-e2e="searchbar-button"]');
  if (button && button.offsetParent !== null) { button.click(); return true; }
  return false;
}

function clickSearchTab(label) {
  const els = Array.from(document.querySelectorAll('div,span,a')).filter(e => (e.textContent || '').trim() === label && e.offsetParent !== null);
  if (els[0]) els[0].click();
  return !!els[0];
}

/**
 * 滚动搜索结果流：新版结果页把滚动放在内部路由容器（如 route-scroll-container），
 * 窗口本身不可滚。优先滚可滚动量最大的容器，回退滚窗口。
 */
function scrollSearchFeed(step) {
  const amount = Number(step) || 1400;
  const candidates = [];
  for (const el of document.querySelectorAll('div,main,section,ul')) {
    if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200) candidates.push(el);
  }
  candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const feed = candidates[0];
  if (feed) {
    const before = feed.scrollTop;
    feed.scrollTop = before + amount;
    return { container: String(feed.className).slice(0, 60), scrolled: feed.scrollTop - before };
  }
  const before = window.scrollY;
  window.scrollBy(0, amount);
  return { container: 'window', scrolled: window.scrollY - before };
}

module.exports = { findSearchInputRect, openSearchEntry, clickSearchButton, clickSearchTab, scrollSearchFeed };
