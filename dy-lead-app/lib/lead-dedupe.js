'use strict';
/**
 * 合并重复线索：同一作品 + 同一用户 + 同一评论文本只保留一行（2.5.2 起去重不再区分采集账号，
 * 旧版本会因不同账号采到同一条评论各存一行）。
 *
 * 保留行：进度最多的那行（私信成功 > 关注成功 > 有关注/私信记录 > 已 AI 判断 > 编号最小即最早采到）。
 * 其余行里保留行缺少的字段（关注、私信、AI 结果、资料等）补进保留行，信息不丢。
 * 返回 { leads, idMap }：idMap 为 被合并行 id → 保留行 id，用于改写执行计划等对线索的引用。
 */
const isEmpty = value => value === undefined || value === null || value === '';

function progressScore(lead) {
  let score = 0;
  if (lead.dmState === 'confirmed_success') score += 16;
  if (lead.followState === 'confirmed_success') score += 8;
  if (lead.dmState || lead.followState || lead.dmAt || lead.followedAt) score += 4;
  if (lead.manualApproved) score += 2;
  if (lead.aiDone) score += 1;
  return score;
}

function mergeDuplicateLeads(leads, keyOf) {
  const groups = new Map();
  leads.forEach((lead, index) => {
    const key = keyOf(lead);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ lead, index });
  });
  const keepIndex = new Set(), idMap = new Map();
  const merged = new Map(); // index → merged lead
  for (const members of groups.values()) {
    if (members.length === 1) { keepIndex.add(members[0].index); continue; }
    const ordered = [...members].sort((a, b) => progressScore(b.lead) - progressScore(a.lead) || (Number(a.lead.id) || 0) - (Number(b.lead.id) || 0) || a.index - b.index);
    const keeper = { ...ordered[0].lead };
    for (const { lead } of ordered.slice(1).sort((a, b) => (Number(a.lead.id) || 0) - (Number(b.lead.id) || 0))) {
      for (const [field, value] of Object.entries(lead)) if (field !== 'id' && isEmpty(keeper[field]) && !isEmpty(value)) keeper[field] = value;
      idMap.set(String(lead.id), String(keeper.id));
    }
    // 保留原列表中最早出现的位置，表格顺序不跳动
    const position = Math.min(...members.map(m => m.index));
    keepIndex.add(position);
    merged.set(position, keeper);
  }
  const result = [];
  leads.forEach((lead, index) => { if (keepIndex.has(index)) result.push(merged.get(index) || lead); });
  return { leads: result, idMap };
}

/** 改写执行计划里的线索引用（leadIds 与 leads[].id），去掉合并后重复的 id。返回是否有改动。 */
function remapPlans(plans, idMap) {
  if (!Array.isArray(plans) || !idMap.size) return false;
  let changed = false;
  const mapId = id => idMap.get(String(id)) || String(id);
  for (const plan of plans) {
    if (Array.isArray(plan.leadIds)) {
      const next = [...new Set(plan.leadIds.map(mapId))];
      if (next.length !== plan.leadIds.length || next.some((id, i) => id !== String(plan.leadIds[i]))) { plan.leadIds = next; changed = true; }
    }
    if (Array.isArray(plan.leads)) {
      const seen = new Set();
      const next = [];
      for (const item of plan.leads) {
        if (!item || typeof item !== 'object') { next.push(item); continue; }
        const id = mapId(item.id);
        if (seen.has(id)) { changed = true; continue; }
        seen.add(id);
        if (id !== String(item.id)) changed = true;
        next.push({ ...item, id: typeof item.id === 'number' ? Number(id) : id });
      }
      plan.leads = next;
    }
  }
  return changed;
}

module.exports = { mergeDuplicateLeads, remapPlans, progressScore };
