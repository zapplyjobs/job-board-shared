#!/usr/bin/env node

/**
 * TAG General Bucket Analyzer
 *
 * Analyzes the composition of general-tagged jobs in all_jobs.json.
 * Identifies which domain each general job SHOULD belong to based on title patterns.
 * Outputs: domain miss counts, top unmatched titles, company concentration.
 *
 * Usage:
 *   node tools/tag-general-analyzer.js /path/to/all_jobs.json
 *   node tools/tag-general-analyzer.js /path/to/all_jobs.json --json
 *   node tools/tag-general-analyzer.js --remote   (reads from jobs-data-2026 on GitHub)
 *
 * Output sections:
 *   1. Overall G1 rate (total + US)
 *   2. General bucket domain assignment (what domain each job SHOULD be)
 *   3. Top unmatched general titles (opportunities for keyword additions)
 *   4. Company concentration (top 20 companies producing generals)
 *   5. Per-domain keyword gap summary
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --- Domain classification heuristics for general jobs ---
// Each entry: [domain, [patterns]]
// Patterns are matched case-insensitive as substrings in the job title.
const DOMAIN_SIGNALS = [
  ['software', [
    'software', 'sw engineer', 'sw developer', 'sw qa', 'sw test',
    'it support', 'it engineer', 'system engineer', 'systems engineer',
    'devops', 'sre', 'site reliability', 'platform engineer',
    'bizops engineer', 'gtm engineer', 'aruba', 'pcai', 'cno developer',
    'junior engineer', 'systems and hardware', 'technical expert',
    'program management specialist', 'project controller',
    'support center rep', 'technical support', 'coverage specialist',
    'cable integration', 'entry-level surveyor', 'scrum master',
    'business systems analyst', 'systems analyst',
    'it operations', 'helpdesk', 'network admin', 'network engineer',
    'database admin', 'dba', 'release engineer', 'automation engineer',
    'linux engineer', 'data center engineer', 'data center admin',
    'data center analyst', 'cloud engineer', 'security analyst',
    'security engineer', 'cybersecurity', 'cyber', 'threat',
    'vulnerability', 'firewall', 'identity', 'access management',
    'servicenow', 'splunk', 'sharepoint', 'sap ', 'erp',
    'mobile developer', 'android developer', 'ios developer',
    'frontend', 'backend', 'full stack', 'fullstack', 'full-stack',
    'web developer', 'application developer', '.net', 'java developer',
    'python developer', 'react developer', 'node developer',
    'integration engineer', 'implementation engineer',
    'solutions engineer', 'solution engineer', 'customer engineer',
    'escalations engineer', 'deployment', 'research engineer',
    'developer experience', 'developer relations', 'devrel',
    'engineering intern', 'software intern', 'tech intern',
    'computer support', 'noc engineer', 'noc technician',
    'mission it', 'help desk', 'desktop support',
    'digital forensics', 'endpoint', 'soc analyst',
    'security operations', 'incident response',
    'technical account manager', 'technical program manager',
    'graphics engineer', 'simulation engineer',
    'test engineer', 'qa engineer', 'qa analyst',
    'reverse engineer', 'developer advocate',
    'sql developer', 'sql engineer', 'data engineer',
    'enterprise architect', 'solution architect',
  ]],
  ['operations', [
    'administrative assistant', 'executive assistant', 'administrative',
    'project manager', 'program manager', 'coordinator',
    'associate 2', 'associate ii', 'client contact',
    'middle office', 'transaction processing', 'core operations',
    'planning', 'implementation', 'change management',
    'executive - cross', 'yard operative', 'business partner',
    'operations manager', 'operations analyst', 'operations specialist',
    'operations associate', 'project coordinator', 'program coordinator',
    'office manager', 'executive admin', 'scheduler',
    'global separation', 'pmo', 'project management',
    'operations intern', 'program management',
    'client services', 'customer success', 'account coordinator',
  ]],
  ['sales', [
    'account executive', 'enterprise account', 'business development',
    'sales manager', 'sales processing', 'sales associate',
    'sales representative', 'sales specialist', 'sales consultant',
    'account manager', 'territory manager', 'regional sales',
    'sales intern', 'business development manager',
    'strategic account', 'key account', 'inside sales',
    'sales engineer', 'sales operations', 'sales analyst',
  ]],
  ['manufacturing', [
    'technician', 'mfg', 'manufacturing', 'assembler', 'assembly',
    'produktionsmitarbeiter', 'mistrz', 'operario', 'ensamble',
    'quality inspection', 'critical environment', 'operator',
    'machine operator', 'cnc', 'welding', 'welder',
    'production worker', 'production associate', 'production supervisor',
    'quality assurance', 'quality control', 'inspector',
    'maintenance tech', 'maintenance technician',
    'fabrication', 'machinist', 'tool and die',
    'manufacturing engineer', 'process engineer', 'industrial engineer',
  ]],
  ['finance', [
    'trader', 'murex', 'engenheiro fiscal', 'consultant média',
    'financial analyst', 'finance manager', 'accounting',
    'auditor', 'tax ', 'credit analyst', 'risk analyst',
    'compliance analyst', 'regulatory', 'underwriter',
    'portfolio', 'investment analyst', 'equity analyst',
    'actuarial', 'quantitative analyst', 'financial advisor',
    'banking associate', 'loan officer', 'mortgage',
    'reconciliation', 'controller', 'bookkeeper',
    'payroll', 'treasury', 'financing',
  ]],
  ['logistics', [
    'driver', 'delivery', 'yard operative', 'logistics',
    'warehouse', 'supply chain', 'material', 'fulfillment',
    'shipping', 'receiving', 'freight', 'cdl',
    'dispatch', 'fleet', 'inventory', 'stocking',
    'distribution center', 'logistics operative',
  ]],
  ['marketing', [
    'marketing', 'media', 'content', 'communications',
    'brand', 'creative', 'advertising', 'digital marketing',
    'social media', 'email marketing', 'seo', 'sem',
    'public relations', 'copywriter', 'graphic design',
    'marketing intern', 'marketing manager', 'marketing coordinator',
  ]],
  ['healthcare', [
    'clinical', 'patient', 'nurse', 'pharma', 'medical',
    'physician', 'surgeon', 'therapy', 'therapist',
    'radiology', 'laboratory', 'lab technician', 'pathology',
    'healthcare', 'health care', 'hospital', 'clinic',
    'phlebotom', 'paramedic', 'ems', 'emergency medical',
    'dental', 'pharmacy', 'occupational health',
  ]],
  ['legal', [
    'legal', 'counsel', 'compliance officer', 'regulatory affairs',
    'contract', 'paralegal', 'attorney', 'lawyer',
    'legal intern', 'legal assistant', 'law clerk',
    'intellectual property', 'patent', 'trademark',
  ]],
  ['hr', [
    'recruiter', 'recruiting', 'human resources', 'talent',
    'people ops', 'learning and development', 'training',
    'talent sourcer', 'talent acquisition', 'hr coordinator',
    'hr assistant', 'benefits', 'compensation',
    'hr intern', 'people partner', 'employee relations',
  ]],
  ['product', [
    'product manager', 'product design', 'product owner',
    'product analyst', 'product strategy', 'product marketing',
    'consumer product', 'product growth',
  ]],
  ['intelligence', [
    'osint', 'intelligence', 'disclosure officer',
    'counterintelligence', 'signals intelligence',
  ]],
];

// --- Main ---
function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const remoteMode = args.includes('--remote');
  const filePath = args.find(a => !a.startsWith('--'));

  let allJobsText;
  if (remoteMode) {
    const { execSync } = require('child_process');
    // Data source priority (post-INF-BLOAT-5: data files no longer committed to git).
    // 1. R2 public URL (live, no auth — if bucket is publicly accessible)
    // 2. Private repo via gh token (live, requires gh auth)
    // 3. Public repo raw.githubusercontent.com (STALE — last resort)
    const sources = [
      ['R2 (live)', 'https://pub-7c6b1d38c7974dd7a11e3a1e6e46c68b.r2.dev/all_jobs.json', []],
      ['private repo (live)', 'https://raw.githubusercontent.com/zapplyjobs/jobs-aggregator-private/main/.github/data/all_jobs.json', ['-H', 'Authorization: token $(gh auth token)']],
      ['public repo (stale)', 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/all_jobs.json', []],
    ];
    for (const [label, url, headers] of sources) {
      console.error(`Fetching all_jobs.json from ${label}...`);
      try {
        const headerArgs = headers.map(h => h.includes('$(') ? `-H 'Authorization: token ${execSync('gh auth token', { encoding: 'utf8' }).trim()}'` : `-H '${h}'`).join(' ');
        allJobsText = execSync(`curl -sL ${headerArgs} "${url}"`, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
        const lineCount = allJobsText.split('\n').filter(l => l.trim()).length;
        if (lineCount > 1000) { console.error(`  ✓ ${lineCount.toLocaleString()} jobs from ${label}`); break; }
        console.error(`  ✗ Only ${lineCount} jobs from ${label}, trying next source...`);
        allJobsText = null;
      } catch (e) { console.error(`  ✗ Failed: ${e.message.slice(0, 100)}`); }
    }
    if (!allJobsText) { console.error('FATAL: Could not fetch all_jobs.json from any source'); process.exit(1); }
  } else if (filePath) {
    allJobsText = fs.readFileSync(filePath, 'utf8');
  } else {
    console.error('Usage: node tag-general-analyzer.js <all_jobs.json> [--json] [--remote]');
    process.exit(1);
  }

  // Parse JSONL
  const generalJobs = [];
  let totalJobs = 0;
  let usJobs = 0;
  let usGeneral = 0;

  for (const line of allJobsText.split('\n')) {
    if (!line.trim()) continue;
    let job;
    try { job = JSON.parse(line); } catch { continue; }
    totalJobs++;

    const tags = job.tags || {};
    const domains = tags.domains || [];
    const isUs = tags.locations && tags.locations.includes('us');
    if (isUs) usJobs++;

    if (domains.includes('general') && domains.length === 1) {
      const title = (job.title || '').trim();
      const titleLower = title.toLowerCase();
      generalJobs.push({ title, titleLower, company: (job.company_name || '').trim(), isUs });
      if (isUs) usGeneral++;
    }
  }

  const totalGeneral = generalJobs.length;

  // Classify generals by likely domain
  const domainCounts = {};
  const domainTitles = {};
  const unmatched = {};
  DOMAIN_SIGNALS.forEach(([d]) => { domainCounts[d] = 0; domainTitles[d] = {}; });

  for (const g of generalJobs) {
    let matched = false;
    for (const [domain, patterns] of DOMAIN_SIGNALS) {
      for (const p of patterns) {
        if (g.titleLower.includes(p)) {
          domainCounts[domain]++;
          domainTitles[domain][g.title] = (domainTitles[domain][g.title] || 0) + 1;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) {
      unmatched[g.title] = (unmatched[g.title] || 0) + 1;
    }
  }

  // Company concentration
  const companyCounts = {};
  for (const g of generalJobs) {
    companyCounts[g.company] = (companyCounts[g.company] || 0) + 1;
  }

  // --- Output ---
  if (jsonMode) {
    const result = {
      total_jobs: totalJobs,
      total_general: totalGeneral,
      general_rate_pct: +(totalGeneral / totalJobs * 100).toFixed(1),
      us_jobs: usJobs,
      us_general: usGeneral,
      us_general_rate_pct: usJobs ? +(usGeneral / usJobs * 100).toFixed(1) : null,
      domain_assignment: Object.fromEntries(
        DOMAIN_SIGNALS.map(([d]) => [d, { count: domainCounts[d], top_titles: Object.entries(domainTitles[d]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => ({ title: t, count: c })) }])
      ),
      unmatched_count: Object.values(unmatched).reduce((a, b) => a + b, 0),
      unmatched_unique: Object.keys(unmatched).length,
      top_unmatched: Object.entries(unmatched).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([t, c]) => ({ title: t, count: c })),
      top_companies: Object.entries(companyCounts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([c, n]) => ({ company: c, count: n })),
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  console.log('=== TAG General Bucket Analysis ===');
  console.log(`Date: ${new Date().toISOString().slice(0, 19)}Z`);
  console.log();
  console.log(`Total jobs: ${totalJobs.toLocaleString()}`);
  console.log(`General: ${totalGeneral.toLocaleString()} (${(totalGeneral / totalJobs * 100).toFixed(1)}%)`);
  console.log(`US jobs: ${usJobs.toLocaleString()}`);
  console.log(`US general: ${usGeneral.toLocaleString()} (${usJobs ? (usGeneral / usJobs * 100).toFixed(1) : 'N/A'}%)`);
  console.log();

  const categorized = totalGeneral - Object.values(unmatched).reduce((a, b) => a + b, 0);
  console.log(`Categorized: ${categorized} (${(categorized / totalGeneral * 100).toFixed(1)}%)`);
  console.log(`Unmatched: ${Object.values(unmatched).reduce((a, b) => a + b, 0)} (${Object.keys(unmatched).length} unique titles)`);
  console.log();

  console.log('=== Domain Assignment ===');
  for (const [domain] of DOMAIN_SIGNALS) {
    const count = domainCounts[domain];
    if (count === 0) continue;
    console.log(`  ${String(count).padStart(5)} (${(count / totalGeneral * 100).toFixed(1)}%) → ${domain}`);
    const topTitles = Object.entries(domainTitles[domain]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [t, c] of topTitles) {
      console.log(`         "${t}" (${c})`);
    }
  }
  console.log();

  console.log('=== Top 30 Unmatched Titles ===');
  for (const [title, count] of Object.entries(unmatched).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${String(count).padStart(4)}  ${title}`);
  }
  console.log();

  console.log('=== Top 20 Companies Producing Generals ===');
  for (const [company, count] of Object.entries(companyCounts).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(count).padStart(4)}  ${company}`);
  }
}

main();
