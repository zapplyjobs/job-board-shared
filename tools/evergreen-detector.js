#!/usr/bin/env node

/**
 * Evergreen/Ghost Job Detector (AGG-QUALITY-1)
 *
 * Analyzes the job pool for evergreen (perpetual postings) and ghost
 * (never-hire listings) jobs. Uses posted_at age, per-company concentration,
 * and title repetition patterns.
 *
 * Usage:
 *   node evergreen-detector.js --data-dir .github/data
 *   node evergreen-detector.js --data-dir .github/data --json
 *   node evergreen-detector.js --remote [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DATA_DIR = args.includes('--data-dir')
  ? args[args.indexOf('--data-dir') + 1]
  : '.github/data';
const JSON_OUTPUT = args.includes('--json');
const USE_REMOTE = args.includes('--remote');

const TTL_DAYS = 14;
const EVERGREEN_THRESHOLD_DAYS = 10;
const CONCENTRATION_THRESHOLD = 0.3;
const MIN_COMPANY_JOBS = 10;

async function loadJobs() {
  if (USE_REMOTE) {
    try {
      const { loadJsonFromR2 } = require('./r2-loader');
      const records = await loadJsonFromR2('all_jobs.json');
      console.error(`Loaded ${records.length} jobs from R2`);
      return records;
    } catch (e) {
      console.error(`R2 load failed: ${e.message}`);
      console.error('ERROR: Could not load all_jobs.json from R2. Check R2 env vars.');
      process.exit(1);
    }
  }
  const p = path.join(DATA_DIR, 'all_jobs.json');
  if (!fs.existsSync(p)) { console.error('No all_jobs.json found'); process.exit(1); }
  return fs.readFileSync(p, 'utf8').trim().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function daysBetween(a, b) {
  return (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24);
}

function analyze(jobs) {
  const now = new Date();
  const cutoff = new Date(now - EVERGREEN_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  // Per-job age classification
  const byAge = { fresh: [], aging: [], evergreen: [] };
  for (const j of jobs) {
    const posted = j.posted_at ? new Date(j.posted_at) : null;
    if (!posted) { byAge.aging.push(j); continue; }
    const ageDays = daysBetween(posted, now);
    j._age_days = Math.round(ageDays * 10) / 10;
    if (ageDays <= 3) byAge.fresh.push(j);
    else if (ageDays <= EVERGREEN_THRESHOLD_DAYS) byAge.aging.push(j);
    else byAge.evergreen.push(j);
  }

  // Per-company evergreen concentration
  const companyMap = new Map();
  for (const j of jobs) {
    const c = j.company_name || 'unknown';
    if (!companyMap.has(c)) companyMap.set(c, { total: 0, evergreen: 0, titles: new Map() });
    const entry = companyMap.get(c);
    entry.total++;
    if (byAge.evergreen.includes(j)) entry.evergreen++;
    const title = (j.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    entry.titles.set(title, (entry.titles.get(title) || 0) + 1);
  }

  const companyConcentration = [];
  for (const [name, data] of companyMap) {
    if (data.total < MIN_COMPANY_JOBS) continue;
    const rate = data.evergreen / data.total;
    if (rate >= CONCENTRATION_THRESHOLD) {
      // Find repeated titles (same title posted multiple times)
      const repeatedTitles = [...data.titles.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      companyConcentration.push({
        company: name,
        total: data.total,
        evergreen: data.evergreen,
        rate: Math.round(rate * 1000) / 10,
        repeated_titles: repeatedTitles.map(([t, c]) => ({ title: t.substring(0, 80), count: c })),
      });
    }
  }
  companyConcentration.sort((a, b) => b.evergreen - a.evergreen);

  // Source-level evergreen distribution
  const sourceMap = new Map();
  for (const j of byAge.evergreen) {
    const s = j.source || 'unknown';
    sourceMap.set(s, (sourceMap.get(s) || 0) + 1);
  }
  const sourceEvergreen = [...sourceMap.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  // Age distribution histogram (day buckets)
  const ageHist = new Map();
  for (const j of jobs) {
    const age = j._age_days || 0;
    const bucket = Math.floor(age);
    ageHist.set(bucket, (ageHist.get(bucket) || 0) + 1);
  }
  const ageDistribution = [...ageHist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, count]) => ({ day, count }));

  return {
    summary: {
      total_jobs: jobs.length,
      fresh_0_3d: byAge.fresh.length,
      aging_4_10d: byAge.aging.length,
      evergreen_10_14d: byAge.evergreen.length,
      evergreen_pct: Math.round(byAge.evergreen.length / jobs.length * 1000) / 10,
    },
    evergreen_by_source: sourceEvergreen,
    evergreen_companies: companyConcentration,
    age_distribution: ageDistribution,
    top_evergreen_jobs: byAge.evergreen
      .sort((a, b) => (a._age_days || 0) - (b._age_days || 0))
      .slice(0, 20)
      .map(j => ({
        id: j.id,
        title: (j.title || '').substring(0, 80),
        company: j.company_name,
        source: j.source,
        posted_at: j.posted_at,
        age_days: j._age_days,
        employment: j.tags?.employment,
        domains: j.tags?.domains,
      })),
  };
}

function printReport(result) {
  const s = result.summary;
  console.log('============================================');
  console.log('  Evergreen/Ghost Job Detection Report');
  console.log('============================================');
  console.log();
  console.log(`Pool: ${s.total_jobs} jobs | Fresh (0-3d): ${s.fresh_0_3d} | Aging (4-10d): ${s.aging_4_10d} | Evergreen (10-14d): ${s.evergreen_10_14d} (${s.evergreen_pct}%)`);
  console.log();

  console.log('=== Evergreen by Source ===');
  for (const { source, count } of result.evergreen_by_source) {
    console.log(`  ${source.padEnd(20)} ${count}`);
  }
  console.log();

  console.log('=== Companies with High Evergreen Concentration (>30%) ===');
  for (const c of result.evergreen_companies.slice(0, 15)) {
    console.log(`  ${c.company} (${c.evergreen}/${c.total} = ${c.rate}%)`);
    for (const t of c.repeated_titles.slice(0, 3)) {
      console.log(`    ×${t.count} ${t.title}`);
    }
  }
  console.log();

  console.log('=== Age Distribution (day buckets) ===');
  for (const { day, count } of result.age_distribution) {
    const bar = '█'.repeat(Math.min(Math.round(count / 500), 40));
    console.log(`  Day ${String(day).padStart(2)}: ${String(count).padStart(5)} ${bar}`);
  }
  console.log();

  console.log('=== Oldest Jobs in Pool ===');
  for (const j of result.top_evergreen_jobs.slice(0, 10)) {
    console.log(`  ${j.age_days}d | ${j.company} | ${j.title}`);
  }
}

(async () => {
const jobs = await loadJobs();
const result = analyze(jobs);
if (JSON_OUTPUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printReport(result);
}
})();
