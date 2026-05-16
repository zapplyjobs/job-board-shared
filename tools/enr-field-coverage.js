#!/usr/bin/env node
// enr-field-coverage.js — Quick per-source enrichment field coverage report
// Replaces inline python blocks that check "what % of X jobs have Y field?"
// Usage: node tools/enr-field-coverage.js /path/to/enriched_jobs.json [--source NAME] [--field NAME] [--json]
//        node projects/zjp/scripts/enr-field-coverage.js [--remote] [--source NAME] [--field NAME] [--json]
//
// Output: Per-source field coverage table (skills, degree, visa, description, summary_line)
// With --source: detailed breakdown for one source
// With --field: filter to specific field only

const https = require('https');
const zlib = require('zlib');

const FIELDS = [
  { key: 'skills', label: 'Skills', check: v => Array.isArray(v) && v.length > 0 },
  { key: 'degree_level', label: 'Degree', check: v => v && v !== 'None' && v !== 'NONE' },
  { key: 'possible_sponsor', label: 'Visa', check: v => v !== null && v !== undefined },
  { key: 'has_description', label: 'Desc', check: v => v === true },
  { key: 'summary_line', label: 'Summary', check: v => v && v.trim().length > 0 },
];

async function fetchRemote(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRemote(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const encoding = res.headers['content-encoding'];
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      let data = '';
      stream.on('data', chunk => data += chunk);
      stream.on('end', () => resolve(data));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function loadData(filePath, useRemote) {
  // Priority: explicit file path > remote > local fallback
  if (filePath && !filePath.startsWith('-')) {
    const fs = require('fs');
    const raw = fs.readFileSync(filePath, 'utf8');
    try { return JSON.parse(raw); } catch { return raw.trim().split('\n').filter(l => l).map(l => JSON.parse(l)); }
  }
  if (useRemote) {
    // Try r2-loader first (S3 client, live data when env vars set)
    try {
      const { loadJsonFromR2 } = require('./r2-loader');
      const records = await loadJsonFromR2('enriched_jobs.json');
      return records;
    } catch {}
    // Fallback: R2 public URL, then GitHub raw
    try {
    try {
      const raw = await fetchRemote('https://pub-7c6b1d38c7974dd7a11e3a1e6e46c68b.r2.dev/enriched_jobs.json');
      try { return JSON.parse(raw); } catch { return raw.trim().split('\n').map(l => JSON.parse(l)); }
    } catch {
      const raw = await fetchRemote('https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/enriched_jobs.json');
      try { return JSON.parse(raw); } catch { return raw.trim().split('\n').filter(l => l).map(l => JSON.parse(l)); }
    }
  }
  // Local fallback
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '..', 'enriched_jobs.json');
    const raw = fs.readFileSync(p, 'utf8');
    try { return JSON.parse(raw); } catch { return raw.trim().split('\n').filter(l => l).map(l => JSON.parse(l)); }
  } catch {
    throw new Error('No data source available. Provide a file path or use --remote.');
  }
}

function getSource(job) {
  return (job.source || job.fetcher_type || 'unknown').toLowerCase();
}

function analyzeCoverage(jobs, filterSource, filterField) {
  const bySource = {};
  let total = 0;

  for (const job of jobs) {
    const source = getSource(job);
    if (filterSource && source !== filterSource.toLowerCase()) continue;
    if (!bySource[source]) bySource[source] = { count: 0, fields: {} };
    bySource[source].count++;
    total++;

    const fieldsToCheck = filterField
      ? FIELDS.filter(f => f.key === filterField || f.label.toLowerCase() === filterField.toLowerCase())
      : FIELDS;

    for (const field of fieldsToCheck) {
      if (!bySource[source].fields[field.key]) {
        bySource[source].fields[field.key] = { present: 0, total: 0 };
      }
      bySource[source].fields[field.key].total++;
      if (field.check(job[field.key])) {
        bySource[source].fields[field.key].present++;
      }
    }
  }

  return { bySource, total };
}

function formatTable(result, filterField) {
  const sources = Object.entries(result.bySource).sort((a, b) => b[1].count - a[1].count);
  const fieldsToCheck = filterField
    ? FIELDS.filter(f => f.key === filterField || f.label.toLowerCase() === filterField.toLowerCase())
    : FIELDS;

  // Header
  const headers = ['Source', 'Jobs', ...fieldsToCheck.map(f => f.label)].map(s => s.padEnd(10));
  console.log(headers.join(' | '));
  console.log(headers.map(() => '----------').join('-+-'));

  // Rows
  for (const [source, data] of sources) {
    const cols = [
      source.padEnd(10),
      String(data.count).padEnd(10),
      ...fieldsToCheck.map(f => {
        const fieldData = data.fields[f.key];
        if (!fieldData) return '?'.padEnd(10);
        const pct = fieldData.total > 0 ? ((fieldData.present / fieldData.total) * 100).toFixed(1) : '0';
        return `${pct}%`.padEnd(10);
      })
    ];
    console.log(cols.join(' | '));
  }

  // Total
  const totalCols = [
    'TOTAL'.padEnd(10),
    String(result.total).padEnd(10),
    ...fieldsToCheck.map(f => {
      let present = 0, total = 0;
      for (const data of Object.values(result.bySource)) {
        if (data.fields[f.key]) {
          present += data.fields[f.key].present;
          total += data.fields[f.key].total;
        }
      }
      const pct = total > 0 ? ((present / total) * 100).toFixed(1) : '0';
      return `${pct}%`.padEnd(10);
    })
  ];
  console.log(totalCols.join(' | '));
}

function formatSourceDetail(source, data) {
  console.log(`\nSource: ${source} (${data.count} jobs)`);
  console.log('---');
  for (const field of FIELDS) {
    const fd = data.fields[field.key];
    if (!fd) { console.log(`  ${field.label}: no data`); continue; }
    const pct = fd.total > 0 ? ((fd.present / fd.total) * 100).toFixed(1) : '0';
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    console.log(`  ${field.label.padEnd(10)} ${bar} ${pct}% (${fd.present}/${fd.total})`);
  }
}

// Main
const args = process.argv.slice(2);
const useRemote = args.includes('--remote');
const jsonOutput = args.includes('--json');
const sourceIdx = args.indexOf('--source');
const fieldIdx = args.indexOf('--field');
const filterSource = sourceIdx >= 0 ? args[sourceIdx + 1] : null;
const filterField = fieldIdx >= 0 ? args[fieldIdx + 1] : null;
// First non-flag argument is the file path
const filePath = args.find(a => !a.startsWith('-'));

(async () => {
  try {
    console.error('Loading enriched jobs...');
    const jobs = await loadData(filePath, useRemote);
    console.error(`Loaded ${jobs.length} jobs`);

    const result = analyzeCoverage(jobs, filterSource, filterField);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else if (filterSource && result.bySource[filterSource.toLowerCase()]) {
      formatSourceDetail(filterSource.toLowerCase(), result.bySource[filterSource.toLowerCase()]);
    } else {
      formatTable(result, filterField);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
