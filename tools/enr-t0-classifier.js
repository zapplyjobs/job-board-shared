#!/usr/bin/env node

/**
 * ENR T0/T1 Root Cause Classifier — ENR-QUALITY-1 (C16)
 *
 * Classifies every T0 and T1 record in enriched_jobs.json by source,
 * company, version, and root cause. Replaces 5+ manual bash/python
 * commands that every ENR session runs.
 *
 * Usage:
 *   node tools/enr-t0-classifier.js [path-to-enriched_jobs.json]
 *
 * Default path: ../../jobs-data-2026/.github/data/enriched_jobs.json
 *
 * Output: JSON report to stdout with:
 *   - Summary: total records, tier distribution, version propagation
 *   - T0 breakdown: by source, by company (top 20), by version
 *   - T1 breakdown: by source, by company (top 20), by version
 *   - T2 composition: degree-only vs visa-only vs both missing
 *   - Skills signal: noise-only records count
 *   - Visa gap: zero-signal records by company (top 20)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const defaultPath = path.resolve(__dirname, '..', '..', '..', '..', 'jobs-data-2026', '.github', 'data', 'enriched_jobs.json');
const inputPath = process.argv[2] || defaultPath;

if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  console.error('Usage: node tools/enr-t0-classifier.js [path-to-enriched_jobs.json]');
  process.exit(1);
}

const lines = fs.readFileSync(inputPath, 'utf8').trim().split('\n').filter(Boolean);
const records = [];
let parseErrors = 0;
for (const line of lines) {
  try {
    records.push(JSON.parse(line));
  } catch (e) {
    parseErrors++;
  }
}

// Tier classification — mirrors enrich-jobs.js lines 1231-1239
// T3 checks degree + visa (not experience). Experience covers 100% via tags (no-op).
function classifyTier(r) {
  const hasDesc = r.has_description !== undefined ? !!r.has_description : !!r.summary_line;
  if (!hasDesc) return 0;
  if (!r.required_skills || r.required_skills.length === 0) return 1;
  const hasDegree = r.min_degree !== null && r.min_degree !== undefined;
  const hasVisa = r.sponsors_visa !== null || r.possible_sponsor !== null || r.visa_question_present !== null;
  return (hasDegree && hasVisa) ? 3 : 2;
}

function getCompany(r) {
  return r.company_name || 'Unknown';
}

function countBy(arr, keyFn) {
  const result = {};
  for (const item of arr) {
    const key = keyFn(item);
    result[key] = (result[key] || 0) + 1;
  }
  return Object.entries(result).sort((a, b) => b[1] - a[1]);
}

// Tiers
const tiers = { 0: [], 1: [], 2: [], 3: [] };
for (const r of records) {
  tiers[classifyTier(r)].push(r);
}

// Version distribution
const versions = countBy(records, r => `v${r.enricher_version || 0}`);
const latestVersion = Math.max(...records.map(r => r.enricher_version || 0));
const latestVersionCount = records.filter(r => r.enricher_version === latestVersion).length;

// T0 breakdown
const t0BySource = countBy(tiers[0], r => r.source || 'unknown');
const t0ByCompany = countBy(tiers[0], r => getCompany(r));
const t0ByVersion = countBy(tiers[0], r => `v${r.enricher_version || 0}`);

// T1 breakdown
const t1BySource = countBy(tiers[1], r => r.source || 'unknown');
const t1ByCompany = countBy(tiers[1], r => getCompany(r));
const t1ByVersion = countBy(tiers[1], r => `v${r.enricher_version || 0}`);

// T2 composition
const t2missingDegree = tiers[2].filter(r => r.min_degree === null || r.min_degree === undefined);
const t2missingVisa = tiers[2].filter(r =>
  r.sponsors_visa === null && r.possible_sponsor === null && r.visa_question_present === null
);
const t2missDegreeOnly = t2missingDegree.filter(r =>
  r.sponsors_visa !== null || r.possible_sponsor !== null || r.visa_question_present !== null
);
const t2missVisaOnly = t2missingVisa.filter(r => r.min_degree !== null && r.min_degree !== undefined);
const t2missBoth = tiers[2].filter(r =>
  (r.min_degree === null || r.min_degree === undefined) &&
  r.sponsors_visa === null && r.possible_sponsor === null && r.visa_question_present === null
);

// Noise-only skills
const noiseTerms = new Set(['analytics', 'reporting', 'analysis', 'consulting', 'modeling',
  'visualization', 'automation', 'integration', 'optimization', 'communication', 'collaboration',
  'microsoft office']);
const noiseOnly = records.filter(r => {
  const skills = (r.required_skills || []).map(s => s.toLowerCase().trim());
  return skills.length > 0 && skills.every(s => noiseTerms.has(s));
});

// Visa zero-signal
const zeroVisa = records.filter(r =>
  r.sponsors_visa === null && r.possible_sponsor === null && r.visa_question_present === null
);
const zeroVisaByCompany = countBy(zeroVisa, r => getCompany(r));

const report = {
  timestamp: new Date().toISOString(),
  total_records: records.length,
  parse_errors: parseErrors || undefined,
  tier_distribution: {
    t0: tiers[0].length,
    t1: tiers[1].length,
    t2: tiers[2].length,
    t3: tiers[3].length,
    t3_pct: +(tiers[3].length / records.length * 100).toFixed(1)
  },
  version_propagation: {
    latest_version: latestVersion,
    latest_version_count: latestVersionCount,
    latest_version_pct: +(latestVersionCount / records.length * 100).toFixed(1),
    versions: Object.fromEntries(versions)
  },
  t0_breakdown: {
    by_source: Object.fromEntries(t0BySource),
    by_company_top20: Object.fromEntries(t0ByCompany.slice(0, 20)),
    by_version: Object.fromEntries(t0ByVersion)
  },
  t1_breakdown: {
    by_source: Object.fromEntries(t1BySource),
    by_company_top20: Object.fromEntries(t1ByCompany.slice(0, 20)),
    by_version: Object.fromEntries(t1ByVersion)
  },
  t2_composition: {
    total: tiers[2].length,
    missing_degree_only: t2missDegreeOnly.length,
    missing_visa_only: t2missVisaOnly.length,
    missing_both: t2missBoth.length
  },
  quality_metrics: {
    noise_only_records: noiseOnly.length,
    noise_only_pct: +(noiseOnly.length / records.length * 100).toFixed(2),
    zero_visa_signal: zeroVisa.length,
    zero_visa_pct: +(zeroVisa.length / records.length * 100).toFixed(1),
    zero_visa_top20: Object.fromEntries(zeroVisaByCompany.slice(0, 20))
  }
};

console.log(JSON.stringify(report, null, 2));
