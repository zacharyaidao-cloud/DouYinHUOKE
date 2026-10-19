'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPageWorkMetadata } = require('../lib/page-work-metadata');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(__dirname, '..', 'node_modules', 'playwright-core', '.local-browsers');
const { chromium } = require('playwright-core');
const browserPath = [chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(file => fs.existsSync(file));
const id = '7000000000000000002', otherId = '7000000000000000003';
const missing = { desc: '', descriptionState: 'missing', descriptionSource: '' };
const paceScript = chunk => '<script type="application/x-static-pace-fixture">self.__pace_f.push(' + JSON.stringify([1, chunk]) + ')</script>';
const normalizedWork = (description = '图文中明确的服务说明', workId = id) => ({
  awemeId: workId, awemeType: 68, mediaType: 2, desc: description, itemTitle: '', caption: '',
  images: [{ width: 1248, height: 1456, uri: 'tos-cn-i-synthetic/fixture', urlList: ['https://image.example.invalid/local.webp'], downloadUrlList: ['https://image.example.invalid/local-download.webp'], video: null }]
});
const paceRow = work => '7:' + JSON.stringify(['$', '$Lfixture', null, { aweme: { detail: work } }]) + '\n';

test('当前作品描述：实际 Chromium 中只读取受限结构化数据或明确描述', { timeout: 60000, skip: !browserPath }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }) : route.abort());
  const page = await context.newPage();
  const content = async (html, url = 'https://www.douyin.com/note/' + id) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.setContent('<!doctype html><html><head></head><body>' + html + '</body></html>');
  };
  const readFull = () => page.evaluate(readPageWorkMetadata, id);
  const read = async () => {
    const result = await readFull();
    return { desc: result.desc, descriptionState: result.descriptionState, descriptionSource: result.descriptionSource };
  };
  try {
    await t.test('真实 PACE 行结构：RENDER_DATA只有应用状态，详情来自row7[3].aweme.detail', async () => {
      const appState = { app: { settings: { placeholder: 'x'.repeat(202806) } } };
      await content('<script id="RENDER_DATA" type="application/json">' + encodeURIComponent(JSON.stringify(appState)) + '</script>' + paceScript(paceRow(normalizedWork())));
      const result = await read();
      assert.deepEqual(result, { desc: '图文中明确的服务说明', descriptionState: 'available', descriptionSource: 'page_json' });
      assert.deepEqual(Object.keys(result).sort(), ['desc', 'descriptionState', 'descriptionSource'].sort());
      const full = await readFull();
      assert.deepEqual(full.workRawText, { desc: '图文中明确的服务说明', itemTitle: '', caption: '' });
      assert.equal(full.imageCount, 1); assert.equal(full.awemeType, 68);
      assert.equal(await page.evaluate(() => typeof self.__pace_f), 'undefined', 'The literal fixture was parsed without executing its script');
    });

    await t.test('PACE跨小chunk拼接JSON行，支持末行无换行，并始终匹配目标作品', async () => {
      const rows = paceRow(normalizedWork('相关推荐的描述', otherId)) + paceRow(normalizedWork('目标图文全文')).trimEnd();
      const chunks = [];
      for (let index = 0; index < rows.length; index += 11) chunks.push(paceScript(rows.slice(index, index + 11)));
      await content(chunks.join(''));
      assert.deepEqual(await read(), { desc: '目标图文全文', descriptionState: 'available', descriptionSource: 'page_json' });
    });

    await t.test('camel awemeId 必须同时具备作品结构，拒绝普通ID或冲突ID', async () => {
      for (const work of [
        { awemeId: id, desc: '只有ID的普通对象' },
        { awemeId: id, awemeType: 68, desc: '缺图片或视频结构' },
        { ...normalizedWork(), aweme_id: otherId },
        { ...normalizedWork(), awemeId: otherId }
      ]) {
        await content(paceScript(paceRow(work)));
        assert.deepEqual(await read(), missing);
      }
      await content(paceScript(paceRow({ awemeId: id, awemeType: 0, video: { duration: 1000 }, desc: '规范化视频正文' })));
      assert.equal((await read()).desc, '规范化视频正文');
      await content(paceScript(paceRow(normalizedWork(' \n '))));
      assert.deepEqual(await read(), { desc: '', descriptionState: 'empty', descriptionSource: 'page_json' });
    });

    await t.test('长图文标题、正文与caption实际字段完整保留，缺desc的caption也不丢', async () => {
      const desc = '实际图文正文\n' + '每段内容都要完整保留。'.repeat(10000);
      await content(paceScript(paceRow({ ...normalizedWork(desc), itemTitle: '实际图文标题', caption: '独立补充文字' })));
      const result = await readFull();
      assert.equal(result.desc, desc); assert.equal(result.workRawText.desc, desc);
      assert.equal(result.workRawText.itemTitle, '实际图文标题'); assert.equal(result.workRawText.caption, '独立补充文字');
      assert.equal(result.imageCount, 1); assert.equal(result.awemeType, 68);
      await content(paceScript(paceRow({ ...normalizedWork(), desc: undefined, caption: '实际caption全文' })));
      const caption = await readFull();
      assert.equal(caption.descriptionState, 'available'); assert.equal(caption.desc, '');
      assert.equal(caption.workRawText.caption, '实际caption全文'); assert.equal(Object.hasOwn(caption.workRawText, 'desc'), false);
    });

    await t.test('仅JSON字面量wrapper与JSON RSC行可解析，任何代码都不执行', async () => {
      const invalidScripts = [
        'self.__pace_f.push([1, someVariable])',
        'self.__pace_f.push((function(){window.qaExecuted=true;return [1,"7:[]"]})())',
        'self.__pace_f.push([1,"7:[]"]);window.qaExecuted=true;',
        'self.__pace_f.push([0,' + JSON.stringify(paceRow(normalizedWork())) + '])',
        'self.__pace_f.push([1,' + JSON.stringify(paceRow(normalizedWork())) + ',0])',
        'self.__pace_f.push([1,"7:{desc:window.qaExecuted=true}"])',
        'self.__pace_f.push([1,"7:window.qaExecuted=true"])'
      ];
      for (const raw of invalidScripts) {
        await content('<script type="application/x-static-pace-fixture">' + raw + '</script>');
        assert.deepEqual(await read(), missing);
        assert.equal(await page.evaluate(() => window.qaExecuted), undefined);
      }
    });

    await t.test('PACE也受2MB和节点总量约束，超大或无终止chunk不会无界解析', async () => {
      await content(paceScript(paceRow(normalizedWork('x'.repeat(2 * 1024 * 1024)))));
      assert.deepEqual(await read(), missing);
      const largeRows = '1:' + JSON.stringify(Array.from({ length: 10001 }, () => ({ plain: 1 }))) + '\n' + paceRow(normalizedWork());
      await content(paceScript(largeRows));
      assert.deepEqual(await read(), missing);
      await content(paceScript('7:{"awemeId":"' + id + '","desc":"unfinished'));
      assert.deepEqual(await read(), missing);
    });

    await t.test('URI 编码 RENDER_DATA 精确选择目标作品，排除推荐及账户对象', async () => {
      const data = { account: { nickname: '合成账号，不返回', desc: '账户说明' }, app: { details: [
        { aweme_id: otherId, desc: '推荐作品描述' }, { aweme_id: id, desc: '图文标题\n具体服务说明 #亚马逊' }
      ] } };
      await content('<script id="RENDER_DATA" type="application/json">' + encodeURIComponent(JSON.stringify(data)) + '</script>');
      assert.deepEqual(await read(), { desc: '图文标题\n具体服务说明 #亚马逊', descriptionState: 'available', descriptionSource: 'page_json' });
    });

    await t.test('结构化目标描述明确为空才返回 empty，缺字段不取音乐标题或标签', async () => {
      await content('<script type="application/json">' + JSON.stringify({ aweme_detail: { aweme_id: id, desc: '  \n  ' } }) + '</script>');
      assert.deepEqual(await read(), { desc: '', descriptionState: 'empty', descriptionSource: 'page_json' });
      await content('<script type="application/json">' + JSON.stringify({ aweme_detail: { aweme_id: id, music: { title: '音乐名称' }, image_post_info: { caption: '未确认字段' }, text_extra: [{ hashtag_name: '标签' }] } }) + '</script>');
      assert.deepEqual(await read(), missing);
    });

    await t.test('只读明确作品描述标记，排除评论、推荐、编辑器、隐藏及其他作品', async () => {
      await content('<div data-e2e="comment-list"><div data-e2e="video-desc">评论文字</div></div><div class="recommend-list"><div data-e2e="note-desc">推荐作品</div></div><div contenteditable="true"><div data-e2e="video-desc">编辑器</div></div><div data-aweme-id="' + otherId + '"><div data-e2e="video-desc">其他作品</div></div><div data-e2e="note-desc" hidden>隐藏描述</div><section data-aweme-id="' + id + '"><div data-e2e="note-desc">当前图文自己的描述</div></section>');
      assert.deepEqual(await read(), { desc: '当前图文自己的描述', descriptionState: 'available', descriptionSource: 'page_description' });
    });

    await t.test('域名、HTTPS和当前页面作品ID任一不匹配就不读描述', async () => {
      for (const url of ['https://foreign.example/note/' + id, 'http://www.douyin.com/note/' + id, 'https://www.douyin.com/note/' + otherId, 'https://www.douyin.com/user/self']) {
        await content('<div data-e2e="note-desc">不得返回此描述</div>', url);
        assert.deepEqual(await read(), missing);
      }
    });

    await t.test('og 描述必须有明确同作品URL，且拒绝通用站点描述', async () => {
      await content('<link rel="canonical" href="https://www.douyin.com/note/' + id + '"><meta property="og:description" content="当前图文的服务说明">');
      assert.deepEqual(await read(), { desc: '当前图文的服务说明', descriptionState: 'available', descriptionSource: 'page_meta' });
      await content('<link rel="canonical" href="https://www.douyin.com/note/' + id + '"><meta property="og:url" content="https://www.douyin.com/note/' + otherId + '"><meta property="og:description" content="其他作品说明">');
      assert.deepEqual(await read(), missing);
      await content('<meta property="og:url" content="https://www.douyin.com/note/' + id + '"><meta property="og:description" content="抖音 - 记录美好生活">');
      assert.deepEqual(await read(), missing);
    });

    await t.test('多处描述互相冲突时不随意选第一条，普通页面正文不会成为描述', async () => {
      await content('<div data-e2e="note-desc">一个说明</div><div data-e2e="video-desc">另一个说明</div><p>大量普通正文和用户评论</p>');
      assert.deepEqual(await read(), missing);
    });

    await t.test('最大2MB、10000节点和深度12限制生效，不执行 JSON 文本', async () => {
      await content('<script id="RENDER_DATA" type="application/json">window.qaExecuted=true</script><div>普通正文</div>');
      assert.deepEqual(await read(), missing); assert.equal(await page.evaluate(() => window.qaExecuted), undefined);
      let deep = { aweme_id: id, desc: '超出深度的描述' };
      for (let depth = 0; depth < 13; depth++) deep = { child: deep };
      await content('<script type="application/json">' + JSON.stringify(deep) + '</script>');
      assert.deepEqual(await read(), missing);
      const many = Array.from({ length: 10001 }, () => ({ ignored: 'plain' }));
      many.push({ aweme_id: id, desc: '超出节点的描述' });
      await content('<script type="application/json">' + JSON.stringify(many) + '</script>');
      assert.deepEqual(await read(), missing);
      await content('<script type="application/json">' + JSON.stringify({ aweme_id: id, desc: 'x'.repeat(2 * 1024 * 1024) }) + '</script>');
      assert.deepEqual(await read(), missing);
    });
  } finally { await context.close(); await browser.close(); }
});
