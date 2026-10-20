'use strict';
// Read-only aggregate inspection. Never logs settings, lead text or credentials,
// and never calls the AI transport or loads the store module.
const fs = require('node:fs'), path = require('node:path');
const AI = require('../dy-lead-app/ai');
const query = require('../dy-lead-app/lead-query');
const appDir = path.resolve(process.argv[2] || '');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const installed = read(path.join(appDir, 'resources', 'app', 'package.json'));
if (installed.version !== require('../desktop/package.json').version) throw new Error('Source and installed version differ');
const dataDir = path.join(appDir, 'data');
const settings = read(path.join(dataDir, 'settings.json'));
const leads = read(path.join(dataDir, 'leads.json')), videos = read(path.join(dataDir, 'videos.json'));
const checkpoint = read(path.join(dataDir, 'task-checkpoint.json'));
const version = AI.getRuleSet(settings).version, options = { settings, ruleVersion: version, now: Date.now() };
const eligible = rows => rows.filter(row => !row.isAuthor && String(row.demand || '').trim());
const pending = rows => eligible(rows).filter(row => !AI.isStoredResultCurrent(row, version, videos));
const summary = checkpoint.collectionSummary || {};
const runRows = summary.runId ? query.filterLeads(leads, videos, { f: 'all', collectionRunId: summary.runId }, options) : [];
const allRows = query.filterLeads(leads, videos, { f: 'all' }, options);
const todoRows = query.filterLeads(leads, videos, { f: 'ai_todo' }, options);
const staleRows = query.filterLeads(leads, videos, { f: 'ai_stale' }, options);
console.log(JSON.stringify({ at: new Date().toISOString(), version: installed.version, readOnly: true, networkRequests: false,
  global: { total: leads.length, facets: query.aiFacetCounts(leads, videos, { f: 'all' }, options), eligiblePending: pending(allRows).length,
    eligibleNeverJudged: eligible(todoRows).length, eligibleStale: eligible(staleRows).length,
    authorOrEmptyExcluded: leads.length - eligible(leads).length },
  collection: { runId: summary.runId || null, rows: runRows.length, pending: pending(runRows).length,
    status: summary.status, aiStatus: summary.aiStatus, aiCounts: summary.aiCounts },
  lastAi: { id: checkpoint.id, kind: checkpoint.kind, state: checkpoint.state,
    selected: Array.isArray(checkpoint.leadIds) ? checkpoint.leadIds.length : 0,
    processed: Array.isArray(checkpoint.processedLeadIds) ? checkpoint.processedLeadIds.length : 0,
    counts: checkpoint.counts, completedAt: checkpoint.completedAt }
}));
