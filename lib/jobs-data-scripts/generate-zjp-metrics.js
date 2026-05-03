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
    aggregator_queue_minutes: null,
    aggregator_execution_minutes: null,
    aggregator_cancel_count: null,
  };

  // Aggregator run status — last 15 runs for stats + latest for timing
  try {
    const res = await ghRequest('https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/runs?per_page=15');
    if (res.body?.workflow_runs) {
      const runs = res.body.workflow_runs;
      const latest = runs[0];
      if (latest) {
        status.last_aggregator_run = latest.created_at;
        status.last_aggregator_status = latest.conclusion || 'in_progress';
        if (latest.updated_at && latest.created_at) {
          const dur = (new Date(latest.updated_at) - new Date(latest.created_at)) / 60000;
          if (dur > 0 && dur < 60) status.aggregator_runtime_minutes = Math.round(dur * 10) / 10;
        }

        // Get job-level timing for queue vs execution breakdown
        if (latest.id) {
          try {
            const jobRes = await ghRequest(`https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/runs/${latest.id}/jobs`);
            if (jobRes.body?.jobs?.[0]) {
              const job = jobRes.body.jobs[0];
              if (job.created_at && latest.created_at) {
                const queueMin = (new Date(job.created_at) - new Date(latest.created_at)) / 60000;
                if (queueMin >= 0 && queueMin < 30) status.aggregator_queue_minutes = Math.round(queueMin * 10) / 10;
              }
              if (job.completed_at && job.started_at) {
                const execMin = (new Date(job.completed_at) - new Date(job.started_at)) / 60000;
                if (execMin > 0 && execMin < 30) status.aggregator_execution_minutes = Math.round(execMin * 10) / 10;
              }
            }
          } catch {}
        }

        // Count cancellations in last 15 runs
        const cancelled = runs.filter(r => r.conclusion === 'cancelled').length;
        status.aggregator_cancel_count = cancelled;
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

async function getRepoSizes() {
  const sizes = {};
  for (const repo of REPOS) {
    try {
      const res = await ghRequest(`https://api.github.com/repos/zapplyjobs/${repo}`);
      if (res.status === 200 && res.body?.size != null) {
        sizes[repo] = Math.round(res.body.size / 1024); // KB → MB
      }
    } catch {}
  }
  const total_mb = Object.values(sizes).reduce((a, b) => a + b, 0);
  return { total_mb: total_mb || null, repos: sizes };
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
  const tagDomains = metadata?.tag_stats?.domains || {};
  const generalCount = tagDomains['general'] ?? null;
  const totalJobs = metadata?.total_jobs ?? null;
  const g1 = metadata?.tag_stats?.g1 ?? null;
  metrics.pool = {
    total_jobs: totalJobs,
    tech_us: enrichStats?.total_tech_us ?? null,
    domains: tagDomains,
    general_rate_pct: (generalCount !== null && totalJobs && totalJobs > 0)
      ? Math.round(generalCount / totalJobs * 1000) / 10 : null,
    g1_us: g1 ? {
      us_total: g1.us_total,
      us_general: g1.us_general,
      us_general_rate_pct: g1.us_general_rate_pct,
      tech_us_general_rate_pct: g1.tech_us_general_rate_pct,
    } : null,
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
  console.log('Querying GitHub API for alignment + freshness + sizes...');
  const [pipeline, submodules, consumers, repoSizes] = await Promise.all([
    getPipelineStatus(),
    getSubmoduleAlignment(),
    getConsumerFreshness(),
    getRepoSizes(),
  ]);

  metrics.pipeline = pipeline;
  // INF-OBSERV-3: Surface per-stage timings from jobs-metadata.json
  if (metadata?.stage_timings) {
    metrics.pipeline.stage_timings = metadata.stage_timings;
  }
  metrics.submodules = submodules;
  metrics.consumers = consumers;
  metrics.repos = repoSizes;

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metrics, null, 2), 'utf8');
  console.log(`Written ${OUTPUT_FILE}`);
  console.log(`  Pool: ${metrics.pool.total_jobs} jobs, ${metrics.pool.tech_us} tech-US`);
  console.log(`  Enrichment: ${metrics.enrichment.enrichment_rate_pct}% T3`);
  console.log(`  P-2: ${metrics.submodules.p2_status}`);
  console.log(`  Consumers: ${Object.keys(metrics.consumers.repos).length} repos checked`);
  console.log(`  Repo sizes: ${metrics.repos.total_mb} MB total`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  // Don't exit with error — this is additive, shouldn't break the pipeline
});
