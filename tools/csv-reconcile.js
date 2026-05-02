#!/usr/bin/env node

/**
 * CSV↔Company-List Reconciliation (SUP-3)
 *
 * Compares company-research-log.csv against company-list.json and reports:
 *   1. Missing CSV rows (company-list entries without CSV documentation)
 *   2. Stale statuses (CSV says accepted but not in company-list, or vice versa)
 *   3. ATS naming normalization issues (variant names for same platform)
 *   4. Domain separator issues (# or , instead of |)
 *
 * Output: JSON reconciliation report to stdout.
 * Usage:
 *   node tools/csv-reconcile.js [--path /path/to/GenAI_Work]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const basePath = process.argv.find(a => a === '--path')
    ? process.argv[process.argv.indexOf('--path') + 1]
    : path.resolve(__dirname, '..', '..', '..', '.GenAI_Work', 'projects', 'zjp');

const CSV_PATH = path.join(basePath, 'company-research-log.csv');
const CL_PATH = path.resolve(__dirname, '..', 'lib', 'aggregator', 'fetchers', 'company-list.json');

// Canonical ATS names
const ATS_CANONICAL = {
    'simplifyjobs': 'simplifyjs',
    'simplify_jobs': 'simplifyjs',
    'simplify js': 'simplifyjs',
    'oracle_hcm': 'oracle-hcm',
    'oracle hcm': 'oracle-hcm',
    'eightfold': 'eightfold',
};

// Standard ATS platforms that appear in company-list.json
const STANDARD_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters']);

// Non-company-list entry sources (exempt from reconciliation)
const EXEMPT_SOURCES = new Set(['simplifyjs', 'custom', 'jsearch', 'eightfold', 'oracle-hcm']);

function loadCSV() {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split('\n');
    const rows = [];
    for (const line of lines) {
        if (line.startsWith('#') || line.trim() === '') continue;
        const fields = parseCSVLine(line);
        if (fields.length >= 6) {
            rows.push({
                company: fields[0]?.trim(),
                ats: fields[1]?.trim(),
                slug: fields[2]?.trim(),
                status: fields[3]?.trim(),
                reason: fields[4]?.trim(),
                domains: fields[5]?.trim(),
                notes: fields[7]?.trim() || '',
            });
        }
    }
    return rows;
}

function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
        if (ch === '"') {
            inQuotes = !inQuotes;
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

function loadCompanyList() {
    const data = JSON.parse(fs.readFileSync(CL_PATH, 'utf8'));
    const entries = [];
    for (const [ats, tenants] of Object.entries(data)) {
        if (ats === '_meta' || !Array.isArray(tenants)) continue;
        for (const t of tenants) {
            const slug = t.slug || t.url || '';
            const name = t.name || '';
            entries.push({ ats, name, slug: normalizeSlug(slug), originalSlug: slug });
        }
    }
    return entries;
}

function normalizeSlug(slug) {
    // Strip protocol, trailing slashes, and site segments
    let s = slug.toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
    // For WD URLs, strip the site path (e.g., /panwexternalcareers, /External, /targetcareers)
    // Keep just the hostname for matching
    if (s.includes('myworkdayjobs.com')) {
        s = s.split('/')[0]; // hostname only
    }
    return s;
}

function reconcile() {
    const csv = loadCSV();
    const cl = loadCompanyList();

    const issues = { missing_csv: [], stale_status: [], ats_naming: [], domain_sep: [] };

    // Build lookup maps
    const csvBySlug = new Map();
    const csvByName = new Map();
    for (const row of csv) {
        if (row.slug) csvBySlug.set(normalizeSlug(row.slug), row);
        if (row.company) csvByName.set(row.company.toLowerCase(), row);
    }

    const clSlugs = new Set(cl.map(e => e.slug));
    const clNames = new Map(cl.map(e => [e.name.toLowerCase(), e]));

    // Check 1: Missing CSV rows — company-list entries without CSV documentation
    for (const entry of cl) {
        const normalizedSlug = normalizeSlug(entry.slug);
        const matchBySlug = csvBySlug.get(normalizedSlug);
        const matchByName = csvByName.get(entry.name.toLowerCase());

        if (!matchBySlug && !matchByName) {
            issues.missing_csv.push({
                company: entry.name,
                ats: entry.ats,
                slug: entry.originalSlug,
            });
        }
    }

    // Check 2: Stale statuses — CSV accepted with standard ATS but not in company-list
    for (const row of csv) {
        if (row.status !== 'accepted') continue;
        const atsLower = (row.ats || '').toLowerCase();
        if (!STANDARD_ATS.has(atsLower)) continue;

        const normalizedSlug = normalizeSlug(row.slug);
        const inCL = cl.some(e => normalizeSlug(e.slug) === normalizedSlug);
        const nameInCL = clNames.has(row.company.toLowerCase());

        if (!inCL && !nameInCL) {
            issues.stale_status.push({
                company: row.company,
                ats: row.ats,
                slug: row.slug,
                issue: 'CSV says accepted but not found in company-list.json',
            });
        }
    }

    // Check 3: ATS naming normalization — only flag if current != canonical
    for (const row of csv) {
        const atsLower = (row.ats || '').toLowerCase();
        const canonical = ATS_CANONICAL[atsLower];
        if (canonical && canonical !== atsLower) {
            issues.ats_naming.push({
                company: row.company,
                current: row.ats,
                canonical,
            });
        }
    }

    // Check 4: Domain separator issues
    for (const row of csv) {
        if (!row.domains) continue;
        if (row.domains.includes('#') || (row.domains.includes(',') && !row.domains.includes('|'))) {
            issues.domain_sep.push({
                company: row.company,
                domains: row.domains,
                issue: row.domains.includes('#') ? 'Uses # separator' : 'Uses , separator without |',
            });
        }
    }

    // Summary
    const summary = {
        csv_rows: csv.length,
        csv_accepted: csv.filter(r => r.status === 'accepted').length,
        cl_entries: cl.length,
        issues: {
            missing_csv: issues.missing_csv.length,
            stale_status: issues.stale_status.length,
            ats_naming: issues.ats_naming.length,
            domain_sep: issues.domain_sep.length,
        },
    };

    console.log(JSON.stringify({ summary, details: issues }, null, 2));
}

reconcile();
