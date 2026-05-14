#!/usr/bin/env node
/**
 * CSV ↔ Company-List Reconciliation Tool (SUP-3)
 *
 * Quarterly reconciliation between company-research-log.csv and company-list.json.
 * Flags drift: missing CSV rows, stale statuses, naming variants, domain separator issues.
 *
 * Usage:
 *   node tools/csv-reconcile.js [--company-list /path/to/company-list.json] [--csv /path/to/company-research-log.csv] [--json]
 *
 * Exit code: 0 = clean, 1 = drift found
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};
const jsonOutput = args.includes('--json');

// ATS naming normalization map
const ATS_ALIASES = {
  'simplifyjs': 'simplify',
  'simplify_jobs': 'simplify',
  'simplify.js': 'simplify',
  'oracle_hcm': 'oracle',
  'oracle-hcm': 'oracle',
};

function normalizeAts(ats) {
  const lower = (ats || '').toLowerCase().trim();
  return ATS_ALIASES[lower] || lower;
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Simple CSV parse (handles quoted fields)
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    values.push(current.trim());

    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    if (row.company) rows.push(row);
  }
  return rows;
}

function loadCompanyList(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function reconcile(companyListPath, csvPath) {
  const companyList = loadCompanyList(companyListPath);
  const csvRows = parseCsv(csvPath);

  const issues = {
    missing_csv_rows: [],      // In company-list but not in CSV
    stale_statuses: [],        // CSV says accepted but not in company-list (wrong ATS)
    ats_naming_variants: [],   // Non-canonical ATS names in CSV
    domain_separator_issues: [], // Domains using # or , instead of |
    summary: { total_cl: 0, total_csv: csvRows.length, clean: 0 },
  };

  // Build CSV lookup: normalized name -> row
  const csvByName = new Map();
  for (const row of csvRows) {
    const key = normalizeName(row.company);
    csvByName.set(key, row);
  }

  // Check 1: Every company-list entry should have a CSV row
  for (const [ats, entries] of Object.entries(companyList)) {
    if (ats === '_meta') continue;
    issues.summary.total_cl += entries.length;

    for (const entry of entries) {
      const name = entry.name || entry.slug || '';
      const key = normalizeName(name);
      const csvRow = csvByName.get(key);

      if (!csvRow) {
        // Try partial match
        const partial = [...csvByName.keys()].find(k => k.includes(key) || key.includes(k));
        if (!partial) {
          issues.missing_csv_rows.push({
            company: name,
            ats,
            slug: entry.slug || entry.url || '',
          });
        }
      } else {
        // Cross-check ATS platform
        const csvAts = normalizeAts(csvRow.ats);
        const clAts = ats;
        if (csvAts !== clAts && csvRow.status === 'accepted') {
          issues.stale_statuses.push({
            company: name,
            csv_ats: csvRow.ats,
            cl_ats: clAts,
            csv_status: csvRow.status,
          });
        }
        issues.summary.clean++;
      }
    }
  }

  // Check 2: CSV accepted entries not in company-list (wrong ATS or missing)
  for (const row of csvRows) {
    if (row.status !== 'accepted') continue;
    const csvAts = normalizeAts(row.ats);
    const standardAts = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters'];
    if (!standardAts.includes(csvAts)) continue; // Skip non-standard ATS (simplify, etc.)

    const key = normalizeName(row.company);
    // Check if this company exists in company-list under ANY ATS
    let found = false;
    for (const [ats, entries] of Object.entries(companyList)) {
      if (ats === '_meta') continue;
      for (const entry of entries) {
        if (normalizeName(entry.name || '') === key) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      issues.stale_statuses.push({
        company: row.company,
        csv_ats: row.ats,
        cl_ats: 'NOT IN company-list',
        csv_status: row.status,
        note: 'Accepted in CSV but absent from company-list.json',
      });
    }
  }

  // Check 3: ATS naming variants in CSV
  for (const row of csvRows) {
    const original = (row.ats || '').toLowerCase().trim();
    if (ATS_ALIASES[original]) {
      issues.ats_naming_variants.push({
        company: row.company,
        original: row.ats,
        canonical: ATS_ALIASES[original],
      });
    }
  }

  // Check 4: Domain separator issues
  for (const row of csvRows) {
    const domains = row.domains || '';
    if (domains.includes('#') || domains.includes(', ')) {
      issues.domain_separator_issues.push({
        company: row.company,
        domains: domains,
        issue: domains.includes('#') ? 'Uses # instead of |' : 'Uses , instead of |',
      });
    }
  }

  return issues;
}

function printReport(issues) {
  const total = issues.summary.total_cl;
  const missing = issues.missing_csv_rows.length;
  const stale = issues.stale_statuses.length;
  const variants = issues.ats_naming_variants.length;
  const separators = issues.domain_separator_issues.length;

  console.log('=== CSV ↔ Company-List Reconciliation ===');
  console.log(`Company-list entries: ${total}`);
  console.log(`CSV rows: ${issues.summary.total_csv}`);
  console.log(`Clean: ${issues.summary.clean}/${total}`);
  console.log();

  if (missing > 0) {
    console.log(`--- Missing CSV Rows (${missing}) ---`);
    for (const item of issues.missing_csv_rows) {
      console.log(`  ${item.company} [${item.ats}] slug=${item.slug}`);
    }
    console.log();
  }

  if (stale > 0) {
    console.log(`--- Stale/Wrong ATS (${stale}) ---`);
    for (const item of issues.stale_statuses) {
      console.log(`  ${item.company}: CSV=${item.csv_ats}/${item.csv_status}, CL=${item.cl_ats}${item.note ? ' — ' + item.note : ''}`);
    }
    console.log();
  }

  if (variants > 0) {
    console.log(`--- ATS Naming Variants (${variants}) ---`);
    for (const item of issues.ats_naming_variants) {
      console.log(`  ${item.company}: "${item.original}" → should be "${item.canonical}"`);
    }
    console.log();
  }

  if (separators > 0) {
    console.log(`--- Domain Separator Issues (${separators}) ---`);
    for (const item of issues.domain_separator_issues) {
      console.log(`  ${item.company}: ${item.issue} (${item.domains})`);
    }
    console.log();
  }

  const totalIssues = missing + stale + variants + separators;
  console.log(`=== Summary: ${totalIssues} issues found ===`);

  if (jsonOutput) {
    console.log('\n--- JSON Output ---');
    console.log(JSON.stringify(issues, null, 2));
  }

  return totalIssues > 0 ? 1 : 0;
}

// Main
const clPath = getArg('--company-list') || path.join(__dirname, 'company-list.json');
const csvPath = getArg('--csv') || path.join(__dirname, '..', '..', '..', 'projects', 'zjp', 'company-research-log.csv');

if (!fs.existsSync(clPath)) {
  console.error(`ERROR: company-list.json not found at ${clPath}`);
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error(`ERROR: CSV not found at ${csvPath}`);
  process.exit(1);
}

const issues = reconcile(clPath, csvPath);
const exitCode = printReport(issues);
process.exit(exitCode);
