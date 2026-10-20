'use strict';

// Generate a public guide from source contracts only. Never import store.js:
// its module initialization opens the configured customer data directory.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'dy-lead-app');
const { publicLeadFields } = require(path.join(sourceRoot, 'lib', 'lead-fields'));
const AI = require(path.join(sourceRoot, 'ai.js'));
const { CONTACT_POLICY, CONTACT_POLICY_VERSION, CONTEXT_TEMPLATE } = require(path.join(sourceRoot, 'lib', 'ai-policy.js'));
const { DEFAULT_KEYWORDS } = require(path.join(sourceRoot, 'lib', 'keyword-screen.js'));
const desktopPackage = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
const expectedVersion = process.argv[2] || desktopPackage.version;
if (desktopPackage.version !== expectedVersion) {
  throw new Error('Desktop version is ' + desktopPackage.version + '; update the release version to ' + expectedVersion + ' before generating its guide.');
}
const version = desktopPackage.version;
const schema = publicLeadFields();
const compactColumns = schema.compactColumns;
if (!Array.isArray(compactColumns) || compactColumns.length !== 7) throw new Error('The public field contract must describe the seven compact table columns.');
const storeSource = fs.readFileSync(path.join(sourceRoot, 'store.js'), 'utf8');
const definition = storeSource.match(/const DEFAULT_SETTINGS = ([\s\S]*?);\r?\n\r?\nfunction getAccounts/);
if (!definition) throw new Error('Cannot locate the pure DEFAULT_SETTINGS source object.');
const promptDefinition = storeSource.match(/const DEFAULT_INDUSTRY_PROMPT = ([\s\S]*?);\r?\nconst DEFAULT_SETTINGS/);
const pureDefaultContext = { CONTACT_POLICY, CONTEXT_TEMPLATE, DEFAULT_KEYWORDS };
const defaultContext = promptDefinition ? { ...pureDefaultContext, DEFAULT_INDUSTRY_PROMPT: vm.runInNewContext('(' + promptDefinition[1] + ')', pureDefaultContext, { timeout: 1000 }) } : pureDefaultContext;
const defaults = JSON.parse(JSON.stringify(vm.runInNewContext('(' + definition[1] + ')', defaultContext, { timeout: 1000 })));
const sampleRequest = AI.buildJudgeRequest(defaults, [
  { id:1,demand:'这种亚马逊账户问题怎么处理？',UID:'样例UID1',nickname:'匿名用户1',time:'2026-10-08',videoLink:'https://www.douyin.com/note/123' },
  { id:2,demand:'问题已经解决，不需要服务。',UID:'样例UID2',nickname:'匿名用户2',time:'2026-10-08',videoLink:'https://www.douyin.com/note/123' }
], {123:{desc:'亚马逊账户申诉业务说明'}});
const samplePayload = sampleRequest.payload;
const aiSource = fs.readFileSync(path.join(sourceRoot, 'ai.js'), 'utf8');
const contextLimitMatch = aiSource.match(/const WORK_CONTEXT_LIMIT = (\d+);/);
if (!contextLimitMatch) throw new Error('Cannot locate the AI work context limit.');
const contextLimit = Number(contextLimitMatch[1]);
const taskSource = fs.readFileSync(path.join(sourceRoot, 'engine-ai-tasks.js'), 'utf8');
const retryLimitMatch = taskSource.match(/const MAX_PROVIDER_RETRIES = (\d+);/);
if (!retryLimitMatch) throw new Error('Cannot locate the bounded AI provider retry limit.');
const providerRetryLimit = Number(retryLimitMatch[1]);
const saveChunkMatch = taskSource.match(/const SAVE_CHUNK = (\d+);/);
const backoffMatch = taskSource.match(/const delayMs=Math\.min\((\d+),/);
if (!saveChunkMatch || !backoffMatch) throw new Error('Cannot locate the AI write chunk and retry backoff limits.');
const saveChunk = Number(saveChunkMatch[1]);
const maxBackoffMs = Number(backoffMatch[1]);
const auditEvents = [...new Set([...taskSource.matchAll(/audit\('([^']+)'/g)].map(match => match[1]))];
const sampleCapacity = AI.modelCapacity(defaults);
const sampleBudget = AI.estimateRequestBudget(sampleRequest.messages, samplePayload.items.length, sampleCapacity, AI.AUTOMATIC_BATCH_STRATEGIES[0].targetRatio);
const fieldSource = fs.readFileSync(path.join(sourceRoot, 'lib', 'lead-fields.js'), 'utf8');
const excelLimitMatch = fieldSource.match(/cell\.length <= (\d+) && \(cell\.match\([^;]*?\.length <= (\d+)/);
const segmentMatch = fieldSource.match(/function splitText\(text, maxChars = (\d+), maxLineFeeds = (\d+)\)/);
if (!excelLimitMatch || !segmentMatch) throw new Error('Cannot locate the Excel long-text limits.');
const excelLimits = {
  maxCellChars: Number(excelLimitMatch[1]), maxCellLineFeeds: Number(excelLimitMatch[2]),
  segmentChars: Number(segmentMatch[1]), segmentLineFeeds: Number(segmentMatch[2])
};
const engineSource = fs.readFileSync(path.join(sourceRoot, 'engine.js'), 'utf8');
const endpoints = {
  work: [{ path: '/aweme/v1/web/aweme/detail/', description: '浏览器作品详情响应；备用是当前 /video/{作品ID} 或 /note/{作品ID} 页内 JSON / 流式 JSON / 明确作品文字。' }],
  comment: [{ path: '/aweme/v1/web/comment/list/', description: '目标作品的一级评论响应；以作品 ID、cursor、评论 ID 和 has_more 核验分页进度。' }],
  user: [
    { path: '/aweme/v1/web/comment/list/', description: 'comments[].user 中已经返回的用户公开资料，无需再访问其主页。' },
    { path: '/aweme/v1/web/user/profile/other/', description: '人工查看或触达时同一次主页访问已经返回的 user，按 sec_uid 匹配回填。' }
  ],
  basic: [
    { path: '本机任务与配置', description: '编号、执行账号、业务编号、筛选、触达结果、判断版本与处理时间。' },
    { path: '/chat/completions', origin: defaults.ai.baseUrl, description: 'DeepSeek 返回 i、need、reason；按编号核验后 need→aiNeed，reason→aiReason。旧 score 保留历史，新判不生成评分。' },
    { path: '/models', origin: defaults.ai.baseUrl, description: '实时读取可用模型、context_window（输入＋输出）及 max_output_tokens，自动组批计入完整规则与结果预留。' }
  ]
};
for (const group of ['work', 'comment', 'user']) {
  for (const endpoint of endpoints[group]) if (!engineSource.includes(endpoint.path)) throw new Error('Endpoint is no longer present in engine.js: ' + endpoint.path);
}
const selectedDefaults = {
  collect: {
    dailyVideoLimit: defaults.collect.dailyVideoLimit, maxScrolls: defaults.collect.maxScrolls,
    scrollIntervalSec: defaults.collect.scrollIntervalSec, scrollJitter: defaults.collect.scrollJitter,
    linkIntervalSec: defaults.collect.linkIntervalSec, linkIntervalJitter: defaults.collect.linkIntervalJitter,
    cooldownHours: defaults.collect.cooldownHours, skipEmptyText: defaults.collect.skipEmptyText,
    autoAiAfterCollect: defaults.collect.autoAiAfterCollect
  },
  follow: { enabled: defaults.follow.enabled, dailyLimit: defaults.follow.dailyLimit },
  dm: { enabled: defaults.dm.enabled, dailyLimit: defaults.dm.dailyLimit, skipAuthor: defaults.dm.skipAuthor, repeatEnabled: defaults.dm.repeat.enabled, repeatIntervalDays: defaults.dm.repeat.intervalDays },
  action: { userIntervalSec: defaults.action.userIntervalSec, userIntervalJitter: defaults.action.userIntervalJitter, pacingVersion: defaults.action.pacingVersion },
  human: { maxConsecutiveErrors: defaults.human.maxConsecutiveErrors, timeZone: defaults.human.timeZone },
  ai: { model: defaults.ai.model, apiKeyConfigured: false, requestTimeoutSec: defaults.ai.requestTimeoutSec, batchMode:defaults.ai.batchMode, batchMaxChars: defaults.ai.batchMaxChars, batchMaxCount: defaults.ai.batchMaxCount, activePromptId: defaults.ai.activePromptId, presetCount: defaults.ai.promptPresets.length, browserIntervalApplies: false },
  keywords: { intent: defaults.keywords.intent, exclude: defaults.keywords.exclude },
  business: { businessDesc: defaults.ai.businessDesc, targetCustomers: defaults.ai.targetCustomers, clearNeeds: defaults.ai.clearNeeds, misjudgments: defaults.ai.misjudgments }
};
const outputDir = path.join(root, '使用文档');
fs.mkdirSync(outputDir, { recursive: true });
const baseName = '华贸获客-字段与采集流程说明-' + version;
const sourceFiles = ['dy-lead-app/lib/lead-fields.js', 'dy-lead-app/lib/work-metadata.js', 'dy-lead-app/lib/user-metadata.js', 'dy-lead-app/lib/account-login.js', 'dy-lead-app/lib/account-login-scan.js', 'dy-lead-app/lib/startup-login-scan.js', 'dy-lead-app/lib/browser-runtime.js', 'dy-lead-app/lib/outreach-browser.js', 'dy-lead-app/lib/action-receipts.js', 'dy-lead-app/lib/ai-policy.js', 'dy-lead-app/lib/keyword-screen.js', 'dy-lead-app/engine-actions.js', 'dy-lead-app/scheduler.js', 'dy-lead-app/engine.js', 'dy-lead-app/ai.js', 'dy-lead-app/engine-ai-tasks.js', 'dy-lead-app/workflow.js', 'dy-lead-app/server.js', 'dy-lead-app/store.js', 'dy-lead-app/web/app.js', 'dy-lead-app/web/index.html', 'desktop/package.json'];
sourceFiles.push('dy-lead-app/engine-collection-tasks.js');
sourceFiles.push('dy-lead-app/lib/dm-protocol.js', 'dy-lead-app/lib/dm-receipt-observer.js', 'dy-lead-app/lib/dm-rejection.js');
sourceFiles.push('dy-lead-app/lead-query.js', 'dy-lead-app/lib/comment-evidence.js');
sourceFiles.push('dy-lead-app/lib/dm-history-observer.js', 'dy-lead-app/lib/profile-relation-observer.js');
sourceFiles.push('desktop/main.js', 'desktop/preload.js', 'desktop/account-browser-host.js', 'dy-lead-app/lib/embedded-browser-client.js', 'dy-lead-app/web/style.css', 'dy-lead-app/package.json', 'desktop/使用说明.txt', 'build-tools/build.js', 'build-tools/build.ps1', 'build-tools/setup.iss');
sourceFiles.push('dy-lead-app/lib/browser-control-lease.js', 'desktop/smoke-checks.js');
sourceFiles.push('dy-lead-app/lib/collection-browser.js', 'build-tools/verify-embedded-browser.js', 'build-tools/verify-embedded-outreach.js');
const provenance = sourceFiles.map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
const generatedAt = new Date().toISOString();
const installedStatusAtReview = version === '2.2.6'
  ? { snapshotOfRelease: '2.2.6', reviewedOn: '2026-10-08', version: '2.2.3', updated: false, reason: '2.2.6 审核快照：客户仍在采集；当时仅生成升级包，尚未替换正在运行的客户端。' }
  : { snapshotOfRelease: version, reviewedOn: null, version: null, updated: null, reason: '生成器不核验客户安装版本，也不执行安装；请以当前客户端和实际升级验证记录为准。' };
const reviewNotice = version === '2.2.6'
  ? '2026-10-08 的 2.2.6 审核快照：当时安装版本仍为 2.2.3，旧图文记录确实缺少文字；当时仅生成 2.2.6 升级包，尚未安装。已有作品记录的文字可关联补齐显示；原来完全没有取得的文字，需要升级后继续采集或强制重采，无法凭空恢复。此快照不表示用户之后未升级。'
  : '文档生成不会检查已安装客户端版本，也不会执行安装。已有作品记录的文字可关联补齐显示；原来完全没有取得的文字，需要新版本继续采集或强制重采。请以当前客户端版本和实际升级记录为准。';
const dictionary = {
  title: '华贸获客字段字典与采集来源', applicationVersion: version, generatedAt,
  schemaVersion: schema.version, dataFormat: '本机 JSON 记录；compactColumns 定义紧凑主表，原字段 registry 保留读取投影、详情与 Excel 全字段',
  publicLeadFields: schema, sourceEndpoints: endpoints, defaults: selectedDefaults,
  embeddedBrowser: {
    runtime: 'Electron WebContentsView', desktopDefault: false, modeSetting: 'accounts[].browserMode', defaultMode: 'external', availableModes: ['external', 'embedded'], observer: 'Playwright 继续观察当前账号页面自身请求与响应，动作仍使用目标页原生控件',
    switching: '账号管理下拉选择模式；PUT /api/accounts/:id 的 browserMode 仅接受 external/embedded。运行任务或手动网页导航时拒绝切换；关闭原账号上下文成功后保存选择并将登录状态置为待确认，失败保留原模式。同一任务槽保护切换，停止入口保持可用。两种模式分别保存资料，均不删除或转换。',
    entry: '账号管理 POST /api/accounts/:id/open 打开登录；账号浏览器标签只切换已经打开的账号，不绕过后端启动和授权流程',
    navigation: '账号标签、只读网址、后退、前进、刷新和返回工作台；普通状态刷新不抢走当前工作页，明确打开请求才切至账号浏览器',
    visibility: '页面切换、弹窗和登录遮罩时隐藏视图，隐藏不等于退出账号或停止任务；视图边界不覆盖全局停止按钮',
    storage: { current: 'data/electron-profiles', legacy: 'data/chrome-profiles', perAccount: true, oldProfilesPreserved: true, autoMigrateChromeLogin: false },
    migration: '保留API Key、设置、账号列表、线索、联系记录及原数据目录；旧chrome-profiles不删除不转换；独立内核下每个账号首次需要重新扫码，不必删除或重建账号',
    bridge: '桌面主进程承载账号WebContentsView；后台经进程IPC和带随机会话凭据的本机回环WebSocket适配Playwright，不开放无鉴权的remote-debugging-port；网页没有Node或桌面管理IPC权限',
    protocolSessions: '生产host支持Playwright newCDPSession(page)所需的独立页面CDP会话，仍只允许当前账号的target及所属会话；独立会话按父会话和代次绑定，分离时不影响主页面会话，也不能附着到另一账号',
    navigationInterception: 'collection-browser通过独立会话的Fetch.requestPaused在主框架Document请求和响应阶段逐跳核对允许的HTTPS域名、GET导航、授权及停止；限制跳数，校验Location后在同页继续。停止或异常先终止挂起请求再释放会话，不以兼容CDP为由扩大导航权限',
    renderingLease: {
      reason: '隔离复现中隐藏账号页的输入框聚焦后可降至约1fps，即使backgroundThrottling关闭也可能拖慢真实控件就绪',
      methods: ['Runtime.callFunctionOn', 'DOM.scrollIntoViewIfNeeded', 'Input.*'],
      mechanism: '上述CDP命令存续期间，按当前账号引用计数持有beginFrameSubscription(true, 空回调)；重叠命令共用订阅，正常完成或异常在finally释放，账号关闭也释放，最后一个持有者退出时endFrameSubscription',
      images: '空回调丢弃帧图像，不保存、不记录、不向后台或远端转发图像；仅当前账号WebContents，不采集整个桌面',
      idle: '命令之间没有常驻帧订阅或采样；保留原页面requestAnimationFrame与输入事件，不改任务等待间隔，不额外重试click',
      validationBoundary: '隔离验证覆盖隐藏视图、聚焦后空闲再点击、并发命令及异常/关闭释放；隐藏测试不等同于已完成所有系统的最小化完整流程验证，也不证明真实平台全部布局或发送均通过'
    },
    manualNavigation: '后退、前进、刷新先同步占用短期控制租约，再异步检查授权和任务空闲；任务启动与手动导航互斥。授权返回后再次核对账号及会话代次，完成或失败释放本次租约，超时释放；不会将过期许可用于新账号页面',
    shutdown: '正常关闭主窗口先中止后台任务，等待账号session的storage与cookies flush完成，再销毁账号视图和主窗口；后台退出有超时兜底，关闭中不会先销毁待保存页面',
    compatibility: '桌面默认外部专用浏览器，缺少browserMode的旧账号也按external处理；优先系统Chrome，其次Edge，再使用随安装包的Chromium。外部模式复用data/chrome-profiles，内嵌模式使用data/electron-profiles，双方不混用。选择embedded但桥接不可用会明确报错，不悄悄换模式',
    dependencies: { ws: '8.22.0' },
    validation: '内嵌host、生产响应client、隔离页面和桌面集成smoke验证；不以隔离验证宣称真实平台发送成功，也不表示所有实网布局已验证'
  },
  leadList: {
    compact: { columns: compactColumns, fontPx: 15, summaryLines: 2, commentThenWork: true, timeDisplay: '日期和时间分两行', homepage: '隐藏原 URL，使用复制按钮', details: '保留完整评论、作品全文、原始字段、单条 AI 与联系核验等操作；主表不放查看作品按钮' },
    aiFilters: { all: '全部', ai_todo: '未判断', ai_yes: 'AI 是（当前有效）', ai_no: 'AI 否（当前有效）', ai_stale: '待重判（历史或失效结果）', ai_excluded: '不参与判断（作者或空评论）' },
    contactFilters: { all: '全部状态', new: '暂无联系记录', followed: '有关注记录', sent: '已有私信记录', pending: '待核验', failed: '操作失败', blocked: '不再联系', replied: '已回复' },
    classification: 'AI 与联系状态分别筛选；作者（含匹配作品作者身份的缓存记录）与空评论优先归不参与判断，不计入待判断或待重判，保留全部记录与历史AI结果，不伪造AI否；列表显示具体原因并禁用不参与项的单条判断，在不参与判断筛选下禁用批量判断。有效性复用 aiDone、是/否、短理由、aiPromptVersion 与 aiInputHash。待核验不算已发送；当前有效 AI 是仍须通过任务预检查',
    counts: 'AI 分类计数保留搜索、评论时间、联系状态等其它条件，只忽略当前 AI 分类；完整筛选总数不受页面显示条数限制',
    commentTime: { choices: [0, 1, 3, 7], hours: [0, 24, 72, 168], source: 'commentTimestamp 保存 comments[].create_time 的原始 Unix 秒；筛选换算为毫秒', legacy: '缺少原始秒时兼容历史 time；无时区的历史日期按 +08:00 解析；非法、未知或未来时间不进入近期范围', freeze: '预检查开始筛选时冻结截止时间，沿用固定名单，不因等待或翻页改变本次范围', identity: '按当前线索主评论的 ID 与对应时间筛选，不把同一用户其它评论的时间拼到主评论上' },
    selection: '切换筛选保留已勾选编号；已勾选范围可能包含当前页面未显示的线索',
    export: { scopes: { filters: '当前完整筛选结果', selected: '已勾选编号，忽略当前筛选；空选择拒绝导出', all: '全部线索和全部作品（含无评论作品）' }, format: '保留原全字段、历史评分与完整长文本，不随紧凑主表删列', works: '当前筛选和已勾选只附带本次导出线索关联的作品；全部及旧 GET 包含全部作品，包括无评论作品', endpoint: 'POST /api/export，JSON {filters,leadIds?,scope?}；旧 GET /api/export 保留全量线索兼容' }
  },
  longText: { rawStorage: 'workRawText', normalizedTitle: 'workTitle', normalizedContent: 'workContent', fullDisplayText: 'workText / fieldValues.videoDesc', aiMaxContextChars: contextLimit, aiStrategy: '实际标题＋正文开头及末尾；省略中间时附明确标记和原文摘要校验', excel: excelLimits },
  servers: {
    authorization: 'https://huamao.xyz/dy-license/', administration: 'https://huamao.xyz/dy-license/manage/',
    ai: defaults.ai.baseUrl, localService: 'http://127.0.0.1:<动态端口>',
    defaultInstallDir: 'D:\\华贸自媒体获客', defaultDataDir: 'D:\\华贸自媒体获客\\data'
  },
  installedStatusAtReview,
  workflow: {
    stages: ['账号就绪', '采集评论', 'AI 与名单', '关注与私信', '结果核验'],
    pacing: {
      commentScroll: { baseSec: defaults.collect.scrollIntervalSec, jitter: defaults.collect.scrollJitter, startsAfter: '首屏评论就绪，以及每次真实翻页完成' },
      nextWork: { baseSec: defaults.collect.linkIntervalSec, jitter: defaults.collect.linkIntervalJitter, startsAfter: '当前实际访问作品结束' },
      nextUser: { baseSec: defaults.action.userIntervalSec, jitter: defaults.action.userIntervalJitter, startsAfter: '当前实际访问用户处理结束' },
      sameProfileDelay: 0, independentDeadlines: true, responseWaitOverlapsPacing: true,
      controls: '设置页面集中管理三组节奏；页面、控件与目标响应仍做有限时就绪检查'
    },
    autoAi: { enabledByDefault: defaults.collect.autoAiAfterCollect, owner: '服务端采集任务串接，页面轮询不启动任务',
      scope: '本次实际评论响应涉及的线索，包括旧记录回填；排除作品作者与空主评论，不按关键词提前筛除；当前有效结果跳过',
      stopOrCollectionError: '保留已采集数据，不自动启动AI', missingAiConfig: '采集数据仍保存，提示完成设置后手动判断本次范围',
      result: '显示采集汇总、AI状态与是/否/失败数量，进入本次评论用户筛选' },
    outreach: { precheck: '计划schema 3冻结执行账号、去重用户名单、逐人动作、话术模板和消息预览，以及重复私信开关和至少1天的间隔；旧计划或重复规则改变须重建',
      contactPolicy: { repeat: { enabled: defaults.dm.repeat.enabled, intervalDays: defaults.dm.repeat.intervalDays }, historyUnknown: 'allow_initial' },
      sequence: ['用户主页', '核对当前关系并按需关注', '打开目标私信', '需要时从列表进入目标对话', '检查可读私信历史', '填写冻结消息', '点击发送', '记录结果'],
      stageGroups: { selecting_conversation: 'opening_dm', checking_dm_history: 'opening_dm' },
      followRelation: '本次主页响应已关注则跳过关注，不计本次成功或尝试；旧followedAt不阻止重新核对现场关系。关注记录和待核验只约束实际执行账号，不用另一账号的已关注替代当前关系',
      dmHistory: '确认目标对话后，被动核对网页自然产生的历史请求与响应、本人发送者和目标会话；可读且确认的历史出站文字包含手动发送。明确已有私信与当前业务同UID的本地跨账号历史共同防重，不重放接口或主动翻历史页。初次最多1.5秒等待结束后继续监听，在准备及发送前复核迟到响应；整体监听最多30秒，在本次发送前冻结，不新增固定间隔。另在已核验目标聊天中识别本人旧消息及空状态栏，排除失败、发送中和未知状态；聊天就绪与最终发送前复核DOM，只保存正向历史，未加载内容仍可能未知',
      repeatPolicy: '已有私信按预检查冻结的repeat.enabled和intervalDays判断；关闭则跳过，开启仍须有可靠最近发送时间且满足至少1天的间隔。最近时间未知禁止自动重复；本地待核验始终禁止重发',
      unknownHistory: '按用户确认策略：网页历史无法确认且本地无已发或待核验记录时静默按首发执行，不弹提示、不保存unknown观察；未知不等于证明从未发送，也不能覆盖明确历史',
      observationStorage: 'followObserved和dmHistoryObserved保存当前账号观察摘要；dmHistorySentObserved保留明确已发证据，后续空历史不能清除。网页历史不增加dmCount，不记本次confirmed_success；本次跳过与历史记录分开显示',
      entryFlow: {
        locate: '在当前目标主页核对关注与私信控件所属区域，使用绑定元素执行真实点击；重绘、歧义或不可用分别诊断',
        profileIdentityFix: '修复私信按钮位于user-info内部时入口识别成功、但身份捕获只认兄弟按钮组的遗漏；身份捕获统一覆盖内部按钮及已验证的配对兄弟组，范围仍限定当前目标主页',
        nameReadiness: '在主页入口点击前取得完整昵称；不读取或等待头像，不要求聊天UID；聊天标题和输入框就绪立即继续，不增加固定间隔',
        evidenceBoundary: '收件人身份未知必须保持未发送；这与私信历史未知的静默首发策略不同。历史未知可沿用用户规则，但每次填写和发送仍须确认收件人身份',
        messageList: '入口点击后可能先显示消息列表；完成目标主页私信入口原生点击后，捕获昵称仍与当前主页一致时，只选择可见活动列表中完整昵称一致的唯一会话行一次；多个同名候选不选择，不选首行。进入后再次比较活动聊天头昵称；头像和UID不参与当前StackLayout会话识别',
        messageListTiming: '沿用有限时就绪检查，目标界面就绪立即继续；不新增额外固定间隔',
        recipient: '所有新建和复用输入框先核对完整昵称：完成目标主页入口原生点击后，比较主页h1与唯一可见StackLayout活动聊天标题；只比较昵称，不核对头像或聊天UID。填写前和发送前重新核对昵称、绑定元素及消息全文；昵称不一致或缺失保持未发送',
        emojiName: '主页Twemoji图片按资源码点核对alt后还原，与聊天文字表情按完整顺序比较；支持纯表情和组合表情，保留连接符及肤色修饰，不删除表情后模糊匹配。缺少alt或未知图片不能退化为剩余文字匹配；读取完整DOM昵称，不受视觉省略号影响',
        recipientEvidence: { protocol: '优先依据：会话打开后网页自身的IM历史请求（cmd301会话串含双方数字UID）与响应只指向目标数字UID的单聊会话，且窗口内没有其他或无法归属的会话请求；输入框须在唯一活动聊天层、主页未变化、可读的聊天头昵称不与主页矛盾；打开前已存在的输入框仍需昵称一致', explicit_uid: '其他旧式页面结构的既有明确ID依据；当前StackLayout流程不使用', dom_profile_name: '目标主页与当前活动聊天顶部完整昵称一致；不核对头像或聊天UID，不等同于平台UID认证' },
        authorization: '入口、目标会话行、填写、关注和发送前重新检查授权与停止；回调不重跑已写待核验动作的资格判断，不增加动作次数',
        diagnostics: ['DM_ENTRY_NOT_FOUND', 'DM_ENTRY_AMBIGUOUS', 'DM_ENTRY_CHANGED', 'DM_ENTRY_UNAVAILABLE', 'DM_MESSAGE_LIST_ONLY', 'DM_TARGET_CHAT_NOT_READY', 'DM_RECIPIENT_UNCONFIRMED'],
        notSent: '入口、会话或发送控件准备失败记本次未发送；不增加私信尝试和成功次数，不推断永久禁发，也不覆盖已确认关注',
        privacy: '界面诊断仅记录入口/会话/发送阶段、白名单错误码、控件计数、protocol/explicit_uid/dom_profile_name依据类型及协议核验状态（confirmed/conflict/none），不记录实际昵称、UID、头像地址、页面全文、私信正文、选择器或凭据',
        manualSend: '用户在浏览器自行发送的文字，能从本次可读网页历史确认时参与防重；明确已有私信按冻结重复规则跳过或继续，不把历史消息伪造成本次软件发送成功',
        validation: '隔离测试复现旧头像路径误暂停、无头像、表情、重复昵称和会话切换；不代表本次发布已完成真实账号发送或生产安装验收'
      },
      unknownReceipt: '仅已执行发送点击且缺少可靠回执才记待核验，人工核验前不自动重发',
      dmReceipt: '当前主页面原生点击后被动核对protobuf命令100、同请求序列、目标会话、冻结全文、客户端消息编号、发送者与服务端消息编号；仅同步业务成功确认平台接受，非送达或已读；总等待上限30秒，明确回执到达即返回',
      notSent: '未找到入口/输入框/发送控件或执行前检查失败：明确未发送，不扣未发生的发送尝试',
      guards: '每次对外动作检查授权与停止；回执检查码与明确重复、会话上限、互关限制分别记录，本用户限制不累计异常；已匹配响应的check_message业务码7180 JSON只读取顶层tips和status_msg.msg_content.tips中已知的平台拒绝文案，据此识别账号频繁或今日陌生人私信上限并立即暂停，不访问后续用户、不自动重试。目标聊天的MessageBoxTipsMessage平台提示也会暂停；普通消息正文与其它会话不作为限制证据。发送前平台限制不创建虚假发送失败；已点击且只有页面限制、无明确业务回执时保留待核验；其他连续异常在保存当前用户结果及进度后暂停；验证码和目标变化立即暂停',
      checkpoint: '每次外联任务开始时保存本次计划编号、冻结线索名单，并用关注成功、私信成功、失败、待核验和跳过计数初始化检查点；处理完一个用户后更新对应计数。遇到账号级限制后，已保存明确拒绝或待核验的当前用户记入已处理名单，后续用户保留待处理。新检查点不复用AI任务的是/否计数和线索名单' },
    upgrade: '保留API Key、账号列表、旧chrome-profiles、线索、联系记录和自定义业务材料；已有新版节奏不重置。内嵌electron-profiles使用独立内核，各账号首次重新扫码，不复制旧Chrome登录'
  },
  aiDecision: {
    contract:AI.RESULT_CONTRACT,policy:AI.CONTACT_POLICY,policyVersion:CONTACT_POLICY_VERSION,inputMapping:AI.FIELD_MAPPING,
    instructionBoundary:{system:'固定联系判断政策、证据来源要求、字段映射及结果协议',userFields:['businessProfile','businessRules','works','items'],user:'业务资料、自定义行业规则和评论作品均为JSON材料，不改变系统政策或返回协议'},
    evidenceRules:'先区分求助、服务咨询、回答作者与提供能力的对话方向；comment和comments是该评论者的完整证据。本人/朋友当前问题及处理、费用、联系方式、服务真实性咨询判是；具体问题作品下主动表示我也是/同样收到/跟你一样已将当前问题指向自身，无需再问怎么办。仅回答作者、提供能力案例、转介绍、纯评价或既往经验无当前问题或新咨询判否。作品作者经历不移植到评论者，评论明确业务对象优先。不能因业务相关、未拒绝或无法证明同行就判是，理由不猜同行。',
    inputCompleteness:{comment:'主评论保留完整文字，去首尾空白；不静默截断',comments:'保留已有同一用户完整评论，去同文重复；不按条数或字符数静默截断',workContext:{maxChars:contextLimit,overLimit:'标题＋正文开头＋末尾，明确省略标记及全文sourceHash；本机全文保留'}},
    promptValidation:'生成的prompt字符串仅含行业规则正文，AI.inspectPromptDraft拒绝生成器任务、嵌套prompt包装、评分/待确认及旧返回字段；不应用失败草稿，旧自定义预设保留并作为用户材料读取。',
    outputMapping:{i:'本批位置，映射到本机线索编号；不用UID或昵称回填',need:'aiNeed',reason:'aiReason',score:'新判不返回；aiScore=null，覆盖旧值前保存到aiScoreHistory'},samplePayload,
    packing:'自动和手动都计完整system、公司介绍、行业要求、共享works/items、JSON消息包装及结果输出预留，自动初始预算75%，超时或回执失败按50%、30%重新装批，最后每批最多200条且仍受75%容量预算约束；手动合计不超过上下文90%，输出另不超过模型max_output_tokens；按选定顺序装批，降档后只重规划剩余固定名单，成功结果不重复发送。手动额外限制用户消息payloadChars及条数。单项超限拒绝发送并保留未判断，不强制单条。UTF8字节保守估算并非精确token分词，实际以usage为准。',
    budget:{targetRatio:0.75,automaticStrategies:AI.AUTOMATIC_BATCH_STRATEGIES,automatic:'75% → 50% → 30% → 最多200条（仍受75%上下文与输出预算约束）',manual:'模型预算＋payloadChars字符预算＋条数上限',oversizeAction:'budget_rejected；未发请求；其它合规线索继续',sample:sampleBudget,capacity:sampleCapacity,outputReservation:AI.outputReservation(2)},
    errorHandling:{automaticRecovery:['AI_TIMEOUT','AI_TRANSPORT_RESPONSE_INVALID','AI_FORMAT_INVALID','AI_OUTPUT_LENGTH','AI_RESPONSE_INVALID','AI_OUTPUT_INCOMPLETE'],recovery:'三档各失败一次后进入200条兜底，兜底失败暂停；无法放入较低预算的完整资料转下一档，不截字段；手动格式失败仍二分',splitOnly:['AI_FORMAT_INVALID','AI_OUTPUT_LENGTH','AI_RESPONSE_INVALID','AI_OUTPUT_INCOMPLETE'],stopHttp:'非429的4xx及其它不可重试HTTP状态，包括401/402/403/404',stopCodes:['AI_OUTPUT_REFUSED','AI_PROVIDER_ERROR'],transient:['HTTP429','HTTP5xx','AI_NETWORK_ERROR','AI_TIMEOUT','AI_TRANSPORT_RESPONSE_INVALID'],providerRetries:providerRetryLimit,maxBackoffMs,backoff:'同批最多'+providerRetryLimit+'次，默认1秒/2秒；尊重Retry-After，上限'+maxBackoffMs/1000+'秒，授权和停止持续有效'},
    scheduling:{normalAiDelay:0,browserActionCounter:false,authorizeEveryRequest:true,stopAvailable:true},
    currentResult:'aiDone===true；aiNeed仅是/否；aiReason为1至30字符；aiPromptVersion和aiInputHash与当前规则及全文输入一致',
    resultFilter:'六类为全部、未判断、AI是、AI否、待重判、不参与判断；作者及空评论优先归不参与判断，不混入待判断/待重判。AI是/否仅含当前有效结果，历史或缺少有效性证据归待重判。联系状态独立筛选，旧f=ai仅为历史接口兼容，预检查仍只接受当前有效是',
    concurrency:{writeChunk:saveChunk,behavior:'固定名单、规则/接口设置、作品与线索输入及旧结果快照；设置改变暂停，删除或输入/已有结果变化拒绝旧回写；分块安全合并写入，保留独立跟进修改'},
    progress:'线索库可见提交、规划、批次、是/否/失败/跳过、实际模型请求数；提交busy防重复；停止同时中止批量/单条、生成草稿和匿名样例测试；部分预算拒绝以completed_with_errors结束，未判不会自动变否',
    audit:{events:auditEvents,preparedEvent:'request（stage:prepared）表示组包准备',sentEvent:'request_sent表示实际HTTP请求前统计',privacy:'不记录API Key、完整输入或模型原始长回复'},
    migration:'仅已知旧内置预设名称/全文和四项默认业务资料精确成对匹配才迁移；三份用户自定义预设、启用选择、API Key、模型与用户设置保留',
    officialSources:['https://api-docs.deepseek.com/api/list-models/','https://api-docs.deepseek.com/api/create-chat-completion/','https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/'],reviewedOn:'2026-10-08'
  },
  sourceFiles: provenance,
  privacy: '仅源代码字段定义、默认配置及公开服务路径；无客户记录、API Key、登录 Cookie、令牌或签名查询参数。'
};

const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const code = value => '<code>' + esc(value) + '</code>';
const groupLabel = group => schema.groups.find(entry => entry.id === group)?.label || group;
const typeNames = { number: '数值', date: '时间', text: '文字', longtext: '完整长文本', url: '公开链接', ai: 'AI 判断', status: '状态' };
function fieldTable(fields) {
  return '<div class="table-wrap"><table><thead><tr><th>界面字段</th><th>统一 key</th><th>原始字段 / 计算依据</th><th>实际来源记录</th><th>类型</th><th>默认显示</th></tr></thead><tbody>' +
    fields.map(field => '<tr><td>' + esc(field.label) + '</td><td>' + code(field.key) + '</td><td>' + esc(field.sourceField) + '</td><td>' +
      (field.sourcePathField ? code(field.sourcePathField) : esc(field.sourceGroup === 'basic' ? '本机配置 / AI / 执行回执' : '按已返回的资料') ) + '</td><td>' + esc(typeNames[field.type] || field.type) +
      '</td><td>' + (field.defaultVisible ? '<span class="tag">主字段</span>' : '按组勾选') + '</td></tr>').join('') + '</tbody></table></div>';
}
function infoTable(rows) {
  return '<div class="table-wrap"><table><tbody>' + rows.map(row => '<tr><th>' + esc(row[0]) + '</th><td>' + row[1] + '</td></tr>').join('') + '</tbody></table></div>';
}
function compactTable(columns) {
  return '<div class="table-wrap"><table><thead><tr><th>紧凑主表列</th><th>展示 key</th><th>关联原字段</th></tr></thead><tbody>' +
    columns.map(column => '<tr><td>' + esc(column.label) + '</td><td>' + code(column.key) + '</td><td>' + esc((column.fields || []).join(' / ')) + '</td></tr>').join('') + '</tbody></table></div>';
}
function settingRows() {
  const c = selectedDefaults.collect, a = selectedDefaults.action, h = selectedDefaults.human, ai = selectedDefaults.ai;
  return [
    ['每天作品尝试', esc(c.dailyVideoLimit) + '；视频和图文合并计数'],
    ['单作品翻页上限', esc(c.maxScrolls) + ' 轮；到上限仍有下一页则保留部分记录，不记完整'],
    ['评论翻页', esc(c.scrollIntervalSec) + ' 秒 ±' + esc(c.scrollJitter * 100) + '%（' + esc(Number((c.scrollIntervalSec * (1-c.scrollJitter)).toFixed(3))) + '～' + esc(Number((c.scrollIntervalSec * (1+c.scrollJitter)).toFixed(3))) + ' 秒）；目标响应已就绪且间隔已到才翻页，两种等待不重复相加'],
    ['作品之间', esc(c.linkIntervalSec) + ' 秒 ±' + esc(c.linkIntervalJitter * 100) + '%（' + esc(c.linkIntervalSec * (1-c.linkIntervalJitter)) + '～' + esc(c.linkIntervalSec * (1+c.linkIntervalJitter)) + ' 秒）；仅进入下一实际作品前等待'],
    ['重复作品冷却', esc(c.cooldownHours) + ' 小时；需要补齐时可显式强制重采'],
    ['每日关注 / 私信尝试', esc(selectedDefaults.follow.dailyLimit) + ' / ' + esc(selectedDefaults.dm.dailyLimit)],
    ['用户之间', esc(a.userIntervalSec) + ' 秒 ±' + esc(a.userIntervalJitter * 100) + '%（' + esc(a.userIntervalSec * (1-a.userIntervalJitter)) + '～' + esc(a.userIntervalSec * (1+a.userIntervalJitter)) + ' 秒）；同一主页内依次关注、打开私信、填写、发送，不另设动作间隔'],
    ['采集后自动 AI', c.autoAiAfterCollect ? '默认开启；只判断本次实际返回或回填的评论用户，作者和空评论排除，有效结果跳过' : '默认关闭'],
    ['连续异常保护', '连续 ' + esc(h.maxConsecutiveErrors) + ' 次异常暂停；AI 单独累计接口异常。时间记录采用 ' + code(h.timeZone)],
    ['AI 默认模型', code(ai.model) + '；使用用户保存的 API Key，从官方刷新模型后明确选择'],
    ['AI 调度 / 超时', '正常请求没有固定间隔；每次请求检查授权、停止。超时 ' + esc(ai.requestTimeoutSec) + ' 秒；自动超时或回执失败按75%/50%/30%/200条逐档恢复，其他临时接口异常有界退避'],
    ['AI 自动组批', '默认 ' + code(ai.batchMode) + '；实时模型容量的75%，失败后50%、30%，最后每批最多200条（仍检查75%容量上限），包含完整介绍、要求、去重输入与结果预留。顺序加线索，返回后继续下一批；token使用保守估算，实际以服务器usage为准。'],
    ['AI 手动组批', esc(ai.batchMaxCount) + ' 条 / 用户消息最多 ' + esc(ai.batchMaxChars) + ' 字符；同时受模型90%输入＋输出预算约束。超限单项不发请求；原有自定义数字保留'],
    ['提示词预设', esc(ai.presetCount) + ' 份，默认启用 ' + code(ai.activePromptId) + '；单条和批量共用同一规则'],
    ['默认关键词初筛', esc(selectedDefaults.keywords.intent.join('、')) + '；默认不设排除词。保存变更同步重算历史粗筛，保留 AI 与联系历史。'],
    ['重复私信 / 视频作者', (selectedDefaults.dm.repeatEnabled ? '启用' : '默认关闭') + '重复私信；' + (selectedDefaults.dm.skipAuthor ? '默认跳过视频作者' : '允许视频作者')]
  ];
}
const mainFields = schema.fields.filter(field => field.defaultVisible);
const sections = ['basic', 'work', 'comment', 'user'].map(group => {
  const title = groupLabel(group);
  const descriptions = {
    basic: '编号、执行账号、业务编号、关键词候选、AI 判断、触达状态及时间由本机任务和 AI 结果保存。它们不从抖音评论接口推测；关键动作结果不明就记待核验。',
    work: '先读同作品详情响应。正文缺失时，只读取当前作品页面已有的结构化 JSON / 流式 JSON 或明确作品文字；使用作品 ID 排除相关推荐。原始 snake_case 与页面 camelCase 在适配层统一。',
    comment: '评论接口的 comments[] 保存评论 ID、正文、时间、等级、属地、点赞与回复计数。当前自动采集一级评论，不把回复计数当作已采集全部楼中楼。',
    user: '直接读 comments[].user。平台返回多少真实公开资料，就保存多少；缺失字段保留空值。已发生的同一次主页访问可用 profile 响应补齐，不为所有线索另开主页遍历。'
  };
  const endpointRows = endpoints[group].map(entry => '<li>' + code((entry.origin || '') + entry.path) + '：' + esc(entry.description) + '</li>').join('');
  return '<section id="group-' + group + '"><h2>' + esc(title) + '</h2><p>' + esc(descriptions[group]) + '</p><ul>' + endpointRows + '</ul>' +
    fieldTable(schema.fields.filter(field => field.sourceGroup === group)) + '</section>';
});
const html = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src \'none\'; base-uri \'none\'; form-action \'none\'">',
  '<title>华贸获客 · 字段与采集流程说明 ' + esc(version) + '</title>',
  '<style>:root{--ink:#182335;--muted:#46556e;--line:#cbd5e3;--blue:#0052d9}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f1f3f7;color:var(--ink);font:16px/1.85 "Microsoft YaHei","Segoe UI",sans-serif}header{background:#20242c;color:#fff;padding:32px max(24px,calc((100vw - 1240px)/2))}header p{color:#d5e2f8;margin:8px 0}header .kicker{font-size:16px;color:#a9ceff}h1{font-size:30px;line-height:1.5;margin:8px 0}h2{font-size:24px;line-height:1.5;margin:0 0 14px}h3{font-size:19px;margin:24px 0 8px}p{margin:10px 0}main{max-width:1288px;padding:24px;margin:auto}nav,section{background:#fff;border:1px solid var(--line);border-radius:5px;margin-bottom:22px;padding:24px}nav{display:flex;gap:12px 24px;flex-wrap:wrap}a{color:#0049bd;text-decoration:underline;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #4389ee;outline-offset:3px}code{font:16px/1.7 Consolas,"Microsoft YaHei",monospace;overflow-wrap:anywhere;background:#edf1f7;border-radius:3px;padding:2px 5px}ul,ol{padding-left:26px}li{margin:8px 0}.note{border-left:4px solid var(--blue);background:#edf4ff;padding:14px 18px;margin:18px 0;color:#204875}.pending{border-left-color:#9a6100;background:#fff6e4;color:#794700}.flow{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0}.flow span{background:#edf4ff;border:1px solid #b9d0f1;padding:9px 14px;border-radius:4px;color:#204875}.flow b{color:#46556e}.table-wrap{overflow:auto;max-width:100%;border:1px solid var(--line);border-radius:4px;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:16px}th,td{padding:12px 14px;text-align:left;vertical-align:top;border-bottom:1px solid #dfe5ee;min-width:125px}th{background:#edf1f7;color:#34445f;font-weight:700}tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}td:nth-child(3){min-width:220px}td code{background:transparent;padding:0}.tag{display:inline-block;border-radius:4px;background:#eaf2ff;color:#0049bd;padding:3px 8px;white-space:nowrap}.small{font-size:14px;color:var(--muted)}.columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.columns>div{padding:16px;border:1px solid var(--line);border-radius:4px}.dictionary-count{font-weight:600;color:#0049bd}footer{padding:0 24px 30px;color:#46556e;max-width:1288px;margin:auto;font-size:14px}@media(max-width:750px){header{padding:24px}h1{font-size:26px}main{padding:14px}section,nav{padding:18px}h2{font-size:22px}.columns{grid-template-columns:1fr}}@media print{body{background:#fff}header{background:#fff;color:#182335}header p,header .kicker{color:#34445f}main{max-width:none;padding:0}nav{display:none}section{border:0;border-bottom:1px solid #cbd5e3;break-inside:auto}.table-wrap{overflow:visible}th,td{min-width:0;padding:7px;font-size:12px}code{font-size:12px}a{color:inherit}footer{padding:15px 0}}</style></head><body>',
  '<header><div class="kicker">HUAMAO WORKSPACE · 版本 ' + esc(version) + '</div><h1>字段与采集流程说明</h1><p>从浏览器真实响应保存数据，用统一字段定义连接采集、线索库、AI 和导出。</p><p class="small" style="color:#d5e2f8">本文由源代码字段字典和全新默认设置自动生成；不含客户数据或密钥。</p></header>',
  '<main><nav aria-label="文档目录"><a href="#changes">本版处理</a><a href="#pages">页面操作</a><a href="#browser">内嵌账号浏览器</a><a href="#browser-protocol">内嵌技术说明</a><a href="#dm-entry">私信入口与会话核对</a><a href="#primary">7 列紧凑主表</a><a href="#lead-filters">筛选与导出</a><a href="#group-basic">基础信息</a><a href="#group-work">视频/图文</a><a href="#group-comment">评论信息</a><a href="#group-user">用户信息</a><a href="#flow">完整流程</a><a href="#ai-flow">AI 判断规划</a><a href="#long-text">长图文与 AI</a><a href="#defaults">默认配置</a><a href="#servers">服务器与升级</a><a href="#maintenance">字段调整</a></nav>',
  '<section id="changes"><h2>外部与内嵌浏览器可切换，保留原有业务数据</h2><p>本版默认使用外部专用浏览器，优先恢复原有账号运行方式。账号管理新增“浏览器模式”，每个账号可独立选择外部或内嵌。采集、关注与私信共用原有流程，仍由 Playwright 操作控件并观察对应页面响应。内嵌扫码后“访问太频繁”的实网问题尚未确认修复，当前提供外部模式作为兼容选择。</p><p>升级保留 API Key、设置、账号列表、线索、联系记录和旧 chrome-profiles；新的 electron-profiles 使用独立内核，各账号首次需要重新扫码，不自动复制 Chrome 登录状态，也不需要删除或重建账号。外部模式继续读取 chrome-profiles；首次使用内嵌才需要在独立资料中重新扫码。切换不会复制 Cookie，不会删除任一模式的数据。</p><h3>继续逐个用户核对关注关系与可读私信历史</h3><p>本版在每位用户主页核对当前关注关系；已关注则跳过，旧关注记录不替代本次网页响应。进入目标对话后检查可读历史，含手动发送的出站文字；明确历史与本地跨账号记录合并，遵从本次预检查冻结的重复联系规则。网页历史不计本次发送成功。网页历史无法确认且本地无已发或待核验时，按用户要求静默首发，不弹提示、不保存未知观察。</p><p>继续支持主页私信入口点击后停在消息列表、列表行没有 UID 的情况。在主页昵称仍与入口点击时捕获的一致时，用完整昵称唯一匹配活动列表的目标行，绑定真实元素点击一次。之后继续核对活动聊天头昵称，不选首行；昵称相同的多个候选不自动选择，头像和聊天 UID 不参与核对。沿用就绪检查，不新增额外固定间隔。每次真实界面操作前重新检查授权与停止，入口、消息列表、目标会话和发送控件分别给出未发送原因。</p><p>线索主表采用7列、15px正文和两行摘要；评论后紧接作品，日期与时间分行，主页改为复制入口。AI分成全部、未判断、AI是、AI否和待重判，联系状态单独筛选；支持评论近1天、3天、一周与全部，以及当前筛选、已勾选或全部线索导出。</p><p>' + esc(version) + ' 把主要工作整理为“账号就绪 → 采集评论 → AI 与名单 → 关注与私信 → 结果核验”。总览给出下一步入口；每个业务页面只保留当前任务的输入、主要按钮和进度，任务上限等规则收进展开区，三组节奏集中在设置页面。</p><p>评论翻页3秒±40%，作品之间10秒±20%，用户之间10秒±40%。同一用户主页内连续完成需要的关注、私信、填写和发送。仅等待真实页面、控件与响应就绪，不再给每个动作添加一段等待。原来每一步的间隔设置已替换为这三处节奏。</p><p>采集正常结束后默认自动批量判断本次评论用户，包含本次回填的已有记录；作者和空评论不参与，不按关键词提前排除。已有效判断的记录跳过；停止、采集异常不会自动接着AI，缺少API设置时评论仍保留。</p><p>联系前一次预检查冻结账号、去重用户名单、逐人动作、消息预览及重复联系开关和间隔。执行页面逐步显示“主页 → 关注 → 打开私信（含选择会话与检查历史） → 填写 → 发送 → 核验”；明确区分没有发送与已经点击发送但待核验。全过程保留授权、停止、目标校验和连续异常保护。</p><div class="note pending">' + esc(reviewNotice) + '</div></section>',
  "<section id=\"pages\"><h2>新版页面怎样使用</h2><div class=\"flow\"><span>01 账号管理</span><b>→</b><span>02 采集获客</span><b>→</b><span>03 AI 与线索</span><b>→</b><span>04 关注私信</span></div><div class=\"table-wrap\"><table><thead><tr><th>页面</th><th>需要填写或核对</th><th>主要操作与结果</th></tr></thead><tbody><tr><td>总览</td><td>账号就绪情况、线索及任务概况</td><td>按当前状态进入下一步；保留工作流程入口，不在总览重复堆放配置</td></tr><tr><td>账号管理</td><td>执行账号、浏览器模式与该模式的登录状态</td><td>启动按所选模式自动检查；点打开登录，在专用窗口或内嵌页面完成扫码，显示检查反馈</td></tr><tr><td>账号浏览器</td><td>已打开账号标签、只读网址和当前网页</td><td>后退、前进、刷新、返回工作台；标签只切换已有账号视图，空列表从账号管理打开；切页隐藏不等于退出账号</td></tr><tr><td>采集获客</td><td>选择账号，粘贴一个或多个作品链接；按需勾选强制重采与采集后AI</td><td>开始采集并判断；查看当前作品、评论响应、切换倒计时、采集和AI汇总；完成后查看本次评论用户</td></tr><tr><td>AI 与线索</td><td>先按AI五分类核对判断，再选择评论时间与联系状态或勾选用户；明确执行账号及范围</td><td>需要时批量判断、读取短理由，进入固定名单预检查；全文与扩展字段按需查看</td></tr><tr><td>关注私信</td><td>核对名单来源、启用动作和私信话术</td><td>预检查弹窗显示固定名单、跳过原因和每人的消息预览；确认后显示当前用户和每一步进展</td></tr><tr><td>设置</td><td>三组任务节奏、连续异常阈值、DeepSeek、业务资料、提示词和关键词</td><td>集中保存节奏；AI提示词明确选用一份，草稿先查看再保存；授权地址由程序内置</td></tr><tr><td>操作日志</td><td>选择账号或系统AI日志</td><td>核对采集暂停、实际动作、未发送原因、待核验以及AI批次和错误原因</td></tr></tbody></table></div><p>全局“停止所有任务”始终可用；等待期间显示是下一作品、评论翻页还是下一用户，并显示剩余时间。未保存的任务设置有明确提示；预检查后改变配置需要重新预检查，筛选变化只影响下一份名单。</p></section>",
  '<section id="browser"><h2>账号浏览器与运行方式</h2><ol><li>在“账号管理”选定账号及浏览器模式，点“打开登录”。默认外部模式显示专用浏览器窗口；内嵌模式显示在“账号浏览器”中。标签只切换已打开的内嵌账号，不能替代开户或授权。</li><li>每个账号首次使用新版内嵌浏览器时重新扫码，并在手机确认。旧 Chrome 浏览器资料仍在原数据目录，未删除、未改写；新内核不承诺继承旧 Cookie。</li><li>上方账号标签用于切换页面；网址仅显示与复制，不提供任意地址输入。后退、前进和刷新作用于当前内嵌账号；返回工作台回到先前业务页。普通加载与网址状态更新不会抢走正在操作的业务页。</li><li>切到其它业务页、打开弹窗或出现登录遮罩时，暂时隐藏内嵌视图。隐藏不等于停止任务、关闭账号或退出登录；需要暂停所有动作请点全局“停止所有任务”。内嵌网页范围会随布局更新，不能覆盖全局停止。</li></ol>' + infoTable([['默认与兼容', esc(dictionary.embeddedBrowser.compatibility)], ['切换处理', esc(dictionary.embeddedBrowser.switching)], ['桌面宿主', code('desktop/main.js / account-browser-host.js') + ' 管理 WebContentsView、独立账号 session、显示边界与生命周期；网页禁用 Node 集成，不获得桌面管理桥接。'], ['后台适配', code('lib/embedded-browser-client.js') + ' 以 Playwright 接入指定账号页；请求与响应观察、定位、填写和真实点击继续共用现有业务代码。'], ['通道边界', '本机进程 IPC 与带随机会话凭据的回环 WebSocket 传递协议，不开放无鉴权远程调试端口；内部凭据不进入日志或客户端设置。'], ['资料与升级', code('data/electron-profiles') + ' 为新版账号资料；' + code('data/chrome-profiles') + ' 为原资料，保留不动。API、设置、线索和联系记录不因重新扫码删除。'], ['手动导航互斥', '后退、前进、刷新先同步占用短期控制租约，再检查授权和任务状态。任务运行时不能手动导航，租约持有期间不能启动任务；异步授权后再核对原账号与会话代次，完成、失败或超时释放租约。'], ['正常退出', '关闭主窗口时先停止后台任务，等待账号 session 的 storage 与 Cookie 完成 flush，再销毁账号视图与主窗口；后台退出保留超时兜底。'], ['兼容验证', '本次仍附带独立 Chromium 供源码与隔离 QA 路径使用，生产桌面运行不调用外部浏览器。隔离测试不表示已向真实平台发送消息，也不表示所有实网布局已验证。']]) + '</section>',
  '<section id="browser-protocol"><h2>内嵌协议、导航拦截与后台渲染</h2><p>本节供后续开发交接使用。原有采集、关注与私信代码仍经生产 Playwright 连接访问当前账号页面；host 的协议兼容应保持账号和目标边界，不能只让测试替身返回成功。</p>' + infoTable([['独立页面会话', esc(dictionary.embeddedBrowser.protocolSessions)], ['逐跳导航校验', esc(dictionary.embeddedBrowser.navigationInterception)], ['隐藏页面问题', esc(dictionary.embeddedBrowser.renderingLease.reason)], ['持有范围', dictionary.embeddedBrowser.renderingLease.methods.map(code).join(' / ') + '；' + esc(dictionary.embeddedBrowser.renderingLease.mechanism)], ['图像处理', esc(dictionary.embeddedBrowser.renderingLease.images)], ['空闲及任务节奏', esc(dictionary.embeddedBrowser.renderingLease.idle)]]) + '<p>导航授权租约与原生渲染租约分别处理不同问题：前者使手动后退、前进、刷新与任务互斥；后者只在指定协议命令执行期间保持页面所需的渲染。它们不更改业务的评论翻页、作品或用户间隔，也不会将一次发送点击重复执行。</p><p class="note">' + esc(dictionary.embeddedBrowser.renderingLease.validationBoundary) + '。真实 host、client 与 engine 的整流程隔离验证记录于 ' + code('build-tools/verify-embedded-outreach.js') + '，页面和响应均为本机合成样例，并非真实平台发送记录。源码及验证脚本摘要由本次构建重新生成。</p></section>',
  '<section id="dm-entry"><h2>先进入目标聊天，再填写与发送</h2><h3>2.3.4：只核对完整昵称</h3><p>已复现旧版误暂停：某些头像地址不含 aweme-avatar 路径，被旧规则误判无效。按用户最新要求，当前 StackLayout 会话只比较目标主页昵称和活动聊天顶部昵称，不再读取头像或要求聊天 UID，也不等待头像加载。</p><p>只点击目标主页内的私信入口。网页可能先出现消息列表，再自动进入聊天；聊天已就绪时直接继续。停在列表时，只点击与主页完整昵称一致的唯一会话行一次；多个同名候选不选择，不选首行。进入聊天后再次核对顶部昵称，消息列表中的名字不能代替当前聊天标题。</p><p>文字和图片表情按原顺序读取，支持纯表情昵称；长昵称读取 DOM 中的完整文字，不受视觉省略号影响。主页或聊天昵称变化、缺失时保持未发送。输入框、停止操作、历史防重、发送回执检查继续保留；昵称相同不代表平台 UID 认证。本轮隔离验证不代表所有实网布局已验证，也不代表向真实账号发送成功。</p>' + infoTable([
    ['2.3.2 表情昵称修复', esc(dictionary.workflow.outreach.entryFlow.emojiName)],
    ['2.3.3 历史响应与网页内容复核', esc(dictionary.workflow.outreach.dmHistory)],
    ['入口未找到 / 有歧义', code('DM_ENTRY_NOT_FOUND / DM_ENTRY_AMBIGUOUS') + '：没有可识别的唯一目标入口；不据此认定用户永久禁止私信。'],
    ['入口改变 / 不可用', code('DM_ENTRY_CHANGED / DM_ENTRY_UNAVAILABLE') + '：点击前控件重绘、改变或不可操作；与入口不存在分别记录。'],
    ['只有消息列表 / 目标未就绪', code('DM_MESSAGE_LIST_ONLY / DM_TARGET_CHAT_NOT_READY') + '：尚未进入可填写的目标会话，本次没有发送。'],
    ['接收人身份不足', code('DM_RECIPIENT_UNCONFIRMED') + '：没有可靠目标身份，停止继续处理，不填写或发送。明确错目标与会话改变同样暂停。'],
    ['输入框 / 发送控件失败', '继续细分输入框缺失、多个候选、发送按钮禁用或消息改变；保存当前阶段的未发送原因。']
  ]) + '<p>“未发送”不增加私信尝试与成功次数，不变成“已发送待核验”；真实发送点击后缺少对应回执才保留待核验并禁止自动重发。界面诊断仅记录阶段、错误码、控件计数和身份依据类型 explicit_uid / dom_profile_name，不输出实际昵称、UID、头像地址、页面全文、私信正文、选择器或凭据。</p><p class="note pending">用户手动发送的文字能从本次可读网页历史确认时参与防重；关闭重复联系则跳过，开启仍须满足冻结间隔，最近发送时间未知时不自动重复。网页历史不会改写成本次发送成功，也不增加软件成功次数。网页历史无法确认且本地无已发或待核验记录时，按用户要求静默按首发执行，不弹提示、不保存未知观察；已有本地记录和待核验仍优先。隔离测试只能证明测试页面下的定位、授权和落库行为，不代表本次发布已完成真实账号发送或生产安装验收。</p></section>',
  '<section id="primary"><h2>7 列紧凑主表，完整数据仍保留</h2><p class="dictionary-count">字段定义版本 ' + esc(schema.version) + ' · 共 ' + esc(schema.fields.length) + ' 个公开数据字段 · 主表合并展示 7 列</p><p>' + compactColumns.map(column => esc(column.label)).join(' → ') + '</p>',
  compactTable(compactColumns),
  '<p>主表正文 15px，评论、作品与理由采用最多两行摘要，缩短单元格间距；评论后紧接作品，便于对照上下文。评论时间把日期和时间分两行。主页不展开原 URL，按需点击复制；“查看作品”不再占据主表行内按钮位置。</p><p>勾选控件放在最左侧；详情保留评论及作品全文、原始字段、单条 AI、跟进和联系结果核验等操作。附加字段按需展开在右侧，表格可横向滚动。显示偏好只保存在本机，不改变筛选条件或已经冻结的执行名单；摘要不会删改已保存的全文。</p><p>列表当前最多显示最近 500 条，筛选计数反映完整结果。“当前筛选结果”任务按完整筛选计算，不限于页面这 500 条；“勾选的线索”任务只处理已勾选编号。切换筛选保留勾选，勾选范围可能包含当前未显示的记录；预检再冻结最终名单。</p><details id="raw-primary"><summary>原始 11 个主字段（详情与 Excel 保留）</summary>' + fieldTable(mainFields) + '</details></section>',
  '<section id="lead-filters"><h2>AI 分类、联系状态、评论时间与导出</h2><h3>AI 六分类与独立联系筛选</h3>' + infoTable(Object.entries(dictionary.leadList.aiFilters).map(([key,label]) => [label, code(key)])) + '<p>“AI 是”和“AI 否”只包含当前有效结果：已完成判断、结果为是/否、理由为1至30字符，且规则版本与完整输入摘要都匹配当前内容。历史结果、缺少有效性证据或内容改变的结果进入“待重判”；从未有判断结果的记录进入“未判断”。分类数量受搜索、评论时间和联系状态等其它筛选影响，只忽略当前 AI 分类。</p><p>联系状态单独选择全部状态、暂无联系记录、有关注记录、已有私信记录、待核验、操作失败、不再联系或已回复。已有私信记录包含本软件确认结果及明确网页历史；列表分别显示“私信已确认”和“历史已私信”，网页历史不增加成功次数。关注观察必须属于当前账号，其他账号旧复制的关注待核验不影响本账号分类。待核验优先于已有记录，即使曾有成功次数也不能替代本次结果核验。AI 分类和联系状态不会互相覆盖；当前有效的 AI 是仍须经过任务预检查。</p><h3>评论时间：全部、1天、3天、一周</h3><p>1天、3天、一周分别是筛选开始时向前24、72、168小时，采用评论发表时间，不采用采集时间或 AI 判断时间。新采集保存 ' + code('commentTimestamp') + '，直接来自评论接口 ' + code('comments[].create_time') + ' 的 Unix 秒；比较时换算毫秒。缺少原始时间的旧记录兼容 ' + code('time') + '，无时区历史日期按中国时间 +08:00 解析。未知、非法或未来时间不进入近期范围，“全部”仍可查看。</p><p>同一用户可能归并多条评论；时间筛选对应当前线索主评论的 ID、正文和时间，不用补充评论的时间冒充主评论时间。预检查在开始筛选时固定截止时间，再冻结执行名单，等待过程不会滚动扩大或缩小本次范围。</p><h3>导出先选范围</h3>' + infoTable([['当前筛选','导出符合当前完整筛选的全部记录，不只导出页面已显示的500条。'],['已勾选','按已勾选编号导出，忽略当前筛选；跨筛选保留勾选。空选择明确拒绝，不自动回退为全部。'],['全部线索','明确导出整个线索库和全部作品，包括无评论作品；不应用当前筛选。']]) + '<p>三种范围都保留原始全字段、历史评分和长文本，不按紧凑主表删列。“当前筛选”和“已勾选”的下方作品资料只附带本次导出线索关联的作品；“全部线索”和旧版 GET 导出保留全部作品，包括无评论作品。导出与 AI、预检查共用筛选规则，选择范围后仍可核对数量。</p></section>',
  ...sections,
  '<section id="flow"><h2>从作品链接到触达的完整流程</h2><div class="flow"><span>输入链接</span><b>→</b><span>采集响应</span><b>→</b><span>AI 判断</span><b>→</b><span>筛选与预检</span><b>→</b><span>固定名单</span><b>→</b><span>同主页关注 / 私信</span><b>→</b><span>核验结果</span></div>',
  '<ol><li><strong>启动自动检查：</strong>先登录软件授权账户，每次进程启动会顺序检查已有抖音账号。各账号按所选模式使用独立浏览器资料：默认外部 chrome-profiles，可选内嵌 electron-profiles。后台读取当前账号页面和真实响应，两种模式的登录证据互不沿用。临时检查按生命周期关闭，已有账号页面只原地检查，不跳转或关闭。现有任务运行时等待；停止或退出会取消检查。账号管理显示检查进度和已登录、未登录、待确认、需验证等状态；上次保存的已登录仅作历史，没有可靠响应不冒充成功。</li>',
  '<li><strong>准备账号：</strong>新增或未登录账号需打开对应账号浏览器，扫码并在手机确认；“检查”仍可手动重新核验。软件授权与抖音登录分别判断，检查不做关注、私信或用户主页补全。</li>',
  '<li><strong>浏览器启动：</strong>账号管理可逐账号选择外部专用浏览器（默认）或内嵌浏览器。外部模式沿用原 chrome-profiles，优先系统 Chrome、其次 Edge、最后随包 Chromium，通过 Playwright 启动专用窗口。内嵌模式由 Electron WebContentsView 承载账号网页，使用独立 session，后台通过进程 IPC 与带随机会话凭据的本机回环桥接接入 Playwright。没有裸 remote-debugging-port，网页不能调用桌面管理 IPC。点击打开登录按所选模式显示专用窗口或内嵌页面；内嵌模式切换工作台只是隐藏视图。更换浏览器模式须先停止任务；关闭旧上下文成功后才保存新模式，并清除上一模式的登录显示，重新检查。切换不删除 API、线索、联系历史及任何浏览器资料。启动失败显示具体反馈，不能靠删除账号资料试错。</li>',
  '<li><strong>输入作品：</strong>支持完整分享文本、v.douyin.com 短链接、/video/ 和 /note/。解析后按作品 ID 去重；保留图文路径。强制重采只针对明确勾选的输入组。</li>',
  '<li><strong>采集作品文字：</strong>先监听后导航，只处理目标作品详情与页面结构化资料。作品 ID 对不上、响应失败或字段未返回时，不用相关推荐填补。</li>',
  "<li><strong>打开评论并翻页：</strong>进入视频或图文后找到真正的评论区域；需要时切换到“评论”。首屏评论就绪后，以3秒±40%（1.8～4.2秒）节奏滚到评论容器底部，让网页请求下一页。响应处理与间隔共用同一时间窗口；响应慢时不再额外加完整间隔。只等待目标评论响应，不滚相关推荐，也不重放带签名的接口URL。作品处理结束后，仅在进入下一个实际作品前等10秒±20%（8～12秒）；单作品结束不空等。</li>",
  '<li><strong>核验每页：</strong>只接收目标作品、status_code 明确成功的评论响应。cursor 或新评论 ID 推进分页；同一条评论重复出现时补齐真实资料，不重复新增。旧响应不回退游标；有效 has_more=0 才确认一级评论分页结束。达到轮数上限、停止或异常保留部分结果和续采状态。</li>',
  "<li><strong>自动判断本次评论用户：</strong>正常采集结束后，服务端直接串接批量AI，只取本次实际评论响应涉及的记录，包含已有线索的本次回填；按线索编号去重，排除作品作者与空主评论，不按关键词先筛除。当前有效结果跳过，仅判断未判、旧规则或内容已变化的记录。停止、异常或每日上限导致采集中断，不会自动启动AI；缺少API Key或未启用AI时，已采集评论仍然保存，页面提示先补设置，再判断本次范围。AI给出“是/否＋不超过30字符理由”，“是”需有评论者求助、服务咨询或本人/朋友当前问题，不等于确定需求或购买。</li>",
  "<li><strong>筛选进入任务：</strong>在“AI 与线索”核对结果，选择当前完整筛选范围或勾选记录。预检查按执行账号和用户去重，冻结用户名单、每人的关注/私信动作、话术模板及消息预览；先看清每人将发送什么，再确认。页面最多显示最近500条，完整筛选任务不限这500条。后续筛选变化仅用于下一次预检查，已冻结的身份或相关配置变化会拒绝旧计划。</li>",
  "<li><strong>按用户处理：</strong>确认后打开执行账号的可见浏览器，进入名单用户主页，同一次访问完成已返回资料回填、需要的关注、打开目标私信、填写和发送。已经关注的用户直接做需要的私信；已经私信过的用户默认只补关注。页面、控件与会话就绪即继续；不会因前一种动作的旧间隔而跳过后一种动作。目标身份变化或控件有歧义时，明确暂停或记录没有执行。私信入口可能先打开消息列表；列表缺少 UID 时，在已捕获且当前一致的主页昵称约束下，用完整昵称唯一匹配活动目标行，绑定原生点击一次。多个同名候选不选择，不选首行；之后仍检查活动聊天头，不能把列表出现当作目标会话已确认。</li>",
  "<li><strong>用户切换：</strong>当前实际访问用户处理结束后，进入下一实际用户之前等待10秒±40%（6～14秒）。同一个用户主页内不另设动作间隔。无需访问的跳过用户不启动一轮等待，最后一个用户处理完立即结束。关注和发送的回执确认、页面与控件就绪采用有限时等待，不是每一步固定睡眠。</li>",
  "<li><strong>关系与历史检查：</strong>主页响应确认当前账号已关注时跳过关注，不产生本次成功或尝试。关注历史仅约束当前执行账号，旧followedAt不会挡住现场检查；私信历史仍按当前业务与UID跨账号防重。私信入口若先到列表，先定位并进入目标对话，再检查网页自然返回、身份可核对的历史出站文字，含手动发送。明确已发遵从冻结重复开关与间隔；最近时间未知不自动重复。本地待核验始终阻止重发。历史未知且本地无已发记录时，按用户要求静默首发，不提示、不保存unknown。选择会话与检查历史都归“打开私信”阶段，详细状态分别显示，不回到主页步骤。</li><li><strong>填写与发送：</strong>核对当前目标会话与冻结消息全文。新出现和复用的输入框都必须有目标身份依据；每次真实界面操作前复核授权与停止，随后再核对绑定控件和接收人。识别抖音编辑器末尾的结构占位符，保留正文中的空格、换行和表情；在同一输入区域定位真实发送箭头并原生点击。只有输入文字不算已经发送。</li>",
  "<li><strong>发送诊断：</strong>操作日志中的“私信网络观察”记录短暂观察窗口内 imapi.douyin.com 的候选请求/响应、类型和 HTTP 状态。路径脱敏，不保存 Cookie、Token 或私信正文；候选响应尚未核实收件人和业务结果，不作为成功证据。</li>",
  "<li><strong>明确记录结果：</strong>入口缺失、入口重绘、仅消息列表、目标会话未就绪、身份未确认或发送控件不可用会分别诊断；发送前准备失败明确显示“本次没有发送”，不扣未发生的发送尝试。执行点击前保存待核验，避免中途退出后重复操作；只有本次目标明确回执才能确认成功。已点击发送但没有可靠回执显示“待核验”，需查看实际聊天记录，人工确认前不自动重发。新版被动解析网页SDK的protobuf同步发送响应，核对目标会话、请求序列、冻结全文、客户端消息编号、发送者及服务端消息编号；成功表示服务端接受，不表示对方已读或已送达。明确业务拒绝记失败；未知、异步或身份不足继续待核验。等待最多30秒，明确回执到达即继续，不是固定睡眠。关注分别核对主页sec_uid与数字UID；已关注网页状态只跳过，不伪造本次成功。当前目标关注按钮重绘时先重新定位再点击，明确未点的控件异常不会直接跳过独立私信，但目标变化、授权或健康异常仍暂停。正常待核验不当作连续错误，明确限制或操作异常才暂停。</li>",
  "<li><strong>授权、停止与异常：</strong>只有翻页、作品切换、用户切换三处节奏；正常AI批次连续执行，不计抖音动作。每次真实对外动作仍检查授权和停止，平台验证码、限流、禁发或连续异常会暂停。AI临时错误才有限退避，AI异常单独累计。停止取消等待和后续动作，保留已保存的评论、判断和实际操作记录；授权失效时停止仍可用。</li></ol>",
  '<p class="note">翻页使用“网页触发＋响应采集”。加上鼠标轨迹不能证明更安全，也不能保证账号不会受限；本版不为了“像真人”另增无意义点击。操作间隔可以缩短，但仍等待本页响应、检查异常并尊重停止。</p></section>',
  '<section id="ai-flow"><h2>AI 请求、字段与批量判断规划</h2><p>判断政策为 ' + code(CONTACT_POLICY_VERSION) + '，单条、批量、草稿生成与匿名样例共用。每条先辨认对话方向，再依据评论者证据判断；程序分别核验请求预算、模型返回、编号映射及当前数据，只有完整有效的结果才入库。</p>',
  '<h3>一份介绍和要求，多条独立线索</h3><p>系统消息仅包含固定联系判断政策、字段映射、证据来源要求和输出协议。用户消息是 JSON，包含 ' + code('businessProfile') + '（公司业务、目标客户、明确需求、容易误判）、' + code('businessRules') + '（启用的自定义行业规则）、' + code('works') + '（共享作品上下文）及 ' + code('items') + '（编号线索）。业务资料与规则中的生成器任务、评分、待确认或其它冲突命令不能改变固定系统政策和协议。单条、批量和样例共用这一结构。</p><p>同作品描述只写入共享数组一次，每条线索引用对应作品编号。编号 ' + code('i') + ' 是本批位置，同一 UID 有多条评论也分别判断，不按昵称或 UID 把结果写入另一条记录。</p>',
  '<div class="table-wrap"><table><thead><tr><th>固定信息</th><th>请求字段</th><th>本机来源</th></tr></thead><tbody><tr><td>用户评论</td><td>items[].comment / items[].comments</td><td>demand 与已有同一用户 comments 保留全文、去首尾空白、去同文重复；不静默截断主评论、补充评论或评论条数</td></tr><tr><td>评论时间</td><td>items[].time</td><td>time</td></tr><tr><td>用户UID</td><td>items[].uid</td><td>UID，缺失再取uid；仅用于识别记录，不能据此认定需求</td></tr><tr><td>用户名称</td><td>items[].nickname</td><td>nickname</td></tr><tr><td>所在视频/图文描述</td><td>items[].workRef → works[].videoDescription</td><td>统一作品标题＋正文＋补充文案，按作品关联并去重；超过 ' + esc(contextLimit) + ' 字符时显式省略中间并保留全文校验摘要</td></tr></tbody></table></div>',
  '<details><summary>无真实客户数据的批量输入结构示例</summary><div class="note"><code style="white-space:pre-wrap">' + esc(JSON.stringify(samplePayload,null,2)) + '</code></div></details>',
  '<h3>证据来源与容易误判的边界</h3><p>先分清求助、供给与作者主体。每条只用该评论者的 comment 和 comments 作为评论证据，作品用于解释业务话题和对话方向。不能把作品作者的停用、冻结或求助写成评论用户本人经历，也不能用作者求助补出评论者需求；同批其它用户、UID、昵称与触发词都不提供本条需求证据。不能仅因业务相关、未拒绝或无法证明同行就判“是”。</p>',
  '<div class="table-wrap"><table id="ai-boundaries"><thead><tr><th>作品与评论语境</th><th>判断</th><th>依据</th></tr></thead><tbody><tr><td>服务介绍下“多少钱”“怎么处理”“真的假的”；或本人/朋友当前账户问题</td><td>是</td><td>处理办法、费用、真实性咨询或当前问题；不要求“我的店”或明确购买</td></tr><tr><td>具体账户问题作品下“我也是”“同样收到”“我跟你一样”“我就是这个情况”</td><td>是</td><td>主动将当前问题指向自身，不要求再问怎么办或购买；理由只描述同样问题，不补未确认细节</td></tr><tr><td>作者求助下“可以处理的”“可以的”“可以试试”“有案例”</td><td>否</td><td>仅回答作者或提供能力、案例；不能因作者有需求就联系评论者</td></tr><tr><td>服务介绍下“你有案例吗”；“这种情况你可以处理吗”</td><td>是</td><td>向服务方询问证据或能否处理，与提供案例方向不同</td></tr><tr><td>“可以帮您处理”“我接，私信我”；推荐第三方能处理</td><td>否</td><td>供给或转介绍；理由说提供能力或推荐渠道，不猜同行身份</td></tr><tr><td>分析作者案例“实锤关联吗”，没有询问处理办法或服务</td><td>否</td><td>询问作者案例性质，未见服务诉求；不能把所有问题句都当咨询</td></tr><tr><td>过去申诉成功、分享经验、纯评价或运营观点，没有当前问题或新咨询</td><td>否</td><td>既往经历或观点本身不是当前需求；仍有资金未回等问题则看实际求助</td></tr><tr><td>亚马逊作品下明确问“抖店封号能解吗”</td><td>否</td><td>评论明确业务对象优先于作品话题，属于主营范围外</td></tr></tbody></table></div><p>这些对照用于理解语义方向，不把单个词硬编码为永久标签。同一用户补充了相关求助、服务咨询或本人/朋友当前问题时，结合其完整评论判断；短评论也不能凭缺少主语就直接排除。理由限30字符，描述可见行为，不编造本人账号被封、同行身份或成交意向。</p>',
  '<h3>强制回执与入库字段</h3><p>回执只接受 JSON 数组，每项恰好包含 ' + code('i') + '、' + code('need') + '、' + code('reason') + '。need只能为是或否，reason为1至30字符；禁止评分、待确认、额外字段、漏项、重复编号和越界编号。模型须返回一个完整正常结束的选择，拒绝或工具调用不能作为判断结果。</p><p>' + code('[{"i":1,"need":"是","reason":"询问账户问题处理办法"},{"i":2,"need":"否","reason":"明确表示已解决，无需服务"}]') + '</p>',
  infoTable([['AI判断',code('need → aiNeed')+'；是需相关求助、服务咨询或本人/朋友当前问题证据，否不等于证明同行'],['AI理由',code('reason → aiReason')+'；新判简短，旧长理由保留全文'],['AI评分',code('aiScore=null')+'；新判不生成评分。覆盖旧评分前保存在'+code('aiScoreHistory')+'，未重判的历史评分保持'],['当前有效结果',code('aiDone===true')+'、二值'+code('aiNeed')+'、1至30字符'+code('aiReason')+'，且'+code('aiPromptVersion / aiInputHash')+'与当前规则及全文输入一致；缺一则需要重判'],['安全回写', '固定规则、作品、线索与原结果快照。规则/接口设置改变暂停；线索删除、输入或已有AI结果变化时拒绝旧回写。每'+esc(saveChunk)+'条安全合并，保留同时发生的独立跟进修改']]),
  '<h3>按75% → 50% → 30% → 200条顺序装批</h3><ol><li>每次实际请求前检查授权和停止，读取选中模型 ' + code('/models') + ' 的容量：context_window含输入和输出，max_output_tokens限制一次返回。模型容量不完整时只允许已核对的官方备用容量，不能猜未知模型容量。</li><li>先计完整 system 政策、公司介绍、启用规则、字段要求及 JSON 消息包装；然后按当前固定范围的选定顺序逐条加入完整评论和共享作品上下文，不重新排序，同作品只写一次。</li><li>自动完整输入与输出预留合计初始不超过模型上下文75%，恢复时按50%、30%，最后每批最多200条并保留75%容量上限；手动仍不超过90%。输出预留另不超过模型最大输出。当前预留按源函数计算，两条样例为 ' + esc(dictionary.aiDecision.budget.outputReservation) + ' token。输入按 UTF8 字节加消息开销保守估算，并非精确分词；实际 usage 由服务器回执提供。</li><li>自动模式按当前档位重新完整装批（75% → 50% → 30% → 最多200条），较低档放不下完整材料则转下一档，最后200条仍受75%容量上限约束，不受原手动字符和条数提前切批。手动模式同时满足用户消息 ' + code('payloadChars') + ' 字符上限、条数上限与模型90%完整输入＋输出预算。</li><li>加下一条超限就发送已有批次，返回并核验后继续下一批。单项连同完整规则、作品及输出预留仍放不下，记 ' + code('budget_rejected') + ' 并保持未判断，不发请求、不强制单条；其它合规项继续。介绍本身超限时直接提示调整。</li></ol><h3>按错误原因处理，避免盲目拆批</h3><ul><li>自动超时、传输回执异常、格式合同不合规、模型输出截断或回执不完整时，75% → 50% → 30%各失败一次后进入200条兜底。已保存的成功批不重复发送，未发送名单重新组批，后续沿用当前档位；200条兜底仍失败则暂停。连续异常仍记录，允许三档恢复走完；手动格式问题仍按原顺序二分。无效结果不写入。</li><li>' + code('401 / 402 / 403 / 404') + ' 等不可重试接口错误直接暂停，提示检查 Key、余额、权限或模型，不缩批逐条反复请求。供应商明确拒绝（AI_OUTPUT_REFUSED）或 HTTP200 携带错误包装（AI_PROVIDER_ERROR）也立即暂停，不通过拆批或退避反复请求。</li><li>' + code('429 / 5xx') + '、网络失败，以及手动传输响应异常、单条判断/模型查询超时，同一请求最多 ' + esc(providerRetryLimit) + ' 次退避重试；默认1秒、2秒，尊重 Retry-After 但上限30秒。退避期间随时可停止，独立连续异常达到设置阈值也暂停。</li></ul><p>官方依据（核对日期2026-10-08）：<a href="https://api-docs.deepseek.com/api/list-models/">模型容量</a>、<a href="https://api-docs.deepseek.com/api/create-chat-completion/">输入输出与截断规则</a>、<a href="https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/">字符与token换算</a>。容量会变化，运行时优先读实际模型接口。</p>',
  '<h3>提示词生成与污染验收</h3><p>生成接口外层仅返回含 prompt 字符串的 JSON；prompt 字符串本身必须是业务判断规则正文，保留固定上下文模板，不应再次嵌入 JSON 包装、生成器身份或“帮我生成提示词”的任务。程序通过 ' + code('AI.inspectPromptDraft') + ' 验收：混入生成任务、嵌套包装、评分、待确认或旧返回字段时，显示具体原因且不应用草稿。用户核对、明确选择一份并保存后才生效。</p>',
  '<h3>线索库进度与停止</h3><p>AI 正常请求没有固定调用间隔，也不累计浏览器动作。每次模型或判断请求仍校验授权和停止；接口临时故障才退避。线索库显示提交、规划、当前批次、是/否/失败/跳过及真实模型请求数，点击启动后立即显示反馈；提交期间 busy 防止重复请求，已有任务运行时不能再启动。</p><p>“停止所有任务”同时中止单条/批量判断、AI 生成草稿与匿名样例测试。未完成结果不应用，已经通过校验并安全写入的结果保留。部分预算超限可结束为 completed_with_errors，未判断项不会自动变成否；已识别作品作者跳过。原范围默认跳过严格有效的当前版本结果；旧规则、变更内容或缺少有效字段的结果仍待判断，需要重判当前结果时显式选择重新判断。</p>',
  '<h3>设置、日志与升级</h3><p>默认自动组批；手动模式才加上保存的字符预算与条数限制，模型预算两种模式都生效。升级保留 API Key、模型、三份自定义预设、启用选择、业务资料和手动数值。只有已知旧内置预设的名称、全文与四项默认业务资料精确成对匹配时，迁移内置规则；修改过的规则或业务资料不会自动替换。自定义行业标准作为 JSON 业务材料，冲突的旧三值、评分和包装格式不能覆盖固定系统要求。政策或全文内容变更后原结果需要重判。建议在线索库“全部”范围判断，关键词筛选只处理用户明确选中的候选范围。</p><p>关键词不授予触达许可，也不覆盖有效 AI 是/否。保存词表变化时只重算 trigger、intent、excluded，保留 AI、账号、跟进和联系历史；自定义词表保留，无触发词的相关线索仍能参加全部范围 AI 判断。生成、编辑或本地加载默认预设仅改变草稿，核对、选择并保存后才生效。</p><p>操作日志选择“系统 / AI判断日志”，查看范围、预算、批次、拆批原因、是/否理由、失败、跳过和实际调用次数。' + code('AI_AUDIT') + ' 结构中 ' + code('request（stage:prepared）') + ' 只表示组包准备；' + code('request_sent') + ' 才表示实际 HTTP 请求前的计数。' + code('budget_rejected') + ' 表示超限未发，' + code('provider_retry') + ' 表示临时故障同批重试，' + code('retry_split') + ' 表示手动格式问题或多条超时缩批；budget_recovery表示自动降档与剩余名单重规划；budget_strategy_skipped表示完整材料放不下该档；' + code('usage') + ' 为服务器实际用量。字典列出的事件名称从当前源提取。</p><p>完成日志分别记录 ' + code('yesCount / noCount / failCount / skipped / splitRetryCount / providerRetryCount / completionRequestCount / modelRequestCount') + '，不会把规划批数或准备日志当成真实调用次数。日志不输出 API Key、原始模型长回复或完整客户输入。“AI 是”与“AI 否”只展示当前有效结果；旧规则、内容变化或缺少有效性证据的结果归入“待重判”。仅当前有效的“是”结果可通过预检查，评分不参与执行许可。</p></section>',
  '<section id="long-text"><h2>超长图文怎样保存、显示和用于 AI</h2><div class="columns"><div><h3>保存和阅读</h3><p>原始 item_title / itemTitle、desc、caption 保存到 ' + code('workRawText') + '；真实标题为 ' + code('workTitle') + '，完整正文为 ' + code('workContent') + '，标题与正文去重组合为 ' + code('workText') + '。主字段“视频描述”统一读取组合后的全文。</p><p>视频和图文都适用。标题没返回就留空，不用正文第一行假造标题；图片内的文字不等于平台 desc。本版不做图片 OCR，也不编造平台未返回的内容。</p><p>列表用15px正文和最多两行摘要控制行高；详情与全文弹窗保留完整换行、可滚动、可复制。剪贴板不可用时明确提示 Ctrl+C，并选中原文。</p></div>',
  '<div><h3>AI 上下文</h3><p>作品文字不超过 ' + esc(contextLimit) + ' 字符时完整发送；超过时保留适合预算的真实标题及正文开头、末尾，中间附明确省略标记。正文可用预算约 75% 给开头、25% 给末尾，过长标题按正文一起处理。</p><p>AI 同时收到 ' + code('workContext.truncated') + '、原文长度、输入长度、来源与全文摘要校验。禁止推断省略内容，也不能把作品作者问题移植给评论者；仍须有评论者求助、服务咨询或本人/朋友当前问题证据。这个显式限制仅作用于作品上下文，不删本机原文；主评论及已有同一用户 comments 不静默截断，真正超预算则不发请求。</p><p>缺失描述与平台明确空文字分别记录。“描述待补充”意味着尚未取得真实文字，“作品无文字描述”意味着平台已明确返回空文本。</p></div></div>',
  '<h3>Excel 单表分组与完整长文本</h3><p>导出文件只有 ' + code('获客线索') + ' 一个页签。上方每行一条评论线索，按主要字段、基础信息、视频与图文、评论信息、用户信息横向分组；冻结前四行与前四列，筛选范围只包含线索。UID、sec_uid、作品 ID 与评论 ID 保持文本格式。下方独立“作品资料”区域保留上次采集时间、采集次数。“当前筛选”和“已勾选”只附带本次线索关联的作品；“全部线索”和旧版 GET 导出保留全部作品，包括无评论作品。作品信息按作品 ID 关联，不按行号拼接。</p><p>单元格超过 ' + esc(excelLimits.maxCellChars) + ' 个字符或 ' + esc(excelLimits.maxCellLineFeeds) + ' 个换行时，主表仅放摘要和全文位置，原文分段写入同一页签下方“完整文本”区域。按记录类型、编号、字段 key 和分段序号定位全文；每段限制 ' + esc(excelLimits.segmentChars) + ' 字符及 ' + esc(excelLimits.segmentLineFeeds) + ' 个换行，并检查 Excel 编码长度。“完整内容分段”列供阅读；“完整内容JSON”列逐段 ' + code('JSON.parse') + ' 后按分段序号拼接，可精确恢复 CRLF、反斜杠、控制字符与 Unicode，不受 Excel 特殊转义影响。不要把主表摘要误当作已删除正文。</p><p>本轮已保存图片数量与平台作品类型；全套图片链接和图片 OCR 尚未加入字段表。它们可以按后续真实响应扩展，当前不会把未实现能力标成已采集。</p></section>',
  '<section id="defaults"><h2>全新安装的默认配置</h2><p>以下数值读取当前源 ' + code('DEFAULT_SETTINGS') + '，属于本软件任务配置，不是抖音官方额度或不封号保证。首次升级采用这三组新节奏并开启采集后AI；后续保存过的新版节奏尊重用户自定义值。API Key、账号列表、旧浏览器资料、线索及联系记录保留；默认先使用外部浏览器沿用原资料（实际是否登录以平台返回为准）；首次切换内嵌内核需要逐账号重新扫码。</p>',
  infoTable(settingRows()),
  '<h3>默认业务资料</h3>' + infoTable([['公司业务', esc(selectedDefaults.business.businessDesc)], ['目标客户', esc(selectedDefaults.business.targetCustomers)], ['明确需求', esc(selectedDefaults.business.clearNeeds)], ['容易误判', esc(selectedDefaults.business.misjudgments)]]),
  '<p>AI Key 新安装为空。三份提示词都能保存，判断仅使用明确选中的一份；“AI 生成提示词”依据上述四项业务资料生成草稿，用户应用并保存后才启用，不直接替换正在使用的规则。</p></section>',
  '<section id="servers"><h2>服务器、数据位置和升级</h2>',
  infoTable([
    ['独立客户端', '安装到 ' + code(dictionary.servers.defaultInstallDir) + '；工作台与账号浏览器都在客户端窗口内。WebContentsView 承担扫码和抖音网页操作，账号标签切换独立资料。'],
    ['本机工作服务', code(dictionary.servers.localService) + '；只在本机回环地址工作，端口随启动确定，不需要向客户暴露或填写。'],
    ['授权服务', '<a href="https://huamao.xyz/dy-license/">https://huamao.xyz/dy-license/</a>；客户端通过 HTTPS 校验授权，每次对外操作前再检查。服务器地址是内置配置，客户设置界面不提供随意更换入口。'],
    ['网页管理系统', '<a href="https://huamao.xyz/dy-license/manage/">https://huamao.xyz/dy-license/manage/</a>；使用管理员身份网页登录。客户版不保留管理入口，采集账号登录与软件授权账号分别管理。'],
    ['AI 服务', '<a href="' + esc(defaults.ai.baseUrl) + '">' + esc(defaults.ai.baseUrl) + '</a>；远程 HTTPS 请求使用客户自行配置的 API Key。'],
    ['本机数据', code(dictionary.servers.defaultDataDir) + '；设置、账号、线索、作品、操作结果和浏览器资料保存在本机，授权管理服务器不承担这些本机采集记录。'],
    ['数据文件', code('settings.json / accounts.json / leads.json / videos.json') + '，以及 ' + code('daily.json / cooldowns.json / plans.json / task-checkpoint.json / logs / electron-profiles / chrome-profiles') + '。electron-profiles 保存内嵌登录；chrome-profiles 保存外部专用浏览器登录，切回外部继续使用。两者不自动互相导入。数据目录被显式改过时，以客户端显示的本机数据目录为准。'],
    ['数据结构', '当前保存的是本机 JSON 文件，并非 SQL 数据库。' + code('leads.json') + ' 的线索与 ' + code('videos.json') + ' 的作品按字符串作品 ID 关联，长 ID 不转换成可能丢精度的数值。统一字段字典作为展示、读取和导出的结构契约。']
  ]),
  '<h3>升级保留现有数据</h3><ol><li>完成本次采集或主动停止任务。</li><li>关闭客户端及旧版曾启动的外部抖音浏览器；新版正常退出会先停止任务并等待账号会话 flush，再销毁页面和主窗口。不要退出账号或删除资料。</li><li>新装默认 D 盘，升级优先沿用原安装目录；如果以前使用绿色版，请手动选择同一目录。升级保留 API Key、账号列表、旧浏览器资料、线索和联系历史。已迁移的新流程和三组节奏不再重置；内嵌内核使用独立 electron-profiles，每个账号首次需重新扫码，旧 chrome-profiles 不删除不转换。模型、自定义业务资料、话术和额度保留；已知未修改内置提示词及对应默认业务资料按精确匹配迁移。新政策导致原判断版本失效，需要重新判断，不删除历史。</li><li>重新打开客户端。已有作品文字会关联到原线索；真正缺失的图文可加入队列并勾选强制重采补齐。评论按规则去重，历史触达结果保留。</li></ol>',
  '<p class="note">' + esc(installedStatusAtReview.reason) + ' 全新安装包不携带测试记录、客户 API 或历史操作数据。未经核实的动作结果仍需要人工核验。</p></section>',
  '<section id="maintenance"><h2>以后调整字段怎样保持同步</h2><ol><li>统一修改 ' + code('dy-lead-app/lib/lead-fields.js') + '：紧凑主表由 compactColumns 的 key、label、width、fields 维护合并列；原始字段 registry 继续定义标签、顺序、分组、类型、来源映射和取值方式。</li><li>后端 ' + code('/api/state') + '、' + code('/api/leads') + ' 提供同一份 ' + code('leadFields') + ' 与每条记录的 ' + code('fieldValues') + '。主表读取 compactColumns，附加字段与详情使用原始 fields；不要为缩窄主表删除原始字段。</li><li>Excel 按原始 registry 保留完整表头和分组数据，不随紧凑主表合并或删列。本文及 JSON 字段字典由 ' + code('node build-tools/generate-field-guide.js ' + version) + ' 重新生成。</li><li>若只是改标签、排序或展示已有字段，旧数据仍可读。如果新增的是尚未采集的响应字段，还需要增加对应采集解析与来源记录、回归检查，再采集到真实值；改表头本身不能创造数据。</li><li>补充字段显示偏好属于本机界面偏好；字段增删不改筛选逻辑、冻结计划或历史触达结果。</li></ol>',
  '<p>字段字典下载：<a href="' + esc(encodeURIComponent(baseName + '.json')) + '">' + esc(baseName + '.json') + '</a>。字典包含字段 key、标签、物理信息分类、显示分类、原字段映射、来源路径记录、默认设置及源文件摘要校验。</p></section>',
  '</main><footer>生成时间：' + esc(generatedAt) + ' · 客户端版本 ' + esc(version) + ' · 源字段字典版本 ' + esc(schema.version) + '<br>此文件仅包含公开字段定义和全新默认配置，不包含客户身份记录、API Key、登录资料或签名请求地址。</footer></body></html>'
].join('\n');

// Keep dictionary JSON and HTML alongside each other; consumers can re-generate
// them after a registry edit rather than copying a second field list.
const htmlFile = path.join(outputDir, baseName + '.html');
const jsonFile = path.join(outputDir, baseName + '.json');
fs.writeFileSync(htmlFile, html, 'utf8');
fs.writeFileSync(jsonFile, JSON.stringify(dictionary, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify({ ok: true, applicationVersion: version, schemaVersion: schema.version, fieldCount: schema.fields.length, primaryFieldCount: mainFields.length, compactColumnCount: compactColumns.length, html: htmlFile, dictionary: jsonFile, customerDataRead: false }, null, 2) + '\n');
