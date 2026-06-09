#!/usr/bin/env node

/**
 * ENR LCA Audit (INF-TOOL-2)
 *
 * Traces LCA sponsor matching for a given company (or all companies with no visa signal).
 * Shows: normalization trace, alias resolution, LCA set membership, actual visa signal coverage,
 * and prefix-match FP risk analysis.
 *
 * Replaces inline python blocks for LCA debugging (C63 used 5+ blocks / ~30K tokens).
 *
 * Usage:
 *   node tools/enr-lca-audit.js --company "Google"
 *   node tools/enr-lca-audit.js --company "Google" --remote --json
 *   node tools/enr-lca-audit.js --gaps          # companies with null visa signal
 *   node tools/enr-lca-audit.js --aliases        # show alias map coverage
 *
 * Output sections:
 *   1. Company normalization trace (input → normalized → LCA lookup)
 *   2. Alias resolution (if applicable)
 *   3. Visa signal breakdown for that company's jobs
 *   4. Per-source visa coverage
 *   5. (--gaps) Companies with null possible_sponsor, ranked by job count
 *   6. (--aliases) Alias coverage: how many companies benefit from each alias
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const useRemote = args.includes('--remote');
const companyArg = args.indexOf('--company') >= 0 ? args[args.indexOf('--company') + 1] : null;
const showGaps = args.includes('--gaps');
const showAliases = args.includes('--aliases');

if (!companyArg && !showGaps && !showAliases) {
  console.error('Usage: node enr-lca-audit.js --company "Name" [--remote] [--json]');
  console.error('       node enr-lca-audit.js --gaps [--remote]');
  console.error('       node enr-lca-audit.js --aliases [--remote]');
  process.exit(1);
}

function normalizeLcaName(name) {
  return name.toLowerCase().trim().replace(/[.,]/g, '').replace(/&/g, 'and').replace(/-/g, ' ');
}

function parseEnrichedContent(content) {
  // enriched_jobs.json may be JSON array or JSONL (one object per line)
  content = content.trim();
  if (content.startsWith('[')) {
    return JSON.parse(content);
  }
  // JSONL: parse each line
  return content.split('\n').filter(l => l.trim()).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ZJP-LCA-Audit/1.0' } }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ ok: res.statusCode === 200, text: d }));
    });
    req.setTimeout(60000, () => { req.destroy(); resolve({ ok: false, text: '' }); });
    req.on('error', () => resolve({ ok: false, text: '' }));
  });
}

async function loadEnrichedJobs() {
  if (useRemote) {
    const { loadJsonFromR2 } = require('./r2-loader');
    return loadJsonFromR2('enriched_jobs.json');
  }

  // Local path: look for enriched_jobs.json in standard locations
  const localPaths = [
    path.join(process.cwd(), 'data', 'enriched_jobs.json'),
    path.join(process.cwd(), '.github', 'data', 'enriched_jobs.json'),
    path.join(process.cwd(), 'enriched_jobs.json'),
  ];
  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      console.error(`Reading ${p}`);
      return parseEnrichedContent(fs.readFileSync(p, 'utf8'));
    }
  }
  console.error('ERROR: enriched_jobs.json not found locally. Use --remote to fetch from R2.');
  process.exit(1);
}

async function loadLcaSponsors() {
  if (useRemote) {
    try {
      const { loadJsonFromR2 } = require('./r2-loader');
      return await loadJsonFromR2('lca-sponsors.json', { prefix: '' });
    } catch (e) {
      console.error(`WARN: Could not fetch lca-sponsors.json from private R2: ${e.message}`);
      return { employers: [] };
    }
  }

  const localPaths = [
    path.join(process.cwd(), '.github', 'data', 'lca-sponsors.json'),
    path.join(process.cwd(), 'lca-sponsors.json'),
  ];
  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      console.error(`Reading ${p}`);
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  console.error('WARN: lca-sponsors.json not found');
  return { employers: [] };
}

async function loadLcaAliases() {
  if (useRemote) {
    // Aliases are in the processing submodule (private repo — raw URL returns 404).
    // Use gh api to fetch from private repo.
    try {
      const { execSync } = require('child_process');
      const b64 = execSync(
        'gh api repos/zapplyjobs/job-board-processing/contents/lib/enrich/lca-aliases.json --jq \'.content\'',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const json = Buffer.from(b64, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      console.error(`Loaded ${Object.keys(parsed).length} LCA aliases via gh api`);
      return parsed;
    } catch (e) {
      console.error('WARN: gh api fallback failed for lca-aliases.json:', e.message?.split('\n')[0]);
      return {};
    }
  }

  const localPaths = [
    path.join(process.cwd(), '.github', 'scripts', 'processing', 'lib', 'enrich', 'lca-aliases.json'),
    path.join(process.cwd(), 'lib', 'enrich', 'lca-aliases.json'),
  ];
  for (const p of localPaths) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return {};
}

function auditCompany(companyName, enrichedJobs, lcaSet, lcaAliases) {
  const norm = normalizeLcaName(companyName);
  const alias = lcaAliases[companyName];
  const normAlias = alias ? normalizeLcaName(alias) : null;

  const inLcaDirect = lcaSet.has(norm);
  const inLcaViaAlias = normAlias && lcaSet.has(normAlias);
  const matchType = inLcaDirect ? 'exact' : (inLcaViaAlias ? 'alias' : 'none');

  // Find all jobs for this company
  const companyJobs = enrichedJobs.filter(j =>
    j.company_name === companyName ||
    normalizeLcaName(j.company_name) === norm
  );

  const visaBreakdown = {
    sponsors_visa_true: 0,
    sponsors_visa_false: 0,
    visa_question_present_true: 0,
    possible_sponsor_true: 0,
    possible_sponsor_null: 0,
    any_visa_signal: 0,
    total: companyJobs.length,
  };

  const bySource = {};

  for (const job of companyJobs) {
    if (job.sponsors_visa === true) visaBreakdown.sponsors_visa_true++;
    if (job.sponsors_visa === false) visaBreakdown.sponsors_visa_false++;
    if (job.visa_question_present === true) visaBreakdown.visa_question_present_true++;
    if (job.possible_sponsor === true) visaBreakdown.possible_sponsor_true++;
    if (job.possible_sponsor === null || job.possible_sponsor === undefined) visaBreakdown.possible_sponsor_null++;

    const hasAny = job.sponsors_visa === true || job.visa_question_present === true || job.possible_sponsor === true;
    if (hasAny) visaBreakdown.any_visa_signal++;

    const src = job.source || 'unknown';
    if (!bySource[src]) bySource[src] = { total: 0, any_signal: 0, possible_sponsor_true: 0, sponsors_visa_true: 0 };
    bySource[src].total++;
    if (hasAny) bySource[src].any_signal++;
    if (job.possible_sponsor === true) bySource[src].possible_sponsor_true++;
    if (job.sponsors_visa === true) bySource[src].sponsors_visa_true++;
  }

  // Find LCA entries that contain the normalized name (for prefix-match risk analysis)
  const prefixMatches = [];
  for (const entry of lcaSet) {
    if (entry !== norm && (entry.startsWith(norm) || norm.startsWith(entry))) {
      prefixMatches.push(entry);
    }
  }

  return {
    company: companyName,
    normalized: norm,
    alias: alias || null,
    normalized_alias: normAlias,
    lca_match: matchType,
    lca_direct: inLcaDirect,
    lca_via_alias: inLcaViaAlias || false,
    prefix_match_risk: prefixMatches.length > 0 ? prefixMatches : null,
    visa_breakdown: visaBreakdown,
    by_source: bySource,
  };
}

function findGapCompanies(enrichedJobs, lcaSet, lcaAliases) {
  // Group by company_name, count jobs with null possible_sponsor
  const companies = {};

  for (const job of enrichedJobs) {
    const name = job.company_name || 'unknown';
    if (!companies[name]) {
      companies[name] = { total: 0, null_sponsor: 0, any_signal: 0, sources: new Set() };
    }
    companies[name].total++;
    companies[name].sources.add(job.source || 'unknown');

    if (job.possible_sponsor === null || job.possible_sponsor === undefined) {
      companies[name].null_sponsor++;
    }
    if (job.sponsors_visa === true || job.visa_question_present === true || job.possible_sponsor === true) {
      companies[name].any_signal++;
    }
  }

  // Filter to companies with >0 null_sponsor and rank by count
  return Object.entries(companies)
    .filter(([_, d]) => d.null_sponsor > 0)
    .map(([name, d]) => {
      const norm = normalizeLcaName(name);
      const alias = lcaAliases[name];
      const normAlias = alias ? normalizeLcaName(alias) : null;
      const inLca = lcaSet.has(norm) || (normAlias && lcaSet.has(normAlias));

      return {
        company: name,
        normalized: norm,
        alias: alias || null,
        in_lca: inLca,
        total_jobs: d.total,
        null_sponsor_jobs: d.null_sponsor,
        any_signal_jobs: d.any_signal,
        sources: [...d.sources],
        signal_gap_pct: Math.round((1 - d.any_signal / d.total) * 100),
      };
    })
    .sort((a, b) => b.null_sponsor_jobs - a.null_sponsor_jobs);
}

function analyzeAliases(lcaAliases, enrichedJobs, lcaSet) {
  const results = [];

  for (const [companyName, aliasTarget] of Object.entries(lcaAliases)) {
    const normAlias = normalizeLcaName(aliasTarget);
    const aliasMatchesLca = lcaSet.has(normAlias);

    // Count how many jobs benefit from this alias
    const norm = normalizeLcaName(companyName);
    const directMatch = lcaSet.has(norm);
    const jobsUsingAlias = enrichedJobs.filter(j => j.company_name === companyName).length;

    results.push({
      company: companyName,
      alias: aliasTarget,
      direct_match: directMatch,
      alias_matches_lca: aliasMatchesLca,
      jobs_benefiting: jobsUsingAlias,
      effective: !directMatch && aliasMatchesLca && jobsUsingAlias > 0,
    });
  }

  return results.sort((a, b) => b.jobs_benefiting - a.jobs_benefiting);
}

async function main() {
  const [enrichedJobs, lcaRaw, lcaAliases] = await Promise.all([
    loadEnrichedJobs(),
    loadLcaSponsors(),
    loadLcaAliases(),
  ]);

  const lcaSet = new Set((lcaRaw.employers || []).map(e => normalizeLcaName(e)));
  console.error(`LCA sponsors: ${lcaSet.size} employers loaded`);
  console.error(`Enriched jobs: ${enrichedJobs.length} records`);
  console.error(`LCA aliases: ${Object.keys(lcaAliases).length} mappings`);
  console.error('');

  if (jsonOutput) {
    const result = {};
    if (companyArg) result.audit = auditCompany(companyArg, enrichedJobs, lcaSet, lcaAliases);
    if (showGaps) result.gaps = findGapCompanies(enrichedJobs, lcaSet, lcaAliases);
    if (showAliases) result.aliases = analyzeAliases(lcaAliases, enrichedJobs, lcaSet);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (companyArg) {
    const audit = auditCompany(companyArg, enrichedJobs, lcaSet, lcaAliases);

    console.log(`=== LCA Audit: ${audit.company} ===`);
    console.log('');
    console.log(`Normalization trace:`);
    console.log(`  Input:      "${audit.company}"`);
    console.log(`  Normalized: "${audit.normalized}"`);
    if (audit.alias) {
      console.log(`  Alias:      "${audit.company}" → "${audit.alias}"`);
      console.log(`  Norm alias: "${audit.normalized_alias}"`);
    } else {
      console.log(`  Alias:      none`);
    }
    console.log(`  LCA match:  ${audit.lca_match}${audit.lca_direct ? ' (direct)' : audit.lca_via_alias ? ` (via "${audit.alias}")` : ''}`);
    console.log('');

    if (audit.prefix_match_risk) {
      console.log(`Prefix-match risk (${audit.prefix_match_risk.length} similar LCA entries):`);
      for (const pm of audit.prefix_match_risk.slice(0, 10)) {
        console.log(`  "${pm}"`);
      }
      console.log('');
    }

    console.log(`Visa signal coverage (${audit.visa_breakdown.total} jobs):`);
    console.log(`  Any visa signal:    ${audit.visa_breakdown.any_visa_signal}/${audit.visa_breakdown.total} (${Math.round(audit.visa_breakdown.any_visa_signal / Math.max(audit.visa_breakdown.total, 1) * 100)}%)`);
    console.log(`  sponsors_visa=true: ${audit.visa_breakdown.sponsors_visa_true}`);
    console.log(`  visa_question=true: ${audit.visa_breakdown.visa_question_present_true}`);
    console.log(`  possible_sponsor:   ${audit.visa_breakdown.possible_sponsor_true} (null: ${audit.visa_breakdown.possible_sponsor_null})`);
    console.log('');

    if (Object.keys(audit.by_source).length > 0) {
      console.log('Per-source breakdown:');
      for (const [src, d] of Object.entries(audit.by_source).sort((a, b) => b[1].total - a[1].total)) {
        const pct = Math.round(d.any_signal / Math.max(d.total, 1) * 100);
        console.log(`  ${src.padEnd(20)} ${String(d.total).padStart(5)} jobs | any_signal ${pct}% | ps=${d.possible_sponsor_true} sv=${d.sponsors_visa_true}`);
      }
      console.log('');
    }
  }

  if (showGaps) {
    const gaps = findGapCompanies(enrichedJobs, lcaSet, lcaAliases);
    console.log(`=== Companies with null possible_sponsor (${gaps.length} companies) ===`);
    console.log('');
    console.log('Top 20 by null-sponsor job count:');
    console.log(`${'Company'.padEnd(40)} ${'Jobs'.padStart(5)} ${'Null'.padStart(5)} ${'Gap%'.padStart(5)} LCA  Alias`);
    for (const g of gaps.slice(0, 20)) {
      const lcaFlag = g.in_lca ? 'YES' : 'NO ';
      const aliasFlag = g.alias ? g.alias.substring(0, 15) : 'none';
      console.log(`  ${g.company.padEnd(38)} ${String(g.total_jobs).padStart(5)} ${String(g.null_sponsor_jobs).padStart(5)} ${String(g.signal_gap_pct).padStart(4)}% ${lcaFlag}  ${aliasFlag}`);
    }

    const inLcaCount = gaps.filter(g => g.in_lca).length;
    const notInLcaCount = gaps.length - inLcaCount;
    console.log('');
    console.log(`Summary: ${gaps.length} companies with gaps. ${inLcaCount} in LCA (alias mismatch?), ${notInLcaCount} not in LCA.`);
    console.log('');
  }

  if (showAliases) {
    const aliasAnalysis = analyzeAliases(lcaAliases, enrichedJobs, lcaSet);
    console.log(`=== LCA Alias Coverage (${aliasAnalysis.length} aliases) ===`);
    console.log('');
    const effective = aliasAnalysis.filter(a => a.effective);
    const ineffective = aliasAnalysis.filter(a => !a.effective);
    console.log(`Effective (alias provides LCA match that direct name doesn't): ${effective.length}`);
    for (const a of effective) {
      console.log(`  "${a.company}" → "${a.alias}": ${a.jobs_benefiting} jobs`);
    }
    console.log('');
    if (ineffective.length > 0) {
      console.log(`Ineffective (direct match exists, or alias doesn't match LCA): ${ineffective.length}`);
      for (const a of ineffective.slice(0, 10)) {
        const reason = a.direct_match ? 'direct match exists' : 'alias not in LCA';
        console.log(`  "${a.company}" → "${a.alias}": ${reason} (${a.jobs_benefiting} jobs)`);
      }
      if (ineffective.length > 10) console.log(`  ... and ${ineffective.length - 10} more`);
    }
    console.log('');
  }
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
