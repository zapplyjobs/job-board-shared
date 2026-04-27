#!/usr/bin/env node

/**
 * ZJP Metrics Generator
 *
 * Consolidates pipeline health data from local files + GitHub API
 * into a single JSON that sessions read at startup instead of
 * running 10+ manual API calls.
 *
 * Runs as a step in collect-metrics.yml (every 15 min).
 * Reads local data files first, queries GitHub API for alignment/freshness.
 *
 * Input files (local, in .github/data/):
 *   - enrichment-stats.json
 *   - jobs-metadata.json
 *   - pipeline-alert.json
 *   - metrics/latest.json
 *
 * Output: .github/data/zjp-metrics.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'zjp-metrics.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const REPOS = [
  'jobs-aggregator-private',
  'jobs-data-2026',
  'New-Grad-Jobs-2026',
  'Internships-2026',
  'New-Grad-Software-Engineering-Jobs-2026',
  'New-Grad-Data-Science-Jobs-2026',
  'New-Grad-Hardware-Engineering-Jobs-2026',
  'New-Grad-Healthcare-Jobs-2026',
];

const CONSUMER_REPOS = REPOS.filter(r => r !== 'jobs-aggregator-private' && r !== 'jobs-data-2026');

function ghRequest(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'ZJP-Metrics-Generator',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    }).on('error', reject);
  });
}

function readLocalFile(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}

async function getSubmoduleAlignment() {
  const submodules = {};
  const hashes = new Set();

  for (const repo of REPOS) {
    try {
      const res = await ghRequest(`https://api.github.com/repos/zapplyjobs/${repo}/contents/.github/scripts/shared`);
      if (res.status === 200 && res.body?.sha) {
        submodules[repo] = res.body.sha;
        hashes.add(res.body.sha);
      } else {
        submodules[repo] = null;
      }
    } catch {
      submodules[repo] = null;
    }
  }

  const aligned = hashes.size === 1;
  const hash = [...hashes][0] || null;
  return { aligned, hash, repos: submodules, p2_status: aligned ? 'PASS' : 'FAIL' };
}

async function getPipelineStatus() {
  const status = {
    last_aggregator_run: null,
    last_aggregator_status: null,
    last_enrichment_run: null,
    last_enrichment_status: null,
    aggregator_runtime_minutes: null,
  };

  // Aggregator run status
  try {
    const res = await ghRequest('https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/runs?per_page=1');
    if (res.body?.workflow_runs?.[0]) {
      const run = res.body.workflow_runs[0];
      status.last_aggregator_run = run.created_at;
      status.last_aggregator_status = run.conclusion || 'in_progress';
      if (run.updated_at && run.created_at) {
        const dur = (new Date(run.updated_at) - new Date(run.created_at)) / 60000;
        if (dur > 0 && dur < 60) status.aggregator_runtime_minutes = Math.round(dur * 10) / 10;
      }
    }
  } catch {}

  // Enrichment run status
  try {
    const res = await ghRequest('https://api.github.com/repos/zapplyjobs/jobs-data-2026/actions/runs?per_page=5');
    if (res.body?.workflow_runs) {
      const enrichRun = res.body.workflow_runs.find(r => r.name === 'Enrich Jobs');
      if (enrichRun) {
        status.last_enrichment_run = enrichRun.created_at;
        status.last_enrichment_status = enrichRun.conclusion || 'in_progress';
      }
    }
  } catch {}

  return status;
}

async function getConsumerFreshness() {
  const consumers = { last_update: null, repos: {} };

  for (const repo of CONSUMER_REPOS) {
    try {
      const res = await ghRequest(`https://api.github.com/repos/zapplyjobs/${repo}/commits?per_page=1`);
      if (res.body?.[0]) {
        const commit = res.body[0];
        const date = commit.commit.committer.date;
        const msg = commit.commit.message.split('\n')[0];
        const posMatch = msg.match(/(\d[\d,]+)\s+positions?/i);
        consumers.repos[repo] = {
          positions: posMatch ? parseInt(posMatch[1].replace(/,/g, '')) : null,
          last_commit: date,
        };
        if (!consumers.last_update || date > consumers.last_update) {
          consumers.last_update = date;
        }
      }
    } catch {
      consumers.repos[repo] = { positions: null, last_commit: null };
    }
  }

  return consumers;
}

async function main() {
  console.log('Generating zjp-metrics.json...');

  // Read local data files
  const enrichStats = readLocalFile('enrichment-stats.json');
  const metadata = readLocalFile('jobs-metadata.json');
  const alertData = readLocalFile('pipeline-alert.json');

  // Build metrics object
  const metrics = {
    schema: 'zjp-metrics-v1',
    generated_at: new Date().toISOString(),
  };

  // Pool data from metadata
  metrics.pool = {
    total_jobs: metadata?.total_jobs ?? null,
    tech_us: enrichStats?.total_tech_us ?? null,
    source: 'jobs-metadata.json + enrichment-stats.json',
  };

  // Enrichment data
  if (enrichStats) {
    const total = enrichStats.total_tech_us || 0;
    const enriched = enrichStats.total_enriched || 0;
    metrics.enrichment = {
      total_enriched: enriched,
      enrichment_rate_pct: total > 0 ? Math.round(enriched / total * 1000) / 10 : null,
      tiers: enrichStats.tiers || {},
      enricher_version: enrichStats.enricher_version || null,
      reenrichment_pending: enrichStats.reenrichment_pending ?? null,
      source: 'enrichment-stats.json',
    };
  } else {
    metrics.enrichment = { source: 'enrichment-stats.json (not available)' };
  }

  // Alerts from local file
  if (alertData) {
    metrics.alerts = {
      active: alertData.active ?? false,
      failures: alertData.failures ?? [],
      last_checked: alertData.checked_at ?? null,
      source: 'pipeline-alert.json',
    };
  } else {
    metrics.alerts = { active: null, source: 'pipeline-alert.json (not available)' };
  }

  // GitHub API calls (async)
  console.log('Querying GitHub API for alignment + freshness...');
  const [pipeline, submodules, consumers] = await Promise.all([
    getPipelineStatus(),
    getSubmoduleAlignment(),
    getConsumerFreshness(),
  ]);

  metrics.pipeline = pipeline;
  metrics.submodules = submodules;
  metrics.consumers = consumers;

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metrics, null, 2), 'utf8');
  console.log(`Written ${OUTPUT_FILE}`);
  console.log(`  Pool: ${metrics.pool.total_jobs} jobs, ${metrics.pool.tech_us} tech-US`);
  console.log(`  Enrichment: ${metrics.enrichment.enrichment_rate_pct}% T3`);
  console.log(`  P-2: ${metrics.submodules.p2_status}`);
  console.log(`  Consumers: ${Object.keys(metrics.consumers.repos).length} repos checked`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  // Don't exit with error — this is additive, shouldn't break the pipeline
});
