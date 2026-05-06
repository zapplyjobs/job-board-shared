#!/usr/bin/env node

/**
 * CSV Update Tool (SUP-SELF-1)
 *
 * Add or update rows in company-research-log.csv.
 * Ensures correct column count (21) and validates field values.
 *
 * Modes:
 *   add    — Add a new company evaluation row
 *   update — Update fields on an existing row (by company name)
 *   status — Batch-update status for multiple companies
 *
 * Usage:
 *   node tools/csv-update.js add --company "Veeva Systems" --ats simplifyjs --slug "Veeva Systems" --status accepted --reason "..." --domains "software" --session F41
 *   node tools/csv-update.js update --company "Veeva Systems" --status accepted --notes "Updated note"
 *   node tools/csv-update.js status --file /tmp/updates.json
 *
 * Input file format (for --file):
 *   [{"company":"Name","status":"accepted","reason":"...","ats":"greenhouse","slug":"slug","domains":"software","session":"F41"}, ...]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const basePath = process.argv.find(a => a === '--path')
    ? process.argv[process.argv.indexOf('--path') + 1]
    : path.resolve(__dirname, '..', '..', '..', '.GenAI_Work', 'projects', 'zjp');

const CSV_PATH = path.join(basePath, 'company-research-log.csv');

const VALID_STATUSES = ['accepted', 'rejected', 'unfetchable', 'pending-add'];
const VALID_ATS = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'simplifyjs', 'custom', 'eightfold', 'jsearch'];
const TODAY = new Date().toISOString().split('T')[0];

// Parse CLI args into key-value pairs
function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const key = process.argv[i].slice(2);
      const val = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : '';
      if (val) { args[key] = val; i++; }
    }
  }
  return args;
}

// Read CSV, skipping comment lines
function readCSV() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = raw.split('\n');
  const dataLines = lines.filter(l => l.trim() && !l.startsWith('#'));
  return dataLines.map(l => parseCSVLine(l));
}

// Parse CSV line respecting quoted fields
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// Write CSV back
function writeCSV(rows) {
  const header = fs.readFileSync(CSV_PATH, 'utf-8').split('\n').filter(l => l.startsWith('#')).join('\n');
  const lines = rows.map(r => csvLine(r));
  fs.writeFileSync(CSV_PATH, header + '\n' + lines.join('\n') + '\n');
}

// Convert fields array to CSV line (quote fields containing commas)
function csvLine(fields) {
  return fields.map(f => {
    if (f.includes(',') || f.includes('"') || f.includes('\n')) {
      return '"' + f.replace(/"/g, '""') + '"';
    }
    return f;
  }).join(',');
}

// Build a 21-field row from partial data
function buildRow(data) {
  const row = new Array(21).fill('');
  row[0] = data.company || '';
  row[1] = data.ats || '';
  row[2] = data.slug || data.slug_or_url || '';
  row[3] = data.status || '';
  row[4] = data.reason || '';
  row[5] = data.domains || '';
  row[6] = data.verified_date || TODAY;
  row[7] = data.session || data.added_session || '';
  row[8] = data.notes || '';
  // 9-16: auto-refresh fields (empty for new rows)
  // 17: has_descriptions
  // 18: last_audit_date
  // 19: domain_breakdown
  // 20: tag_review_result
  row[20] = data.tag_review_result || 'not-reviewed';
  return row;
}

// Find row index by company name (case-insensitive)
function findRow(rows, company) {
  const lower = company.toLowerCase();
  return rows.findIndex(r => r[0].toLowerCase() === lower);
}

// Mode: add
function cmdAdd(args) {
  if (!args.company) { console.error('Error: --company required'); process.exit(1); }
  if (!args.status) { console.error('Error: --status required'); process.exit(1); }
  if (!VALID_STATUSES.includes(args.status)) { console.error(`Error: invalid status "${args.status}". Valid: ${VALID_STATUSES.join(', ')}`); process.exit(1); }

  const rows = readCSV();
  const idx = findRow(rows, args.company);
  if (idx >= 0) {
    console.error(`Error: "${args.company}" already exists at row ${idx + 1}. Use "update" mode instead.`);
    process.exit(1);
  }

  const row = buildRow(args);
  if (row.length !== 21) { console.error(`Error: row has ${row.length} fields, expected 21`); process.exit(1); }

  rows.push(row);
  writeCSV(rows);
  console.log(`Added: "${args.company}" (${args.status})`);
}

// Mode: update
function cmdUpdate(args) {
  if (!args.company) { console.error('Error: --company required'); process.exit(1); }

  const rows = readCSV();
  const idx = findRow(rows, args.company);
  if (idx < 0) {
    console.error(`Error: "${args.company}" not found in CSV. Use "add" mode first.`);
    process.exit(1);
  }

  const row = rows[idx];
  let changed = [];

  if (args.status) {
    if (!VALID_STATUSES.includes(args.status)) { console.error(`Error: invalid status "${args.status}"`); process.exit(1); }
    row[3] = args.status;
    changed.push(`status=${args.status}`);
  }
  if (args.ats) { row[1] = args.ats; changed.push(`ats=${args.ats}`); }
  if (args.slug) { row[2] = args.slug; changed.push(`slug=${args.slug}`); }
  if (args.reason) { row[4] = args.reason; changed.push('reason updated'); }
  if (args.domains) { row[5] = args.domains; changed.push(`domains=${args.domains}`); }
  if (args.session) { row[7] = args.session; changed.push(`session=${args.session}`); }
  if (args.notes) { row[8] = args.notes ? (row[8] ? row[8] + ' ' + args.notes : args.notes) : row[8]; changed.push('notes appended'); }

  rows[idx] = row;
  writeCSV(rows);
  console.log(`Updated: "${args.company}" — ${changed.join(', ')}`);
}

// Mode: status (batch from file)
function cmdStatus(args) {
  if (!args.file) { console.error('Error: --file required for batch mode'); process.exit(1); }

  const updates = JSON.parse(fs.readFileSync(args.file, 'utf-8'));
  const rows = readCSV();
  let added = 0, updated = 0, skipped = 0;

  for (const entry of updates) {
    const idx = findRow(rows, entry.company);
    if (idx >= 0) {
      // Update existing
      if (entry.status) rows[idx][3] = entry.status;
      if (entry.reason) rows[idx][4] = entry.reason;
      if (entry.notes) rows[idx][8] = rows[idx][8] ? rows[idx][8] + ' ' + entry.notes : entry.notes;
      updated++;
    } else if (entry.status === 'accepted' || entry.status === 'rejected' || entry.status === 'unfetchable') {
      // Add new
      rows.push(buildRow(entry));
      added++;
    } else {
      skipped++;
    }
  }

  writeCSV(rows);
  console.log(`Batch: ${added} added, ${updated} updated, ${skipped} skipped`);
}

// Main
const mode = process.argv[2];
const args = parseArgs();

if (!mode || !['add', 'update', 'status'].includes(mode)) {
  console.error('Usage: node csv-update.js <add|update|status> [--company X] [--ats X] [--slug X] [--status X] [--reason X] [--domains X] [--session X] [--notes X] [--file X]');
  process.exit(1);
}

if (mode === 'add') cmdAdd(args);
else if (mode === 'update') cmdUpdate(args);
else if (mode === 'status') cmdStatus(args);
