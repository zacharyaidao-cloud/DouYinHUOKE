'use strict';

// Synthetic DOM fixtures in a new headless context. No installed profile,
// application data or production endpoint is opened by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openComments, scrollComments } = require('../lib/collection-browser');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(__dirname, '..', 'node_modules', 'playwright-core', '.local-browsers');
const { chromium } = require('playwright-core');
const browserPath = [chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(file => fs.existsSync(file));

test('评论展开和滚动：静态回调在实际 Chromium 的隔离合成页面运行', { timeout: 60000, skip: !browserPath }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const content = async html => {
    await page.setContent('<!doctype html><html><body style="margin:0">' + html + '</body></html>');
    await page.evaluate(() => { window.qaClicks = 0; window.scrollTo(0, 0); });
  };
  const position = () => page.evaluate(() => ({ window: window.scrollY, reco: document.querySelector('#reco')?.scrollTop || 0, clicks: window.qaClicks || 0 }));
  try {
    await t.test('图文相关推荐已有可滚列表，先点击评论标签，再滚评论；不滚推荐', async () => {
      await content('<div class="tab-row"><span>相关推荐</span><span id="entry" onclick="window.qaClicks=(window.qaClicks||0)+1;document.querySelector(\'#comments\').style.display=\'block\';document.querySelector(\'#reco\').style.display=\'none\'">评论(29)</span></div><div id="reco" data-e2e="scroll-list" style="height:180px;overflow:auto"><div style="height:3000px">相关推荐内容</div></div><div id="comments" data-e2e="comment-list" style="display:none;height:180px;overflow:auto"><div style="height:3000px">目标作品评论</div></div>');
      assert.deepEqual(await page.evaluate(scrollComments, 800), { state: 'not_ready', moved: false, hasRegion: false });
      assert.deepEqual(await position(), { window: 0, reco: 0, clicks: 0 });
      assert.deepEqual(await page.evaluate(openComments), { state: 'opened', hasRegion: false, clicked: true });
      assert.deepEqual(await page.evaluate(openComments), { state: 'ready', hasRegion: true, clicked: false });
      assert.deepEqual(await position(), { window: 0, reco: 0, clicks: 1 });
      assert.deepEqual(await page.evaluate(scrollComments, 800), { state: 'scrolled', moved: true, hasRegion: true });
      assert.deepEqual(await position(), { window: 0, reco: 0, clicks: 1 });
    });

    await t.test('评论区域已经打开时不重复点击，到底无移动明确返回 at_end', async () => {
      await content('<button onclick="window.qaClicks=(window.qaClicks||0)+1">评论(29)</button><div id="comments" data-e2e="comment-list" style="height:180px;overflow:auto"><div style="height:900px">目标评论</div></div>');
      assert.equal((await page.evaluate(openComments)).state, 'ready');
      assert.deepEqual(await page.evaluate(scrollComments, 10000), { state: 'scrolled', moved: true, hasRegion: true });
      assert.deepEqual(await page.evaluate(scrollComments, 10000), { state: 'at_end', moved: false, hasRegion: true });
      assert.equal((await position()).clicks, 0);
    });

    await t.test('没有确定评论入口时不点击文案、关注或点赞，隐藏评论不当成已打开', async () => {
      await content('<h1>评论</h1><div data-e2e="comment-list" style="display:none">隐藏评论</div><div id="reco" data-e2e="scroll-list" style="height:180px;overflow:auto"><div style="height:3000px">相关推荐</div></div><button aria-label="关注" onclick="window.qaClicks=1"><svg data-e2e="comment-icon"></svg></button><button aria-label="点赞" onclick="window.qaClicks=1">点赞</button><div data-e2e="comment-input"><button aria-label="评论" onclick="window.qaClicks=1">评论</button></div>');
      assert.deepEqual(await page.evaluate(openComments), { state: 'missing', hasRegion: false, clicked: false });
      assert.deepEqual(await page.evaluate(scrollComments, 800), { state: 'not_ready', moved: false, hasRegion: false });
      assert.deepEqual(await position(), { window: 0, reco: 0, clicks: 0 });
    });

    await t.test('滚动实际承载评论的专属 overflow 祖先', async () => {
      await content('<div id="comments" style="height:180px;overflow-y:auto"><div data-e2e="comment-list"><div style="height:3000px">目标评论</div></div></div><div id="reco" style="height:180px;overflow:auto"><div style="height:3000px">相关推荐</div></div>');
      assert.equal((await page.evaluate(openComments)).state, 'ready');
      assert.deepEqual(await page.evaluate(scrollComments, 800), { state: 'scrolled', moved: true, hasRegion: true });
      assert((await page.locator('#comments').evaluate(element => element.scrollTop)) > 0);
      assert.deepEqual(await position(), { window: 0, reco: 0, clicks: 0 });
    });

    await t.test('通用 scroll-list 只有明确包含可见评论 item 才能作为评论区域', async () => {
      await content('<div data-e2e="scroll-list" style="height:180px;overflow:auto"><div style="height:3000px"><div data-e2e="comment-item"><button onclick="window.qaClicks=1">评论(29)</button></div></div></div>');
      assert.equal((await page.evaluate(openComments)).state, 'ready');
      assert.equal((await page.evaluate(scrollComments, 800)).state, 'scrolled');
      assert.equal((await position()).clicks, 0);
    });

    await t.test('SVG 图标的明确 aria 评论按钮支持展开，编辑器按钮不会匹配', async () => {
      await content('<div data-e2e="comment-input"><button aria-label="评论" onclick="window.qaClicks=100">评论</button></div><button aria-label="评论" onclick="window.qaClicks=(window.qaClicks||0)+1;document.querySelector(\'#comments\').hidden=false"><svg data-e2e="video-comment-icon" width="20" height="20"><path d="M0 0h10v10z"/></svg><span>29</span></button><div id="comments" data-e2e="comment-list" hidden style="height:180px;overflow:auto"><div style="height:3000px">目标评论</div></div>');
      assert.equal((await page.evaluate(openComments)).state, 'opened');
      assert.equal((await position()).clicks, 1);
      assert.equal((await page.evaluate(openComments)).state, 'ready');
    });

    await t.test('aria-controls 精确关联的 tabpanel 在展开后可识别并滚动', async () => {
      await content('<div role="tablist"><button role="tab" aria-controls="pane42" onclick="document.querySelector(\'#pane42\').hidden=false">评论(29)</button><button role="tab">相关推荐</button></div><section role="tabpanel" id="pane42" hidden style="height:180px;overflow-y:auto"><div style="height:3000px">目标评论</div></section>');
      assert.equal((await page.evaluate(openComments)).state, 'opened');
      assert.equal((await page.evaluate(openComments)).state, 'ready');
      assert.equal((await page.evaluate(scrollComments, 800)).state, 'scrolled');
    });

    await t.test('没有 button 标签的明确 SVG 评论入口仅点击其单图标容器', async () => {
      await content('<div onclick="window.qaClicks=(window.qaClicks||0)+1;document.querySelector(\'#comments\').hidden=false"><svg data-e2e="comment-icon" width="20" height="20"><path d="M0 0h10v10z"/></svg><span>29</span></div><div id="comments" data-e2e="comment-list" hidden style="height:180px;overflow:auto"><div style="height:3000px">目标评论</div></div>');
      assert.equal((await page.evaluate(openComments)).state, 'opened');
      assert.equal((await position()).clicks, 1);
      assert.equal((await page.evaluate(openComments)).state, 'ready');
    });

    await t.test('共享祖先包含推荐列表时不使用它，也不回退滚动 window 或 body', async () => {
      await content('<div id="shared" style="height:180px;overflow:auto"><div data-e2e="comment-list"><div style="height:2000px">目标评论</div></div><div data-e2e="recommend-list">相关推荐内容</div></div><div style="height:3000px">页面其他内容</div>');
      assert.equal((await page.evaluate(openComments)).state, 'ready');
      assert.deepEqual(await page.evaluate(scrollComments, 800), { state: 'not_ready', moved: false, hasRegion: true });
      assert.equal(await page.locator('#shared').evaluate(element => element.scrollTop), 0);
      assert.equal((await position()).window, 0);
    });
  } finally { await context.close(); await browser.close(); }
});
