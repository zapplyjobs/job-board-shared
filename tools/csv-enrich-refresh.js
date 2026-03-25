#!/usr/bin/env node

/**
 * CSV Enrichment Refresh — CSV-REFORM-1 (S229)
 *
 * Reads enrichment-stats.json and updates the company-research-log.csv
 * with current enrichment data (enriched_count, skills_pct, summary_pct).
 * Does NOT overwrite enrichment_notes — those are manually verified root causes.
 *
 * Usage:
 *   node tools/csv-enrich-refresh.js [--dry-run]
 *
 * Paths are relative to the standard repo layout:
 *   enrichment-stats: ../../jobs-data-2026/.github/data/enrichment-stats.json
 *   CSV: ../../.GenAI_Work/projects/zjp/company-research-log.csv
 */

'use strict';

const fs = require('fs');
const path = require('path');

const dryRun = process.argv.includes('--dry-run');
const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));

// Resolve paths
// Default paths assume standard repo layout under Job_Listings/
// __dirname = shared/tools/ → 5 levels up = Job_Listings/
const JOB_LISTINGS = path.resolve(__dirname, '..', '..', '..', '..', '..');
const STATS_PATH = positionalArgs[0] ||
  path.join(JOB_LISTINGS, 'jobs-data-2026', '.github', 'data', 'enrichment-stats.json');
const CSV_PATH = positionalArgs[1] ||
  path.resolve(JOB_LISTINGS, '..', '.GenAI_Work', 'projects', 'zjp', 'company-research-log.csv');

if (!fs.existsSync(STATS_PATH)) {
  console.error(`Stats file not found: ${STATS_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error(`CSV file not found: ${CSV_PATH}`);
  process.exit(1);
}

// Load enrichment stats
const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
const companies = stats.by_company || [];
console.log(`Enrichment stats: ${companies.length} companies (generated ${stats.generated})`);

// Build lookup: normalize company name → stats
const statsMap = new Map();
for (const c of companies) {
  statsMap.set(c.company.toLowerCase().trim(), c);
}

// Read CSV
const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n');
const header = lines[0].trim().split(',');

// Find column indices
const colIdx = {
  company: header.indexOf('company'),
  enriched_count: header.indexOf('enriched_count'),
  skills_pct: header.indexOf('skills_pct'),
  summary_pct: header.indexOf('summary_pct'),
  enrichment_notes: header.indexOf('enrichment_notes'),
  status: header.indexOf('status'),
};

if (colIdx.enriched_count === -1) {
  console.error('CSV missing enriched_count column');
  process.exit(1);
}

let updated = 0;
let skipped = 0;
const newLines = [lines[0]];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) { newLines.push(lines[i]); continue; }

  const fields = line.split(',');
  // Pad to header length if needed
  while (fields.length < header.length) fields.push('');

  const company = (fields[colIdx.company] || '').trim();
  const status = (fields[colIdx.status] || '').trim();

  // Only update accepted companies
  if (status !== 'accepted') {
    newLines.push(fields.join(',') + '\n');
    continue;
  }

  // Match against enrichment stats (fuzzy: check if CSV name is contained in stats name or vice versa)
  let match = statsMap.get(company.toLowerCase());
  if (!match) {
    // Try partial match
    for (const [statsName, statsData] of statsMap) {
      if (statsName.includes(company.toLowerCase()) || company.toLowerCase().includes(statsName)) {
        match = statsData;
        break;
      }
    }
  }

  if (match) {
    const oldCount = fields[colIdx.enriched_count].trim();
    const oldSkills = fields[colIdx.skills_pct].trim();

    fields[colIdx.enriched_count] = String(match.enriched);
    fields[colIdx.skills_pct] = String(match.skills_pct);
    fields[colIdx.summary_pct] = String(match.summary_pct);
    // Do NOT overwrite enrichment_notes — those are manually verified

    if (oldCount !== String(match.enriched) || oldSkills !== String(match.skills_pct)) {
      console.log(`  ${dryRun ? '[DRY-RUN] ' : ''}${company}: enriched ${oldCount || '—'}→${match.enriched}, skills ${oldSkills || '—'}%→${match.skills_pct}%`);
      updated++;
    } else {
      skipped++;
    }
  }

  newLines.push(fields.join(',') + '\n');
}

if (!dryRun) {
  fs.writeFileSync(CSV_PATH, newLines.join(''));
  console.log(`\nUpdated ${updated} companies, ${skipped} unchanged. CSV written.`);
} else {
  console.log(`\n[DRY-RUN] Would update ${updated} companies, ${skipped} unchanged.`);
}
