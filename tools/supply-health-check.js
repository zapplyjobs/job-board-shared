#!/usr/bin/env node

/**
 * Supply Health Check (SUP-TOOL-1)
 *
 * Daily automated analysis of internship supply by source.
 * Surfaces growth opportunities ranked by enrichment quality:
 *   1. Primary-ATS fetcher query tuning (Google, Amazon, Netflix)
 *   2. New primary-ATS company discoveries
 *   3. SimplifyJs fallback additions (last resort)
 *
 * Reads all_jobs.json + company-list.json + SimplifyJs listings.
 * Outputs console table + JSON to stdout.
 *
 * Usage:
 *   node tools/supply-health-check.js [--jobs /path/to/all_jobs.json] [--company-list /path/to/company-list.json] [--simplify-js /path/to/simplify.js] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};
const jsonOutput = args.includes('--json');

function findFile(candidates) {
  for (const p of candidates.filter(Boolean)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'ZJP-SUP-Health-Check/1.0', 'Accept': 'application/json' }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { resolve(null); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'ZJP-SUP-Health-Check/1.0' }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ ok: res.statusCode === 200, text: d }));
    });
    req.setTimeout(60000, () => { req.destroy(); resolve({ ok: false, text: '' }); });
    req.on('error', () => resolve({ ok: false, text: '' }));
  });
}

function loadJobsFile(filePath) {
  const jobs = [];
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { jobs.push(JSON.parse(line)); }
    catch (e) { /* skip malformed */ }
  }
  return jobs;
}

function isUSJob(job) {
  const tags = job.tags || {};
  const locs = tags.locations || [];
  return locs.includes('us');
}

const TECH_DOMAINS = new Set(['software', 'hardware', 'data_science', 'ai']);

function isTechUS(job) {
  const tags = job.tags || {};
  const domains = tags.domains || [];
  const locs = tags.locations || [];
  return domains.some(d => TECH_DOMAINS.has(d)) && locs.includes('us');
}

function isEntryLevel(job) {
  const tags = job.tags || {};
  return tags.employment !== 'senior';
}

function isInternship(job) {
  const tags = job.tags || {};
  return tags.employment === 'internship';
}

async function loadJobsFromRemote() {
  const urls = [
    'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/all_jobs.json',
    'https://pub-7c6b1d38c7974dd7a11e3a1e6e46c68b.r2.dev/all_jobs.json',
  ];
  for (const url of urls) {
    console.error(`Fetching from ${url.split('/').slice(-2).join('/')}...`);
    const resp = await fetchText(url);
    if (!resp.ok || !resp.text) continue;
    const jobs = [];
    for (const line of resp.text.split('\n')) {
      if (!line.trim()) continue;
      try { jobs.push(JSON.parse(line)); }
      catch (e) { /* skip */ }
    }
    if (jobs.length > 1000) return jobs;
  }
  return null;
}

async function main() {
  // 1. Load all_jobs.json — prefer local, fall back to remote
  let jobs = null;
  const jobsFile = findFile([
    getArg('--jobs'),
    path.resolve(__dirname, '..', '..', '..', 'jobs-data-2026', '.github', 'data', 'all_jobs.json'),
    path.resolve(__dirname, '..', '..', '..', 'jobs-aggregator-private', '.github', 'data', 'all_jobs.json'),
  ]);

  if (jobsFile) {
    jobs = loadJobsFile(jobsFile);
    // Staleness check: if local has <40K jobs, remote likely has more
    if (jobs.length < 40000) {
      console.error(`WARN: Local all_jobs.json has ${jobs.length} jobs (remote typically has 55K+). Fetching remote...`);
      const remote = await loadJobsFromRemote();
      if (remote && remote.length > jobs.length) {
        console.error(`Using remote data: ${remote.length} jobs (vs local ${jobs.length})`);
        jobs = remote;
      } else {
        console.error(`Remote unavailable or smaller. Using local: ${jobs.length} jobs. Data may be stale.`);
      }
    }
  } else {
    console.error('No local all_jobs.json found. Fetching remote...');
    jobs = await loadJobsFromRemote();
  }

  if (!jobs || jobs.length === 0) {
    console.error('ERROR: No job data available.');
    process.exit(1);
  }

  // 2. Load company-list.json — search post-split paths + CLI override
  const companyListFile = findFile([
    getArg('--company-list'),
    path.resolve(__dirname, '..', '..', '..', 'jobs-aggregator-private', '.github', 'scripts', 'aggregator', 'lib', 'fetchers', 'company-list.json'),
    path.resolve(__dirname, '..', '..', '..', 'job-board-aggregator', 'lib', 'fetchers', 'company-list.json'),
    path.resolve(__dirname, '..', 'lib', 'aggregator', 'fetchers', 'company-list.json'),
  ]);
  const companyList = companyListFile ? JSON.parse(fs.readFileSync(companyListFile, 'utf8')) : {};

  // Count ATS tenants by platform
  const atsPlatforms = {};
  const allAtsCompanies = [];
  for (const [platform, entries] of Object.entries(companyList)) {
    if (platform === '_meta' || !Array.isArray(entries)) continue;
    atsPlatforms[platform] = entries.length;
    for (const e of entries) {
      allAtsCompanies.push({
        name: (e.name || e.company || '').toLowerCase().trim(),
        platform,
        slug: e.slug || e.greenhouse_slug || e.url || '',
      });
    }
  }

  // 2b. Load SimplifyJs TARGET_COMPANIES from simplify.js — search post-split paths
  const simplifyJsFile = findFile([
    getArg('--simplify-js'),
    path.resolve(__dirname, '..', '..', '..', 'jobs-aggregator-private', '.github', 'scripts', 'aggregator', 'lib', 'fetchers', 'simplify.js'),
    path.resolve(__dirname, '..', '..', '..', 'job-board-aggregator', 'lib', 'fetchers', 'simplify.js'),
    path.resolve(__dirname, '..', 'lib', 'aggregator', 'fetchers', 'simplify.js'),
  ]);
  const targetCompanies = new Set();
  if (simplifyJsFile) {
    const src = fs.readFileSync(simplifyJsFile, 'utf8');
    const match = src.match(/const TARGET_COMPANIES\s*=\s*\[([\s\S]*?)\];/);
    if (match) {
      for (const line of match[1].split('\n')) {
        const m = line.match(/^\s*'([^']+)'/);
        if (m) targetCompanies.add(m[1].toLowerCase().trim());
      }
    }
  }

  // 3. Classify all jobs
  const internJobs = jobs.filter(isInternship);
  const internUS = internJobs.filter(isUSJob);
  const internTechUS = internUS.filter(isTechUS);

  // 4. Source decomposition for internships
  const internBySource = {};
  const internTechUSBySource = {};
  for (const j of internTechUS) {
    const src = j.source || 'unknown';
    internBySource[src] = (internBySource[src] || 0) + 1;
  }
  // Also count all internships (not just tech-US) by source
  for (const j of internUS) {
    const src = j.source || 'unknown';
    internTechUSBySource[src] = (internTechUSBySource[src] || 0) + 1;
  }

  // 5. Per-source total vs internship yield (the growth lever analysis)
  const sourceStats = {};
  for (const j of jobs) {
    const src = j.source || 'unknown';
    if (!sourceStats[src]) sourceStats[src] = { total: 0, us: 0, techUS: 0, internAll: 0, internTechUS: 0 };
    sourceStats[src].total++;
    if (isUSJob(j)) sourceStats[src].us++;
    if (isTechUS(j)) sourceStats[src].techUS++;
    if (isInternship(j)) {
      sourceStats[src].internAll++;
      if (isUSJob(j)) {
        if ((j.tags || {}).domains?.length > 0) sourceStats[src].internTechUS++;
      }
    }
  }

  // 6. Custom fetcher internship yield gap (untapped capacity)
  const customFetchers = ['google', 'amazon', 'netflix', 'apple', 'microsoft', 'amd', 'oracle', 'uber', 'twosigma'];
  const fetcherGaps = [];
  for (const src of customFetchers) {
    const s = sourceStats[src];
    if (!s) continue;
    const internPct = s.total > 0 ? (s.internAll / s.total * 100).toFixed(1) : '0.0';
    const techUSInternPct = s.techUS > 0 ? (s.internTechUS / s.techUS * 100).toFixed(1) : '0.0';
    fetcherGaps.push({
      source: src,
      total_jobs: s.total,
      tech_us: s.techUS,
      internships: s.internAll,
      intern_tech_us: s.internTechUS,
      intern_pct: internPct + '%',
      techus_intern_pct: techUSInternPct + '%',
      untapped: Math.max(0, Math.round(s.techUS * 0.15) - s.internTechUS), // rough: if 15% of tech-US should be internships
    });
  }
  fetcherGaps.sort((a, b) => b.untapped - a.untapped);

  // 7. SimplifyJs contribution check (fallback-only audit)
  const simplifyInterns = internTechUS.filter(j => j.source === 'simplify');
  const simplifyPct = internTechUS.length > 0 ? (simplifyInterns.length / internTechUS.length * 100).toFixed(1) : '0.0';

  // 8. Load SimplifyJs listings for gap analysis
  let simplifyGap = null;
  try {
    const [newGrad, summer] = await Promise.all([
      fetchJson('https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'),
      fetchJson('https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json'),
    ]);

    if (summer && Array.isArray(summer)) {
      const activeUS = summer.filter(l =>
        l.active &&
        l.locations?.some(loc => typeof loc === 'string' && /,\s*[A-Z]{2}\s*$/.test(loc))
      );

      // Companies not in pipeline via any ATS AND not in SimplifyJs TARGET AND not already producing
      const atsNameSet = new Set(allAtsCompanies.map(c => c.name));
      // Also exclude companies already producing internships (by source company name)
      const producingCompanies = new Set(
        internTechUS.map(j => (j.company_name || '').toLowerCase().trim()).filter(Boolean)
      );
      const uncovered = new Map();
      for (const l of activeUS) {
        const name = (l.company_name || '').trim().toLowerCase();
        if (!name || atsNameSet.has(name) || targetCompanies.has(name) || producingCompanies.has(name)) continue;
        if (!uncovered.has(name)) uncovered.set(name, { name: l.company_name, count: 0, titles: [] });
        uncovered.get(name).count++;
        if (uncovered.get(name).titles.length < 3) uncovered.get(name).titles.push(l.title);
      }

      const gapCandidates = [...uncovered.values()]
        .filter(c => c.count >= 3)
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

      simplifyGap = {
        total_active_us: activeUS.length,
        total_uncovered_companies: uncovered.size,
        candidates_3plus: gapCandidates.length,
        top_candidates: gapCandidates,
      };
    }
  } catch (e) {
    // SimplifyJs fetch failed — non-fatal
  }

  // 9. Build output
  const result = {
    generated_at: new Date().toISOString(),
    summary: {
      total_jobs: jobs.length,
      internships_total: internJobs.length,
      internships_us: internUS.length,
      internships_tech_us: internTechUS.length,
      target: 1500,
      gap: Math.max(0, 1500 - internTechUS.length),
    },
    source_decomposition: internBySource,
    ats_tenants: atsPlatforms,
    custom_fetcher_gaps: fetcherGaps,
    simplify_audit: {
      internships_from_simplify: simplifyInterns.length,
      pct_of_tech_us_interns: simplifyPct + '%',
      status: parseFloat(simplifyPct) > 20 ? 'OVER_REPRESENTED' : 'within bounds',
      note: 'SimplifyJs is fallback-only (T0 data). Should be <20% of internship supply.',
    },
    simplify_gap_candidates: simplifyGap,
    priority_actions: [],
  };

  // 10. Generate priority actions
  const actions = [];

  // Action: high-untapped custom fetchers
  for (const fg of fetcherGaps) {
    if (fg.untapped >= 10) {
      actions.push({
        priority: 'HIGH',
        type: 'fetcher_tuning',
        source: fg.source,
        action: `${fg.source} has ${fg.tech_us} tech-US jobs but only ${fg.intern_tech_us} tech-US internships (${fg.techus_intern_pct}). INFERENCE: ~${fg.untapped} untapped (verify with API — F56 showed projections can be 96% wrong).`,
      });
    }
  }

  // Action: SimplifyJs over-representation
  if (parseFloat(simplifyPct) > 20) {
    actions.push({
      priority: 'MEDIUM',
      type: 'source_balance',
      action: `SimplifyJs provides ${simplifyPct}% of tech-US internships (target <20%). Prioritize primary-ATS growth before adding more SimplifyJs targets.`,
    });
  }

  // Action: gap candidates from SimplifyJs (LOW priority, last resort)
  if (simplifyGap && simplifyGap.top_candidates.length > 0) {
    actions.push({
      priority: 'LOW',
      type: 'simplify_fallback',
      action: `${simplifyGap.top_candidates.length} companies with 3+ US tech internships not in pipeline. Add only after primary-ATS levers exhausted.`,
      candidates: simplifyGap.top_candidates.map(c => `${c.name} (${c.count})`),
    });
  }

  result.priority_actions = actions;

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Console table format
    console.log('\n=== SUPPLY HEALTH CHECK ===');
    console.log(`Generated: ${result.generated_at}`);
    console.log(`Data source: ${jobs.length} total pool jobs`);
    console.log(`\n--- Internship Summary ---`);
    console.log(`Total internships:     ${internJobs.length}`);
    console.log(`US internships:        ${internUS.length}`);
    console.log(`Tech-US internships:   ${internTechUS.length}`);
    console.log(`Target:                1,500`);
    console.log(`Gap:                   ${result.summary.gap}`);
    console.log(`\n  Note: Counts are from POOL (all_jobs.json), not consumer output.`);
    console.log(`  Consumer (Internships-2026) shows TTL-filtered subset.\n`);

    console.log(`\n--- Source Decomposition (tech-US internships) ---`);
    const sorted = Object.entries(internBySource).sort((a, b) => b[1] - a[1]);
    for (const [src, count] of sorted) {
      const pct = internTechUS.length > 0 ? (count / internTechUS.length * 100).toFixed(1) : '0.0';
      const bar = '#'.repeat(Math.min(40, Math.round(count / Math.max(...Object.values(internBySource)) * 40)));
      console.log(`  ${src.padEnd(15)} ${String(count).padStart(5)} (${pct}%) ${bar}`);
    }

    console.log(`\n--- Custom Fetcher: Total vs Internship Yield ---`);
    console.log(`  ${'Source'.padEnd(12)} ${'Tech-US'.padStart(7)} ${'Intern'.padStart(7)} ${'%Intern'.padStart(8)} ${'Untapped'.padStart(9)}`);
    for (const fg of fetcherGaps) {
      const flag = fg.untapped >= 10 ? ' <<<' : '';
      console.log(`  ${fg.source.padEnd(12)} ${String(fg.tech_us).padStart(7)} ${String(fg.intern_tech_us).padStart(7)} ${fg.techus_intern_pct.padStart(8)} ${String(fg.untapped).padStart(9)}${flag}`);
    }

    console.log(`\n--- SimplifyJs Audit ---`);
    console.log(`  Internships from SimplifyJs: ${simplifyInterns.length} (${simplifyPct}% of tech-US)`);
    console.log(`  Status: ${result.simplify_audit.status}`);

    if (simplifyGap) {
      console.log(`\n--- SimplifyJs Gap Candidates (fallback only) ---`);
      console.log(`  ${simplifyGap.total_uncovered_companies} uncovered companies, ${simplifyGap.candidates_3plus} with 3+ listings`);
      for (const c of simplifyGap.top_candidates.slice(0, 10)) {
        console.log(`  ${c.name.padEnd(35)} ${c.count} listings  (e.g. ${c.titles[0] || '?'})`);
      }
    }

    console.log(`\n--- Priority Actions ---`);
    for (const a of actions) {
      console.log(`  [${a.priority}] ${a.action}`);
      if (a.candidates) {
        console.log(`         Candidates: ${a.candidates.slice(0, 5).join(', ')}`);
      }
    }
    console.log('');
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });