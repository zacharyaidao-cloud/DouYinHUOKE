'use strict';
/**
 * 核心流程 · 实测运行入口：登录确认 → 关键词搜索 → 评论采集 → 保存结果
 *
 *   node core/run-flow.js --profile=<浏览器资料目录> --out=<输出目录> --keywords=亚马逊停用,亚马逊申诉 [--pages=2] [--works=0]
 *
 * 输出：
 *   trace.jsonl     每一步动作与平台响应摘要
 *   works.json      搜索到的作品（去重）
 *   comments.json   采集到的一级评论（含 cid、时间、评论者 sec_uid/昵称、所在作品）
 *   summary.json    每个作品的采集结论（complete / partial / interrupted 及原因）
 * 本入口只读：不关注、不私信、不改账号设置。
 */
const fs = require('node:fs');
const path = require('node:path');
const { Session } = require('./session');
const { createTrace } = require('./trace');
const { searchKeyword, filterWorks } = require('./search');
const { DEFAULT_PACING, between: pace } = require('./pacing');
const { collectWork } = require('./collect');

const arg = name => (process.argv.find(value => value.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const profileDir = arg('profile');
const outDir = arg('out');
const keywords = arg('keywords').split(',').map(value => value.trim()).filter(Boolean);
const pages = Math.max(1, Number(arg('pages')) || 2);
const workLimit = Math.max(0, Number(arg('works')) || 0);
const withinDays = Math.max(0, Number(arg('within-days')) || 0); // 只采最近 N 天发布的作品（0=不限）
const minComments = Math.max(0, Number(arg('min-comments')) || 0);
if (!profileDir || !outDir || !keywords.length) {
  console.error('用法：node core/run-flow.js --profile=<资料目录> --out=<输出目录> --keywords=词1,词2 [--pages=2] [--works=0]');
  process.exit(2);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const between = (min, max) => sleep(min + Math.round(Math.random() * (max - min)));
const save = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2), 'utf8');

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const trace = createTrace(path.join(outDir, 'trace.jsonl'));
  const session = new Session({ profileDir, trace });
  try {
    await session.open();
    if (!await session.ensureLogin()) throw new Error('未登录');

    const works = new Map();
    // --seed-works=<文件>：并入之前已搜到的作品（断点续跑时不必重搜已完成的关键词）
    const seedFile = arg('seed-works');
    if (seedFile) for (const work of JSON.parse(fs.readFileSync(seedFile, 'utf8'))) works.set(work.awemeId, work);
    for (let index = 0; index < keywords.length; index++) {
      if (index) await pace(session.page, DEFAULT_PACING.search.betweenKeywords); // 关键词之间
      const result = await searchKeyword(session, keywords[index], { pages });
      trace.step('search.keyword_result', { keyword: keywords[index], works: result.works.length, pages: result.pages, stopReason: result.stopReason || result.reason });
      if (!result.ok) trace.step('search.failed', { keyword: keywords[index], reason: result.reason });
      for (const work of result.works) {
        const known = works.get(work.awemeId);
        if (known) known.keywords.push(work.keyword); else works.set(work.awemeId, { ...work, keywords: [work.keyword] });
      }
      save('works.json', [...works.values()]);
    }
    const all = [...works.values()].sort((a, b) => b.commentCount - a.commentCount);
    save('works.json', all);
    const { kept, dropped } = filterWorks(all.filter(work => work.commentCount > 0), { publishedWithinDays: withinDays, minComments });
    const targets = kept.slice(0, workLimit || undefined);
    trace.step('collect.plan', { searched: all.length, withinDays, minComments, kept: kept.length, dropped, collecting: targets.length });

    const comments = [], summary = [];
    for (let index = 0; index < targets.length; index++) {
      if (index) await pace(session.page, DEFAULT_PACING.collect.betweenWorks); // 作品之间
      const result = await collectWork(session, targets[index]);
      comments.push(...result.comments);
      summary.push({ awemeId: result.work.awemeId, type: result.work.workType, listed: result.work.commentCount, collected: result.comments.length, state: result.state, reason: result.reason });
      save('comments.json', comments.map(({ raw, ...row }) => row)); save('summary.json', summary);
      if (/安全验证未完成/.test(result.reason)) { trace.step('run.stop', { reason: result.reason }); break; }
    }
    trace.step('run.done', { works: summary.length, comments: comments.length,
      states: summary.reduce((acc, row) => ({ ...acc, [row.state]: (acc[row.state] || 0) + 1 }), {}) });
  } catch (error) {
    trace.step('run.error', { message: error.message });
  } finally {
    await session.close();
  }
})();
