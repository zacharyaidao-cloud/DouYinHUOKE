/**
 * 抖音获客软件 - 数据存储（本地 JSON，原子写入）
 * 数据目录可通过根目录 config.json 的 dataDir 指定专用路径（如 D:\抖音获客数据），
 * 不配置则默认保存在软件目录下的 data 文件夹。
 */
const fs = require('fs');
const path = require('path');
const { CONTACT_POLICY, LEGACY_CONTACT_POLICY_V2211, CONTEXT_TEMPLATE } = require('./lib/ai-policy');
const { DEFAULT_KEYWORDS, normalizeKeywords, keywordSignature, isLegacyDefaultKeywords, reclassifyLeads } = require('./lib/keyword-screen');

let DATA_DIR = path.join(__dirname, 'data');
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8').replace(/^\uFEFF/, ''));
  if (cfg && cfg.dataDir && String(cfg.dataDir).trim()) {
    DATA_DIR = String(cfg.dataDir).trim();
  }
} catch (e) { /* 无配置则用默认目录 */ }
if (process.env.DY_LEAD_DATA_DIR) DATA_DIR = path.resolve(process.env.DY_LEAD_DATA_DIR);
const LOG_DIR = path.join(DATA_DIR, 'logs');
const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profiles');

/** 读取程序根目录 config.json（数据目录 + 内置授权配置） */
function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) { return {}; }
}

function ensureDirs() {
  [DATA_DIR, LOG_DIR, PROFILE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}
ensureDirs();

// 解析结果缓存：以文件 mtime + size 判定是否变化（外部改写文件也会自动失效）。
// 调用方会修改返回值再 set 回去，所以每次返回深拷贝，缓存本体只读。
// 线索上万条时，触达流程每个用户要读几十次 leads.json，缓存省掉重复的磁盘读取与解析。
const parsedCache = new Map();
function readJson(file, fallback) {
  try {
    const stat = fs.statSync(file);
    const cached = parsedCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return structuredClone(cached.value);
    const raw = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    const value = JSON.parse(raw);
    parsedCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return structuredClone(value);
  } catch (e) {
    parsedCache.delete(file);
    if (e.code === 'ENOENT') return fallback;
    throw new Error('数据文件读取失败，请保留原文件并从备份恢复：' + path.basename(file));
  }
}

// 大数据文件（线索、作品）用紧凑格式写入，体积约小三分之一；配置类文件保留缩进便于人工查看。
function compactFile(file) { return file === F.leads || file === F.videos || file === F.searchResults; }
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  parsedCache.delete(file);
  fs.writeFileSync(tmp, compactFile(file) ? JSON.stringify(obj) : JSON.stringify(obj, null, 2), 'utf-8');
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(tmp, file);
}

const F = {
  accounts: path.join(DATA_DIR, 'accounts.json'),
  leads: path.join(DATA_DIR, 'leads.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  videos: path.join(DATA_DIR, 'videos.json'),
  cooldowns: path.join(DATA_DIR, 'cooldowns.json'),
  daily: path.join(DATA_DIR, 'daily.json'),
  plans: path.join(DATA_DIR, 'plans.json'),
  checkpoint: path.join(DATA_DIR, 'task-checkpoint.json'),
  searchResults: path.join(DATA_DIR, 'search-results.json'),
  dmAccountState: path.join(DATA_DIR, 'dm-account-state.json'),
  contactAllocation: path.join(DATA_DIR, 'contact-allocation.json'),
  keywordStats: path.join(DATA_DIR, 'keyword-stats.json'),
  migrations: path.join(DATA_DIR, 'migrations.json'),
  inbox: path.join(DATA_DIR, 'inbox.json'),
  searchDraft: path.join(DATA_DIR, 'search-draft.json')
};

const LEGACY_BUILTIN_PROMPT = '依据公司业务、目标客户、明确需求和容易误判的说明，判断评论用户是否存在亚马逊账户申诉、激活、解封或资金解冻的服务需求。描述自己的相关账户问题，或结合视频上下文询问处理方式、服务费用、联系方式，且符合业务范围时判为“是”。明确无自身需求、同行广告、招代理、卖货或其他平台问题判为“否”。只有泛泛提问、围观、质疑，或需求对象无法确定时判为“待确认”，不得仅凭关键词认定需求。UID和昵称仅用于标识上下文，不能作为需求证据；不能承诺申诉成功或编造用户经历。评分表示现有需求证据强弱，理由指出具体评论证据。\n\n【用户评论】{需求内容}\n【评论时间】{评论时间}\n【用户UID】{UID}\n【用户名称】{昵称}\n【所在视频描述】{视频描述}';
const LEGACY_BUILTIN_BUSINESS = {
  businessDesc:'我们提供亚马逊账号申诉、激活、解封、资金解冻服务',
  targetCustomers:'经营亚马逊店铺，遇到账户停用、申诉失败、激活或资金冻结问题的卖家',
  clearNeeds:'评论明确描述自己的亚马逊账户问题，或询问此类问题的处理方式、服务费用、联系方式',
  misjudgments:'同行广告、招代理、卖货、仅围观或讨论视频观点；没有自身问题的泛泛提问；其他平台账户问题；不可因出现申诉、解封等词语就认定有需求'
};
const PREVIOUS_INDUSTRY_PROMPT = '依据公司业务、目标客户、明确需求和容易误判的说明，判断评论用户是否可考虑联系，而不是是否已确认购买需求。评论或作品上下文涉及亚马逊账户申诉、激活、解封、资金解冻等业务相关咨询、疑问、经验交流或自身问题，且没有明确排除证据时判为“是”。未说明自己的账户问题或需求尚不明确也保留为“是”，理由可写“需求未明，业务相关”。明确业务无关、同行广告、拒绝联系、已经解决或明确无需服务才判为“否”；纯表情或路过等无业务相关内容可排除。不能因质疑、泛泛提问或分享经验直接排除相关用户。缺少上下文不编造用户经历、确定需求或成交意向，不承诺成功。UID和昵称仅标识上下文。只输出“是/否”及不超过30字符的简短理由，不输出评分或待确认。\n\n【用户评论】{需求内容}\n【评论时间】{评论时间}\n【用户UID】{UID}\n【用户名称】{昵称}\n【所在视频描述】{视频描述}';
const PREVIOUS_BUILTIN_BUSINESS = {
  businessDesc:'我们提供亚马逊账号申诉、激活、解封、资金解冻服务',
  targetCustomers:'经营亚马逊店铺，遇到账户停用、申诉失败、激活或资金冻结问题的卖家',
  clearNeeds:'业务相关的咨询、疑问、经验交流或账户问题；即使未明确服务需求，没有明确排除证据也可考虑联系',
  misjudgments:'明确业务无关、同行广告、拒绝联系、已经解决或明确无需服务；纯表情或路过且无相关内容。不能因质疑、经验分享、泛泛提问或未描述自身问题直接排除业务相关用户'
};
// Exact 2.2.11 defaults are migration identifiers, never new judgment rules.
const WIDE_V2211_INDUSTRY_PROMPT = '业务范围：亚马逊账户申诉、激活、解封、资金解冻。结合公司业务和目标客户判断。\n' + LEGACY_CONTACT_POLICY_V2211 + '\n只输出“是/否”及不超过30字符的简短理由，不输出评分或待确认。\n\n' + CONTEXT_TEMPLATE;
const WIDE_V2211_BUILTIN_BUSINESS = {
  businessDesc:'我们提供亚马逊账号申诉、激活、解封、资金解冻服务',
  targetCustomers:'经营亚马逊店铺，遇到账户停用、申诉失败、激活或资金冻结问题的卖家',
  clearNeeds:'评论结合亚马逊账户服务话题询问处理办法、费用、联系、真假或分享账户经历；未说明本人问题但业务相关仍可考虑联系，不等于确认购买需求',
  misjudgments:'明确提供服务揽客、无关业务、拒绝、全部问题已解决且无后续求助、纯表情或赞美才排除。不能凭短评、昵称、服务商或案例一词猜同行；作品作者的问题不是评论者本人问题'
};
const DEFAULT_INDUSTRY_PROMPT = '业务范围：亚马逊账户申诉、激活、解封、资金解冻。结合公司业务和目标客户判断。\n' + CONTACT_POLICY + '\n只输出“是/否”及不超过30字符的简短理由，不输出评分或待确认。\n\n' + CONTEXT_TEMPLATE;
const DEFAULT_SETTINGS = {
  collect: {
    scrollIntervalSec: 3, scrollJitter: 0.4, maxScrolls: 120, cooldownHours: 24, dailyVideoLimit: 240, worksPerAccount: 10,
    skipEmptyText: true,
    linkIntervalSec: 10, linkIntervalJitter: 0.2, autoAiAfterCollect: true
  },
  action: { userIntervalSec: 20, userIntervalJitter: 0.25, pacingVersion: 1 },
  follow: { enabled: true, dailyLimit: 150 },
  dm: {
    enabled: true,
    template: '你好，我们是专门处理亚马逊账户问题的，有问题可以随时联系',
    dailyLimit: 150,
    skipAuthor: true,
    repeat: { enabled: false, intervalDays: 7 },
    // 2026-10-21 实测：单账号约 11–12 条陌生人私信/10 分钟即触发“频繁”，完全安静约 60 分钟后恢复。
    // 默认每发 10 条休息 55–60 分钟，主动避开频繁；多账号时由账号轮换消化这段休息。
    // 2026-10-21 用户确认的节奏：单号每发 5 条休息 5 分钟
    sessionPause: { count: 5, pauseMinSec: 300, pauseMaxSec: 300 },
    // 多账号私信分发（v2 设计）
    poolAccounts: [],
    // 触发频繁后暂停：30 分钟 → 仍频繁 1 小时 → 仍频繁 2 小时（基准 × 2^n，封顶 2 小时）；计时从触发时刻开始
    frequentCooldownSec: 1800,
    dailyResetHour: 8,
    batchPerAccount: 5, // 多号：每号每轮 5 人后立即切换下一个号
    roundRestSec: 300, // 多号：所有号都发过一轮后统一休息 5 分钟（单号同样每轮休息）
    accountSwitchIntervalSec: 0,
    adaptiveCap: true,
    maxFrequentRetriesPerDay: 3, // 频繁后连续试发 3 次仍频繁 → 按今日上限停用
    sameVideoPerBatch: 2
  },
  search: {
    enabled: true,
    intervalSec: 20, intervalJitter: 0.3,
    // publishedWithinDays：只保留最近 N 天发布的作品（0=不限），旧作品不进入评论采集
    maxPages: 20, dailySearchLimit: 30, minCommentCount: 0, publishedWithinDays: 30
  },
  keywords: { intent: [...DEFAULT_KEYWORDS.intent], exclude: [...DEFAULT_KEYWORDS.exclude] },
  human: {
    timeZone: 'Asia/Shanghai', maxConsecutiveErrors: 3
  },
  outreach: { businessId: 'default' },
  ai: {
    enabled: true,
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-flash',
    businessDesc: '我们提供亚马逊账号申诉、激活、解封、资金解冻服务',
    targetCustomers: '遇到亚马逊账户停用、申诉、激活或资金问题的卖家，以及询问处理办法、服务费用、联系方式或真实性的用户（含代朋友咨询）',
    clearNeeds: '评论者描述本人或朋友当前相关问题，或向服务方询问处理办法、能否处理、费用、联系方式、服务真实性；具体账户问题作品下主动说“我也是、同样收到、跟你一样、就是这个情况”已指向自身问题，判是，不要求再写怎么办，也不要求明确购买或写“我的店”',
    misjudgments: '作者求助不能直接移植给评论者，但评论主动表示本人或朋友遇到同样当前问题则判是；仅回答作者、提供能力案例、转介绍、纯评价和既往经验无新问题或咨询判否。业务相关、未拒绝、无法证明同行不足以判是；理由不猜同行、不编造本人问题细节',
    requestTimeoutSec: 60,
    autoJudgeWindowDays: 7,
    batchMode: 'auto',
    batchMaxChars: 24000,
    batchMaxCount: 20,
    activePromptId: 'prompt-1',
    promptPresets: [
      { id: 'prompt-1', name: '亚马逊账户服务', prompt: DEFAULT_INDUSTRY_PROMPT },
      { id: 'prompt-2', name: '提示词 2', prompt: '' },
      { id: 'prompt-3', name: '提示词 3', prompt: '' }
    ]
  },
  license: { enabled: true, serverUrl: '' }
};

function getAccounts() { return readJson(F.accounts, []); }
function setAccounts(list) { writeJson(F.accounts, list); }

function getLeads() { return readJson(F.leads, []); }
function setLeads(list) { writeJson(F.leads, list); }

function normalizeSettings(s = {}) {
  const merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const k of Object.keys(merged)) {
    if (s[k]) merged[k] = { ...merged[k], ...s[k] };
  }
  // 仅精确旧内置词表迁移；自定义候选与排除词始终保留。
  if (isLegacyDefaultKeywords(s.keywords)) merged.keywords = { intent: [...DEFAULT_KEYWORDS.intent], exclude: [...DEFAULT_KEYWORDS.exclude] };
  merged.keywords = normalizeKeywords(merged.keywords);
  merged.dm.repeat = { ...DEFAULT_SETTINGS.dm.repeat, ...(s.dm && s.dm.repeat || {}) };
  merged.dm.sessionPause = { ...DEFAULT_SETTINGS.dm.sessionPause, ...(s.dm && s.dm.sessionPause || {}) };
  // 多账号分发设置归一化
  for (const field of ['frequentCooldownSec', 'dailyResetHour', 'batchPerAccount', 'roundRestSec', 'accountSwitchIntervalSec', 'maxFrequentRetriesPerDay', 'sameVideoPerBatch']) {
    const value = Number(merged.dm[field]);
    merged.dm[field] = Number.isFinite(value) ? value : DEFAULT_SETTINGS.dm[field];
  }
  merged.dm.dailyResetHour = Math.min(23, Math.max(0, Math.floor(merged.dm.dailyResetHour)));
  merged.dm.adaptiveCap = typeof merged.dm.adaptiveCap === 'boolean' ? merged.dm.adaptiveCap : true;
  if (!Array.isArray(merged.dm.poolAccounts)) merged.dm.poolAccounts = [];
  else merged.dm.poolAccounts = merged.dm.poolAccounts.filter(p => p && p.accountId)
    .map(p => ({ accountId: String(p.accountId), template: typeof p.template === 'string' ? p.template : '' }));
  merged.search = { ...DEFAULT_SETTINGS.search, ...(s.search || {}) };
  // 已废弃的执行开关：曾经保存但从未参与判定，继续保留会让用户误以为生效。
  delete merged.collect.enrichProfiles;
  delete merged.follow.onlyIntent; delete merged.follow.onlyAi;
  delete merged.dm.onlyIntent; delete merged.dm.onlyAi;
  // 用户明确改为三处节奏。首次升级统一迁移，保存 marker 后保留后续自定义值。
  // 只改节奏字段；不涉及客户 API、额度、话术、账号或已采集数据。
  if (s.action?.pacingVersion !== 1) {
    for (const field of ['scrollIntervalSec', 'scrollJitter', 'linkIntervalSec', 'linkIntervalJitter', 'autoAiAfterCollect']) {
      merged.collect[field] = DEFAULT_SETTINGS.collect[field];
    }
    merged.action.userIntervalSec = DEFAULT_SETTINGS.action.userIntervalSec;
    merged.action.userIntervalJitter = DEFAULT_SETTINGS.action.userIntervalJitter;
    merged.action.pacingVersion = 1;
  }
  // 2026-10-21 用户确认的私信节奏（单号每 5 条休息 5 分钟；多号每号 5 人、立即切号、一轮后休息 5 分钟；
  // 频繁 30 分钟 / 1 小时 / 2 小时，连续试发 3 次仍频繁今日停用）。首次升级统一迁移，之后保留用户自定义值。
  if (s.dm?.pacingVersion !== 2) {
    merged.dm.sessionPause = { ...DEFAULT_SETTINGS.dm.sessionPause };
    for (const field of ['frequentCooldownSec', 'batchPerAccount', 'roundRestSec', 'accountSwitchIntervalSec', 'maxFrequentRetriesPerDay']) merged.dm[field] = DEFAULT_SETTINGS.dm[field];
    merged.dm.pacingVersion = 2;
  }
  delete merged.action.intervalMinSec; delete merged.action.intervalMaxSec;
  delete merged.follow.intervalMinSec; delete merged.follow.intervalMaxSec;
  delete merged.dm.intervalMinSec; delete merged.dm.intervalMaxSec;
  merged.human = { timeZone: merged.human.timeZone, maxConsecutiveErrors: merged.human.maxConsecutiveErrors };
  delete merged.ai.intervalSec; delete merged.ai.intervalJitter;
  const oldAI = s.ai || {};
  merged.ai.batchMode = oldAI.batchMode === 'manual' ? 'manual' : 'auto';
  const builtinPreset=Array.isArray(oldAI.promptPresets)&&oldAI.promptPresets.find(p=>p?.id==='prompt-1');
  const builtinMigration=builtinPreset?.name==='亚马逊账户服务'&&[
    {prompt:LEGACY_BUILTIN_PROMPT,business:LEGACY_BUILTIN_BUSINESS,upgradeOldBudget:true},
    {prompt:PREVIOUS_INDUSTRY_PROMPT,business:PREVIOUS_BUILTIN_BUSINESS},
    {prompt:WIDE_V2211_INDUSTRY_PROMPT,business:WIDE_V2211_BUILTIN_BUSINESS}
  ].find(profile=>builtinPreset.prompt===profile.prompt&&Object.entries(profile.business).every(([field,value])=>oldAI[field]===value));
  if(builtinMigration) {
    // 只更新未修改的内置槽；保留其它两份预设及其启用选择。
    merged.ai.promptPresets=oldAI.promptPresets.map(p=>p.id==='prompt-1'?{...p,prompt:DEFAULT_INDUSTRY_PROMPT}:{...p});
    merged.ai.targetCustomers=DEFAULT_SETTINGS.ai.targetCustomers;
    merged.ai.clearNeeds=DEFAULT_SETTINGS.ai.clearNeeds;merged.ai.misjudgments=DEFAULT_SETTINGS.ai.misjudgments;
    const plainLegacySlots=oldAI.activePromptId==='prompt-1'&&oldAI.promptPresets.slice(1).every(p=>!p.prompt);
    if(builtinMigration.upgradeOldBudget&&plainLegacySlots&&oldAI.batchMaxChars===3000&&oldAI.batchMaxCount===20) merged.ai.batchMaxChars=DEFAULT_SETTINGS.ai.batchMaxChars;
  }
  if (!Object.hasOwn(oldAI, 'clearNeeds') && Object.hasOwn(oldAI, 'positiveExamples')) merged.ai.clearNeeds = String(oldAI.positiveExamples || '');
  if (!Object.hasOwn(oldAI, 'misjudgments') && (Object.hasOwn(oldAI, 'exclusions') || Object.hasOwn(oldAI, 'ambiguousCases'))) merged.ai.misjudgments = [oldAI.exclusions, oldAI.ambiguousCases].filter(Boolean).join('\n');
  delete merged.ai.positiveExamples; delete merged.ai.exclusions; delete merged.ai.ambiguousCases;
  if (!Array.isArray(oldAI.promptPresets) && typeof oldAI.prompt === 'string' && oldAI.prompt.trim()) {
    merged.ai.promptPresets[0] = { id: 'prompt-1', name: '原有提示词', prompt: oldAI.prompt };
    merged.ai.activePromptId = 'prompt-1';
  }
  const active = Array.isArray(merged.ai.promptPresets) && merged.ai.promptPresets.find(p => p.id === merged.ai.activePromptId);
  merged.ai.prompt = active ? active.prompt : '';
  // 客户端只支持 DeepSeek 官方固定服务；旧通用地址不再继续使用。
  merged.ai.baseUrl = 'https://api.deepseek.com';
  // 客户端不保存管理密钥；授权端点由程序配置固定。
  merged.license = { enabled: true, serverUrl: String(getConfig().license?.serverUrl || '') };
  return merged;
}
function getSettings() { return normalizeSettings(readJson(F.settings, {})); }
function getIndustryProfile() {
  const businessInput=Object.fromEntries(['businessDesc','targetCustomers','clearNeeds','misjudgments'].map(field=>[field,DEFAULT_SETTINGS.ai[field]]));
  return { businessInput, prompt:DEFAULT_INDUSTRY_PROMPT, keywords:JSON.parse(JSON.stringify(DEFAULT_SETTINGS.keywords)) };
}
function setSettings(s) {
  const previous = readJson(F.settings, {}), next = normalizeSettings(s);
  if (keywordSignature(previous.keywords || DEFAULT_KEYWORDS) !== keywordSignature(next.keywords)) {
    // 保存规则时一次重算历史初筛；不修改 AI 回执、账号及关注私信记录。
    // 先读完数据，损坏线索文件时拒绝保存，避免掩盖原文件。
    const screening = reclassifyLeads(getLeads(), next.keywords);
    if (screening.changed) setLeads(screening.leads);
  }
  writeJson(F.settings, next);
}

function getVideos() { return readJson(F.videos, {}); }
function setVideos(v) { writeJson(F.videos, v); }

function getCooldowns() { return readJson(F.cooldowns, {}); }
function setCooldowns(c) { writeJson(F.cooldowns, c); }

/** 每日用量：{ 'acctId': { '2026-10-07': {follow: n, dm: n, videos: n} } } */
function getDaily() { return readJson(F.daily, {}); }
function setDaily(d) { writeJson(F.daily, d); }
function getPlans() { return readJson(F.plans, []); }
function setPlans(plans) { writeJson(F.plans, plans); }
function getTaskCheckpoint() { return readJson(F.checkpoint, null); }
function setTaskCheckpoint(checkpoint) { writeJson(F.checkpoint, checkpoint); }

/** 搜索找作品结果：{keyword, workType, results:[{awemeId,desc,authorName,authorUid,commentCount,workType,link,foundAt}], updatedAt} */
function getSearchResults() {
  try {
    const list = readJson(F.searchResults, []);
    return Array.isArray(list) ? list.map(work => ({ ...work, workType: require('./lib/search-works').searchWorkType(work) })) : [];
  } catch (e) { return []; }
}
function setSearchResults(list) { writeJson(F.searchResults, Array.isArray(list) ? list : []); }

/** 私信归集：各账号的会话与消息（见 lib/inbox-store.js） */
function getInbox() { const raw = readJson(F.inbox, { accounts: {} }); return raw && typeof raw === 'object' && raw.accounts && typeof raw.accounts === 'object' ? raw : { accounts: {} }; }
function setInbox(inbox) { writeJson(F.inbox, inbox && inbox.accounts ? inbox : { accounts: {} }); }

/** 一次性数据迁移的完成标记（如 leadDedupeV1：合并跨账号重复线索） */
function getMigrations() { const raw = readJson(F.migrations, {}); return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
function setMigrations(marks) { writeJson(F.migrations, marks); }
/** 把数据文件完整复制一份备份（迁移改写前调用），返回备份文件名 */
function backupDataFile(name, tag) {
  const file = F[name];
  if (!file || !fs.existsSync(file)) return '';
  const stamp = nowStr().replace(/[-: ]/g, '').slice(0, 14);
  const target = file.replace(/\.json$/, `.${tag}-${stamp}.json`);
  fs.copyFileSync(file, target);
  return path.basename(target);
}

/** 关键词统计（见 lib/keyword-stats.js）与搜索输入草稿（关键词与搜索选项，重启后恢复） */
function getKeywordStats() { const raw = readJson(F.keywordStats, {}); return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
function recordKeywordSearch(keyword, run) {
  const { recordKeywordRun } = require('./lib/keyword-stats');
  writeJson(F.keywordStats, recordKeywordRun(getKeywordStats(), keyword, { ...run, at: nowStr() }));
}
const DRAFT_FIELDS = { keywords: 'string', workType: 'string', minComments: 'string', publishedWithinDays: 'string', maxPages: 'string' };
function getSearchDraft() { const raw = readJson(F.searchDraft, {}); return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
function setSearchDraft(input = {}) {
  const draft = {};
  for (const [key, type] of Object.entries(DRAFT_FIELDS)) if (input[key] != null) draft[key] = String(input[key]).slice(0, key === 'keywords' ? 5000 : 20);
  writeJson(F.searchDraft, { ...draft, savedAt: nowStr() });
  return draft;
}
function addSearchResults(keyword, workType, works) {
  const list = getSearchResults();
  const seen = new Set(list.map(x => String(x.awemeId)));
  let added = 0;
  for (const work of works) {
    if (!work || !work.awemeId || seen.has(String(work.awemeId))) continue;
    seen.add(String(work.awemeId));
    added++;
    list.push({ ...work, keyword: String(keyword || ''), workType: require('./lib/search-works').searchWorkType(work, workType), searchType: String(workType || 'video'), foundAt: nowStr() });
  }
  // 保留最近 3000 条（深翻单个关键词就有 100+ 条），避免无限增长
  setSearchResults(list.slice(-3000));
  return added;
}

function todayStr() {
  const timeZone = getSettings().human.timeZone || 'Asia/Shanghai';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 运营日：每日额度与账号状态按"早 dailyResetHour 点"切日（默认8点前算前一天） */
function opDayStr() {
  try {
    const settings = getSettings();
    const resetHour = Math.min(23, Math.max(0, Math.floor(Number(settings.dm && settings.dm.dailyResetHour) || 8)));
    const timeZone = settings.human && settings.human.timeZone || 'Asia/Shanghai';
    const shifted = new Date(Date.now() - resetHour * 3600000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(shifted).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch (e) { return todayStr(); }
}

/** 下一个 dailyResetHour 点的本地绝对时刻（毫秒），用于"今日停用"截止 */
function nextResetMs(now = Date.now()) {
  try {
    const settings = getSettings();
    const resetHour = Math.min(23, Math.max(0, Math.floor(Number(settings.dm && settings.dm.dailyResetHour) || 8)));
    const timeZone = settings.human && settings.human.timeZone || 'Asia/Shanghai';
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(fmt.formatToParts(new Date(now)).map(x => [x.type, x.value]));
    const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const offset = localAsUtc - Math.floor(now / 1000) * 1000; // 该时区相对 UTC 的偏移
    let target = Date.UTC(+p.year, +p.month - 1, +p.day, resetHour, 0, 0) - offset;
    if (target <= now) target += 86400000;
    return target;
  } catch (e) { return Date.now() + 86400000; }
}

function nowStr() {
  // 历史展示时间统一为北京时间，避免旧数据的无时区时间被错误解释。
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function getDailyUsage(accountId) {
  const daily = getDaily();
  const t = opDayStr();
  const usage = daily[accountId] && daily[accountId][t] || {};
  return { follow: 0, dm: 0, videos: 0, profileVisits: 0, ...usage,
    followAttempts: usage.followAttempts ?? usage.follow ?? 0,
    dmAttempts: usage.dmAttempts ?? usage.dm ?? 0,
    collectAttempts: usage.collectAttempts ?? usage.videos ?? 0 };
}

function bumpDaily(accountId, field) {
  const daily = getDaily();
  const t = opDayStr();
  if (!daily[accountId]) daily[accountId] = {};
  if (!daily[accountId][t]) daily[accountId][t] = { follow: 0, dm: 0, videos: 0 };
  const previous = daily[accountId][t][field] ?? ({followAttempts:'follow',dmAttempts:'dm',collectAttempts:'videos'}[field] ? daily[accountId][t][{followAttempts:'follow',dmAttempts:'dm',collectAttempts:'videos'}[field]] : 0);
  daily[accountId][t][field] = (Number(previous) || 0) + 1;
  setDaily(daily);
}

function log(accountId, line) {
  try {
    const file = path.join(LOG_DIR, `${safeId(accountId)}-${todayStr()}.log`);
    fs.appendFileSync(file, `[${nowStr()}] ${line}\n`, 'utf-8');
  } catch (e) { /* ignore */ }
}

function tailLog(accountId, lines = 80) {
  try {
    const file = path.join(LOG_DIR, `${safeId(accountId)}-${todayStr()}.log`);
    if (!fs.existsSync(file)) return [];
    const txt = fs.readFileSync(file, 'utf-8');
    return txt.split('\n').filter(Boolean).slice(-lines);
  } catch (e) { return []; }
}

function profileDir(accountId) {
  return path.join(PROFILE_DIR, safeId(accountId));
}
function safeId(id) {
  const value = String(id);
  if (!/^[\w-]{1,100}$/.test(value)) throw new Error('账号标识无效');
  return value;
}

/** 私信分发账号状态（频繁冷却/今日停用/经验上限），跨日自愈由调用方执行 */
function getDmAccountState() {
  try { return readJson(F.dmAccountState, {}); } catch (e) { return {}; }
}
function setDmAccountState(state) { writeJson(F.dmAccountState, state && typeof state === 'object' ? state : {}); }

/** 触达分配锁：{ "业务|uid": { accountId, kind, plannedAt, consumed } } */
function getAllocations() {
  try { return readJson(F.contactAllocation, {}); } catch (e) { return {}; }
}
function setAllocations(allocations) { writeJson(F.contactAllocation, allocations && typeof allocations === 'object' ? allocations : {}); }

module.exports = {
  F, DATA_DIR, LOG_DIR, PROFILE_DIR,
  getConfig,
  getAccounts, setAccounts, getLeads, setLeads,
  getSettings, setSettings, normalizeSettings, getIndustryProfile, getVideos, setVideos,
  getCooldowns, setCooldowns, getDaily, setDaily,
  getPlans, setPlans, getTaskCheckpoint, setTaskCheckpoint,
  getSearchResults, setSearchResults, addSearchResults, getKeywordStats, recordKeywordSearch, getSearchDraft, setSearchDraft, getMigrations, setMigrations, backupDataFile, getInbox, setInbox,
  getDmAccountState, setDmAccountState, getAllocations, setAllocations,
  todayStr, nowStr, opDayStr, nextResetMs, getDailyUsage, bumpDaily,
  log, tailLog, profileDir, DEFAULT_SETTINGS
};
