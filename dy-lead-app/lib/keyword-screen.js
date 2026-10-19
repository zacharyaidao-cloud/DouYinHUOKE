'use strict';

// 关键词只标记待审候选；既不能授予触达许可，也不能覆盖 AI 结论。
const LEGACY_DEFAULT_INTENT = Object.freeze(['多少钱', '怎么', '价格', '收费', '费用', '联系', '怎么弄', '多少米', '激活', '恢复', '重启', '申诉', '可以吗', '真的吗', '真假', '价格是多少', '怎么收费', '怎么操作', '怎么整', '搞', '救']);
const DEFAULT_KEYWORDS = Object.freeze({
  intent: Object.freeze([
    '协议三', '协议3', '申诉', '申述', '激活', '解封', '解冻', '恢复', '重启', '盘活',
    '封店', '封号', '被封', '停用', '冻结', '侵权', '关联', '不适当库存', '库存调查',
    '描述不符', '重复链接', '重复创建', '视频验证', '视频审核', '视频没通过', '视频不过',
    '法人', '提现', '站内信', '一刷', '二刷', '欺诈', '店铺不存在', '店铺点进去显示不存在', 'asin',
    '多少钱', '多少米', '多钱', '多少', '价格', '收费', '费用', '报价', '先付款', '成功后付款',
    '怎么联系', '联系方式', '联系我', '私我', '帮我看', '我需要', '我也是', '我跟你一模一样',
    '怎么弄', '怎么整', '怎么操作', '怎么解决', '怎么处理', '怎么办', '如何申诉',
    '可以吗', '能不能', '真的吗', '真的假的', '真假', '有得救', '能救', '能整', '能搞', '能解'
  ]),
  exclude: Object.freeze([])
});

function normalizedText(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
function normalizedList(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string').map(normalizedText).filter(Boolean))];
}
function normalizeKeywords(keywords = {}) {
  keywords = keywords && typeof keywords === 'object' ? keywords : {};
  return { intent: normalizedList(keywords.intent), exclude: normalizedList(keywords.exclude) };
}
function keywordSignature(keywords) {
  const normalized = normalizeKeywords(keywords);
  return JSON.stringify({ intent: [...normalized.intent].sort(), exclude: [...normalized.exclude].sort() });
}
function isLegacyDefaultKeywords(keywords) {
  return Boolean(keywords && Array.isArray(keywords.intent)
    && keywords.intent.length === LEGACY_DEFAULT_INTENT.length
    && keywords.intent.every((word, index) => word === LEGACY_DEFAULT_INTENT[index])
    && (keywords.exclude === undefined || Array.isArray(keywords.exclude) && keywords.exclude.length === 0));
}
function screen(text, words) {
  const source = normalizedText(text);
  if (words.exclude.some(word => source.includes(word))) return { hit: false, kw: '', excluded: true };
  const kw = words.intent.find(word => source.includes(word));
  return { hit: Boolean(kw), kw: kw || '', excluded: false };
}
function preparedKeywords(keywords) {
  const words = normalizeKeywords(keywords);
  words.intent.sort((left, right) => right.length - left.length || left.localeCompare(right, 'zh-CN'));
  return words;
}
function matchIntent(text, keywords = {}) { return screen(text, preparedKeywords(keywords)); }
function reclassifyLeads(leads, keywords) {
  let changed = 0; const words = preparedKeywords(keywords);
  const updated = leads.map(lead => {
    const result = screen(lead.demand, words);
    if (lead.trigger === result.kw && lead.intent === result.hit && lead.excluded === result.excluded) return lead;
    changed++;
    return { ...lead, trigger: result.kw, intent: result.hit, excluded: result.excluded };
  });
  return { leads: updated, changed };
}

module.exports = { DEFAULT_KEYWORDS, LEGACY_DEFAULT_INTENT, normalizeKeywords, keywordSignature, isLegacyDefaultKeywords, matchIntent, reclassifyLeads };
