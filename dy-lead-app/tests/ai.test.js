'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai');

const settings = () => ({ ai: {
  enabled: true, apiKey: 'mock-key-never-sent-to-real-network', baseUrl: 'https://api.deepseek.com',
  prompt: '按业务判断，同行广告排除。业务：{业务介绍}；评论：{需求内容}；UID：{UID}；昵称：{昵称}',
  businessDesc: '账号申诉', targetCustomers: '店铺被封的卖家', exclusions: '同行广告'
} });
const leads = () => [
  { id: 1, UID: 'secret-uid-123', nickname: 'secret-nickname', demand: '我的店铺停用了，可以申诉吗？', time: '2026-10-08', videoLink: 'https://www.douyin.com/video/123' },
  { id: 2, UID: 'secret-uid-456', nickname: 'secret-name2', demand: '路过', time: '2026-10-08' }
];
const videos = { '123': { desc: '关于账号申诉' } };
const response = content => ({ ok: true, status: 200, url: 'https://api.deepseek.com/chat/completions', json: async () => ({ data:[{id:'deepseek-flash',name:'DeepSeek-V4.1-Flash'}], choices: [{ finish_reason:'stop', message: { content } }] }) });
const judgeMock = calls => async (url, options) => {
  if(options.method==='GET') return response('');
  calls.push({ url, options });
  const req = JSON.parse(options.body);
  const data = JSON.parse(req.messages[1].content);
  return response(JSON.stringify(data.items.map(item => ({ i: item.i, need: item.i === 1 ? '是' : '否', reason: '测试依据' }))));
};

test('single and batch share the exact same custom rules and fixed context mappings', async () => {
  const calls = [];
  const one = await AI.judgeOne(settings(), leads()[0], videos, { fetchImpl: judgeMock(calls) });
  const batch = await AI.judgeBatch(settings(), leads(), videos, { fetchImpl: judgeMock(calls) });
  const a = JSON.parse(calls[0].options.body), b = JSON.parse(calls[1].options.body);
  assert.equal(a.messages[0].content, b.messages[0].content);
  assert.deepEqual(JSON.parse(a.messages[1].content).items[0], JSON.parse(b.messages[1].content).items[0]);
  assert.equal(one.promptVersion, batch[1].promptVersion);
  assert.equal(one.inputHash, batch[1].inputHash);
  assert.doesNotMatch(a.messages[0].content, /按业务判断，同行广告排除/);
  assert.match(JSON.parse(a.messages[1].content).businessRules, /同行广告排除/);
  assert.match(calls[0].options.body, /secret-uid-123/);
  assert.match(calls[0].options.body, /secret-nickname/);
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].url, /^https:/);
});

test('note 图文描述进入单条及批量 AI 上下文，描述变化会改变输入依据', async () => {
  const note = { ...leads()[0], videoLink: 'https://www.douyin.com/note/7693579483274183025' };
  const noteVideos = { '7693579483274183025': { desc: '图文说明：自己的店铺被停用，需要申诉资料' } };
  const calls = [];
  const one = await AI.judgeOne(settings(), note, noteVideos, { fetchImpl: judgeMock(calls) });
  const batch = await AI.judgeBatch(settings(), [note], noteVideos, { fetchImpl: judgeMock(calls) });
  const contexts = calls.map(call => JSON.parse(JSON.parse(call.options.body).messages[1].content));
  assert.equal(contexts[0].works[0].videoDescription, noteVideos['7693579483274183025'].desc);
  assert.equal(contexts[1].works[0].videoDescription, contexts[0].works[0].videoDescription);
  assert.equal(contexts[0].items[0].workRef,contexts[0].works[0].id);
  assert.equal(Object.hasOwn(contexts[0].items[0],'context'),false);
  assert.equal(one.inputHash, batch[1].inputHash);
  const changed = await AI.judgeOne(settings(), note, { '7693579483274183025': { desc: '广告描述，非本人需求' } }, { fetchImpl: judgeMock([]) });
  assert.notEqual(one.inputHash, changed.inputHash);
  assert.notDeepEqual(AI.leadInput(note, noteVideos), AI.leadInput(note, { '7693579483274183025': { desc: '广告描述，非本人需求' } }));
});

test('rule version changes for business/custom rule changes but not for API keys', () => {
  const first = settings(), second = settings();
  second.ai.apiKey = 'different-key';
  assert.equal(AI.getRuleSet(first).version, AI.getRuleSet(second).version);
  second.ai.exclusions = '广告和代理';
  assert.notEqual(AI.getRuleSet(first).version, AI.getRuleSet(second).version);
  second.ai.exclusions = first.ai.exclusions; second.ai.prompt += ' 必须明确需求';
  assert.notEqual(AI.getRuleSet(first).version, AI.getRuleSet(second).version);
});

test('strict parser accepts binary short reasons and rejects old score/pending or extra fields', () => {
  assert.deepEqual(AI.parseAiReply('{"need":"是","reason":"需求未明，业务相关"}'), { need: '是', reason: '需求未明，业务相关' });
  for (const input of [
    '{"need":"是","score":"90","reason":"依据"}', '{"need":"是","score":101,"reason":"依据"}',
    '{"need":"是","score":20.2,"reason":"依据"}', '{"need":"是","score":90,"reason":""}',
    '{"need":"maybe","score":90,"reason":"依据"}', '{"need":"是","score":90,"reason":"依据","UID":"leak"}',
    '{"need":"待确认","reason":"需求未明"}',JSON.stringify({need:'是',reason:'长'.repeat(31)}),
    '前面的说明 {"need":"是","score":90,"reason":"依据"}'
  ]) assert.equal(AI.parseAiReply(input), null);
});

test('batch parser rejects missing/duplicate/out of range entries and non-array JSON', () => {
  const valid = { i: 1, need: '是', reason: '依据' };
  assert.equal(AI.parseAiBatchReply(JSON.stringify([valid]), 2), null);
  assert.equal(AI.parseAiBatchReply(JSON.stringify([valid, valid]), 2), null);
  assert.equal(AI.parseAiBatchReply(JSON.stringify([valid, { ...valid, i: 3 }]), 2), null);
  assert.equal(AI.parseAiBatchReply(JSON.stringify(valid), 1), null);
  assert.deepEqual(AI.parseAiBatchReply('```json\n' + JSON.stringify([valid]) + '\n```', 1), { 1: { need: '是', reason: '依据' } });
});

test('plain HTTP, embedded credentials and unsafe redirect URLs are rejected before sending', async () => {
  let callCount = 0;
  const mock = async () => { callCount++; return response('[]'); };
  for (const baseUrl of ['http://mock.example', 'https://user:password@mock.example', 'https://mock.example?apiKey=secret']) {
    const config = settings(); config.ai.baseUrl = baseUrl;
    await assert.rejects(AI.judgeOne(config, leads()[0], videos, { fetchImpl: mock }), /HTTPS/);
  }
  assert.equal(callCount, 0);
  await assert.rejects(AI.judgeOne(settings(), leads()[0], videos, { fetchImpl: async () => ({ ...response('[]'), url: 'http://mock.example' }) }), /不安全跳转/);
});

test('provider endpoint is fixed to the official HTTPS address', () => {
  assert.equal(AI.endpointOf(settings()), 'https://api.deepseek.com/chat/completions');
  const config = settings(); config.ai.baseUrl = 'https://api.deepseek.com/v1/chat/completions/';
  assert.equal(AI.endpointOf(config), 'https://api.deepseek.com/chat/completions');
  config.ai.baseUrl = 'https://mock.example'; assert.throws(()=>AI.endpointOf(config),/官方 HTTPS/);
});

test('timeout aborts transport even if a mock never resolves', async () => {
  let signal;
  await assert.rejects(AI.judgeOne(settings(), leads()[0], videos, { timeoutMs: 15, fetchImpl: async (_, options) => { signal = options.signal; return new Promise(() => {}); } }), /超时/);
  assert.equal(signal.aborted, true);
});

test('caller cancellation aborts running requests and avoids a new request when already stopped', async () => {
  const controller = new AbortController();
  let transportSignal;
  const pending = AI.judgeOne(settings(), leads()[0], videos, { signal: controller.signal, fetchImpl: async (_, options) => { transportSignal = options.signal; return new Promise(() => {}); } });
  controller.abort();
  await assert.rejects(pending, /已停止/);
  assert.equal(transportSignal.aborted, true);
  let called = false;
  await assert.rejects(AI.judgeOne(settings(), leads()[0], videos, { signal: controller.signal, fetchImpl: async () => { called = true; } }), /已停止/);
  assert.equal(called, false);
});

test('provider errors and thrown network errors do not expose request keys or response bodies', async () => {
  let bodyRead = false;
  await assert.rejects(AI.judgeOne(settings(), leads()[0], videos, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => { bodyRead = true; return 'secret-key'; } }) }), error => error.message === 'AI 接口返回 HTTP 401');
  assert.equal(bodyRead, false);
  await assert.rejects(AI.judgeOne(settings(), leads()[0], videos, { fetchImpl: async () => { throw new Error('private-token request'); } }), error => !/private-token/.test(error.message));
});

function memoryStore(config = settings()) {
  let values = leads();
  let currentSettings = config;
  return {
    getLeads: () => structuredClone(values), setLeads: next => { values = structuredClone(next); },
    getSettings: () => currentSettings, setSettings: next => { currentSettings = next; },
    getVideos: () => structuredClone(videos), nowStr: () => '2026-10-08 12:00:00'
  };
}

test('result persistence merges only AI fields into fresh records and preserves concurrent notes', async () => {
  const store = memoryStore();
  const snapshot = store.getLeads()[0];
  const result = await AI.judgeOne(store.getSettings(), snapshot, store.getVideos(), { fetchImpl: judgeMock([]) });
  const changed = store.getLeads(); changed[0].note = '新增跟进备注'; changed[1].dmState = 'pending'; store.setLeads(changed);
  assert.equal(AI.applyResultPatch(store, snapshot, result).ok, true);
  assert.equal(store.getLeads()[0].note, '新增跟进备注');
  assert.equal(store.getLeads()[1].dmState, 'pending');
  assert.equal(store.getLeads()[0].aiPromptVersion, result.promptVersion);
});

test('stale rule, stale input, deleted lead and stopped task never persist an AI result', async () => {
  for (const change of ['rules', 'input', 'delete', 'stop']) {
    const store = memoryStore(), snapshot = store.getLeads()[0];
    const result = await AI.judgeOne(store.getSettings(), snapshot, store.getVideos(), { fetchImpl: judgeMock([]) });
    const options = {};
    if (change === 'rules') { const config = settings(); config.ai.prompt += '新条件'; store.setSettings(config); }
    if (change === 'input') { const current = store.getLeads(); current[0].demand = '已解决'; store.setLeads(current); }
    if (change === 'delete') store.setLeads(store.getLeads().slice(1));
    if (change === 'stop') { const controller = new AbortController(); controller.abort(); options.signal = controller.signal; }
    assert.equal(AI.applyResultPatch(store, snapshot, result, options).skipped, true);
    assert.equal(store.getLeads().some(lead => lead.aiDone), false);
  }
});

test('older concurrent AI response cannot overwrite a newer result even at the same second', async () => {
  const store = memoryStore(), snapshot = store.getLeads()[0];
  const result = await AI.judgeOne(store.getSettings(), snapshot, store.getVideos(), { fetchImpl: judgeMock([]) });
  assert.equal(AI.applyResultPatch(store, snapshot, result).ok, true);
  assert.equal(AI.applyResultPatch(store, snapshot, { ...result, need: '否' }).skipped, true);
  assert.equal(store.getLeads()[0].aiNeed, '是');
});

test('draft generation returns a reviewable draft and does not activate or mutate configuration', async () => {
  const config = settings(), before = structuredClone(config);
  const result = await AI.generatePromptDraft(config, { businessDesc: '家装咨询', targetCustomers: '新房装修业主' }, { fetchImpl: async () => response('{"prompt":"判断是否咨询装修方案，同行广告排除，相关咨询但需求未明可保留。"}') });
  assert.equal(result.draft, true);
  assert.match(result.prompt, /装修/);
  assert.deepEqual(config, before);
  assert.notEqual(result.version, AI.getRuleSet(config).version);
  await assert.rejects(AI.generatePromptDraft(config, {}, { fetchImpl: async () => response('{"prompt":"规则","activate":true}') }), /草稿格式无效/);
});

test('sample testing anonymizes identities and contact information and never writes configuration', async () => {
  const config = settings(), before = structuredClone(config), calls = [];
  const result = await AI.testPromptDraft(config, { prompt: '需求不明待确认', businessInput: { businessDesc: '家装咨询' }, samples: [
    { comment: '要装修，联系 13812345678 或 me@example.com', UID: 'secret-uid', nickname: 'secret-person' }, '只是看看'
  ] }, { fetchImpl: judgeMock(calls) });
  assert.equal(result.draft, true);
  assert.equal(result.results.length, 2);
  assert.doesNotMatch(calls[0].options.body, /13812345678|me@example.com|secret-uid|secret-person/);
  assert.match(result.results[0].comment, /\[手机号\].*\[邮箱\]/);
  assert.deepEqual(config, before);
});

test('invalid model response is not silently coerced to a valid judgement', async () => {
  const result = await AI.judgeBatch(settings(), leads(), videos, { fetchImpl: async () => response('[{"i":1,"need":"是","score":"80","reason":"依据"}]') });
  assert.equal(result, null);
  await assert.rejects(AI.judgeOne(settings(), leads()[0], videos, { fetchImpl: async () => response('not-json') }), /未标记为已判断/);
});
