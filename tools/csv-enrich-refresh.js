#!/usr/bin/env node

/**
 * CSV Company Data Refresh — CSV-REFORM-1 Phase 1 (S229)
 *
 * Reads pipeline data and updates company-research-log.csv with:
 *   - enriched_count, skills_pct, summary_pct (from enrichment-stats.json)
 *   - total_jobs, tech_us_jobs, intern_count (from all_jobs.json)
 *   - has_descriptions (from descriptions-*.jsonl)
 *   - last_audit_date (set to today on each run)
 *
 * Does NOT overwrite: enrichment_notes, domains, status, reason, notes
 * (those are manually verified).
 *
 * Usage:
 *   node tools/csv-enrich-refresh.js [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const dryRun = process.argv.includes('--dry-run');

// Default paths: Job_Listings/ is 5 levels up from shared/tools/
const JOB_LISTINGS = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DATA_DIR = path.join(JOB_LISTINGS, 'jobs-data-2026', '.github', 'data');
const STATS_PATH = path.join(DATA_DIR, 'enrichment-stats.json');
const ALL_JOBS_PATH = path.join(DATA_DIR, 'all_jobs.json');
const CSV_PATH = path.resolve(JOB_LISTINGS, '..', '.GenAI_Work', 'projects', 'zjp', 'company-research-log.csv');

const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai', 'cybersecurity']);

// ---------------------------------------------------------------------------
// 1. Load enrichment stats (top companies only)
// ---------------------------------------------------------------------------
const statsMap = new Map();
if (fs.existsSync(STATS_PATH)) {
  const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  for (const c of (stats.by_company || [])) {
    statsMap.set(c.company.toLowerCase().trim(), c);
  }
  console.log(`Enrichment stats: ${statsMap.size} companies (generated ${stats.generated})`);
} else {
  console.warn(`Warning: ${STATS_PATH} not found — enrichment columns will not be updated`);
}

// ---------------------------------------------------------------------------
// 2. Load pool data from all_jobs.json (per-company counts)
// ---------------------------------------------------------------------------
const poolMap = new Map(); // company_name.lower → { total, tech_us, intern }
if (fs.existsSync(ALL_JOBS_PATH)) {
  const lines = fs.readFileSync(ALL_JOBS_PATH, 'utf8').trim().split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const job = JSON.parse(line);
      const company = (job.company_name || '').trim();
      if (!company) continue;
      const key = company.toLowerCase();
      if (!poolMap.has(key)) poolMap.set(key, { total: 0, tech_us: 0, intern: 0, name: company });
      const d = poolMap.get(key);
      d.total++;
      const domains = job.tags?.domains || [];
      const locs = job.tags?.locations || [];
      if (domains.some(dom => TECH_DOMAINS.has(dom)) && locs.includes('us')) d.tech_us++;
      if (job.tags?.employment === 'internship') d.intern++;
    } catch (_) {}
  }
  console.log(`Pool data: ${poolMap.size} companies from all_jobs.json`);
} else {
  console.warn(`Warning: ${ALL_JOBS_PATH} not found — pool columns will not be updated`);
}

// ---------------------------------------------------------------------------
// 3. Load description availability (which companies have descriptions?)
// ---------------------------------------------------------------------------
const descCompanies = new Map(); // company_slug.lower → count of descriptions
const descFiles = fs.readdirSync(DATA_DIR).filter(f => /^descriptions-.*\.jsonl$/.test(f));
let totalDescs = 0;
const descIdSet = new Set();
for (const f of descFiles) {
  const lines = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').trim().split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const { id } = JSON.parse(line);
      if (id) descIdSet.add(id);
      totalDescs++;
    } catch (_) {}
  }
}
console.log(`Descriptions: ${descIdSet.size} unique IDs across ${descFiles.length} sidecar files`);

// Match description IDs to companies via all_jobs.json
const companyDescCount = new Map(); // company.lower → { has_desc, total }
if (fs.existsSync(ALL_JOBS_PATH)) {
  const lines = fs.readFileSync(ALL_JOBS_PATH, 'utf8').trim().split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const job = JSON.parse(line);
      const company = (job.company_name || '').toLowerCase().trim();
      if (!company) continue;
      if (!companyDescCount.has(company)) companyDescCount.set(company, { has: 0, total: 0 });
      const d = companyDescCount.get(company);
      d.total++;
      if (descIdSet.has(job.id)) d.has++;
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 4. Read and update CSV
// ---------------------------------------------------------------------------
const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
const csvLines = csvContent.split('\n');
const header = csvLines[0].trim().split(',');

const col = {};
for (const name of header) col[name] = header.indexOf(name);

const today = new Date().toISOString().slice(0, 10);
let updated = 0;
let skipped = 0;
const newLines = [csvLines[0].trim() + '\n'];

for (let i = 1; i < csvLines.length; i++) {
  const line = csvLines[i].trim();
  if (!line) { newLines.push(csvLines[i]); continue; }

  const fields = line.split(',');
  while (fields.length < header.length) fields.push('');

  const company = (fields[col.company] || '').trim();
  const status = (fields[col.status] || '').trim();

  if (status !== 'accepted') {
    newLines.push(fields.join(',') + '\n');
    continue;
  }

  let changed = false;

  // --- Enrichment stats (top companies only) ---
  let statsMatch = statsMap.get(company.toLowerCase());
  if (!statsMatch) {
    for (const [name, data] of statsMap) {
      if (name.includes(company.toLowerCase()) || company.toLowerCase().includes(name)) {
        statsMatch = data;
        break;
      }
    }
  }
  if (statsMatch) {
    if (fields[col.enriched_count] !== String(statsMatch.enriched) ||
        fields[col.skills_pct] !== String(statsMatch.skills_pct)) {
      changed = true;
    }
    fields[col.enriched_count] = String(statsMatch.enriched);
    fields[col.skills_pct] = String(statsMatch.skills_pct);
    fields[col.summary_pct] = String(statsMatch.summary_pct);
  }

  // --- Pool counts (from all_jobs.json) ---
  let poolMatch = poolMap.get(company.toLowerCase());
  if (!poolMatch) {
    for (const [name, data] of poolMap) {
      if (name.includes(company.toLowerCase()) || company.toLowerCase().includes(name)) {
        poolMatch = data;
        break;
      }
    }
  }
  if (poolMatch) {
    const oldTotal = fields[col.total_jobs];
    fields[col.total_jobs] = String(poolMatch.total);
    fields[col.tech_us_jobs] = String(poolMatch.tech_us);
    fields[col.intern_count] = String(poolMatch.intern);
    if (oldTotal !== String(poolMatch.total)) changed = true;
  }

  // --- Description availability ---
  const descData = companyDescCount.get(company.toLowerCase());
  if (descData) {
    const ratio = descData.has / descData.total;
    const hasDesc = ratio > 0.8 ? 'yes' : (ratio > 0.1 ? 'partial' : 'no');
    if (fields[col.has_descriptions] !== hasDesc) changed = true;
    fields[col.has_descriptions] = hasDesc;
  }

  // --- Last audit date ---
  if (changed) {
    fields[col.last_audit_date] = today;
    updated++;
    if (dryRun) {
      console.log(`  [DRY-RUN] ${company}: total=${fields[col.total_jobs]} tech_us=${fields[col.tech_us_jobs]} intern=${fields[col.intern_count]} skills=${fields[col.skills_pct] || '—'}% desc=${fields[col.has_descriptions]}`);
    }
  } else {
    skipped++;
  }

  newLines.push(fields.join(',') + '\n');
}

if (!dryRun) {
  fs.writeFileSync(CSV_PATH, newLines.join(''));
  console.log(`\nUpdated ${updated} companies, ${skipped} unchanged. CSV written.`);
} else {
  console.log(`\n[DRY-RUN] Would update ${updated} companies, ${skipped} unchanged.`);
}
