'use strict';

// Real Chromium, manufactured pages only. A rejecting loopback proxy and
// deny-by-default Playwright routes prevent any real account / origin action.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

// 受限环境下系统临时目录可能不可写（Chromium 锁文件/配置写入被拒）：
// 将 Playwright 的临时配置目录重定向到构建目录，保证浏览器可正常初始化。
const QA_TMP = path.join(__dirname, 'qa-tmp');
fs.mkdirSync(QA_TMP, { recursive: true });
process.env.TEMP = process.env.TMP = QA_TMP;

const ROOT = path.resolve(__dirname, '..');
const source = process.argv.includes('--source');
const match = process.argv.find(value => value.startsWith('--match='))?.slice('--match='.length) || '';
const nicknamePolicy = process.argv.includes('--nickname-policy');
const exclude = process.argv.find(value => value.startsWith('--exclude='))?.slice('--exclude='.length) || '';
const APP = path.join(ROOT, source ? 'dy-lead-app' : 'dy-lead-app-release');
const REPORT = path.join(__dirname, 'outreach-browser-' + (source ? 'source' : 'build') + (match || exclude ? '-focused' : '') + '-verification.json');
const adapter = require(path.join(APP, 'lib', 'outreach-browser.js'));
const chromium = require(path.join(APP, 'node_modules', 'playwright-core')).chromium;
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
const revision = manifest.browsers.find(item => item.name === 'chromium').revision;
// 某些受限环境中，从刚生成的大目录直接启动浏览器会被拦截（锁文件/崩溃上报管道被拒）。
// 验证仍使用发布包里 1:1 的文件，只是复制到构建目录的 QA 缓存目录后启动。
const shippedChromiumDir = path.join(APP, 'node_modules', 'playwright-core', '.local-browsers', 'chromium-' + revision, 'chrome-win64');
const launchChromiumDir = source ? shippedChromiumDir : path.join(__dirname, '.qa-chromium-cache');
if (!source) {
  const cacheMarker = path.join(launchChromiumDir, '.qa-revision');
  const fresh = fs.existsSync(path.join(launchChromiumDir, 'chrome.exe')) && fs.existsSync(cacheMarker) && fs.readFileSync(cacheMarker, 'utf8') === String(revision);
  if (!fresh) {
    fs.rmSync(launchChromiumDir, { recursive: true, force: true });
    fs.cpSync(shippedChromiumDir, launchChromiumDir, { recursive: true });
    fs.writeFileSync(cacheMarker, String(revision), 'utf8');
  }
}
// VERIFY_CHROME_PATH 可指向本机 Chrome/Edge，便于在没有内置 Chromium 的开发机上运行
const executablePath = process.env.VERIFY_CHROME_PATH || path.join(launchChromiumDir, 'chrome.exe');
const lead = { uid: 'qa_outreach_target', homepage: 'https://www.douyin.com/user/qa_outreach_target' };
const MESSAGE = '只在隔离网页输入\n不会向真实用户发送。';
const completed = [];
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const verificationSources = { adapterSha256: hash(path.join(APP, 'lib', 'outreach-browser.js')), verifierSha256: hash(__filename) };

function pageHtml({ editor = 'textarea', legacy = false, duplicateFollow = false, duplicateSend = false,
  recipient = lead.uid, followText = '+ 关注', noFollow = false, noDm = false, disabledSend = false } = {}) {
  const input = editor === 'textarea' ? '<textarea id="qa-editor" aria-label="发送消息输入框"></textarea>'
    : `<div id="qa-editor" contenteditable="${editor === 'plaintext-only' ? 'plaintext-only' : 'true'}" role="textbox" style="min-height:32px"></div>`;
  const scopeStart = legacy ? '<div id="qa-conversation" hidden>' : `<section id="qa-conversation" role="dialog" data-e2e="message-panel" data-recipient-sec-uid="${recipient}" hidden>`;
  const scopeEnd = legacy ? '</div>' : '</section>';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <header><button id="qa-header-dm">私信</button><button id="qa-header-follow">关注</button></header>
    <div id="qa-parent-trap">私信</div>
    <aside data-e2e="recommend-list"><a href="/user/qa_foreign">推荐用户</a><button id="qa-recommend-follow">关注</button><button id="qa-recommend-dm">私信</button></aside>
    <h1>隔离测试个人主页</h1><section ${legacy ? 'data-testid="profile-info"' : 'data-e2e="user-info"'}>
      ${noFollow ? '' : `<span id="qa-follow" role="button" tabindex="0">${followText}</span>`}
      ${duplicateFollow ? '<button>关注</button>' : ''}
      ${noDm ? '' : '<a id="qa-open-dm" role="button" tabindex="0">私信</a>'}
    </section>
    ${scopeStart}${legacy ? `<div data-e2e="chat-header"><a href="/user/${recipient}">已确认收件人</a></div>` : ''}${input}<button id="qa-send" aria-label="发送消息" ${disabledSend ? 'disabled' : ''}><svg width="16" height="16"><path d="M0 0L16 8L0 16Z"></path></svg></button>
    ${duplicateSend ? '<button aria-label="发送">图标</button>' : ''}${scopeEnd}
    <div data-e2e="comment-list"><textarea placeholder="发表评论">旁边的评论框</textarea></div>
    <script>
      window.qaActions = { follow: 0, open: 0, send: 0, decoy: 0, trustedFollow: false, trustedOpen: false, trustedInput: false, trustedSend: false };
      for (const id of ['qa-parent-trap','qa-header-dm','qa-header-follow','qa-recommend-follow','qa-recommend-dm']) document.getElementById(id).addEventListener('click', () => window.qaActions.decoy++);
      const follow = document.getElementById('qa-follow');
      if (follow) follow.addEventListener('click', event => { window.qaActions.follow++; window.qaActions.trustedFollow = event.isTrusted; follow.textContent = '已关注'; });
      const open = document.getElementById('qa-open-dm');
      if (open) open.addEventListener('click', event => { window.qaActions.open++; window.qaActions.trustedOpen = event.isTrusted; document.getElementById('qa-conversation').hidden = false; });
      document.getElementById('qa-editor').addEventListener('input', event => window.qaActions.trustedInput = event.isTrusted);
      document.getElementById('qa-send').addEventListener('click', event => { window.qaActions.send++; window.qaActions.trustedSend = event.isTrusted; });
    </script></body></html>`;
}

function responsiveProfilePageHtml({ hiddenStyle = 'display:none', showBoth = false, listOnly = false, targetRow = false, unknownEditor = false, ...options } = {}) {
  let html = pageHtml(options).replace(/<h1>隔离测试个人主页<\/h1><section[^>]*>[\s\S]*?<\/section>/, `
    <div id="qa-global-menu"><button id="qa-global-inbox" title="私信">消息</button></div>
    <div id="qa-profile"><div>头像</div><div data-e2e="user-info"><h1>当前主页昵称</h1><div>关注 20 · 粉丝 10</div></div>
      <div><button id="frame-user-info-share-button">分享</button>
        <div><button id="qa-open-dm"><span class="semi-button-content">私信</span></button><button id="qa-follow" data-e2e="user-info-follow-btn"><span>已关注</span></button></div>
        <div ${showBoth ? '' : `style="${hiddenStyle}"`}><div><button data-e2e="user-info-follow-btn">已关注</button><button id="qa-responsive-dm"><span>私信</span></button></div><div>下载客户端</div></div>
      </div>
    </div>`);
  if (unknownEditor) html = html.replace(`data-recipient-sec-uid="${lead.uid}"`, '');
  if (listOnly) html = html.replace('<script>', `<div id="qa-message-list" data-e2e="conversation-list" hidden><input placeholder="搜索消息"><div role="listitem" data-e2e="conversation-row" ${targetRow ? `data-recipient-sec-uid="${lead.uid}"` : ''} id="qa-target-row">${targetRow ? '明确目标' : '同名但身份未知'}</div></div><script>`);
  return html.replace('</script>', `
    window.qaActions.select = 0;
    document.getElementById('qa-global-inbox').addEventListener('click', () => window.qaActions.decoy++);
    document.getElementById('qa-responsive-dm').addEventListener('click', () => window.qaActions.decoy++);
    ${listOnly ? `document.getElementById('qa-open-dm').addEventListener('click', () => { document.getElementById('qa-conversation').hidden = true; document.getElementById('qa-message-list').hidden = false; });
    document.getElementById('qa-target-row').addEventListener('click', event => { window.qaActions.select++; window.qaActions.trustedSelect = event.isTrusted; document.getElementById('qa-conversation').hidden = false; });` : ''}
    </script>`);
}

// The inspected production composer renders a Slate end-of-line caret marker
// after native input, and exposes Send as an unlabelled SVG beside the editor.
// Reproduce that structure rather than adding an aria-label solely for tests.
function slatePageHtml({ sendMode = 'svg', recipientHeader = lead.uid, contentEditable = 'true', composerWrapper = false, ...options } = {}) {
  const editor = `<div class="messageMsgInputinputColumn"><div class="messageMsgInputinputRow">
    <div class="messageEditorimChatEditorContainer"><div id="qa-editor" contenteditable="${contentEditable}" data-slate-editor="true" role="textbox" style="white-space:pre-wrap;min-height:40px;width:320px"><div class="ace-line" data-node="true"><span data-string="true" data-enter="true" data-leaf="true">&#8203;</span></div></div></div>
    <div class="messageMsgInputinputAction">
      <svg id="qa-emoji" width="28" height="28" style="cursor:pointer"><circle cx="14" cy="14" r="12"></circle></svg>
      <svg id="qa-send" class="messageMsgInputpublishBtn ${sendMode === 'disabled-class' ? '' : 'messageMsgInputpublishRedBtn'} ${sendMode === 'unmarked' ? '' : 'e2e-send-msg-btn'}" width="28" height="28" style="cursor:pointer" ${sendMode === 'disabled-aria' ? 'aria-disabled="true"' : ''}><path d="M14 3L24 15H18V26H10V15H4Z"></path></svg>
      ${sendMode === 'duplicate' ? '<svg id="qa-second-send" class="messageMsgInputpublishBtn messageMsgInputpublishRedBtn e2e-send-msg-btn" width="28" height="28"><path d="M14 3L24 15H18V26H10V15H4Z"></path></svg>' : ''}
    </div></div></div>`;
  let html = pageHtml({ ...options, editor: 'contenteditable' });
  html = html.replace(/<div id="qa-editor"[^>]*><\/div><button id="qa-send"[^>]*>[\s\S]*?<\/button>/, editor);
  html = html.replace(editor, `<div data-e2e="chat-header"><a id="qa-recipient" href="/user/${recipientHeader}">隔离会话收件人</a></div>${composerWrapper ? '<div class="chat-composer">' + editor + '</div>' : editor}`);
  if (sendMode === 'wrapped') {
    html = html.replace(/<svg id="qa-send"[^>]*>[\s\S]*?<\/svg>/, svg => `<button id="qa-send-button" aria-label="发送消息">${svg}</button>`);
    html = html.replace("document.getElementById('qa-send').addEventListener('click'", "document.getElementById('qa-send-button').addEventListener('click'");
  }
  if (sendMode === 'disabled-parent') {
    html = html.replace(/<svg id="qa-send"[^>]*>[\s\S]*?<\/svg>/, svg => `<div aria-disabled="true">${svg}</div>`);
  }
  return html.replace('</script>', `
    window.qaRenderSlate = text => {
      const editor = document.getElementById('qa-editor');
      editor.replaceChildren();
      for (const lineText of text.split('\\n')) {
        const line = document.createElement('div'); line.className = 'ace-line'; line.setAttribute('data-node', 'true');
        const text = document.createElement('span'); text.setAttribute('data-string', 'true'); text.setAttribute('data-leaf', 'true'); text.textContent = lineText;
        const caret = document.createElement('span'); caret.setAttribute('data-string', 'true'); caret.setAttribute('data-enter', 'true'); caret.setAttribute('data-leaf', 'true'); caret.textContent = '\\u200b';
        line.append(text, caret); editor.append(line);
      }
    };
    document.getElementById('qa-editor').addEventListener('input', event => {
      // This fake editor owns a line model, as the real rich editor does. Read
      // native input from that model so empty blocks stay as actual blank lines
      // and its own previously-rendered caret does not become message content.
      const lines = Array.from(event.currentTarget.children);
      const value = lines.length && lines.every(line => line.classList.contains('ace-line'))
        ? lines.map(line => Array.from(line.childNodes).map(leaf => leaf.nodeType === 1 && leaf.getAttribute('data-enter') === 'true' && leaf.textContent === '\\u200b' ? '' : leaf.textContent).join('')).join('\\n')
        : event.currentTarget.innerText;
      window.qaRenderSlate(value);
    });
    document.getElementById('qa-emoji').addEventListener('click', () => window.qaActions.decoy++);
    const secondSend = document.getElementById('qa-second-send');
    if (secondSend) secondSend.addEventListener('click', () => window.qaActions.decoy++);
    </script>`);
}

// Observed StackLayout DOM: mounted list and chat layers, no user ID in the
// header or list. Only the profile's real display identity can confirm this UI.
function stackPageHtml({ chatName = '承恩勇闯亚马逊', profileName = '承恩勇闯亚马逊',
  chatAsset = 'tos-cn-i-0813c001_qaObservedAvatarAsset123456', profileAsset = 'tos-cn-i-0813c001_qaObservedAvatarAsset123456',
  delay = 0, listEditor = false, offscreenChat = false, explicitUid = '', selectToChat = false, listDelay = 0,
  rowName = profileName, rowAsset = profileAsset, internalProfileActions = false, historyMarkup = '',
  profileAvatarUrl = '', chatAvatarUrl = '', ...options } = {}) {
  let html = slatePageHtml(options);
  html = html.replace(/<h1>隔离测试个人主页<\/h1><section[^>]*>[\s\S]*?<\/section>/, `
    <div id="qa-global-menu"><button id="qa-global-inbox" title="私信">消息</button></div>
    <div id="qa-profile"><span data-e2e="live-avatar"><img width="48" height="48" src="${profileAvatarUrl || `https://p3.douyinpic.com/img/aweme-avatar/${profileAsset}~c5_300x300.jpeg`}"></span>
      <div data-e2e="user-info"><h1>${profileName}</h1><div>关注 20 · 粉丝 10</div>${internalProfileActions ? '' : '</div>'}
      <div><button id="frame-user-info-share-button">分享</button>
        <div><button id="qa-open-dm"><span class="semi-button-content">私信</span></button><button id="qa-follow" data-e2e="user-info-follow-btn">已关注</button></div>
        <div style="display:none"><div><button data-e2e="user-info-follow-btn">已关注</button><button id="qa-responsive-dm">私信</button></div><div>下载客户端</div></div>
      </div>
      ${internalProfileActions ? '</div>' : ''}
    </div>`);
  const chatHeader = (name, asset) => `<div class="StackLayoutStackTitleBartitleBar" style="height:64px;background:#ddd"><div class="StackLayoutStackChatHeaderinfoContainer"><div class="StackLayoutStackChatHeaderuser" ${explicitUid ? `data-sec-uid="${explicitUid}"` : ''}>
    <div data-apm-action="个人页卡片"><img width="36" height="36" src="${chatAvatarUrl || `https://p26.douyinpic.com/img/aweme-avatar/${asset}~c5_168x168.webp`}"></div><div class="StackLayoutStackChatHeadertitle">${name}</div></div></div></div>`;
  const row = (id, name, asset) => `<div data-e2e="conversation-item" id="${id}" style="height:64px;cursor:pointer"><div class="conversationConversationItemrowArea1" style="display:flex;align-items:center;height:100%"><div class="commonIMAvataravatarContainer"><img width="36" height="36" src="https://p26.douyinpic.com/img/aweme-avatar/${asset}~c5_100x100.webp"></div><div class="conversationConversationItemtitle">${name}</div></div></div>`;
  const listRows = selectToChat
    ? row('qa-decoy-row', '另一名会话用户', profileAsset) + row('qa-target-row', rowName, rowAsset)
    : `<div data-e2e="conversation-item" id="qa-target-row"><img width="24" height="24" src="https://p3.douyinpic.com/img/aweme-avatar/${profileAsset}~c5_100x100.jpeg"><div class="conversationConversationItemtitle">${profileName}</div></div>`;
  html = html.replace(/<section id="qa-conversation"[^>]*>/, `<aside id="qa-conversation" aria-hidden="false" hidden style="position:fixed;right:10px;top:10px;width:380px;height:570px;overflow:hidden;background:#fff">
    <div data-e2e="im-dialog" style="width:100%;height:100%"><div id="imSaasContainerId" class="StackLayoutStackLayoutV2wrapper" style="position:relative;height:100%">
      <div data-stack-layer="list" id="qa-list-layer" style="position:absolute;inset:0">${listRows}
        ${listEditor ? '<div class="messageMsgInputinputRow"><textarea id="qa-list-editor" aria-label="发送消息"></textarea><button>发送</button></div>' : ''}</div>
      ${offscreenChat ? `<div data-stack-layer="chat" style="position:absolute;inset:0;transform:translateX(420px)">${chatHeader(profileName, profileAsset)}<div class="messageMsgInputinputRow"><textarea id="qa-old-editor"></textarea><button>发送</button></div></div>` : ''}
      <div data-stack-layer="chat" id="qa-active-chat" hidden style="position:absolute;inset:0;background:white">`);
  html = html.replace(/<div data-e2e="chat-header"><a id="qa-recipient"[^>]*>[\s\S]*?<\/a><\/div>/, chatHeader(chatName, chatAsset) + `<div class="messageMessageListwrapper"><div class="messageMessageListlist">${historyMarkup}</div></div>`);
  html = html.replace('</section>\n    <div data-e2e="comment-list">', '</div></div></div></aside>\n    <div data-e2e="comment-list">');
  html = html.replace('class="messageMsgInputinputColumn"', 'data-e2e="msg-input" class="messageMsgInputinputColumn"');
  html = html.replace('data-slate-editor="true" role="textbox"', 'data-slate-editor="true" data-placeholder="发送消息" role="textbox"');
  html = html.replace('messageMsgInputpublishBtn messageMsgInputpublishRedBtn e2e-send-msg-btn', 'messageMsgInputpublishBtn e2e-send-msg-btn');
  return html.replace('</script>', `
    window.qaActions.select = 0;
    document.getElementById('qa-global-inbox').addEventListener('click', () => window.qaActions.decoy++);
    document.getElementById('qa-responsive-dm').addEventListener('click', () => window.qaActions.decoy++);
    ${selectToChat ? `
    document.getElementById('qa-target-row').hidden = ${listDelay > 0};
    document.getElementById('qa-list-layer').addEventListener('click', event => {
      const row = event.target.closest('[data-e2e="conversation-item"]');
      if (row?.id === 'qa-target-row') {
        window.qaActions.select++; window.qaActions.trustedSelect = event.isTrusted;
        setTimeout(() => document.getElementById('qa-active-chat').hidden = false, ${delay});
      } else if (row) window.qaActions.decoy++;
    });` : "document.getElementById('qa-target-row').addEventListener('click', () => window.qaActions.select++);"}
    document.getElementById('qa-open-dm').addEventListener('click', () => {
      ${selectToChat ? `setTimeout(() => document.getElementById('qa-target-row').hidden = false, ${listDelay});` : `setTimeout(() => document.getElementById('qa-active-chat').hidden = false, ${delay});`}
    });
    document.getElementById('qa-editor').addEventListener('input', () => document.getElementById('qa-send').classList.add('messageMsgInputpublishRedBtn'));
    </script>`);
}

(async () => {
  let blocker, browser, context;
  let proxyConnections = 0, manufacturedDocuments = 0, abortedRequests = 0;
  const pages = [];
  try {
    assert(fs.existsSync(executablePath), 'The bundled shipping Chromium must be present');
    if (!source) assert.match(fs.readFileSync(path.join(APP, 'engine.js'), 'utf8'), /_0x[0-9a-f]+/i, 'Release test must use the shipping build');
    blocker = net.createServer(socket => { proxyConnections++; socket.destroy(); });
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: false,
      args: ['--disable-crash-reporter', '--no-crashpad', '--disable-breakpad'],
      proxy: { server: 'http://127.0.0.1:' + blocker.address().port } });
    context = await browser.newContext({ serviceWorkers: 'block' });
    let html = '';
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.isNavigationRequest() && url.origin === 'https://www.douyin.com' && /^\/user\/[a-z_]+$/.test(url.pathname)) {
        manufacturedDocuments++;
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      } else { abortedRequests++; await route.abort(); }
    });
    async function fixture(options = {}) {
      html = options.stack ? stackPageHtml(options) : options.responsive ? responsiveProfilePageHtml(options) : options.slate ? slatePageHtml(options) : pageHtml(options);
      const page = await context.newPage(); pages.push(page);
      await page.goto(lead.homepage, { waitUntil: 'domcontentloaded' });
      return page;
    }
    async function test(name, operation) {
      if (nicknamePolicy && !/^(?:Nickname identity:|Emoji identity:|Profile identity capture:|DOM history:|Observed list:|Observed list boundary:|Observed StackLayout|Observed identity|Observed profile identity)/.test(name)) return;
      if (match && !name.includes(match)) return;
      if (exclude && name.includes(exclude)) return;
      await operation(); completed.push(name);
      process.stdout.write('PASS ' + name + '\n');
      for (const page of pages.splice(0)) if (!page.isClosed()) await page.close();
    }
    const actions = page => page.evaluate(() => window.qaActions);

    // Anonymized copy of the user's 2026-10-10 old outbound bubble structure.
    const oldOutgoing = `<div data-index="0"><div class="messageMessageBoxmessageBox messageMessageBoxlargeMargin messageMessageBoxstackLayout"><div class="messageMessageBoxcontentBox messageMessageBoxisFromMe messageMessageBoxstackLayout"><div data-apm-action="个人页卡片"><img width="20" height="20"></div><div class="MessageBoxContentcolumnBox MessageBoxContentisFromMe"><div class="MessageBoxContentrowBox"><div data-e2e="msg-item-content" class="MessageBoxContentactiveClickArea MessageBoxContentstackLayout"><div><div><div><div class="MessageItemTextcontainer MessageItemTextisFromMe"><div class="MessageItemTextbubbleContent"><div class="MessageItemTextbubbleTextContent"><span class="TextMessageTexttextInnerContent"><span class="TextMessageTextpureText" data-apm-action="纯文本">测试历史消息</span></span></div></div></div></div></div></div></div><div class="MessageBoxContentSidewrapper"></div></div><div class="MessageBoxContentBottomwrapper MessageBoxContentBottomisFromMe"></div></div></div></div></div>`;
    const observeHistory = async (historyMarkup, options = {}) => {
      const page = await fixture({ stack: true, historyMarkup, ...options });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true);
      return { page, observation: await adapter.readDirectMessageHistory(page, lead) };
    };
    await test('DOM history: supplied outgoing structure blocks duplicate without filling or sending', async () => {
      const { page, observation } = await observeHistory(oldOutgoing);
      assert.equal(observation.history.state, 'already_sent');
      assert.equal(observation.history.complete, false); assert.equal(observation.history.lastSentAt, null);
      assert.equal(observation.history.outboundCount, 1);
      assert.deepEqual([(await actions(page)).send, (await actions(page)).trustedInput], [0, false]);
      assert(!JSON.stringify(observation).includes('测试历史消息'), 'Do not retain message text');
    });
    for (const [name, html] of [
      ['failed side icon', oldOutgoing.replace('class="MessageBoxContentSidewrapper">', 'class="MessageBoxContentSidewrapper"><svg class="message-failed"><path/></svg>')],
      ['pending bottom indicator', oldOutgoing.replace('class="MessageBoxContentBottomwrapper MessageBoxContentBottomisFromMe">', 'class="MessageBoxContentBottomwrapper MessageBoxContentBottomisFromMe"><span>发送中</span>')],
      ['unknown status icon', oldOutgoing.replace('class="MessageBoxContentSidewrapper">', 'class="MessageBoxContentSidewrapper"><svg class="new-status"/>')],
      ['incoming message', oldOutgoing.replace(/messageMessageBoxisFromMe|MessageBoxContentisFromMe|MessageItemTextisFromMe/g, '')],
      ['system hint only', '<div class="messageMessageBoxmessageBox messageMessageBoxisFullRowCenterMessage"><span>对方回复或关注你之前，只能发送一条文字消息</span></div>'],
      ['empty chat', '']
    ]) await test(`DOM history: ${name} cannot prove previous send`, async () => {
      const { observation } = await observeHistory(html);
      assert.equal(observation.history.state, 'unknown');
    });
    await test('DOM history: stale recipient and list preview never supply history', async () => {
      const { page } = await observeHistory('');
      await page.locator('#qa-list-layer').evaluate((node, html) => node.insertAdjacentHTML('beforeend', html), oldOutgoing);
      assert.equal((await adapter.readDirectMessageHistory(page, lead)).history.state, 'unknown');
      await page.locator('#qa-active-chat .messageMessageListlist').evaluate((node, html) => node.innerHTML = html, oldOutgoing);
      await page.locator('#qa-active-chat .StackLayoutStackChatHeadertitle').evaluate(node => node.textContent = '另一位用户');
      assert.notEqual((await adapter.readDirectMessageHistory(page, lead)).history?.state, 'already_sent');
    });
    for (const [code, notice] of [
      ['DM_RECIPIENT_MUTUAL_ONLY', '对方设置了仅和他互关的人可发消息，由于你不在范围内，暂无法给对方发送消息'],
      ['DM_RECIPIENT_MESSAGE_LIMIT', '给对方发送的消息已达上限，对方回复或互关后才能继续发送消息'],
      ['DM_ACCOUNT_FREQUENT', '操作频繁，请稍后再试'],
      ['DM_ACCOUNT_DAILY_LIMIT', '今日陌生人私信达到上限']
    ]) await test(`DOM history: ${code} is scoped to platform notice and remains readable after click`, async () => {
      const { page } = await observeHistory('');
      await page.locator('#qa-active-chat .messageMessageListwrapper').evaluate((node, text) => node.insertAdjacentHTML('beforeend', `<p>${text}</p>`), notice);
      assert.equal((await adapter.readDirectMessageHistory(page, lead)).restriction.code, code);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const prepared = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(prepared.state, 'ready'); await prepared.click();
      assert.equal((await prepared.readFeedback()).restriction.code, code);
      await page.locator('#qa-active-chat .StackLayoutStackChatHeadertitle').evaluate(node => node.textContent = '新目标');
      assert.equal((await prepared.readFeedback()).state, 'missing');
    });
    await test('DOM history: message text cannot masquerade as platform restriction', async () => {
      const text = '对方设置了仅和他互关的人可发消息，由于你不在范围内，暂无法给对方发送消息';
      const { observation } = await observeHistory(oldOutgoing.replace('测试历史消息', text));
      assert.equal(observation.restriction, null);
    });
    await test('DOM history: observed MessageBoxTipsMessage frequency row is a platform limit; bubble text and foreign chat remain excluded', async () => {
      const notice = '给陌生人发送消息过于频繁，请稍后再发送陌生人消息';
      const html = '<div class="messageMessageBoxmessageBox messageMessageBoxlargeMargin messageMessageBoxstackLayout">'
        + '<div class="MessageBoxTipsMessagelayout"><p class="MessageBoxTipsMessagecontent"><span><span class="MessageBoxTipsMessagetext">'
        + notice + '</span></span></p></div></div>';
      const { page, observation } = await observeHistory(html);
      assert.equal(observation.restriction.code, 'DM_ACCOUNT_FREQUENT'); assert.equal(observation.restriction.failureScope, 'account');
      assert.equal(observation.history.state, 'unknown');
      const ordinary = await observeHistory(oldOutgoing.replace('测试历史消息', notice));
      assert.equal(ordinary.observation.restriction, null);
      await page.locator('#qa-active-chat .StackLayoutStackChatHeadertitle').evaluate(node => node.textContent = '另一位用户');
      const foreign = await adapter.readDirectMessageHistory(page, lead);
      assert.notEqual(foreign.state, 'ready'); assert.equal(foreign.restriction || null, null);
    });

    const emojiImage = (alt, asset) => `<img draggable="false" width="20" height="20" alt="${alt}" src="//p-pc-weboff.byteimg.com/tos-cn-i-9r5gewecjs/twemoji/72x72/${asset}.png">`;

    for (const [name, options, alter] of [
      ['different avatar', { chatAsset: 'qaOtherAvatarAssetDifferent123456' }],
      ['missing avatar', {}, async page => page.locator('[data-e2e="live-avatar"]').evaluate(node => node.remove())],
      ['unloaded avatar', {}, async page => page.locator('[data-e2e="live-avatar"] img').evaluate(node => node.removeAttribute('src'))],
      ['duplicate avatar elements', {}, async page => page.locator('[data-e2e="live-avatar"]').evaluate(node => node.after(node.cloneNode(true)))],
      ['placeholder avatar', { profileAsset: 'default_qaAvatarAsset12345678' }],
      ['UID attributes are not a nickname gate', { explicitUid: 'qa_foreign' }, async page => page.locator('#qa-editor').evaluate(node => node.setAttribute('data-sec-uid', 'qa_other'))],
      ['same list nickname with different avatar', { selectToChat: true, rowAsset: 'qaOtherAvatarAssetDifferent123456' }],
      ['list UID attributes are not a nickname gate', { selectToChat: true }, async page => page.locator('#qa-target-row').evaluate(node => node.setAttribute('data-sec-uid', 'qa_other'))],
      ['emoji-only name with missing avatar', { profileName: emojiImage('💎', '1f48e'), chatName: '💎' }, async page => page.locator('[data-e2e="live-avatar"]').evaluate(node => node.remove())],
    ]) await test('Nickname identity: ' + name + ' permits full-name match', async () => {
      const page = await fixture({ stack: true, ...options });
      if (alter) await alter(page);
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal(adapter.getDiagnostic(page).recipientEvidence, 'dom_profile_name');
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready'); await send.click();
      const result = await actions(page);
      assert.deepEqual([result.open, result.select, result.send, result.decoy], [1, options.selectToChat ? 1 : 0, 1, 0]);
      assert(result.trustedOpen && result.trustedInput && result.trustedSend);
    });
    await test('Nickname identity: matching UID cannot override a different nickname', async () => {
      const page = await fixture({ stack: true, explicitUid: lead.uid, chatName: '别人的聊天' });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), false);
      assert.equal((await actions(page)).send, 0);
      assert.equal((await actions(page)).trustedInput, false);
    });
    await test('Nickname identity: duplicate full names with distinct avatars remain ambiguous', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      await page.locator('#qa-decoy-row .conversationConversationItemtitle').evaluate(node => { node.textContent = '承恩勇闯亚马逊'; });
      await page.locator('#qa-decoy-row img').evaluate(node => { node.src = 'https://example.invalid/another-avatar'; });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), false);
      assert.equal(adapter.getDiagnostic(page).targetConversationRowCount, 2);
      assert.deepEqual([(await actions(page)).select, (await actions(page)).decoy, (await actions(page)).send], [0, 0, 0]);
    });
    await test('Nickname identity: stop before entry prevents native click', async () => {
      const page = await fixture({ stack: true });
      await assert.rejects(adapter.openDirectMessage(page, lead, { beforeUiAction: () => { throw new Error('user stopped'); } }), /user stopped/);
      assert.equal((await actions(page)).open, 0);
    });
    await test('Entry click: persistent overlay reports DM_ENTRY_CLICK_BLOCKED without a native click', async () => {
      const page = await fixture({ stack: true });
      // A fixed overlay that Escape cannot close covers the whole profile.
      await page.evaluate(() => { const veil = document.createElement('div'); veil.id = 'qa-veil'; veil.className = 'qa-toast';
        veil.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.01)'; document.body.appendChild(veil); });
      assert.equal(await adapter.openDirectMessage(page, lead), false);
      const diagnostic = adapter.getDiagnostic(page);
      assert.equal(diagnostic.code, 'DM_ENTRY_CLICK_BLOCKED');
      assert.match(diagnostic.entryBlocker, /^div\|qa-toast\|/);
      assert.equal((await actions(page)).open, 0);
    });
    await test('Entry click: transient overlay closed by Escape still opens the target chat', async () => {
      const page = await fixture({ stack: true });
      await page.evaluate(() => { const veil = document.createElement('div'); veil.id = 'qa-veil';
        veil.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.01)'; document.body.appendChild(veil);
        document.addEventListener('keydown', event => { if (event.key === 'Escape') veil.remove(); }); });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal((await actions(page)).open, 1);
    });
    await test('Entry pairing: follow button re-rendered without its marker still pairs the DM entry', async () => {
      const page = await fixture({ stack: true });
      const removed = await page.evaluate(() => { const nodes = document.querySelectorAll('#qa-follow');
        nodes.forEach(node => node.removeAttribute('data-e2e')); return nodes.length; });
      assert(removed >= 1);
      assert.equal(await adapter.openDirectMessage(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal((await actions(page)).open, 1);
    });
    await test('Nickname identity: observed legacy avatar and clipped full title permit native send', async () => {
      const page = await fixture({ stack: true, profileName: '蜗牛妈妈跨境创业中', chatName: '蜗牛妈妈跨境创业中',
        profileAvatarUrl: 'https://p3-pc.douyinpic.com/img/be0c00128432b51fed9f~c5_300x300.jpeg?from=2956013662',
        chatAvatarUrl: 'https://p11.douyinpic.com/img/be0c00128432b51fed9f~c5_168x168.webp?biz_tag=aweme_im' });
      await page.locator('.StackLayoutStackChatHeadertitle').evaluate(node => { node.style.cssText = 'max-width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal(adapter.getDiagnostic(page).chatNameMatches, 1);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready'); await send.click();
      const result = await actions(page);
      assert.deepEqual([result.open, result.send, result.decoy], [1, 1, 0]);
      assert(result.trustedOpen && result.trustedInput && result.trustedSend);
    });
    for (const [name, profileName, chatName, selectToChat] of [
      ['image emoji around text', emojiImage('✨', '2728') + '测试昵称' + emojiImage('✨', '2728'), '✨测试昵称✨', false],
      ['emoji-only name', emojiImage('💎', '1f48e'), '💎', false],
      ['joined emoji sequence', emojiImage('👩‍💻', '1f469-200d-1f4bb'), '👩‍💻', false],
      ['emoji target list row', emojiImage('✨', '2728') + '测试昵称', '✨测试昵称', true],
    ]) {
      await test(`Emoji identity: ${name} keeps full name and native target action`, async () => {
        const page = await fixture({ stack: true, profileName, chatName, rowName: chatName, selectToChat });
        assert.equal(await adapter.openDirectMessage(page, lead), true);
        assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
        assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
        const send = await adapter.prepareSend(page, lead, MESSAGE);
        assert.equal(send.state, 'ready'); assert.equal(await send.click(), true);
        const result = await actions(page);
        assert.deepEqual([result.open, result.select, result.send, result.decoy], [1, selectToChat ? 1 : 0, 1, 0]);
        assert(result.trustedOpen && result.trustedInput && result.trustedSend);
      });
    }
    for (const [name, options] of [
      ['different emoji with identical text', { profileName: emojiImage('✨', '2728') + '测试昵称', chatName: '💎测试昵称' }],
      ['different emoji-only names', { profileName: emojiImage('✨', '2728'), chatName: '💎' }],
      ['missing emoji alt never collapses to bare text', { profileName: emojiImage('', '2728') + '测试昵称', chatName: '测试昵称' }],
      ['unexpected inline image never collapses to bare text', { profileName: '<img width="20" height="20" alt="✨" src="https://example.invalid/icon.png">测试昵称', chatName: '测试昵称' }],
      ['emoji filename disagrees with alt', { profileName: emojiImage('✨', '1f48e') + '测试昵称', chatName: '✨测试昵称' }],
    ]) {
      await test(`Emoji identity: ${name} blocks fill and send`, async () => {
        const page = await fixture({ stack: true, ...options });
        assert.equal(await adapter.openDirectMessage(page, lead), true);
        assert.equal(await adapter.ensureDirectMessageConversation(page, lead), false);
        const result = await actions(page);
        assert.deepEqual([result.send, result.decoy, result.trustedInput], [0, 0, false]);
      });
    }

    await test('Profile identity capture: internal user-info actions bind sibling avatar to UID-less chat', async () => {
      const page = await fixture({ stack: true, internalProfileActions: true });
      assert.equal(await page.locator('[data-e2e="user-info"] #qa-open-dm').count(), 1);
      assert.equal(await page.locator('[data-e2e="user-info"] [data-e2e="live-avatar"]').count(), 0);
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal(adapter.getDiagnostic(page).profileIdentityCaptured, 1);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE);
      assert.equal(send.state, 'ready'); assert.equal(await send.click(), true);
      const result = await actions(page);
      assert.deepEqual([result.open, result.select, result.send, result.decoy], [1, 0, 1, 0]);
      assert(result.trustedOpen && result.trustedInput && result.trustedSend);
    });
    await test('Profile identity capture: internal actions select the UID-less target list row once', async () => {
      const page = await fixture({ stack: true, internalProfileActions: true, selectToChat: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.deepEqual([(await actions(page)).select, (await actions(page)).trustedInput], [1, false]);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready'); await send.click();
      const result = await actions(page);
      assert.deepEqual([result.open, result.select, result.send, result.decoy], [1, 1, 1, 0]);
      assert(result.trustedOpen && result.trustedSelect && result.trustedInput && result.trustedSend);
    });


    for (const [label, options] of [['different chat name', { chatName: '另一个目标用户' }],
      ['empty chat name', { chatName: '' }]]) {
      await test('Profile identity capture: internal actions reject ' + label, async () => {
        const page = await fixture({ stack: true, internalProfileActions: true, ...options });
        assert.equal(await adapter.openDirectMessage(page, lead), true);
        assert.equal(await adapter.ensureDirectMessageConversation(page, lead), false);
        assert.equal(adapter.getDiagnostic(page).profileIdentityCaptured, 1);
        assert.deepEqual([(await actions(page)).trustedInput, (await actions(page)).send], [false, 0]);
      });
    }

    await test('Profile identity capture: internal profile identity changing after readiness blocks native fill', async () => {
      const page = await fixture({ stack: true, internalProfileActions: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true);
      await page.locator('[data-e2e="user-info"] h1').evaluate(node => { node.textContent = '页面身份已变更'; });
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      const diagnostic = adapter.getDiagnostic(page);
      assert.equal(diagnostic.profileIdentityCaptured, 1); assert.equal(diagnostic.profileIdentityChanged, 1);
      assert.equal(diagnostic.profileIdentityReason, 'profile_identity_changed');
      assert.deepEqual([(await actions(page)).trustedInput, (await actions(page)).send], [false, 0]);
    });


    await test('Conversation readiness: ensure selects and binds without filling, then reuses readiness once', async () => {
      const page = await fixture({ stack: true, selectToChat: true, delay: 300 });
      const stages = [];
      const options = { onStage: stage => stages.push(stage) };
      assert.equal(await adapter.openDirectMessage(page, lead, options), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead, options), true);
      assert.equal(await page.locator('#qa-editor').innerText(), '\u200b');
      assert.deepEqual([(await actions(page)).select, (await actions(page)).trustedInput, (await actions(page)).send], [1, false, 0]);
      assert.deepEqual(stages, ['selecting_conversation', 'conversation_ready']);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead, options), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE, options), true);
      assert.deepEqual(stages, ['selecting_conversation', 'conversation_ready']);
      assert.equal((await actions(page)).select, 1);
      assert.equal((await actions(page)).trustedInput, true);
      const send = await adapter.prepareSend(page, lead, MESSAGE, options);
      assert.equal(send.state, 'ready'); assert.equal(await send.click(), true);
      assert.deepEqual([(await actions(page)).send, (await actions(page)).decoy], [1, 0]);
    });
    await test('Conversation readiness: a preexisting matching draft cannot authorize Send without fill', async () => {
      const page = await fixture();
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true);
      await page.locator('#qa-editor').evaluate((editor, text) => { editor.value = text; }, MESSAGE);
      assert.equal((await adapter.prepareSend(page, lead, MESSAGE)).state, 'missing');
      assert.deepEqual([(await actions(page)).trustedInput, (await actions(page)).send], [false, 0]);
    });
    await test('Conversation readiness: identity changed after ensure blocks fill and send', async () => {
      const page = await fixture({ stack: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true);
      await page.locator('#qa-active-chat .StackLayoutStackChatHeadertitle').evaluate(title => { title.textContent = '已切到另一人'; });
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal((await adapter.prepareSend(page, lead, MESSAGE)).state, 'missing');
      assert.deepEqual([(await actions(page)).trustedInput, (await actions(page)).send], [false, 0]);
    });
    await test('Conversation readiness: editor replacement after ensure invalidates the saved binding', async () => {
      const page = await fixture();
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true);
      await page.locator('#qa-editor').evaluate(editor => editor.replaceWith(editor.cloneNode(true)));
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(await page.locator('#qa-editor').inputValue(), '');
      assert.equal((await adapter.prepareSend(page, lead, MESSAGE)).state, 'missing');
      assert.equal((await actions(page)).send, 0);
    });
    await test('Conversation readiness: two sequential native target conversations keep separate readiness', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      const otherLead = { uid: 'qa_second_target', homepage: 'https://www.douyin.com/user/qa_second_target' };
      for (const target of [lead, otherLead]) {
        if (target === otherLead) {
          html = stackPageHtml({ selectToChat: true, profileName: '第二个测试用户', chatName: '第二个测试用户',
            profileAsset: 'tos-cn-i-0813c001_qaSecondProfileAvatar123', chatAsset: 'tos-cn-i-0813c001_qaSecondProfileAvatar123' });
          await page.goto(target.homepage, { waitUntil: 'domcontentloaded' });
        }
        const stages = [];
        const options = { onStage: stage => stages.push(stage) };
        assert.equal(await adapter.openDirectMessage(page, target, options), true);
        assert.equal(await adapter.ensureDirectMessageConversation(page, target, options), true);
        assert.deepEqual([(await actions(page)).select, (await actions(page)).trustedInput, (await actions(page)).send], [1, false, 0]);
        assert.equal(await adapter.fillDirectMessage(page, target, MESSAGE, options), true);
        const send = await adapter.prepareSend(page, target, MESSAGE, options);
        assert.equal(send.state, 'ready'); assert.equal(await send.click(), true);
        assert.deepEqual(stages, ['selecting_conversation', 'conversation_ready']);
        const result = await actions(page);
        assert.deepEqual([result.open, result.select, result.send, result.decoy], [1, 1, 1, 0]);
        assert(result.trustedOpen && result.trustedSelect && result.trustedInput && result.trustedSend);
      }
    });

    await test('Observed list: unique full profile name selects the nonfirst row before delayed target chat', async () => {
      const page = await fixture({ stack: true, selectToChat: true, delay: 2000 });
      let authorizations = 0;
      const options = { beforeUiAction: async () => { authorizations++; } };
      assert.equal(await adapter.openDirectMessage(page, lead, options), true);
      assert.equal(await page.locator('#qa-active-chat').isVisible(), false);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE, options), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal(adapter.getDiagnostic(page).conversationRowEvidence, 'dom_profile_name');
      assert.equal(adapter.getDiagnostic(page).recipientEvidence, 'dom_profile_name');
      assert.equal((await actions(page)).select, 1); assert.equal((await actions(page)).trustedSelect, true);
      const send = await adapter.prepareSend(page, lead, MESSAGE, options);
      assert.equal(send.state, 'ready'); assert.equal(await send.click(), true);
      assert.equal(authorizations, 4);
      assert.deepEqual([(await actions(page)).decoy, (await actions(page)).send], [0, 1]);
    });
    await test('Observed list: late row selection starts bounded independent chat readiness', async () => {
      const page = await fixture({ stack: true, selectToChat: true, listDelay: 6200, delay: 2500 });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      const started = Date.now();
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert(Date.now() - started >= 8300, 'Chat mounts after the original eight-second deadline');
      assert(Date.now() - started < 16500, 'Combined readiness stays bounded');
      assert.equal((await actions(page)).select, 1);
    });
    for (const [name, options] of [
      ['same avatar with different name', { rowName: '同头像的另一用户' }],
    ]) {
      await test(`Observed list: ${name} cannot supply the target row`, async () => {
        const page = await fixture({ stack: true, selectToChat: true, ...options });
        assert.equal(await adapter.openDirectMessage(page, lead), true);
        assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
        assert.equal(adapter.getDiagnostic(page).targetConversationRowCount, 0);
        assert.deepEqual([(await actions(page)).select, (await actions(page)).trustedInput, (await actions(page)).decoy], [0, false, 0]);
      });
    }
    await test('Observed list: duplicate full names do not permit a first-row guess', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      await page.locator('#qa-target-row').evaluate(row => { const copy = row.cloneNode(true); copy.id = 'qa-duplicate-row'; row.after(copy); });
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(adapter.getDiagnostic(page).targetConversationRowCount, 2);
      assert.deepEqual([(await actions(page)).select, (await actions(page)).decoy], [0, 0]);
    });


    for (const style of ['visibility:hidden', 'transform:translateX(420px)']) {
      await test(`Observed list: ${style} rows cannot be selected through mounted DOM`, async () => {
        const page = await fixture({ stack: true, selectToChat: true });
        await page.locator('#qa-target-row').evaluate((row, style) => { row.style.cssText += ';' + style; }, style);
        assert.equal(await adapter.openDirectMessage(page, lead), true);
        assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
        assert.equal(adapter.getDiagnostic(page).targetConversationRowCount, 0);
        assert.equal((await actions(page)).select, 0);
      });
    }
    await test('Observed list: row redrawn during authorization rebinds the unique matching element once', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      let checks = 0;
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE, { beforeUiAction: async () => {
        if (++checks === 1) await page.locator('#qa-target-row').evaluate(row => row.replaceWith(row.cloneNode(true)));
      } }), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal((await actions(page)).select, 1); assert.equal((await actions(page)).decoy, 0);
    });
    await test('Observed list: current profile identity changed during row authorization blocks selection', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE, { beforeUiAction: async () => {
        await page.locator('[data-e2e="user-info"] h1').evaluate(name => { name.textContent = '变成另一个目标'; });
      } }), false);
      assert.equal((await actions(page)).select, 0); assert.equal((await actions(page)).trustedInput, false);
    });
    await test('Observed list: correct list identity never authorizes a mismatched resulting chat', async () => {
      const page = await fixture({ stack: true, selectToChat: true, chatName: '跳转到其他会话' });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal((await actions(page)).select, 1); assert.equal((await actions(page)).trustedInput, false);
      assert.equal(adapter.getDiagnostic(page).code, 'DM_RECIPIENT_UNCONFIRMED');
    });
    await test('Observed list boundary: an identity row mounted in the wrong stack is never selectable', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      await page.locator('#qa-target-row').evaluate(row => {
        const layer = document.createElement('div'); layer.setAttribute('data-stack-layer', 'chat');
        layer.style.cssText = 'position:absolute;top:200px;left:0;width:100%;height:100px';
        const fakeList = document.createElement('div'); fakeList.setAttribute('data-e2e', 'conversation-list');
        layer.append(fakeList); row.closest('[data-e2e="im-dialog"]').append(layer); fakeList.append(row);
      });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(adapter.getDiagnostic(page).targetConversationRowCount, 0);
      assert.equal((await actions(page)).select, 0);
    });
    await test('Observed list boundary: nickname changed during row authorization prevents selection', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE, { beforeUiAction: async () => {
        await page.locator('#qa-target-row').evaluate(row => { row.querySelector('.conversationConversationItemtitle').textContent = '别的昵称'; });
      } }), false);
      assert.equal((await actions(page)).select, 0); assert.equal((await actions(page)).trustedInput, false);
    });
    await test('Observed list boundary: replacing a bound row at native click never clicks its replacement', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      const locate = page.locator.bind(page); let clickCalls = 0;
      page.locator = (...args) => {
        const locator = locate(...args), bind = locator.elementHandle.bind(locator);
        locator.elementHandle = async options => {
          const handle = await bind(options);
          if (!handle) return handle;
          const nativeClick = handle.click.bind(handle);
          handle.click = async options => {
            clickCalls++;
            await handle.evaluate(element => element.replaceWith(element.cloneNode(true)));
            return nativeClick(options);
          };
          return handle;
        };
        return locator;
      };
      await assert.rejects(adapter.fillDirectMessage(page, lead, MESSAGE), /not attached|detached/i);
      assert.equal(clickCalls, 1);
      assert.deepEqual([(await actions(page)).select, (await actions(page)).trustedInput, (await actions(page)).decoy], [0, false, 0]);
    });

    await test('Observed StackLayout waits for target chat and confirms full profile name without avatar or UID checks', async () => {
      const page = await fixture({ stack: true, delay: 2000, listEditor: true, offscreenChat: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await page.locator('#qa-send').getAttribute('class'), 'messageMsgInputpublishBtn e2e-send-msg-btn');
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal(adapter.getDiagnostic(page).recipientEvidence, 'dom_profile_name');
      assert.equal(await page.locator('#qa-list-editor').inputValue(), '');
      assert.equal(await page.locator('#qa-old-editor').inputValue(), '');
      const send = await adapter.prepareSend(page, lead, MESSAGE);
      assert.equal(send.state, 'ready'); assert.equal(await send.click(), true);
      const result = await actions(page);
      assert.deepEqual([result.open, result.select, result.send, result.decoy], [1, 1, 1, 0]);
      assert(result.trustedOpen && result.trustedInput && result.trustedSend);
    });
    for (const [name, options] of [
      ['same avatar but different name', { chatName: '另一个同头像用户' }],
      ['matching list identity cannot authorize a different chat', { chatName: '错误会话', chatAsset: 'tos-cn-i-0813c001_qaOtherAvatarAsset789123', listEditor: true }],
    ]) {
      await test(`Observed StackLayout refuses ${name}`, async () => {
        const page = await fixture({ stack: true, ...options });
        assert.equal(await adapter.openDirectMessage(page, lead), true);
        assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
        assert.equal(adapter.getDiagnostic(page).code, 'DM_RECIPIENT_UNCONFIRMED');
        assert.equal(await page.locator('#qa-editor').innerText(), '\u200b');
        assert.deepEqual([(await actions(page)).select, (await actions(page)).send], [0, 0]);
      });
    }


    await test('Observed identity is rechecked after authorization and before native fill', async () => {
      const page = await fixture({ stack: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE, { beforeUiAction: async () => {
        await page.locator('[data-e2e="user-info"] h1').evaluate(e => { e.textContent = '已变成其他主页'; });
      } }), false);
      assert.equal(adapter.getDiagnostic(page).code, 'DM_RECIPIENT_UNCONFIRMED');
      assert.equal(adapter.getDiagnostic(page).profileIdentityChanged, 1);
      assert.equal((await actions(page)).trustedInput, false);
    });
    await test('Observed profile identity changes before prepared send prohibit the native click', async () => {
      const page = await fixture({ stack: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE, { beforeUiAction: async () => {
        await page.locator('[data-e2e="user-info"] h1').evaluate(e => { e.textContent = '别的昵称'; });
      } });
      assert.equal(send.state, 'ready');
      await assert.rejects(send.click(), error => error.actionNotStarted === true);
      assert.equal((await actions(page)).send, 0);
    });




    await test('Native role-button follow, textarea, icon send; decoys are never clicked', async () => {
      const page = await fixture();
      const follow = await adapter.prepareFollow(page, lead);
      assert.equal(follow.state, 'ready'); assert.equal((await actions(page)).follow, 0, 'Preparation is read-only');
      assert.equal(await follow.click(), true);
      assert.equal((await adapter.prepareFollow(page, lead)).state, 'already', 'Already-followed never toggles follow off');
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert.equal(await page.locator('#qa-editor').inputValue(), MESSAGE);
      const send = await adapter.prepareSend(page, lead, MESSAGE);
      assert.equal(send.state, 'ready'); assert.equal((await actions(page)).send, 0, 'Send preparation is read-only');
      assert.equal(await send.click(), true);
      const result = await actions(page);
      assert.deepEqual({ follow: result.follow, open: result.open, send: result.send, decoy: result.decoy }, { follow: 1, open: 1, send: 1, decoy: 0 });
      assert(result.trustedFollow && result.trustedOpen && result.trustedInput && result.trustedSend, 'Actions must be native trusted browser events');
      assert.equal((await adapter.prepareSend(page, lead, MESSAGE)).state, 'missing', 'A prepared send cannot be reused');
    });
    await test('Legacy unique controls and contenteditable remain supported', async () => {
      const page = await fixture({ legacy: true, editor: 'contenteditable', followText: '关注' });
      assert.equal(await (await adapter.prepareFollow(page, lead)).click(), true);
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert.equal(await page.locator('#qa-editor').innerText(), MESSAGE);
      assert.equal(await (await adapter.prepareSend(page, lead, MESSAGE)).click(), true);
      assert.equal((await actions(page)).decoy, 0);
    });

    for (const hiddenStyle of ['display:none', 'visibility:hidden', 'opacity:0']) {
      await test(`Sibling profile action groups ignore ancestor ${hiddenStyle} and global inbox decoys`, async () => {
        const page = await fixture({ responsive: true, hiddenStyle });
        assert.equal((await adapter.prepareFollow(page, lead)).state, 'already');
        assert.equal(await adapter.openDirectMessage(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
        assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
        assert.equal((await actions(page)).open, 1); assert.equal((await actions(page)).decoy, 0);
      });
    }
    await test('Two visible responsive profile groups remain ambiguous and perform no click', async () => {
      const page = await fixture({ responsive: true, showBoth: true });
      assert.equal(await adapter.openDirectMessage(page, lead), false);
      assert.equal(adapter.getDiagnostic(page).code, 'DM_ENTRY_AMBIGUOUS');
      assert.deepEqual([(await actions(page)).open, (await actions(page)).decoy], [0, 0]);
    });
    await test('A global message list without recipient identity is never guessed by nickname', async () => {
      const page = await fixture({ responsive: true, listOnly: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(adapter.getDiagnostic(page).code, 'DM_MESSAGE_LIST_ONLY');
      assert.deepEqual([(await actions(page)).select, (await actions(page)).send, (await actions(page)).decoy], [0, 0, 0]);
      assert.equal(await page.locator('#qa-editor').inputValue(), '');
      assert.equal(adapter.getDiagnostic(page).messageListCount, 1);
      assert.equal(adapter.getDiagnostic(page).targetConversationRowCount, 0);
    });
    await test('A unique explicitly identified target conversation is selected once before verified fill', async () => {
      const page = await fixture({ responsive: true, listOnly: true, targetRow: true });
      let authorizationChecks = 0;
      const options = { beforeUiAction: async () => { authorizationChecks++; } };
      assert.equal(await adapter.openDirectMessage(page, lead, options), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE, options), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal((await actions(page)).select, 1); assert.equal((await actions(page)).trustedSelect, true);
      const send = await adapter.prepareSend(page, lead, MESSAGE, options);
      assert.equal(send.state, 'ready'); assert.equal(await send.click(), true);
      assert.equal(authorizationChecks, 4, 'entry, target row, native fill and Send each recheck authorization');
      assert.equal((await actions(page)).send, 1); assert.equal((await actions(page)).decoy, 0);
      await assert.rejects(send.click(), error => error.code === 'DM_SEND_PREPARATION_CONSUMED' && error.actionNotStarted !== true);
      assert.equal((await actions(page)).send, 1, 'the same prepared send must never click a second time');
    });
    await test('An explicitly matching numeric UID conversation row is accepted without guessing sec_uid', async () => {
      const page = await fixture({ responsive: true, listOnly: true, targetRow: true });
      await page.locator('#qa-target-row').evaluate(element => { element.removeAttribute('data-recipient-sec-uid'); element.setAttribute('data-recipient-uid', '700000001'); });
      const numericLead = { ...lead, UID: '700000001' };
      assert.equal(await adapter.openDirectMessage(page, numericLead), true);
      assert.equal(await adapter.fillDirectMessage(page, numericLead, MESSAGE), true);
      assert.equal((await actions(page)).select, 1); assert.equal((await actions(page)).send, 0);
    });
    await test('Duplicate target conversation rows do not permit a first-match choice', async () => {
      const page = await fixture({ responsive: true, listOnly: true, targetRow: true });
      await page.locator('#qa-target-row').evaluate(element => element.after(element.cloneNode(true)));
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(adapter.getDiagnostic(page).targetConversationRowCount, 2);
      assert.equal((await actions(page)).select, 0); assert.equal(await page.locator('#qa-editor').inputValue(), '');
    });
    await test('Selecting a target row never authorizes a composer showing a different recipient', async () => {
      const page = await fixture({ responsive: true, listOnly: true, targetRow: true, recipient: 'qa_foreign' });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal((await actions(page)).select, 1, 'the row is not clicked again while waiting for target evidence');
      assert.equal(await page.locator('#qa-editor').inputValue(), ''); assert.equal((await actions(page)).send, 0);
    });
    await test('An unrecognized message-list structure is reported as target chat not ready without guessed clicks', async () => {
      const page = await fixture({ responsive: true, listOnly: true });
      await page.locator('#qa-message-list').evaluate(element => element.removeAttribute('data-e2e'));
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(adapter.getDiagnostic(page).code, 'DM_TARGET_CHAT_NOT_READY');
      assert.equal((await actions(page)).select, 0); assert.equal((await actions(page)).send, 0);
    });
    await test('A newly mounted editor without recipient identity is not filled or sent', async () => {
      const page = await fixture({ responsive: true, unknownEditor: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(adapter.getDiagnostic(page).code, 'DM_RECIPIENT_UNCONFIRMED');
      assert.equal(await page.locator('#qa-editor').inputValue(), '');
      assert.equal((await actions(page)).send, 0);
    });
    await test('A profile entry redrawn during authorization is revalidated and clicked once', async () => {
      const page = await fixture({ responsive: true });
      assert.equal(await adapter.openDirectMessage(page, lead, { beforeUiAction: async () => page.locator('#qa-open-dm').evaluate(element => {
        const replacement = element.cloneNode(true);
        replacement.addEventListener('click', event => { window.qaActions.open++; window.qaActions.trustedOpen = event.isTrusted; document.getElementById('qa-conversation').hidden = false; });
        element.replaceWith(replacement);
      }) }), true);
      assert.equal((await actions(page)).open, 1); assert.equal((await actions(page)).decoy, 0);
    });
    await test('An entry changed to a different control before click is unavailable without a fallback', async () => {
      const page = await fixture({ responsive: true });
      assert.equal(await adapter.openDirectMessage(page, lead, { beforeUiAction: async () => page.locator('#qa-open-dm').evaluate(element => {
        element.textContent = '消息'; element.id = 'qa-unrelated-entry';
      }) }), false);
      assert.equal(adapter.getDiagnostic(page).code, 'DM_ENTRY_UNAVAILABLE');
      assert.deepEqual([(await actions(page)).open, (await actions(page)).decoy], [0, 0]);
    });
    await test('A same-path replacement at the native click boundary is never clicked through a positional selector', async () => {
      const page = await fixture({ responsive: true });
      const locate = page.locator.bind(page);
      let clickCalls = 0;
      page.locator = (...args) => {
        const locator = locate(...args), bind = locator.elementHandle.bind(locator);
        locator.elementHandle = async options => {
          const handle = await bind(options);
          if (!handle) return handle;
          const nativeClick = handle.click.bind(handle);
          handle.click = async options => {
            clickCalls++;
            await handle.evaluate(element => { const replacement = element.cloneNode(true); replacement.addEventListener('click', () => window.qaActions.decoy++); element.replaceWith(replacement); });
            return nativeClick(options);
          };
          return handle;
        };
        return locator;
      };
      await assert.rejects(adapter.openDirectMessage(page, lead), /not attached|detached/i);
      assert.equal(clickCalls, 1, 'an actual click attempt must not be retried');
      assert.deepEqual([(await actions(page)).open, (await actions(page)).decoy], [0, 0]);
    });
    await test('Authorization failure before selecting a target row prevents selection and fill', async () => {
      const page = await fixture({ responsive: true, listOnly: true, targetRow: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      await assert.rejects(adapter.fillDirectMessage(page, lead, MESSAGE, { beforeUiAction: async () => { throw new Error('qa authorization expired'); } }), /authorization expired/);
      assert.equal((await actions(page)).select, 0); assert.equal(await page.locator('#qa-editor').inputValue(), '');
    });
    await test('Plaintext-only message editors use native fill and native Send', async () => {
      const page = await fixture({ editor: 'plaintext-only' });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert.equal(await (await adapter.prepareSend(page, lead, MESSAGE)).click(), true);
      assert.equal((await actions(page)).trustedInput, true);
      assert.equal((await actions(page)).trustedSend, true);
    });
    await test('Observed Slate caret leaves and sibling SVG Send support exactly one native send', async () => {
      const page = await fixture({ slate: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      const filled = await adapter.fillDirectMessage(page, lead, MESSAGE);
      assert.equal(filled, true, JSON.stringify({ ...adapter.getDiagnostic(page), fixture: await page.locator('#qa-editor').evaluate(element => ({ html: element.innerHTML, text: element.innerText })) }));
      assert.notEqual(await page.locator('#qa-editor').innerText(), MESSAGE, 'The fixture must reproduce the strict innerText comparison failure');
      assert.equal(await page.locator('#qa-send').getAttribute('aria-label'), null);
      assert.equal(await page.locator('#qa-send').getAttribute('role'), null);
      const send = await adapter.prepareSend(page, lead, MESSAGE);
      assert.equal(send.state, 'ready', JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal((await actions(page)).send, 0, 'Preparing the SVG must not send');
      assert.equal(await send.click(), true);
      const result = await actions(page);
      assert.equal(result.send, 1); assert.equal(result.decoy, 0);
      assert.equal(result.trustedInput, true); assert.equal(result.trustedSend, true);
      assert.equal((await adapter.prepareSend(page, lead, MESSAGE)).state, 'missing');
    });
    await test('Observed Slate structure also supports a plaintext-only contenteditable', async () => {
      const page = await fixture({ slate: true, contentEditable: 'plaintext-only' });
      await adapter.openDirectMessage(page, lead);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true, JSON.stringify(adapter.getDiagnostic(page)));
      const send = await adapter.prepareSend(page, lead, MESSAGE);
      assert.equal(send.state, 'ready'); await send.click();
      assert.equal((await actions(page)).send, 1); assert.equal((await actions(page)).decoy, 0);
    });
    await test('A labelled button wrapping the marked SVG remains one Send action', async () => {
      const page = await fixture({ slate: true, sendMode: 'wrapped' });
      await adapter.openDirectMessage(page, lead);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready');
      await send.click();
      assert.equal((await actions(page)).send, 1); assert.equal((await actions(page)).decoy, 0);
      assert.equal((await actions(page)).trustedSend, true);
    });
    for (const [name, message, altered] of [
      ['ordinary leaf ZWSP', '字\u200b符', '字符'],
      ['emoji ZWJ', '联系开发者 👩\u200d💻', '联系开发者 👩💻'],
      ['leading whitespace', '  请联系我', '请联系我'],
      ['trailing whitespace', '请联系我  ', '请联系我'],
      ['multiple and blank lines', '第一行\n\n第三行\n第四行', '第一行\n第三行\n第四行']
    ]) {
      await test(`Slate preserves ${name} and refuses a substantive message change`, async () => {
        const page = await fixture({ slate: true });
        await adapter.openDirectMessage(page, lead);
        assert.equal(await adapter.fillDirectMessage(page, lead, message), true, JSON.stringify(adapter.getDiagnostic(page)));
        const send = await adapter.prepareSend(page, lead, message);
        assert.equal(send.state, 'ready', JSON.stringify(adapter.getDiagnostic(page)));
        await page.evaluate(value => window.qaRenderSlate(value), altered);
        await assert.rejects(send.click(), error => error.actionNotStarted === true && /会话、消息或发送控件已改变/.test(error.message));
        assert.equal((await actions(page)).send, 0); assert.equal((await actions(page)).decoy, 0);
      });
    }
    await test('A foreign header outside both the editor and chat-composer prevents Slate fill', async () => {
      const page = await fixture({ slate: true, recipientHeader: 'qa_foreign', composerWrapper: true });
      await adapter.openDirectMessage(page, lead);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal((await actions(page)).trustedInput, false);
      assert.equal((await actions(page)).send, 0);
    });
    await test('A recipient header change after preparation prevents SVG Send', async () => {
      const page = await fixture({ slate: true });
      await adapter.openDirectMessage(page, lead);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready');
      await page.locator('#qa-recipient').evaluate(element => element.href = '/user/qa_foreign');
      await assert.rejects(send.click(), error => error.actionNotStarted === true);
      assert.equal((await actions(page)).send, 0); assert.equal((await actions(page)).decoy, 0);
    });
    for (const mode of ['duplicate', 'disabled-aria', 'disabled-class', 'disabled-parent', 'unmarked']) {
      await test(`Observed SVG Send ${mode} is rejected without clicking any icon`, async () => {
        const page = await fixture({ slate: true, sendMode: mode });
        await adapter.openDirectMessage(page, lead);
        assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true, JSON.stringify(adapter.getDiagnostic(page)));
        const send = await adapter.prepareSend(page, lead, MESSAGE);
        assert.equal(send.state, 'missing');
        if (mode.startsWith('disabled-')) assert.equal(adapter.getDiagnostic(page).code, 'DM_SEND_DISABLED');
        assert.equal((await actions(page)).send, 0); assert.equal((await actions(page)).decoy, 0);
      });
    }
    await test('Removing the SVG active class after preparation prevents the click', async () => {
      const page = await fixture({ slate: true });
      await adapter.openDirectMessage(page, lead);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready');
      await page.locator('#qa-send').evaluate(element => element.classList.remove('messageMsgInputpublishRedBtn'));
      await assert.rejects(send.click(), error => error.actionNotStarted === true);
      assert.equal((await actions(page)).send, 0); assert.equal((await actions(page)).decoy, 0);
    });
    await test('An initially disabled Send still identifies the legacy composer and enables after input', async () => {
      const page = await fixture({ legacy: true, disabledSend: true });
      await page.locator('#qa-editor').evaluate(element => element.addEventListener('input', () => { document.getElementById('qa-send').disabled = false; }));
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert.equal(await (await adapter.prepareSend(page, lead, MESSAGE)).click(), true);
      assert.equal((await actions(page)).send, 1);
    });
    await test('A composer that mounts after the former 1.8 second deadline is awaited without a fixed delay', async () => {
      const page = await fixture();
      await page.locator('#qa-open-dm').evaluate(element => element.addEventListener('click', () => {
        const panel = document.getElementById('qa-conversation'); panel.hidden = true;
        setTimeout(() => { panel.hidden = false; }, 2200);
      }));
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      const started = Date.now();
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert(Date.now() - started >= 1800);
      assert.equal(await (await adapter.prepareSend(page, lead, MESSAGE)).click(), true);
    });
    await test('Stopping during editor readiness prevents filling and sending', async () => {
      const page = await fixture();
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      await page.locator('#qa-editor').evaluate(element => element.hidden = true);
      let checks = 0;
      await assert.rejects(adapter.fillDirectMessage(page, lead, MESSAGE, { checkStopped() { if (++checks >= 4) throw new Error('qa readiness stopped'); } }), /qa readiness stopped/);
      assert.equal(await page.locator('#qa-editor').inputValue(), '');
      assert.equal((await actions(page)).send, 0);
    });
    await test('Follow-back label is an actionable unfollowed relationship on the target profile', async () => {
      const page = await fixture({ followText: '回关' });
      const prepared = await adapter.prepareFollow(page, lead);
      assert.equal(prepared.state, 'ready'); assert.equal(await prepared.click(), true);
      const result = await actions(page);
      assert.equal(result.follow, 1); assert.equal(result.trustedFollow, true); assert.equal(result.decoy, 0);
    });
    await test('Two profile follow controls are ambiguous and perform no action', async () => {
      const page = await fixture({ duplicateFollow: true });
      assert.equal((await adapter.prepareFollow(page, lead)).state, 'missing');
      assert.deepEqual([ (await actions(page)).follow, (await actions(page)).decoy ], [0, 0]);
    });
    await test('Missing follow / DM controls never fall back to header or recommendation', async () => {
      const page = await fixture({ noFollow: true, noDm: true });
      assert.equal((await adapter.prepareFollow(page, lead)).state, 'missing');
      assert.equal(await adapter.openDirectMessage(page, lead), false);
      assert.equal((await actions(page)).decoy, 0);
    });
    await test('Another user card without semantic classes cannot supply profile controls', async () => {
      const page = await fixture({ noFollow: true, noDm: true, legacy: true });
      await page.evaluate(() => { const aside = document.querySelector('aside'); const section = document.createElement('section'); section.innerHTML = aside.innerHTML; aside.replaceWith(section); });
      assert.equal((await adapter.prepareFollow(page, lead)).state, 'missing');
      assert.equal(await adapter.openDirectMessage(page, lead), false);
      assert.equal((await actions(page)).decoy, 0);
    });
    await test('Two conversation editors are ambiguous and neither receives a message', async () => {
      const page = await fixture();
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      await page.evaluate(() => { const extra = document.createElement('textarea'); extra.id = 'qa-second-editor'; document.getElementById('qa-conversation').append(extra); });
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(adapter.getDiagnostic(page).code, 'DM_EDITOR_AMBIGUOUS');
      assert.equal(adapter.getDiagnostic(page).conversationEditorCount, 2);
      assert.doesNotMatch(JSON.stringify(adapter.getDiagnostic(page)), /qa_outreach_target|隔离|不会向/);
      assert.equal(await page.locator('#qa-editor').inputValue(), '');
      assert.equal((await actions(page)).send, 0);
    });
    await test('An explicit foreign conversation recipient is rejected', async () => {
      const page = await fixture({ recipient: 'qa_foreign' });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(await page.locator('#qa-editor').inputValue(), '');
      assert.equal((await actions(page)).send, 0);
    });
    await test('A known numeric UID is accepted separately from sec_uid', async () => {
      const page = await fixture();
      await page.locator('#qa-conversation').evaluate(element => { element.removeAttribute('data-recipient-sec-uid'); element.setAttribute('data-recipient-uid', '700000001'); });
      const numericLead = { ...lead, UID: '700000001' };
      assert.equal(await adapter.openDirectMessage(page, numericLead), true);
      assert.equal(await adapter.fillDirectMessage(page, numericLead, MESSAGE), true);
      assert.equal((await adapter.prepareSend(page, numericLead, MESSAGE)).state, 'ready');
      assert.equal((await actions(page)).send, 0);
    });
    await test('An unknown numeric recipient is never guessed from sec_uid', async () => {
      const page = await fixture();
      await page.locator('#qa-conversation').evaluate(element => { element.removeAttribute('data-recipient-sec-uid'); element.setAttribute('data-recipient-uid', '700000001'); });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(await page.locator('#qa-editor').inputValue(), '');
    });
    await test('A previous visible conversation without target evidence is not overwritten', async () => {
      const page = await fixture();
      await page.locator('#qa-conversation').evaluate(element => { element.hidden = false; element.removeAttribute('data-recipient-sec-uid'); });
      await page.locator('#qa-editor').fill('之前会话尚未发送的文字');
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), false);
      assert.equal(await page.locator('#qa-editor').inputValue(), '之前会话尚未发送的文字');
      assert.equal((await adapter.prepareSend(page, lead, MESSAGE)).state, 'missing');
      assert.equal((await actions(page)).send, 0);
    });
    await test('A reused visible conversation with explicit target evidence is allowed', async () => {
      const page = await fixture();
      await page.locator('#qa-conversation').evaluate(element => { element.hidden = false; });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert.equal(await (await adapter.prepareSend(page, lead, MESSAGE)).click(), true);
      assert.equal((await actions(page)).send, 1);
    });
    await test('A delayed switch from an old editor waits for explicit target evidence', async () => {
      const page = await fixture();
      await page.locator('#qa-conversation').evaluate(element => { element.hidden = false; element.removeAttribute('data-recipient-sec-uid'); });
      await page.locator('#qa-open-dm').evaluate(element => element.addEventListener('click', () => setTimeout(() => document.getElementById('qa-conversation').setAttribute('data-recipient-sec-uid', 'qa_outreach_target'), 300)));
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert.equal(await (await adapter.prepareSend(page, lead, MESSAGE)).click(), true);
      assert.equal((await actions(page)).send, 1);
    });
    await test('Recipient evidence lost after reusing a conversation prevents sending', async () => {
      const page = await fixture(); await page.locator('#qa-conversation').evaluate(element => { element.hidden = false; });
      await adapter.openDirectMessage(page, lead); await adapter.fillDirectMessage(page, lead, MESSAGE);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready');
      await page.locator('#qa-conversation').evaluate(element => element.removeAttribute('data-recipient-sec-uid'));
      await assert.rejects(send.click(), error => error.actionNotStarted === true && /会话、消息或发送控件已改变/.test(error.message));
      assert.equal((await actions(page)).send, 0);
    });
    await test('Duplicate send controls are rejected after filling; nothing is sent', async () => {
      const page = await fixture({ duplicateSend: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert.equal((await adapter.prepareSend(page, lead, MESSAGE)).state, 'missing');
      assert.equal((await actions(page)).send, 0);
    });
    await test('Disabled send control is never clicked', async () => {
      const page = await fixture({ disabledSend: true });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      assert.equal((await adapter.prepareSend(page, lead, MESSAGE)).state, 'missing');
      assert.equal((await actions(page)).send, 0);
    });
    await test('Wrong target URL is rejected before preparing / opening / filling / sending', async () => {
      const page = await fixture();
      await page.evaluate(() => history.replaceState({}, '', '/user/qa_foreign'));
      await assert.rejects(adapter.prepareFollow(page, lead), /离开当前目标/);
      await assert.rejects(adapter.openDirectMessage(page, lead), /离开当前目标/);
      await assert.rejects(adapter.fillDirectMessage(page, lead, MESSAGE), /离开当前目标/);
      await assert.rejects(adapter.prepareSend(page, lead, MESSAGE), /离开当前目标/);
      assert.deepEqual([ (await actions(page)).follow, (await actions(page)).open, (await actions(page)).send ], [0, 0, 0]);
    });
    await test('Navigation after follow preparation is rejected before clicking', async () => {
      const page = await fixture(); const follow = await adapter.prepareFollow(page, lead);
      await page.evaluate(() => history.replaceState({}, '', '/user/qa_foreign'));
      await assert.rejects(follow.click(), error => error.actionNotStarted === true && error.code === 'TARGET_MISMATCH'); assert.equal((await actions(page)).follow, 0);
    });
    await test('A unique replacement follow element on the same profile is rebound for one native click', async () => {
      const page = await fixture(); const follow = await adapter.prepareFollow(page, lead);
      await page.locator('#qa-follow').evaluate(element => {
        const replacement = element.cloneNode(true);
        replacement.addEventListener('click', event => { window.qaActions.follow++; window.qaActions.trustedFollow = event.isTrusted; replacement.textContent = '已关注'; });
        element.replaceWith(replacement);
      });
      assert.equal(await follow.click(), true);
      assert.equal((await actions(page)).follow, 1); assert.equal((await actions(page)).trustedFollow, true); assert.equal((await actions(page)).decoy, 0);
      await assert.rejects(follow.click(), error => error.actionNotStarted === true && error.code === 'FOLLOW_PREPARATION_CONSUMED');
      assert.equal((await actions(page)).follow, 1);
    });
    await test('A prepared follow is consumed even when the pre-click state is already followed', async () => {
      const page = await fixture(); const follow = await adapter.prepareFollow(page, lead);
      await page.locator('#qa-follow').evaluate(element => { element.textContent = '已关注'; });
      await assert.rejects(follow.click(), error => error.actionNotStarted === true && error.code === 'FOLLOW_ALREADY');
      await page.locator('#qa-follow').evaluate(element => { element.textContent = '+ 关注'; });
      await assert.rejects(follow.click(), error => error.actionNotStarted === true && error.code === 'FOLLOW_PREPARATION_CONSUMED');
      assert.equal((await actions(page)).follow, 0);
    });
    await test('A replacement editor or changed text invalidates a prepared send', async () => {
      const page = await fixture(); await adapter.openDirectMessage(page, lead); await adapter.fillDirectMessage(page, lead, MESSAGE);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready');
      await page.locator('#qa-editor').evaluate(element => element.replaceWith(element.cloneNode(true)));
      await assert.rejects(send.click(), /会话、消息或发送控件已改变/); assert.equal((await actions(page)).send, 0);
    });
    await test('Changed recipient invalidates a prepared send', async () => {
      const page = await fixture(); await adapter.openDirectMessage(page, lead); await adapter.fillDirectMessage(page, lead, MESSAGE);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready');
      await page.locator('#qa-conversation').evaluate(element => element.setAttribute('data-recipient-sec-uid', 'qa_foreign'));
      await assert.rejects(send.click(), /会话、消息或发送控件已改变/); assert.equal((await actions(page)).send, 0);
    });
    await test('Changed textarea message invalidates a prepared send', async () => {
      const page = await fixture(); await adapter.openDirectMessage(page, lead); await adapter.fillDirectMessage(page, lead, MESSAGE);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready');
      await page.locator('#qa-editor').fill('另一条内容');
      await assert.rejects(send.click(), /会话、消息或发送控件已改变/); assert.equal((await actions(page)).send, 0);
    });
    await test('Closed browser rejects a prepared action', async () => {
      const page = await fixture(); const follow = await adapter.prepareFollow(page, lead); await page.close();
      await assert.rejects(follow.click(), error => error.actionNotStarted === true && error.code === 'PAGE_CLOSED');
    });
    assert.equal(hash(path.join(APP, 'lib', 'outreach-browser.js')), verificationSources.adapterSha256, 'The adapter changed while the verification process was running; rerun the final source');
    assert.equal(hash(__filename), verificationSources.verifierSha256, 'The verifier changed while the verification process was running; rerun the final source');
    assert(completed.length, 'No verification case matched the selected filter');
    const report = { ok: true, source, ...(match ? { match } : {}), ...(exclude ? { exclude } : {}), app: path.basename(APP), browserRevision: String(revision), cases: completed.length,
      checks: completed, manufacturedDocuments, abortedRequests, proxyConnections,
      realPlatformRequests: 0, installedClientDataUsed: false,
      ...verificationSources };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write('Outreach browser verification passed: ' + completed.length + ' cases.\n');
  } catch (error) {
    process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (blocker) await new Promise(resolve => blocker.close(resolve));
    try { fs.rmSync(QA_TMP, { recursive: true, force: true }); } catch (e) { /* 清理尽力而为 */ }
  }
})();
