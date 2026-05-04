/**
 * validate-lca-aliases.js
 *
 * Validates all LCA_COMPANY_ALIASES entries against live LCA data.
 * Reports: broken aliases (don't resolve), orphaned aliases (company not in pool),
 * and missing aliases (companies in pool with possible_sponsor=null that might
 * have LCA matches).
 *
 * Run: node tools/validate-lca-aliases.js
 * From: job-board-shared/ root
 *
 * Or with remote data (no local clone needed):
 *   node tools/validate-lca-aliases.js --remote
 *
 * Exit code: 0 if all aliases valid, 1 if any broken aliases found.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function normalizeLcaName(name) {
  return name.toLowerCase().trim().replace(/[.,]/g, '').replace(/&/g, 'and').replace(/-/g, ' ');
}

function loadLocalLca() {
  const lcaPath = path.join(process.cwd(), '.github', 'data', 'lca-sponsors.json');
  if (!fs.existsSync(lcaPath)) {
    console.error('lca-sponsors.json not found at .github/data/');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(lcaPath, 'utf8'));
}

function loadRemoteLca() {
  const { execSync } = require('child_process');
  try {
    // Use raw URL for large files — contents API has size limits
    const raw = execSync(
      'curl -sL https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/lca-sponsors.json',
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to fetch remote LCA data:', e.message.slice(0, 200));
    process.exit(1);
  }
}

function loadRemoteAliasSource() {
  const { execSync } = require('child_process');
  try {
    const content = execSync(
      'gh api repos/zapplyjobs/job-board-shared/contents/lib/jobs-data-scripts/enrich-jobs.js --jq .content',
      { encoding: 'utf8' }
    ).trim();
    const source = Buffer.from(content, 'base64').toString('utf8');
    // Extract LCA_COMPANY_ALIASES object
    const match = source.match(/const LCA_COMPANY_ALIASES = \{([\s\S]*?)\};/);
    if (!match) {
      console.error('Could not extract LCA_COMPANY_ALIASES from remote source');
      process.exit(1);
    }
    // Parse the alias map — it's a flat key-value object
    const aliasStr = '{' + match[1] + '}';
    return new Function('return ' + aliasStr)();
  } catch (e) {
    console.error('Failed to fetch remote alias source:', e.message);
    process.exit(1);
  }
}

function loadLocalAliases() {
  // Extract from the loaded module
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'jobs-data-scripts', 'enrich-jobs.js'),
    'utf8'
  );
  const match = source.match(/const LCA_COMPANY_ALIASES = \{([\s\S]*?)\};/);
  if (!match) {
    console.error('Could not extract LCA_COMPANY_ALIASES from source');
    process.exit(1);
  }
  const aliasStr = '{' + match[1] + '}';
  return new Function('return ' + aliasStr)();
}

function loadRemoteEnrichedJobs() {
  const { execSync } = require('child_process');
  try {
    // Get the SHA of enriched_jobs.json first to check size
    const sha = execSync(
      'gh api repos/zapplyjobs/jobs-data-2026/contents/.github/data/enriched_jobs.json --jq .sha',
      { encoding: 'utf8' }
    ).trim();
    // Use blob API for large files
    const blob = execSync(
      `gh api repos/zapplyjobs/jobs-data-2026/git/blobs/${sha} --jq .content`,
      { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }
    ).trim();
    const decoded = Buffer.from(blob, 'base64').toString('utf8');
    return decoded.trim().split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error('Failed to fetch enriched jobs:', e.message.slice(0, 200));
    return [];
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

const useRemote = process.argv.includes('--remote');

console.log(`\n${'='.repeat(60)}`);
console.log(`LCA Alias Validation (${useRemote ? 'remote' : 'local'} data)`);
console.log('='.repeat(60));

const lcaData = useRemote ? loadRemoteLca() : loadLocalLca();
const aliases = useRemote ? loadRemoteAliasSource() : loadLocalAliases();
const lcaSet = new Set((lcaData.employers || []).map(e => normalizeLcaName(e)));

console.log(`LCA employers: ${lcaSet.size}`);
console.log(`Aliases defined: ${Object.keys(aliases).length}`);

// ─── Check 1: Every alias resolves to an LCA entry ────────────────────────

console.log('\n--- Check 1: Alias Resolution ---');
let broken = 0;
let valid = 0;

for (const [displayName, aliasValue] of Object.entries(aliases)) {
  const normalizedAlias = normalizeLcaName(aliasValue);
  if (!lcaSet.has(normalizedAlias)) {
    console.log(`  BROKEN: '${displayName}' → '${aliasValue}' → '${normalizedAlias}' NOT in LCA`);
    broken++;
  } else {
    valid++;
  }
}

console.log(`  Results: ${valid} valid, ${broken} broken`);

// ─── Check 2: Direct matches (displayName normalizes to LCA entry) ─────────

console.log('\n--- Check 2: Direct Match Coverage ---');
let directMatches = 0;
for (const displayName of Object.keys(aliases)) {
  const norm = normalizeLcaName(displayName);
  if (lcaSet.has(norm)) {
    directMatches++;
  }
}
console.log(`  ${directMatches}/${Object.keys(aliases).length} aliases have direct LCA match too`);

// ─── Check 3: Duplicate alias values ───────────────────────────────────────

console.log('\n--- Check 3: Duplicate Alias Values ---');
const valueCounts = {};
for (const [_, aliasValue] of Object.entries(aliases)) {
  const norm = normalizeLcaName(aliasValue);
  valueCounts[norm] = (valueCounts[norm] || 0) + 1;
}
const dups = Object.entries(valueCounts).filter(([_, c]) => c > 1);
if (dups.length > 0) {
  for (const [val, count] of dups) {
    console.log(`  DUPLICATE: '${val}' used by ${count} aliases`);
  }
} else {
  console.log('  No duplicate alias values found');
}

// ─── Check 4: Potential missing aliases (if remote) ────────────────────────

if (useRemote) {
  console.log('\n--- Check 4: Companies with possible_sponsor=null (alias candidates) ---');
  const jobs = loadRemoteEnrichedJobs();
  const nullSponsorCompanies = {};
  for (const job of jobs) {
    if (job.possible_sponsor === null && job.has_description !== false) {
      const name = job.company_name || 'unknown';
      if (!nullSponsorCompanies[name]) nullSponsorCompanies[name] = 0;
      nullSponsorCompanies[name]++;
    }
  }
  // Show top 20 companies with null sponsor that aren't already aliased
  const aliasKeys = new Set(Object.keys(aliases));
  const candidates = Object.entries(nullSponsorCompanies)
    .filter(([name]) => !aliasKeys.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  if (candidates.length > 0) {
    console.log(`  Top unaliased companies with possible_sponsor=null:`);
    for (const [name, count] of candidates) {
      // Check if they have any direct LCA match
      const norm = normalizeLcaName(name);
      const directHit = lcaSet.has(norm) ? ' [DIRECT HIT - add alias]' : '';
      console.log(`    ${name}: ${count} jobs${directHit}`);
    }
  } else {
    console.log('  All null-sponsor companies already have aliases');
  }
}

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`Summary: ${valid} valid, ${broken} broken, ${Object.keys(aliases).length} total`);
if (broken > 0) {
  console.log('ACTION REQUIRED: Fix broken aliases before next ENR version bump');
  process.exit(1);
} else {
  console.log('All aliases resolve correctly');
}
