'use strict';

// Verify the shipping AI engine with throwaway data and an in-process provider
// mock. There is no browser, installed profile, real DeepSeek call or paid API.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const sourceMode = process.argv.includes('--source');
const APP = path.join(ROOT, sourceMode ? 'dy-lead-app' : 'dy-lead-app-release');
const REPORT = path.join(__dirname, sourceMode ? 'ai-source-verification.json' : 'ai-build-verification.json');
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-ai-build-'));
process.env.DY_LEAD_DATA_DIR = path.join(fixture, 'data');
const originalFetch = globalThis.fetch;
const syntheticKey = 'mock-ai-release-key-never-sent-to-network';
const workId = '7000000000000000011';
const workLink = 'https://www.douyin.com/note/' + workId;
const title = '本地隔离亚马逊账号业务图文';
const longBody = '本地图文业务内容及操作记录。'.repeat(1700) + '末尾证据：保留实际内容，不编造用户需求';
const videos = { [workId]: { id: workId, videoLink: workLink, kind: 'note', awemeType: 68,
  workTitle: title, workContent: longBody, workText: title + '\n' + longBody, desc: title + '\n' + longBody,
  workTextState: 'available', workTextSource: 'api', workCapturedAt: '2026-10-08 12:00:00' } };
const demands = ['账号停用了，谁处理过？', '路过', '这类情况需要哪些资料？', '凑个热闹，随便看看']; // 第4条须是“否”且不被同行预筛拦下（同行预筛另有单测）
const needByComment = new Map(demands.map((comment, i) => [comment, i % 2 === 0 ? '是' : '否']));
const requests = [];
const authorizations = [];
let responseMode = 'valid', deniedRequests = 0, draftText = '';
const customRuleMarker = 'MOCK_CUSTOM_RULE_MUST_REMAIN_USER_DATA';
const businessMarker = 'MOCK_BUSINESS_MUST_REMAIN_USER_DATA';

function rows(prefix, count, legacy = false) {
  return Array.from({ length: count }, (_, index) => ({ id: prefix + '-' + (index + 1), accountId: 'qa-ai-account',
    UID: '70000000000000001' + String(index).padStart(2, '0'), uid: 'qa_comment_user_' + index,
    nickname: '隔离评论用户' + (index + 1), time: '2026-10-08 12:00:00', demand: demands[index % demands.length], videoLink: workLink,
    isAuthor: false, intent: true, note: '保留本机备注', ...(legacy ? {
      aiNeed: '待确认', aiScore: 71 + index % 20, aiReason: '旧协议依据', aiDone: true,
      aiJudgedAt: '2026-10-07 12:00:00', aiPromptVersion: 'ai-v2-legacy-score', aiInputHash: 'old-input-hash'
    } : { aiScore: 31 + index % 50, aiDone: false }) }));
}

globalThis.fetch = async (address, options = {}) => {
  const url = new URL(String(address));
  const method = options.method || 'GET';
  if (url.href !== 'https://api.deepseek.com/models' || method !== 'GET') {
    if (url.href !== 'https://api.deepseek.com/chat/completions' || method !== 'POST') {
      deniedRequests++; throw new Error('Unknown outbound request rejected by local AI verifier');
    }
  }
  assert.equal(options.redirect, 'error', 'Provider transport must reject redirects');
  assert.equal(options.headers.Authorization, 'Bearer ' + syntheticKey);
  assert(options.signal instanceof AbortSignal, 'Every request must carry an abort signal');
  if (method === 'GET') {
    requests.push({ kind: 'models' });
    return { ok: true, status: 200, url: url.href, json: async () => ({ data: [{ id: 'deepseek-flash', name: 'Local mock model',
      context_window: 1048576, max_output_tokens: 393216 }] }) };
  }
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user');
  const payload = JSON.parse(body.messages[1].content);
  if (responseMode === 'draft') {
    assert.deepEqual(Object.keys(payload).sort(), ['businessDesc', 'clearNeeds', 'misjudgments', 'targetCustomers']);
    assert.match(body.messages[0].content, /不能复制本段生成器身份/);
    assert.match(body.messages[0].content, /不能再嵌套JSON对象/);
    assert(!body.messages[1].content.includes('qa_comment_user_'));
    requests.push({ kind: 'draft', body });
    return { ok: true, status: 200, url: url.href, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ prompt: draftText }) } }] }) };
  }
  assert.equal(typeof payload.businessRules, 'string');
  assert.deepEqual(Object.keys(payload.businessProfile).sort(), ['businessDesc', 'clearNeeds', 'misjudgments', 'targetCustomers']);
  assert(payload.businessRules.includes(customRuleMarker), 'Configured industry rules must be retained as user materials');
  assert(payload.businessProfile.businessDesc.includes(businessMarker), 'Configured industry scope must be retained as user materials');
  assert(!body.messages[0].content.includes(customRuleMarker), 'Configured custom rules must not become system instructions');
  assert(!body.messages[0].content.includes(businessMarker), 'Configured company text must not become system instructions');
  assert.match(body.messages[0].content, /作品作者的停用.*不能代替评论者本人的需求.*理由也不得这样归属/);
  assert.match(body.messages[0].content, /不能将同批其它用户的评论当作本条证据/);
  assert.match(body.messages[0].content, /求助帖下“有案例”是向作者提供案例/);
  assert.match(body.messages[0].content, /不能仅因业务相关、没有拒绝或无法证明同行就保留/);
  assert.match(body.messages[0].content, /need只能为“是”或“否”/);
  assert.match(body.messages[0].content, /reason为1至30个字符/);
  assert.equal(payload.total, payload.items.length);
  assert.equal(payload.works.length, 1, 'All local comments share one work context');
  assert.equal(payload.works[0].id, 'work-1');
  assert.equal(payload.works[0].workContext.truncated, true, 'Long source must carry an explicit truncation signal');
  assert.match(payload.works[0].videoDescription, /AI 上下文已明确省略中间部分/);
  for (const item of payload.items) {
    assert.equal(item.workRef, 'work-1');
    assert.equal(Object.hasOwn(item, 'videoDescription'), false, 'Do not repeat work text inside every comment');
    assert.equal(Object.hasOwn(item, 'context'), false, 'Do not duplicate fixed fields in a large per-row template');
    assert(needByComment.has(item.comment), 'Only the supplied synthetic comments may be judged');
  }
  requests.push({ kind: 'completion', responseMode, body, payload });
  const invalid = responseMode === 'invalid' || responseMode === 'fallback' && payload.total > 1
    || responseMode === 'split' && payload.total > 2;
  const output = payload.items.map(item => ({ i: item.i, need: needByComment.get(item.comment),
    reason: (payload.total > 1 ? '批量编号' : '单条编号') + item.i,
    ...(invalid ? { score: 99 } : {}) })).reverse();
  return { ok: true, status: 200, url: url.href,
    json: async () => ({ choices: [{ finish_reason: responseMode === 'length' && payload.total > 2 ? 'length' : 'stop',
      message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 1000 + payload.total * 60, completion_tokens: payload.total * 50, total_tokens: 1000 + payload.total * 110 } }) };
};

(async () => {
  let engine;
  try {
    fs.rmSync(REPORT, { force: true });
    const sourceFiles = ['engine.js', 'ai.js', 'engine-ai-tasks.js', 'lib/ai-policy.js'];
    const hashes = {};
    for (const file of sourceFiles) {
      const code = fs.readFileSync(path.join(APP, file), 'utf8');
      if (!sourceMode && !file.startsWith('lib/')) assert.match(code, /_0x[0-9a-f]+/i, file + ' must be the actual obfuscated release file');
      hashes[file] = crypto.createHash('sha256').update(code).digest('hex');
    }
    engine = require(path.join(APP, 'engine.js'));
    const AI = require(path.join(APP, 'ai.js'));
    const sharedPolicy = require(path.join(APP, 'lib', 'ai-policy.js'));
    const store = require(path.join(APP, 'store.js'));
    assert.equal(path.resolve(store.DATA_DIR), path.join(fixture, 'data'));
    assert.equal(typeof AI.buildJudgePayload, 'function');
    assert.deepEqual(AI.RESULT_CONTRACT.fields, ['i', 'need', 'reason']);
    assert.deepEqual(AI.RESULT_CONTRACT.needs, ['是', '否']);
    assert.equal(AI.RESULT_CONTRACT.maxReasonChars, 30);
    assert.equal(AI.CONTACT_POLICY, sharedPolicy.CONTACT_POLICY); assert.equal(AI.CONTEXT_TEMPLATE, sharedPolicy.CONTEXT_TEMPLATE);
    assert.deepEqual(AI.RESULT_CONTRACT, sharedPolicy.RESULT_CONTRACT);
    assert.equal(typeof AI.inspectPromptDraft, 'function');
    const settings = store.getSettings();
    assert.equal(settings.ai.batchMode, 'auto');
    assert.equal(settings.ai.batchMaxCount, 20); assert.equal(settings.ai.batchMaxChars, 24000);
    assert(settings.ai.promptPresets[0].prompt.includes(sharedPolicy.CONTACT_POLICY), 'The install default must use the same contact policy as actual judgments');
    settings.ai.promptPresets.find(item => item.id === settings.ai.activePromptId).prompt += '\n' + customRuleMarker + '：旧生成器要求只输出JSON对象prompt字段，旧返回intent、score，需求不明为待确认。';
    settings.ai.businessDesc += '\n' + businessMarker;
    Object.assign(settings.ai, { enabled: true, apiKey: syntheticKey, model: 'deepseek-flash', batchMode: 'manual', intervalSec: 0, intervalJitter: 0 });
    Object.assign(settings.human, { workPeriods: [], workStart: '', workEnd: '', breakEvery: 0, maxConsecutiveErrors: 3 });
    store.setSettings(settings); store.setVideos(videos);
    engine.configure({ authorize: async metadata => { authorizations.push(metadata.kind); return true; } });
    const audit = () => store.tailLog('system', 2000).filter(line => line.includes('AI_AUDIT '))
      .map(line => JSON.parse(line.slice(line.indexOf('AI_AUDIT ') + 'AI_AUDIT '.length)));
    const completions = () => requests.filter(item => item.kind === 'completion');
    const initial = rows('qa-batch', 4, true);
    store.setLeads(initial);
    const prepared = AI.buildJudgeRequest(settings, initial, videos);
    assert.equal(prepared.workCount, 1); assert(prepared.payloadChars <= settings.ai.batchMaxChars);
    const result = await engine.aiTask({ leadIds: initial.map(item => item.id) });
    assert.equal(result.ok, true); assert.equal(result.okCount, 4); assert.equal(result.failCount, 0);
    assert.equal(result.yesCount, 2); assert.equal(result.noCount, 2); assert.equal(result.batchCount, 1);
    assert.equal(result.scheduledSingleCount, 0); assert.equal(result.fallbackCount, 0);
    assert.equal(completions().length, 1, 'Four comments sharing one long work must use one completion');
    const batchRequest = completions()[0];
    assert.deepEqual(batchRequest.payload, prepared.payload);
    const saved = store.getLeads();
    for (let index = 0; index < saved.length; index++) {
      const lead = saved[index];
      assert.equal(lead.aiNeed, needByComment.get(lead.demand));
      assert.equal(lead.aiReason, '批量编号' + (index + 1), 'Reverse reply order must still map by i');
      assert.equal(lead.aiScore, null); assert.equal(lead.aiDone, true); assert.equal(lead.note, initial[index].note);
      assert.match(lead.aiPromptVersion, /^ai-v3-[a-f0-9]{20}$/);
      assert.deepEqual(lead.aiScoreHistory, [{ score: initial[index].aiScore, judgedAt: initial[index].aiJudgedAt, promptVersion: initial[index].aiPromptVersion }]);
      assert(Array.from(lead.aiReason).length <= 30); assert(['是', '否'].includes(lead.aiNeed));
    }
    let entries = audit();
    assert(entries.some(item => item.event === 'plan' && item.count === 4 && item.multiBatchCount === 1 && item.maxChars === 24000 && item.maxCount === 20));
    assert(entries.some(item => item.event === 'request' && item.mode === 'batch' && item.count === 4 && item.workCount === 1));
    assert(entries.some(item => item.event === 'batch_completed' && item.mode === 'batch' && item.yes === 2 && item.no === 2));
    assert(entries.some(item => item.event === 'usage' && item.usage.total_tokens === 1440));
    assert.equal(engine.taskState.aiUsage.usage.total_tokens, 1440);

    const single = await engine.aiJudgeOne(initial[0].id);
    assert.equal(single.ok, true); assert.equal(completions().length, 2);
    const singleRequest = completions()[1];
    assert.equal(singleRequest.body.messages[0].content, batchRequest.body.messages[0].content, 'Single and batch must share the exact same final policy');
    assert.deepEqual(singleRequest.payload.works, batchRequest.payload.works);
    assert.deepEqual(singleRequest.payload.items[0], batchRequest.payload.items[0]);
    assert.deepEqual(singleRequest.payload.businessProfile, batchRequest.payload.businessProfile); assert.equal(singleRequest.payload.businessRules, batchRequest.payload.businessRules);
    assert.equal(store.getLeads()[0].aiScoreHistory.length, 1, 'A null current score must not be archived again');
    assert.equal(store.getLeads()[0].aiScore, null);
    assert.equal(engine.taskState.aiUsage.usage.total_tokens, 1110, 'Manual single judgement must also publish provider usage');
    assert.equal(engine.taskState.aiBudget.count, 1); assert.equal(engine.taskState.aiBaseBudget.withinBudget, true);
    assert(audit().some(item => item.event === 'request' && item.mode === 'single' && item.count === 1));
    assert(audit().some(item => item.event === 'request' && item.mode === 'single' && item.payloadChars === singleRequest.body.messages[1].content.length), 'Single audit must include complete business materials in its payload character count');

    // Automatic planning uses live model capacity and the complete serialized
    // system + shared payload, without the old 20/100-item pre-cut.
    settings.ai.batchMode = 'auto'; store.setSettings(settings);
    const automaticRows = rows('qa-automatic', 107);
    store.setLeads(automaticRows);
    const automaticStart = completions().length;
    const automatic = await engine.aiTask({ leadIds: automaticRows.map(item => item.id) });
    assert.equal(automatic.ok, true); assert.equal(automatic.okCount, 107);
    assert.equal(automatic.batchCount, 1); assert.equal(automatic.scheduledSingleCount, 0); assert.equal(automatic.fallbackCount, 0);
    assert.equal(completions().length - automaticStart, 1, 'Automatic capacity planning must not cut a 107-row fitting batch at 20 or 100');
    const automaticRequest = completions().at(-1);
    assert.equal(automaticRequest.payload.total, 107); assert.equal(automaticRequest.payload.works.length, 1);
    const automaticBudget = AI.estimateRequestBudget(automaticRequest.body.messages, 107, { contextWindow: 1048576, maxOutputTokens: 393216 });
    assert.equal(automaticBudget.withinBudget, true); assert.equal(automaticBudget.targetTokens, Math.floor(1048576 * 0.9));
    assert(automaticBudget.inputTokensEstimate >= Buffer.byteLength(JSON.stringify(automaticRequest.body.messages), 'utf8'));
    assert(automaticRequest.body.max_tokens >= 107 * 200); assert(automaticRequest.body.max_tokens <= 393216);
    assert.equal(engine.taskState.aiBudget.count, 107);
    assert.equal(engine.taskState.aiBudget.inputTokensEstimate, automaticBudget.inputTokensEstimate);
    assert.equal(engine.taskState.aiBaseBudget.withinBudget, true);
    assert(engine.taskState.aiBaseBudget.inputTokensEstimate > 0 && engine.taskState.aiBaseBudget.inputTokensEstimate < automaticBudget.inputTokensEstimate);
    const automaticSaved = store.getLeads();
    assert.deepEqual(automaticSaved.map(item => item.id), automaticRows.map(item => item.id), 'Automatic mode keeps the current selection order');
    for (let index = 0; index < automaticSaved.length; index++) {
      assert.equal(automaticSaved[index].aiReason, '批量编号' + (index + 1));
      assert.equal(automaticSaved[index].aiNeed, needByComment.get(automaticSaved[index].demand));
    }
    assert(audit().some(item => item.event === 'plan' && item.count === 107 && item.batchCount === 1));
    assert(audit().some(item => item.event === 'model_capacity' && item.contextWindow === 1048576 && item.maxOutputTokens === 393216 && item.sourceKind === 'live'));

    // A malformed or length-truncated four-row batch is reduced to two ordered
    // two-row batches before any single fallback is considered.
    settings.ai.batchMode = 'manual'; store.setSettings(settings);
    for (const mode of ['split', 'length']) {
      responseMode = mode;
      const splitRows = rows('qa-' + mode, 4); store.setLeads(splitRows);
      const splitStart = completions().length, splitAuditStart = audit().length;
      const splitResult = await engine.aiTask({ leadIds: splitRows.map(item => item.id) });
      assert.equal(splitResult.ok, true); assert.equal(splitResult.okCount, 4); assert.equal(splitResult.splitRetryCount, 1); assert.equal(splitResult.fallbackCount, 0);
      const splitRequests = completions().slice(splitStart);
      assert.deepEqual(splitRequests.map(item => item.payload.total), [4, 2, 2]);
      assert.deepEqual(splitRequests[1].payload.items.map(item => item.comment), splitRows.slice(0, 2).map(item => item.demand));
      assert.deepEqual(splitRequests[2].payload.items.map(item => item.comment), splitRows.slice(2).map(item => item.demand));
      assert.equal(store.getLeads().every(item => item.aiDone === true && item.aiScore === null), true);
      const splitAudit = audit().slice(splitAuditStart);
      assert(splitAudit.some(item => item.event === 'retry_split' && item.leftCount === 2 && item.rightCount === 2));
      assert.equal(splitAudit.filter(item => item.event === 'result' && item.outcome === 'success').length, 4);
      if (mode === 'length') assert(splitAudit.some(item => item.event === 'request_failed' && /长度限制截断/.test(item.reason)));
    }

    // Reject old score-bearing replies, then prove that explicit valid fallback
    // completions can recover individual rows through the same policy.
    responseMode = 'fallback';
    const recoveryRows = rows('qa-fallback', 2);
    store.setLeads(recoveryRows);
    const recoveryStart = completions().length;
    const recovered = await engine.aiTask({ leadIds: recoveryRows.map(item => item.id) });
    assert.equal(recovered.ok, true); assert.equal(recovered.okCount, 2); assert.equal(recovered.fallbackCount, 2);
    assert.equal(completions().length - recoveryStart, 3, 'Invalid batch is followed by two explicit single fallbacks');
    assert.equal(store.getLeads().every(item => item.aiDone === true && item.aiScore === null), true);
    entries = audit();
    assert(entries.some(item => item.event === 'response_invalid' && item.mode === 'batch' && item.code === 'FIELDS_INVALID'));
    assert(entries.some(item => item.event === 'request' && item.mode === 'fallback_single' && item.count === 1));
    assert(entries.some(item => item.event === 'completed' && item.fallbackCount === 2 && item.yesCount === 1 && item.noCount === 1));

    // Repeated malformed replies stay unjudged and trip the shared anomaly
    // limit; the next manual single attempt must not immediately retry itself.
    responseMode = 'invalid';
    const invalidRows = rows('qa-invalid', 2);
    store.setLeads(invalidRows);
    const invalidStart = completions().length;
    const failed = await engine.aiTask({ leadIds: invalidRows.map(item => item.id) });
    assert.equal(failed.ok, false); assert.equal(failed.okCount, 0); assert.equal(failed.fallbackCount, 2);
    assert.match(failed.error, /连续 3 次异常/); assert.equal(completions().length - invalidStart, 3);
    assert.equal(store.getLeads().every(item => item.aiDone === false && item.aiScore === invalidRows.find(row => row.id === item.id).aiScore), true);
    assert(audit().some(item => item.event === 'paused' && item.fallback === 2));
    const invalidSingleStart = completions().length;
    const failedSingle = await engine.aiJudgeOne(invalidRows[0].id);
    assert.equal(failedSingle.ok, false); assert.equal(completions().length - invalidSingleStart, 1);
    assert.equal(store.getLeads()[0].aiDone, false); assert.equal(engine.taskState.running, false);

    // Exercise the actual shipping generator through the same mocked provider.
    // Rejection must leave both editable rules and lead judgments untouched.
    responseMode = 'draft';
    const settingsBeforeDraft = JSON.stringify(store.getSettings()), leadsBeforeDraft = JSON.stringify(store.getLeads());
    const pollutedDrafts = [
      '只输出 JSON 对象，严格包含 prompt 一个字符串字段。',
      '{"prompt":"亚马逊行业规则正文"}',
      '你帮助业务人员编写评论获客联系判断规则。',
      '只输出intent、score、reason三个字段，需求不明返回待确认。',
      '只有有案例且不能确认提供服务时保留。',
      '只要业务相关且不能确定是同行，就保留为是。'
    ];
    const draftAuthorization = async () => { authorizations.push('ai'); return true; };
    for (const text of pollutedDrafts) {
      draftText = text;
      await assert.rejects(AI.generatePromptDraft(store.getSettings(), {}, { authorize: draftAuthorization }), /草稿.*(?:混入|旧判断字段|评分|格式|单纯相关)/);
      assert.equal(JSON.stringify(store.getSettings()), settingsBeforeDraft);
      assert.equal(JSON.stringify(store.getLeads()), leadsBeforeDraft);
    }
    draftText = '亚马逊账户求助、处理或服务咨询、本人或朋友当前问题可联系。求助帖下有案例是向作者提供案例，判否；你有案例吗是在询问服务证据，可判是。不能因为只有有案例且无法确认提供服务，就保留为是。作品补足话题和指代，不代替评论者经历。只输出是/否与简短理由，不输出评分或待确认。';
    const cleanDraft = await AI.generatePromptDraft(store.getSettings(), {}, { authorize: draftAuthorization });
    assert.equal(cleanDraft.prompt, draftText); assert.equal(cleanDraft.draft, true);
    assert.equal(JSON.stringify(store.getSettings()), settingsBeforeDraft); assert.equal(JSON.stringify(store.getLeads()), leadsBeforeDraft);
    assert.equal(deniedRequests, 0); assert(requests.some(item => item.kind === 'models'));
    assert(authorizations.length >= requests.length && authorizations.every(kind => kind === 'ai'));
    const logText = store.tailLog('system', 2000).join('\n');
    assert.equal(logText.includes(syntheticKey), false);
    assert.equal(logText.includes(longBody), false);
    for (const row of initial) assert.equal(logText.includes(row.UID), false);
    const packageFile = sourceMode ? path.join(ROOT, 'desktop', 'package.json') : path.join(APP, 'resources', 'app', 'package.json');
    const report = { ok: true, version: JSON.parse(fs.readFileSync(packageFile, 'utf8')).version,
      actualObfuscatedReleaseEngine: !sourceMode, releaseEngineSha256: hashes['engine.js'], releaseAiSha256: hashes['ai.js'], releaseAiTasksSha256: hashes['engine-ai-tasks.js'],
      sharedAiPolicySha256: hashes['lib/ai-policy.js'], sharedPolicyUsedByDefaultGeneratorAndJudge: true,
      isolatedDataAndProfile: true, noInstalledClientDataAccess: true, noNetworkRequestsMade: true, providerTransportMocked: true,
      unknownOutboundRequestsRejected: true, defaultBatchMode: 'auto', manualBatchCount: 20, manualBatchMaxChars: 24000,
      sharedLongWorkCount: 1, normalBatchLeadCount: 4, normalBatchCompletionCount: 1,
      actualSharedPayloadBudgetVerified: true, reverseIndexedRepliesMappedExactly: true,
      binaryShortReasonContractEnforced: true, currentScoreClearedAndLegacyScoresArchived: true,
      mockedProviderUsageReportedInAuditAndTask: true,
      singleAndBatchBudgetAndBaseBudgetPublished: true,
      oldAiV2ResultsRejudged: true, singleAndBatchSharePolicyAndInput: true,
      configuredBusinessAndCustomRulesRetainedOnlyAsUserData: true, fixedSystemPolicyAndContractProtected: true,
      commentAndAuthorEvidenceSourcesSeparated: true, singleAuditCountsCompleteUserPayload: true,
      pollutedGeneratorDraftsRejectedWithoutChangingSettingsOrLeads: pollutedDrafts.length,
      cleanGeneratorDraftRemainsReviewableAndInactive: true, semanticModelAccuracyNotTested: true,
      automaticModelCapacityMetadataUsed: true, completeSystemAndPayloadConservativelyBudgeted: true,
      ninetyPercentContextAndOutputReservationVerified: true, automaticOver100ItemsStayOneFittingBatch: true,
      automaticSelectionOrderPreserved: true,
      invalidBatchRejectsOldScoreFields: true, explicitSingleFallbackVerified: true,
      malformedAndLengthLimitedBatchShrinkBeforeSingleFallback: true, sequentialSplitKeepsOriginalRowOrder: true,
      malformedSingleRemainsUnjudgedWithoutImmediateRetry: true, continuousMalformedRepliesPauseTask: true,
      modeCountAndFallbackAuditEvidenceVerified: true, logsExcludeApiKeyUidAndWorkBody: true,
      ruleVersion: AI.getRuleSet(settings).version, mockedModelRequests: requests.filter(item => item.kind === 'models').length,
      mockedCompletionRequests: completions().length, mockedDraftGenerationRequests: requests.filter(item => item.kind === 'draft').length };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log('PASS: ' + (sourceMode ? 'source' : 'actual obfuscated release') + ' AI shares long work context, maps binary replies by i, archives old scores and verifies audited fallback/failure/pause; all provider calls mocked');
  } finally {
    globalThis.fetch = originalFetch;
    if (engine) await engine.shutdown();
    if (path.dirname(fixture) !== __dirname || !path.basename(fixture).startsWith('qa-ai-build-')) throw new Error('Unsafe AI fixture cleanup');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
