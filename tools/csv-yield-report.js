#!/usr/bin/env node

/**
 * Per-Company Yield Funnel Report (SUP-2)
 *
 * Reads all_jobs.json (JSONL) and computes the 5-step yield funnel per company:
 *   1. Total jobs
 *   2. US jobs (locations includes 'us')
 *   3. US entry-level (employment != 'senior')
 *   4. US tech (domain != 'general' and not empty)
 *   5. US tech entry-level (what actually reaches users)
 *
 * Classifies each company by Yield Gate (HIGH ≥10, STANDARD 5-9, LOW 1-4, SKIP 0).
 * Flags zero-output companies (fetched but 0 US tech entry-level).
 *
 * Output: JSON report to stdout.
 * Usage:
 *   node tools/csv-yield-report.js [--jobs /path/to/all_jobs.json] [--csv /path/to/company-research-log.csv]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};

function findJobsFile() {
    const candidates = [
        getArg('--jobs'),
        path.resolve(__dirname, '..', '..', '..', 'jobs-data-2026', '.github', 'data', 'all_jobs.json'),
        path.resolve(__dirname, '..', '..', '..', 'Job_Listings', 'jobs-data-2026', '.github', 'data', 'all_jobs.json'),
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return candidates[candidates.length - 1]; // last candidate for error message
}

const JOBS_PATH = findJobsFile();
const basePath = getArg('--csv-base') || path.resolve(__dirname, '..', '..', '..', '.GenAI_Work', 'projects', 'zjp');
const CSV_PATH = path.join(basePath, 'company-research-log.csv');

const TECH_DOMAINS = new Set(['software', 'hardware', 'data_science', 'ai']);

function classifyYieldGate(usTechEntry) {
    if (usTechEntry >= 10) return 'HIGH';
    if (usTechEntry >= 5) return 'STANDARD';
    if (usTechEntry >= 1) return 'LOW';
    return 'SKIP';
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

function loadCSVStatus() {
    const statusMap = new Map();
    if (!fs.existsSync(CSV_PATH)) return statusMap;
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    for (const line of raw.split('\n')) {
        if (line.startsWith('#') || line.trim() === '') continue;
        const fields = parseCSVLine(line);
        if (fields.length >= 4) {
            const company = (fields[0] || '').trim().toLowerCase();
            const status = (fields[3] || '').trim();
            if (company && status) statusMap.set(company, status);
        }
    }
    return statusMap;
}

async function run() {
    if (!fs.existsSync(JOBS_PATH)) {
        console.error(`Error: all_jobs.json not found at ${JOBS_PATH}`);
        console.error('Use --jobs flag to specify path, or ensure jobs-data-2026 is cloned');
        process.exit(1);
    }

    const csvStatus = loadCSVStatus();

    // Per-company funnel accumulators
    const companies = new Map();

    const fileStream = fs.createReadStream(JOBS_PATH);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (!line.trim()) continue;
        let job;
        try {
            job = JSON.parse(line);
        } catch {
            continue;
        }

        const company = (job.company_name || job.company_slug || 'unknown').toLowerCase();
        if (!companies.has(company)) {
            companies.set(company, { total: 0, us: 0, us_entry: 0, us_tech: 0, us_tech_entry: 0, source: job.source || 'unknown' });
        }
        const c = companies.get(company);
        c.total++;

        const isUS = (job.tags?.locations || []).includes('us');
        if (!isUS) continue;
        c.us++;

        const isSenior = (job.tags?.employment || '') === 'senior';
        if (!isSenior) c.us_entry++;

        const domains = job.tags?.domains || [];
        const isTech = domains.some(d => TECH_DOMAINS.has(d));
        if (!isTech) continue;
        c.us_tech++;

        if (!isSenior) c.us_tech_entry++;
    }

    // Build report
    const byGate = { HIGH: [], STANDARD: [], LOW: [], SKIP: [] };
    const zeroOutput = [];
    const noUS = [];

    for (const [company, funnel] of companies) {
        const gate = classifyYieldGate(funnel.us_tech_entry);
        const entry = { company, gate, ...funnel };
        byGate[gate].push(entry);

        if (funnel.us_tech_entry === 0 && funnel.total > 0) {
            zeroOutput.push({ company, total: funnel.total, us: funnel.us, us_entry: funnel.us_entry, us_tech: funnel.us_tech, source: funnel.source });
        }
        if (funnel.us === 0 && funnel.total > 0) {
            noUS.push({ company, total: funnel.total, source: funnel.source });
        }
    }

    // Sort each gate by us_tech_entry descending
    for (const gate of Object.keys(byGate)) {
        byGate[gate].sort((a, b) => b.us_tech_entry - a.us_tech_entry);
    }

    const totalCompanies = companies.size;
    const withUSOutput = [...byGate.HIGH, ...byGate.STANDARD, ...byGate.LOW].length;

    const report = {
        generated_at: new Date().toISOString(),
        data_source: JOBS_PATH,
        summary: {
            total_companies: totalCompanies,
            with_us_tech_entry_output: withUSOutput,
            zero_output: zeroOutput.length,
            no_us: noUS.length,
            by_gate: {
                HIGH: byGate.HIGH.length,
                STANDARD: byGate.STANDARD.length,
                LOW: byGate.LOW.length,
                SKIP: byGate.SKIP.length,
            },
        },
        top_yield: [...byGate.HIGH, ...byGate.STANDARD].slice(0, 30),
        zero_output_companies: zeroOutput.slice(0, 50),
        no_us_companies: noUS.slice(0, 30),
        all_companies: [...byGate.HIGH, ...byGate.STANDARD, ...byGate.LOW, ...byGate.SKIP],
    };

    console.log(JSON.stringify(report, null, 2));
}

run().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
