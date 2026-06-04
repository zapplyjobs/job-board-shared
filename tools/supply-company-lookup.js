#!/usr/bin/env node
'use strict';

/**
 * supply-company-lookup.js — look up whether a company is covered in SUP truth surfaces.
 *
 * Checks three layers:
 *  1. remote job-board-aggregator company-list.json (source config truth)
 *  2. local company-research-log.csv (evaluation/history truth)
 *  3. live R2 all_jobs.json (destination/output truth)
 *
 * Usage:
 *   node tools/supply-company-lookup.js "Honeywell"
 *   node tools/supply-company-lookup.js "NREL" --json
 *   node tools/supply-company-lookup.js "Ultra" --csv /path/to/company-research-log.csv
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadJsonFromR2 } = require('./r2-loader');

const ROOT = path.resolve(__dirname, '..');
const COMPANY_LIST_REPO = 'zapplyjobs/job-board-aggregator';
const COMPANY_LIST_PATH = 'lib/fetchers/company-list.json';
const TECH_DOMAINS = new Set(['software', 'hardware', 'data_science', 'ai']);

function parseArgs(argv) {
  const args = { query: null, json: false, csv: null, companyList: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!args.query && !arg.startsWith('--')) {
      args.query = arg;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--csv') {
      args.csv = argv[i + 1] || null;
      i += 1;
    } else if (arg === '--company-list') {
      args.companyList = argv[i + 1] || null;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.query) throw new Error('Usage: node tools/supply-company-lookup.js <company> [--json] [--csv PATH] [--company-list PATH]');
  return args;
}

function printHelp() {
  console.log('Usage: node tools/supply-company-lookup.js <company> [--json] [--csv PATH] [--company-list PATH]');
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function candidateMatch(queryNorm, candidate) {
  const candNorm = normalize(candidate);
  return Boolean(candNorm) && (queryNorm === candNorm || queryNorm.includes(candNorm) || candNorm.includes(queryNorm));
}

function findCsvPath(override) {
  const candidates = [
    override,
    process.env.ZJP_COMPANY_CSV,
    path.resolve(ROOT, '..', '..', '.GenAI_Work', 'projects', 'zjp', 'company-research-log.csv'),
    path.resolve(process.cwd(), 'projects', 'zjp', 'company-research-log.csv'),
    path.resolve(process.cwd(), 'company-research-log.csv'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`company-research-log.csv not found. Tried: ${candidates.join(', ')}`);
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] || ''; });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function loadCompanyList(localPath) {
  if (localPath) return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  const raw = execFileSync('gh', ['api', `repos/${COMPANY_LIST_REPO}/contents/${COMPANY_LIST_PATH}`, '--jq', '.content'], { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
}

function findCompanyListMatches(query, companyList) {
  const queryNorm = normalize(query);
  const matches = [];
  for (const [platform, entries] of Object.entries(companyList)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const name = entry.name || '';
      if (!candidateMatch(queryNorm, name)) continue;
      const record = { platform, name };
      for (const key of ['url', 'slug', 'base_url', 'site', 'site_number', 'tenant', 'verified_jobs', 'verified_date', 'default_domain']) {
        if (Object.prototype.hasOwnProperty.call(entry, key)) record[key] = entry[key];
      }
      matches.push(record);
    }
  }
  return matches;
}

function findCsvMatches(query, csvPath) {
  const queryNorm = normalize(query);
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const matches = [];
  for (const row of rows) {
    if (!candidateMatch(queryNorm, row.company || '')) continue;
    matches.push({
      company: row.company || '',
      ats: row.ats || '',
      slug: row.slug || '',
      status: row.status || '',
      date: row.date || '',
      notes: row.notes || '',
      domains: row.domains || '',
      fetch_total: row.fetch_total || '',
      pool_total: row.pool_total || '',
      tech_us_count: row.tech_us_count || '',
      intern_count: row.intern_count || '',
    });
  }
  return matches;
}

async function summarizeLivePool(names) {
  const targets = names.filter(Boolean);
  const out = Object.fromEntries(targets.map(name => [name, { total: 0, tech_us: 0, sources: {}, sample_titles: [] }]));
  if (targets.length === 0) return out;
  const jobs = await loadJsonFromR2('all_jobs.json');
  const targetMap = new Map(targets.map(name => [normalize(name), name]));
  for (const job of jobs) {
    const match = targetMap.get(normalize(job.company_name));
    if (!match) continue;
    const row = out[match];
    row.total += 1;
    const source = job.source || 'unknown';
    row.sources[source] = (row.sources[source] || 0) + 1;
    const tags = job.tags || {};
    if ((tags.locations || []).includes('us') && (tags.domains || []).some(d => TECH_DOMAINS.has(d))) row.tech_us += 1;
    if (row.sample_titles.length < 5) row.sample_titles.push(job.title || '');
  }
  return out;
}

function renderText(query, companyListMatches, csvMatches, poolSummary) {
  const lines = [`# SUP company lookup: ${query}`, ''];

  lines.push('## Company-list matches');
  if (companyListMatches.length) {
    for (const match of companyListMatches) {
      const detail = [];
      for (const key of ['slug', 'url', 'site', 'site_number', 'verified_jobs', 'verified_date']) {
        if (match[key] !== undefined && match[key] !== null && match[key] !== '') detail.push(`${key}=${match[key]}`);
      }
      lines.push(`- ${match.name} [${match.platform}]${detail.length ? ` | ${detail.join('; ')}` : ''}`);
    }
  } else {
    lines.push('- none');
  }

  lines.push('', '## CSV matches');
  if (csvMatches.length) {
    for (const row of csvMatches) {
      const detail = [`status=${row.status}`, `ats=${row.ats}`];
      if (row.slug) detail.push(`slug=${row.slug}`);
      if (row.date) detail.push(`date=${row.date}`);
      if (row.tech_us_count) detail.push(`tech_us_count=${row.tech_us_count}`);
      if (row.intern_count) detail.push(`intern_count=${row.intern_count}`);
      lines.push(`- ${row.company} | ${detail.join('; ')}`);
      if (row.notes) lines.push(`  notes: ${row.notes.slice(0, 240)}`);
    }
  } else {
    lines.push('- none');
  }

  lines.push('', '## Live R2 pool');
  let anyHits = false;
  for (const [name, summary] of Object.entries(poolSummary || {})) {
    if (!summary || summary.total === 0) continue;
    anyHits = true;
    lines.push(`- ${name}: total=${summary.total} | tech_us=${summary.tech_us} | sources=${JSON.stringify(summary.sources)}`);
    if (summary.sample_titles.length) lines.push(`  sample: ${summary.sample_titles.slice(0, 3).join(' | ')}`);
  }
  if (!anyHits) lines.push('- none');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = findCsvPath(args.csv);
  const companyList = loadCompanyList(args.companyList);
  const companyListMatches = findCompanyListMatches(args.query, companyList);
  const csvMatches = findCsvMatches(args.query, csvPath);

  const names = [];
  const seen = new Set();
  for (const row of companyListMatches) {
    const key = normalize(row.name);
    if (key && !seen.has(key)) { seen.add(key); names.push(row.name); }
  }
  for (const row of csvMatches) {
    const key = normalize(row.company);
    if (key && !seen.has(key)) { seen.add(key); names.push(row.company); }
  }
  if (names.length === 0) names.push(args.query);

  const livePool = await summarizeLivePool(names);
  const result = { query: args.query, csv_path: csvPath, company_list_matches: companyListMatches, csv_matches: csvMatches, live_pool: livePool };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(args.query, companyListMatches, csvMatches, livePool));
}

main().catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});
