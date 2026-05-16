#!/usr/bin/env node

/**
 * ENR Tier Classifier (INF-TOOL-2 / ENR-QUALITY)
 *
 * Structured analysis of enrichment tier distribution, T1 quality decomposition,
 * and description quality metrics. Replaces inline python analysis blocks.
 *
 * Reads enriched_jobs.json (+ optional descriptions sidecars for quality metrics).
 * Outputs human-readable summary + optional JSON (--json flag).
 *
 * Usage:
 *   node tools/enr-t0-classifier.js /path/to/enriched_jobs.json
 *   node tools/enr-t0-classifier.js /path/to/enriched_jobs.json --json
 *   node tools/enr-t0-classifier.js /path/to/enriched_jobs.json --desc-dir /path/to/descriptions/
 *
 * Output sections:
 *   1. Tier distribution (overall + per-source)
 *   2. T1 quality decomposition (degree/visa present, only skills missing)
 *   3. T2 missing-field decomposition
 *   4. Version propagation
 *   5. Description quality (with --desc-dir: length stats, template detection)
 *   6. Per-company T1/T2 concentration
 */

'use strict';

const fs = require('fs');
const path = require('path');

const https = require('https');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const useRemote = args.includes('--remote');
const enrichedPath = useRemote ? '--remote' : args.find(a => !a.startsWith('--'));
const descDir = args.indexOf('--desc-dir') >= 0 ? args[args.indexOf('--desc-dir') + 1] : null;

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ZJP-ENR-Classifier/1.0' } }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ ok: res.statusCode === 200, text: d }));
    });
    req.setTimeout(60000, () => { req.destroy(); resolve({ ok: false, text: '' }); });
    req.on('error', () => resolve({ ok: false, text: '' }));
  });
}

async function loadFromRemote() {
  // Try r2-loader first (S3 client, live data when env vars set)
  try {
    const { loadJsonFromR2 } = require('./r2-loader');
    return await loadJsonFromR2('enriched_jobs.json');
  } catch {}
  // Fallback: public URLs
  const urls = [
    'https://pub-7c6b1d38c7974dd7a11e3a1e6e46c68b.r2.dev/data/enriched_jobs.json',
    `https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/enriched_jobs.json?t=${Math.floor(Date.now()/1000)}`,
  ];
  for (const url of urls) {
    console.error(`Fetching from ${url.split('/').slice(-2).join('/')}...`);
    const resp = await fetchText(url);
    if (!resp.ok || !resp.text) continue;
    const records = [];
    for (const line of resp.text.split('\n').filter(Boolean)) {
      try { records.push(JSON.parse(line)); } catch (_) {}
    }
    if (records.length > 100) return records;
  }
  return null;
}

if (!enrichedPath) {
  console.error('Usage: node enr-t0-classifier.js <enriched_jobs.json> [--json] [--desc-dir <dir>]');
  console.error('       node enr-t0-classifier.js --remote [--json]');
  process.exit(1);
}

// --- Load data ---
(async () => {
let records = [];
if (enrichedPath === '--remote') {
  const remote = await loadFromRemote();
  if (!remote) { console.error('ERROR: Could not fetch enriched_jobs.json from remote.'); process.exit(1); }
  records = remote;
} else {
  for (const line of fs.readFileSync(enrichedPath, 'utf8').trim().split('\n').filter(Boolean)) {
    try { records.push(JSON.parse(line)); } catch (_) {}
  }
}
console.error(`[enr-t0-classifier] Loaded ${records.length} records`);

// --- Helpers ---
const hasSkills = r => Array.isArray(r.required_skills) && r.required_skills.length > 0;
const hasDegree = r => r.min_degree !== null && r.min_degree !== undefined;
const hasVisa = r => r.sponsors_visa !== null || r.possible_sponsor !== null || r.visa_question_present !== null;

function classifyTier(r) {
  if (!r.has_description) return 0;
  if (!hasSkills(r)) return 1;
  if (hasDegree(r) && hasVisa(r)) return 4;
  if (hasDegree(r)) return 3;
  return 2;
}

// --- Section 1: Tier distribution ---
const tiers = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
const tiersBySource = {};
for (const r of records) {
  const t = classifyTier(r);
  tiers[t]++;
  const src = r.source || 'unknown';
  if (!tiersBySource[src]) tiersBySource[src] = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0, total: 0 };
  tiersBySource[src][`t${t}`]++;
  tiersBySource[src].total++;
}
const total = tiers[0] + tiers[1] + tiers[2] + tiers[3] + tiers[4];
const t3PlusPct = total > 0 ? ((tiers[3] + tiers[4]) / total * 100).toFixed(1) : '0.0';
const t3Pct = total > 0 ? (tiers[3] / total * 100).toFixed(1) : '0.0';
const t4Pct = total > 0 ? (tiers[4] / total * 100).toFixed(1) : '0.0';

// --- Section 2: T1 decomposition ---
const t1Records = records.filter(r => classifyTier(r) === 1);
const t1WithDegree = t1Records.filter(r => hasDegree(r)).length;
const t1WithVisa = t1Records.filter(r => hasVisa(r)).length;
const t1WithBoth = t1Records.filter(r => hasDegree(r) && hasVisa(r)).length;
const t1WithNeither = t1Records.filter(r => !hasDegree(r) && !hasVisa(r)).length;

const t1BySource = {};
for (const r of t1Records) {
  const src = r.source || 'unknown';
  if (!t1BySource[src]) t1BySource[src] = { total: 0, hasDegreeVisa: 0 };
  t1BySource[src].total++;
  if (hasDegree(r) && hasVisa(r)) t1BySource[src].hasDegreeVisa++;
}

// --- Section 3: T2 decomposition ---
const t2Records = records.filter(r => classifyTier(r) === 2);
const t2NoDegree = t2Records.filter(r => !hasDegree(r)).length;
const t2NoVisa = t2Records.filter(r => !hasVisa(r)).length;
const t2NoBoth = t2Records.filter(r => !hasDegree(r) && !hasVisa(r)).length;
const t2NoDegreeOnly = t2NoDegree - t2NoBoth;
const t2NoVisaOnly = t2NoVisa - t2NoBoth;

// --- Section 4: Version propagation ---
const versionCounts = {};
for (const r of records) {
  const v = r.enricher_version || 0;
  versionCounts[v] = (versionCounts[v] || 0) + 1;
}

// --- Section 5: Description quality (optional) ---
let descQuality = null;
if (descDir && fs.existsSync(descDir)) {
  descQuality = { sources: {} };
  const files = fs.readdirSync(descDir).filter(f => /^descriptions-.*\.jsonl$/.test(f));
  for (const file of files) {
    const src = file.replace('descriptions-', '').replace('.jsonl', '');
    const lengths = [];
    let templateCount = 0;
    let total_ = 0;
    const templates = [
      'Write product or system development code',
      'Imagine what you',
      'Imagine what you could do here',
    ];
    for (const line of fs.readFileSync(path.join(descDir, file), 'utf8').trim().split('\n').filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        const text = obj.description_text || '';
        total_++;
        lengths.push(text.length);
        for (const t of templates) {
          if (text.includes(t)) { templateCount++; break; }
        }
      } catch (_) {}
    }
    if (lengths.length > 0) {
      lengths.sort((a, b) => a - b);
      descQuality.sources[src] = {
        count: total_,
        minLen: lengths[0],
        maxLen: lengths[lengths.length - 1],
        medianLen: lengths[Math.floor(lengths.length / 2)],
        meanLen: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
        templateCount,
        templatePct: (templateCount / total_ * 100).toFixed(1),
      };
    }
  }
}

// --- Section 6: Per-company T1/T2 concentration ---
const companyMap = {};
for (const r of records) {
  const co = r.company_name || 'Unknown';
  if (!companyMap[co]) companyMap[co] = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0, total: 0, source: r.source };
  const t = classifyTier(r);
  companyMap[co][`t${t}`]++;
  companyMap[co].total++;
}
const topT1Companies = Object.entries(companyMap)
  .filter(([_, v]) => v.t1 > 2)
  .sort((a, b) => b[1].t1 - a[1].t1)
  .slice(0, 20);

// --- Output ---
const result = {
  generated: new Date().toISOString(),
  totalRecords: records.length,
  tiers: { ...tiers, total, t3_pct: parseFloat(t3Pct), t4_pct: parseFloat(t4Pct), t3_plus_pct: parseFloat(t3PlusPct) },
  tiersBySource,
  t1Decomposition: {
    total: t1Records.length,
    hasDegreeAndVisa: t1WithBoth,
    hasDegreeOnly: t1WithDegree - t1WithBoth,
    hasVisaOnly: t1WithVisa - t1WithBoth,
    hasNeither: t1WithNeither,
    pctCloseToT3: t1Records.length > 0 ? parseFloat((t1WithBoth / t1Records.length * 100).toFixed(1)) : 0,
    bySource: t1BySource,
  },
  t2Decomposition: {
    total: t2Records.length,
    missingDegreeOnly: t2NoDegreeOnly,
    missingVisaOnly: t2NoVisaOnly,
    missingBoth: t2NoBoth,
  },
  versionPropagation: versionCounts,
  descriptionQuality: descQuality,
  topT1Companies: topT1Companies.map(([name, v]) => ({ company: name, ...v })),
};

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  // Human-readable output
  console.log(`\n=== ENR Tier Classifier Report ===\n`);
  console.log(`Records: ${total}  |  T3+T4: ${tiers[3]+tiers[4]} (${t3PlusPct}%)  |  T3: ${tiers[3]} (${t3Pct}%)  |  T4: ${tiers[4]} (${t4Pct}%)  |  T2: ${tiers[2]}  |  T1: ${tiers[1]}  |  T0: ${tiers[0]}\n`);

  console.log(`--- Per-Source Tiers (sorted by T3+T4%) ---`);
  const srcSorted = Object.entries(tiersBySource).sort((a, b) => {
    const pctA = (a[1].t3 + a[1].t4) / a[1].total;
    const pctB = (b[1].t3 + b[1].t4) / b[1].total;
    return pctB - pctA;
  });
  for (const [src, t] of srcSorted) {
    const pct = ((t.t3 + t.t4) / t.total * 100).toFixed(1);
    console.log(`  ${src.padEnd(16)} T3+T4=${pct.padStart(5)}%  (${t.t3+t.t4}/${t.total})  T3=${t.t3} T4=${t.t4} T1=${t.t1} T2=${t.t2}`);
  }

  console.log(`\n--- T1 Decomposition (${t1Records.length} records) ---`);
  console.log(`  Has degree+visa, only missing skills: ${t1WithBoth} (${(t1WithBoth/t1Records.length*100).toFixed(0)}%)`);
  console.log(`  Has degree only (missing visa+skills): ${t1WithDegree - t1WithBoth}`);
  console.log(`  Has visa only (missing degree+skills): ${t1WithVisa - t1WithBoth}`);
  console.log(`  Has neither:                          ${t1WithNeither}`);
  console.log(`  → ${t1WithBoth} records would become T3/T4 if descriptions had tech terms`);
  console.log(`  → Projected T3+T4 with T1→T3 conversion: ${tiers[3]+tiers[4] + t1WithBoth}/${total} = ${((tiers[3]+tiers[4] + t1WithBoth)/total*100).toFixed(1)}%`);

  console.log(`\n  T1 by source:`);
  for (const [src, d] of Object.entries(t1BySource).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`    ${src.padEnd(16)} ${d.total} T1  (${d.hasDegreeVisa} close to T3)`);
  }

  console.log(`\n--- T2 Decomposition (${t2Records.length} records) ---`);
  console.log(`  Missing degree only: ${t2NoDegreeOnly}`);
  console.log(`  Missing visa only:   ${t2NoVisaOnly}`);
  console.log(`  Missing both:        ${t2NoBoth}`);

  console.log(`\n--- Version Propagation ---`);
  for (const [v, cnt] of Object.entries(versionCounts).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    console.log(`  v${v}: ${cnt} (${(cnt/total*100).toFixed(1)}%)`);
  }

  if (descQuality) {
    console.log(`\n--- Description Quality ---`);
    for (const [src, d] of Object.entries(descQuality.sources).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${src.padEnd(16)} ${d.count} descs  len: ${d.minLen}-${d.maxLen} (med ${d.medianLen})  template: ${d.templateCount} (${d.templatePct}%)`);
    }
  }

  console.log(`\n--- Top 20 Companies by T1 Count ---`);
  for (const [name, v] of topT1Companies.slice(0, 20)) {
    const pct = (v.t1 / v.total * 100).toFixed(0);
    console.log(`  ${name.padEnd(30)} T1=${v.t1} (${pct}% of ${v.total})  src=${v.source}`);
  }

  console.log(`\n--- Impact Projections ---`);
  const gaT1 = (t1BySource['google']?.total || 0) + (t1BySource['apple']?.total || 0);
  const t3t4 = tiers[3] + tiers[4];
  console.log(`  Google+Apple T1→T3 (AGG-FETCH-10): ${t3t4} + ${gaT1} = ${t3t4 + gaT1} → ${((t3t4 + gaT1)/total*100).toFixed(1)}%`);
  console.log(`  All T1→T3 (ideal):                  ${t3t4} + ${t1Records.length} = ${t3t4 + t1Records.length} → ${((t3t4 + t1Records.length)/total*100).toFixed(1)}%`);
  const allT2toT3 = t3t4 + t1Records.length + t2Records.length;
  console.log(`  All T1+T2→T3 (unrealistic):         ${allT2toT3}/${total} → ${(allT2toT3/total*100).toFixed(1)}%`);

  console.log();
}
})();