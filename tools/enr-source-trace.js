#!/usr/bin/env node
// enr-source-trace.js — Diagnose WHY a source is underperforming in enrichment
//
// Traces a source through 5 pipeline stages to identify where data is lost.
// Stage 1: Fetcher — did the source produce jobs? (jobs-metadata.json)
// Stage 2: Sidecar — do jobs have description entries? (enriched_jobs has_description)
// Stage 3: Skills — were skills extracted? (enriched_jobs skills array)
// Stage 4: Degree — was degree inferred/extracted? (enriched_jobs degree_level)
// Stage 5: Visa — was visa signal found? (enriched_jobs possible_sponsor)
//
// Usage:
//   node projects/zjp/scripts/enr-source-trace.js google
//   node projects/zjp/scripts/enr-source-trace.js oracle --remote
//   node projects/zjp/scripts/enr-source-trace.js apple --json
//   node projects/zjp/scripts/enr-source-trace.js --list    (show all sources)
//
// Output: Per-source diagnostic with stage-by-stage pass/fail + root cause hint.

'use strict';

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const useRemote = args.includes('--remote');
const listSources = args.includes('--list');
const sourceName = args.find(a => !a.startsWith('--'));

if (!sourceName && !listSources) {
  console.error('Usage: enr-source-trace.js <source_name> [--remote] [--json]');
  console.error('       enr-source-trace.js --list [--remote]');
  process.exit(1);
}

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'ZJP-SourceTrace/1.0' },
      timeout: 120000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve);
      }
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip())
        : res;
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve({
        ok: res.statusCode === 200,
        text: Buffer.concat(chunks).toString('utf-8'),
      }));
      stream.on('error', () => resolve({ ok: false, text: '' }));
    });
    req.setTimeout(120000, () => { req.destroy(); resolve({ ok: false, text: '' }); });
    req.on('error', () => resolve({ ok: false, text: '' }));
  });
}

async function fetchGhApi(path) {
  const { execSync } = require('child_process');
  try {
    const content = execSync(
      `gh api repos/zapplyjobs/${path} --jq '.content' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 }
    ).trim();
    if (!content) return null;
    return JSON.parse(Buffer.from(content, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

async function loadEnrichedJobs() {
  if (useRemote) {
    // Try r2-loader first (S3 client, live data when env vars set)
    try {
      const { loadJsonFromR2 } = require('./r2-loader');
      return await loadJsonFromR2('enriched_jobs.json');
    } catch {}
    // Fallback: gh api, then R2 public, then raw GitHub (stale)
    const data = await fetchGhApi('jobs-data-2026/contents/.github/data/enriched_jobs.json');
    if (data) {
      console.error('  Loaded enriched_jobs.json via gh api (fresh)');
      return Array.isArray(data) ? data : Object.values(data);
    }

    for (const url of [
      'https://pub-7c6b1d38c7974dd7a11e3a1e6e46c68b.r2.dev/enriched_jobs.json',
      `https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/enriched_jobs.json?t=${Math.floor(Date.now()/1000)}`,
    ]) {
      console.error(`  Fetching ${url.split('/').slice(-2).join('/')}...`);
      const resp = await fetchText(url);
      if (!resp.ok || !resp.text) continue;
      try {
        const records = [];
        let parsed;
        try {
          parsed = JSON.parse(resp.text);
        } catch {
          for (const line of resp.text.trim().split('\n')) {
            if (line.trim()) try { records.push(JSON.parse(line)); } catch {}
          }
          if (records.length) { console.error(`  Loaded ${records.length} records (JSONL)`); return records; }
          continue;
        }
        if (Array.isArray(parsed)) { console.error(`  Loaded ${parsed.length} records`); return parsed; }
        if (parsed.jobs) { console.error(`  Loaded ${parsed.jobs.length} records`); return parsed.jobs; }
      } catch { continue; }
    }
    console.error('ERROR: Could not load enriched_jobs.json from any source');
    process.exit(1);
  }

  // Local file
  const localPath = args.find(a => !a.startsWith('--') && a !== sourceName);
  const tryPaths = [
    localPath,
    'enriched_jobs.json',
    '../jobs-data-2026/enriched_jobs.json',
  ].filter(Boolean);

  for (const p of tryPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
      console.error(`  Loaded ${records.length} records from ${p}`);
      return records;
    }
  }
  console.error('ERROR: No enriched_jobs.json found. Provide path or use --remote.');
  process.exit(1);
}

async function loadMetadata() {
  if (useRemote) {
    const data = await fetchGhApi('jobs-aggregator-private/contents/jobs-metadata.json');
    if (data) { console.error('  Loaded jobs-metadata.json via gh api'); return data; }
  }
  return null;
}

function hasSkills(job) {
  const skills = job.skills || job.required_skills;
  return Array.isArray(skills) && skills.length > 0;
}

function getDegree(job) {
  return job.degree_level || job.min_degree;
}

function hasVisa(job) {
  return job.possible_sponsor !== null && job.possible_sponsor !== undefined;
}

function classifyTier(job) {
  const sk = hasSkills(job);
  const deg = getDegree(job) && getDegree(job) !== 'None' && getDegree(job) !== 'NONE';
  const visa = hasVisa(job);

  if (sk && deg && visa) return 'T4';
  if (sk && deg) return 'T3';
  if (sk || deg) return 'T2';
  return 'T1';
}

async function main() {
  const jobs = await loadEnrichedJobs();
  const metadata = await loadMetadata();

  // Build source index
  const bySource = {};
  for (const job of jobs) {
    const src = job.source || 'unknown';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(job);
  }

  // List mode
  if (listSources) {
    const rows = Object.entries(bySource)
      .map(([src, srcJobs]) => {
        const usJobs = srcJobs.filter(j => j.is_us || j.location_tags?.includes('US') || j.job_country === 'US');
        const enriched = srcJobs.filter(j => (j.enriched_version || j.enricher_version || 0) > 0);
        const t3t4 = srcJobs.filter(j => ['T3', 'T4'].includes(classifyTier(j)));
        return {
          source: src,
          total: srcJobs.length,
          us: usJobs.length,
          enriched: enriched.length,
          t3t4: t3t4.length,
          t3t4_pct: srcJobs.length ? (t3t4.length / srcJobs.length * 100).toFixed(1) : '0.0',
        };
      })
      .sort((a, b) => b.total - a.total);

    if (jsonOutput) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log('\n=== Source Overview ===\n');
      console.log('Source'.padEnd(25) + 'Total'.padStart(7) + 'US'.padStart(7) + 'Enr%'.padStart(7) + 'T3+T4%'.padStart(8));
      console.log('-'.repeat(54));
      for (const r of rows) {
        const enrPct = r.total ? (r.enriched / r.total * 100).toFixed(1) : '0.0';
        console.log(
          r.source.padEnd(25) +
          String(r.total).padStart(7) +
          String(r.us).padStart(7) +
          `${enrPct}%`.padStart(7) +
          `${r.t3t4_pct}%`.padStart(8)
        );
      }
    }
    return;
  }

  // Single source trace
  const sourceJobs = bySource[sourceName];
  if (!sourceJobs) {
    console.error(`ERROR: Source "${sourceName}" not found. Available: ${Object.keys(bySource).sort().join(', ')}`);
    console.error('Use --list to see all sources.');
    process.exit(1);
  }

  // Stage 1: Fetcher output
  const fetcherInfo = metadata?.sources?.[sourceName];
  const stage1 = {
    name: 'Fetcher Output',
    pass: sourceJobs.length > 0,
    detail: `${sourceJobs.length} jobs fetched`,
    metadata: fetcherInfo || null,
  };

  // Stage 2: Sidecar / Description
  const withDesc = sourceJobs.filter(j => j.has_description === true);
  const stage2 = {
    name: 'Description Available',
    pass: withDesc.length > 0,
    has_desc: withDesc.length,
    total: sourceJobs.length,
    pct: sourceJobs.length ? (withDesc.length / sourceJobs.length * 100).toFixed(1) : '0.0',
    detail: `${withDesc.length}/${sourceJobs.length} (${sourceJobs.length ? (withDesc.length / sourceJobs.length * 100).toFixed(1) : '0'}%) have descriptions`,
  };

  // Stage 3: Skills extraction
  const withSkills = sourceJobs.filter(j => hasSkills(j));
  const noSkills = sourceJobs.filter(j => !hasSkills(j));
  const stage3 = {
    name: 'Skills Extraction',
    pass: withSkills.length > 0,
    has_skills: withSkills.length,
    total: sourceJobs.length,
    pct: sourceJobs.length ? (withSkills.length / sourceJobs.length * 100).toFixed(1) : '0.0',
    detail: `${withSkills.length}/${sourceJobs.length} (${sourceJobs.length ? (withSkills.length / sourceJobs.length * 100).toFixed(1) : '0'}%) have skills`,
  };

  // Stage 4: Degree inference
  const withDegree = sourceJobs.filter(j => {
    const d = getDegree(j);
    return d && d !== 'None' && d !== 'NONE';
  });
  const stage4 = {
    name: 'Degree Inference',
    pass: withDegree.length > 0,
    has_degree: withDegree.length,
    total: sourceJobs.length,
    pct: sourceJobs.length ? (withDegree.length / sourceJobs.length * 100).toFixed(1) : '0.0',
    detail: `${withDegree.length}/${sourceJobs.length} (${sourceJobs.length ? (withDegree.length / sourceJobs.length * 100).toFixed(1) : '0'}%) have degree`,
  };

  // Stage 5: Visa signal
  const withVisa = sourceJobs.filter(j => j.possible_sponsor !== null && j.possible_sponsor !== undefined);
  const stage5 = {
    name: 'Visa Signal',
    pass: withVisa.length > 0,
    has_visa: withVisa.length,
    total: sourceJobs.length,
    pct: sourceJobs.length ? (withVisa.length / sourceJobs.length * 100).toFixed(1) : '0.0',
    detail: `${withVisa.length}/${sourceJobs.length} (${sourceJobs.length ? (withVisa.length / sourceJobs.length * 100).toFixed(1) : '0'}%) have visa signal`,
  };

  // Tier breakdown
  const tiers = { T1: 0, T2: 0, T3: 0, T4: 0 };
  for (const j of sourceJobs) tiers[classifyTier(j)]++;
  const t3t4 = tiers.T3 + tiers.T4;
  const t3t4Pct = sourceJobs.length ? (t3t4 / sourceJobs.length * 100).toFixed(1) : '0.0';

  // Version distribution
  const versions = {};
  for (const j of sourceJobs) {
    const v = j.enriched_version || j.enricher_version || 0;
    versions[v] = (versions[v] || 0) + 1;
  }

  // Root cause analysis
  const rootCauses = [];
  if (stage2.pct < 50) {
    rootCauses.push('LOW_DESCRIPTION: <50% of jobs have descriptions. Fetcher may not be reaching detail pages, or sidecar is being deleted as stale.');
  }
  if (stage2.pct >= 50 && stage3.pct < 50) {
    rootCauses.push('SKILLS_EXTRACTION_GAP: Descriptions exist but skills not extracted. Possible taxonomy gap — source uses terminology not in skills-taxonomy.json.');
  }
  if (stage3.pct >= 50 && stage4.pct < 30) {
    rootCauses.push('DEGREE_INFERENCE_GAP: Skills extracted but degree not inferred. Title-based inference may not cover this source\'s job titles.');
  }
  if (stage3.pct >= 50 && stage4.pct >= 30 && stage5.pct < 30) {
    rootCauses.push('VISA_SIGNAL_GAP: Skills and degree present but visa signal missing. LCA alias may not cover this source\'s company names.');
  }
  if (Object.keys(versions).length > 1 && (versions[0] || 0) > sourceJobs.length * 0.3) {
    rootCauses.push(`STALE_VERSION: ${versions[0] || 0} jobs at version 0 (never enriched). Re-enrichment may not be reaching these records.`);
  }
  if (rootCauses.length === 0 && t3t4Pct >= 80) {
    rootCauses.push('HEALTHY: Source enrichment is within acceptable range. No action needed.');
  } else if (rootCauses.length === 0) {
    rootCauses.push('COMPOUND_GAP: Multiple fields partially missing. No single dominant root cause. Investigate individual job samples.');
  }

  // T1 sample jobs (for manual verification)
  const t1Jobs = sourceJobs.filter(j => classifyTier(j) === 'T1').slice(0, 5);

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify({
      source: sourceName,
      total_jobs: sourceJobs.length,
      stages: [stage1, stage2, stage3, stage4, stage5],
      tiers,
      t3t4_pct: parseFloat(t3t4Pct),
      versions,
      root_causes: rootCauses,
      t1_samples: t1Jobs.map(j => ({
        id: j.job_id || j.id,
        title: j.title,
        company: j.company_name || j.company,
        has_description: j.has_description,
        skills: (j.skills || j.required_skills || []).length,
        degree: j.degree_level || j.min_degree,
        visa: j.possible_sponsor,
        url: j.url || j.job_url,
      })),
    }, null, 2));
    return;
  }

  // Human-readable output
  console.log(`\n=== Source Trace: ${sourceName} ===\n`);

  console.log(`Total jobs: ${sourceJobs.length} | T1: ${tiers.T1} | T2: ${tiers.T2} | T3: ${tiers.T3} | T4: ${tiers.T4} | T3+T4: ${t3t4Pct}%`);
  console.log(`Versions: ${Object.entries(versions).sort((a,b) => b[1]-a[1]).map(([v,c]) => `v${v}=${c}`).join(', ')}`);
  console.log();

  const stages = [stage1, stage2, stage3, stage4, stage5];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const icon = s.pass ? '✅' : '❌';
    console.log(`Stage ${i+1}: ${icon} ${s.name}`);
    console.log(`        ${s.detail}`);
  }

  console.log(`\n=== Root Cause Analysis ===`);
  for (const rc of rootCauses) {
    console.log(`  → ${rc}`);
  }

  if (t1Jobs.length > 0) {
    console.log(`\n=== T1 Sample Jobs (verify manually) ===`);
    for (const j of t1Jobs) {
      const url = j.url || j.job_url || 'N/A';
      console.log(`  • ${(j.title || 'N/A').substring(0, 50).padEnd(52)} | ${(j.company_name || j.company || 'N/A').substring(0, 20)}`);
      console.log(`    URL: ${url}`);
    }
  }

  console.log();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
