#!/usr/bin/env node

/**
 * Collect Metrics for Aggregator Monitoring
 *
 * Pipeline-level data is read locally from jobs-metadata.json + all_jobs.json.
 * Per-repo data is fetched from GitHub API (workflow status filtered to update-jobs.yml,
 * last jobs update from commits API filtered to the data file path).
 *
 * Output: overwrites .github/data/metrics/latest.json, appends to history.jsonl.
 * Cron: every 6 hours (collect-metrics.yml).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const METRICS_DIR = path.join(DATA_DIR, 'metrics');
const LATEST_FILE = path.join(METRICS_DIR, 'latest.json');
const HISTORY_FILE = path.join(METRICS_DIR, 'history.jsonl');

// Repos to monitor. All 6 consumer repos have last_count.json + current_jobs.json.
const REPOS = [
  { owner: 'zapplyjobs', repo: 'New-Grad-Jobs-2026',                      name: 'New-Grad',      hasJobsFile: true  },
  { owner: 'zapplyjobs', repo: 'Internships-2026',                         name: 'Internships',   hasJobsFile: true  },
  { owner: 'zapplyjobs', repo: 'New-Grad-Software-Engineering-Jobs-2026',  name: 'Software',      hasJobsFile: true  },
  { owner: 'zapplyjobs', repo: 'New-Grad-Data-Science-Jobs-2026',          name: 'Data-Science',  hasJobsFile: true  },
  { owner: 'zapplyjobs', repo: 'New-Grad-Hardware-Engineering-Jobs-2026',  name: 'Hardware',      hasJobsFile: true  },
  { owner: 'zapplyjobs', repo: 'New-Grad-Healthcare-Jobs-2026',            name: 'Healthcare',    hasJobsFile: true  },
];

function ghRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Zapply-Metrics-Bot',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    }).on('error', reject);
  });
}

function rawRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Zapply-Metrics-Bot' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

/**
 * Get job count from last_count.json (fast, tiny file) with current_jobs.json fallback.
 * last_count.json is written by consumer workflows and contains {count, timestamp}.
 */
async function getJobCount(owner, repo) {
  // Try last_count.json first — avoids downloading 20 MB current_jobs.json for NGJ
  try {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/.github/data/last_count.json`;
    const res = await rawRequest(url);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      if (typeof data.count === 'number') return data.count;
    }
  } catch {}

  // Fallback: parse current_jobs.json array length
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/.github/data/current_jobs.json`;
  try {
    const res = await rawRequest(url);
    if (res.status !== 200) return null;
    const jobs = JSON.parse(res.body);
    return Array.isArray(jobs) ? jobs.length : null;
  } catch {
    return null;
  }
}

/**
 * Get the timestamp of the last commit that touched a specific file path.
 * Uses commits API with path filter — accurate even if other commits landed after.
 */
async function getLastFileCommitTimestamp(owner, repo, filePath) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${filePath}&per_page=1`;
  try {
    const res = await ghRequest(url);
    if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) return null;
    return res.body[0].commit?.committer?.date || res.body[0].commit?.author?.date || null;
  } catch {
    return null;
  }
}

/**
 * Get status of the last run of update-jobs.yml specifically.
 * Avoids the bug in the old script which picked up any workflow run (pages, cleanup, etc.).
 */
async function getUpdateJobsWorkflowStatus(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/update-jobs.yml/runs?per_page=1`;
  try {
    const res = await ghRequest(url);
    if (res.status !== 200 || !res.body?.workflow_runs?.length) return null;
    const run = res.body.workflow_runs[0];
    return {
      status: run.status,
      conclusion: run.conclusion,
      lastRun: run.updated_at
    };
  } catch {
    return null;
  }
}

async function getRepoMetrics(repo) {
  const [jobCount, lastJobsUpdate, workflowData] = await Promise.all([
    repo.hasJobsFile ? getJobCount(repo.owner, repo.repo) : Promise.resolve(null),
    repo.hasJobsFile
      ? getLastFileCommitTimestamp(repo.owner, repo.repo, '.github/data/current_jobs.json')
      : Promise.resolve(null),
    getUpdateJobsWorkflowStatus(repo.owner, repo.repo)
  ]);

  return {
    name: repo.name,
    // null means "not applicable by design" (New-Grad), not a failure
    jobCount,
    lastJobsUpdate,
    workflowStatus: workflowData?.conclusion || null,
    workflowLastRun: workflowData?.lastRun || null
  };
}

/**
 * Read pipeline-level data from local files (same repo, available at runtime).
 * all_jobs.json is JSONL — line count = pipeline size.
 */
function getPipelineMetrics() {
  try {
    const metadataPath = path.join(DATA_DIR, 'jobs-metadata.json');
    const allJobsPath = path.join(DATA_DIR, 'all_jobs.json');

    if (!fs.existsSync(metadataPath)) {
      console.warn('  ⚠️  jobs-metadata.json not found — pipeline metrics unavailable');
      return null;
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    // JSONL line count for pipeline total
    let pipelineTotal = null;
    if (fs.existsSync(allJobsPath)) {
      const content = fs.readFileSync(allJobsPath, 'utf8');
      pipelineTotal = content.split('\n').filter(l => l.trim()).length;
    }

    return {
      pipelineTotal,
      prevTotalJobs: metadata.total_jobs ?? null,
      bySource: metadata.by_source || null,
      jsearchTotalFetched: metadata.jsearch_stats?.total_fetched ?? null, // JSearch decommissioned — residual field, always null
      tagStats: {
        usTagged: metadata.tag_stats?.locations?.us ?? null,
        entryLevel: metadata.tag_stats?.employment?.entry_level ?? null,
        internship: metadata.tag_stats?.employment?.internship ?? null,
        domains: metadata.tag_stats?.domains || null
      },
      duplicatesRemoved: metadata.duplicates_removed ?? null,
      generatedAt: metadata.generated || null
    };
  } catch (err) {
    console.warn('  ⚠️  Error reading pipeline metrics:', err.message);
    return null;
  }
}

/**
 * Read star counts from daily-stats.json (local file, updated by daily-stats.yml).
 * Returns object keyed by consumer repo short name, or null if file missing.
 */
function getStarCounts() {
  try {
    const statsPath = path.join(DATA_DIR, 'daily-stats.json');
    if (!fs.existsSync(statsPath)) return null;
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    if (!stats.stars) return null;
    // Map full repo names to the consumer short names used in REPOS
    return {
      'New-Grad':    stats.stars['New-Grad-Jobs-2026'] ?? null,
      'Internships': stats.stars['Internships-2026'] ?? null,
      'Software':    stats.stars['New-Grad-Software-Engineering-Jobs-2026'] ?? null,
      'Data-Science':stats.stars['New-Grad-Data-Science-Jobs-2026'] ?? null,
      'Hardware':    stats.stars['New-Grad-Hardware-Engineering-Jobs-2026'] ?? null,
      'Healthcare':  stats.stars['New-Grad-Healthcare-Jobs-2026'] ?? stats.stars['New-Grad-Nursing-Jobs-2026'] ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Read enrichment summary from enrichment-stats.json (local file, updated each aggregator run).
 * Returns { totalEnriched, totalHasDescription } or null if file missing.
 */
function getEnrichmentStats() {
  try {
    const enrichPath = path.join(DATA_DIR, 'enrichment-stats.json');
    if (!fs.existsSync(enrichPath)) return null;
    const stats = JSON.parse(fs.readFileSync(enrichPath, 'utf8'));
    return {
      totalEnriched: stats.total_enriched ?? null,
      totalHasDescription: stats.total_has_description ?? null,
      totalTechUs: stats.total_tech_us ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Compute week-over-week growth trends from history.jsonl.
 * Finds the snapshot closest to 7 days ago and diffs against current pipeline metrics.
 * Returns null if history is too short (<7 days).
 */
function computeGrowthTrends(currentPipeline) {
  if (!fs.existsSync(HISTORY_FILE) || !currentPipeline) return null;

  const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length < 2) return null;

  const now = Date.now();
  const TARGET_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  // Find snapshot closest to 7 days ago
  let best = null;
  let bestDiff = Infinity;
  for (const line of lines) {
    try {
      const snap = JSON.parse(line);
      const age = now - new Date(snap.timestamp).getTime();
      const diff = Math.abs(age - TARGET_AGE_MS);
      if (diff < bestDiff) { bestDiff = diff; best = snap; }
    } catch { /* skip malformed */ }
  }

  if (!best || bestDiff > TARGET_AGE_MS) return null; // no snapshot within 7 days window

  const prevTotal = best.pipeline?.pipelineTotal ?? null;
  const currTotal = currentPipeline.pipelineTotal ?? null;
  const prevBySource = best.pipeline?.bySource ?? {};
  const currBySource = currentPipeline.bySource ?? {};

  const totalDelta = (currTotal !== null && prevTotal !== null) ? currTotal - prevTotal : null;
  const bySourceDelta = {};
  for (const src of new Set([...Object.keys(prevBySource), ...Object.keys(currBySource)])) {
    const prev = prevBySource[src] ?? 0;
    const curr = currBySource[src] ?? 0;
    bySourceDelta[src] = curr - prev;
  }

  return {
    compared_to: best.timestamp,
    total_delta: totalDelta,
    total_delta_pct: (prevTotal && totalDelta !== null) ? Math.round((totalDelta / prevTotal) * 100) : null,
    by_source_delta: bySourceDelta,
  };
}

/**
 * Read traffic data from traffic-history.jsonl (local file, updated by collect-traffic.yml).
 * Returns latest day's views/uniques + aggregated top referrers, or null if file missing.
 */
function getTrafficData() {
  try {
    const trafficPath = path.join(DATA_DIR, 'traffic-history.jsonl');
    if (!fs.existsSync(trafficPath)) return null;
    const lines = fs.readFileSync(trafficPath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const referrerTotals = {};
    let latestEntry = null;

    for (const line of lines) {
      const entry = JSON.parse(line);
      if (!latestEntry || entry.date > latestEntry.date) latestEntry = entry;
      for (const repoData of Object.values(entry.repos || {})) {
        for (const ref of repoData.referrers || []) {
          referrerTotals[ref.referrer] = (referrerTotals[ref.referrer] || 0) + ref.count;
        }
      }
    }

    const topReferrers = Object.entries(referrerTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([referrer, count]) => ({ referrer, count }));

    const totalViews = Object.values(latestEntry.repos || {}).reduce((s, r) => s + (r.views || 0), 0);
    const totalUniques = Object.values(latestEntry.repos || {}).reduce((s, r) => s + (r.uniques || 0), 0);

    return { date: latestEntry.date, totalViews, totalUniques, topReferrers, daysTracked: lines.length };
  } catch {
    return null;
  }
}

function loadPreviousSnapshot() {
  try {
    if (!fs.existsSync(LATEST_FILE)) return null;
    return JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function mergeWithPrevious(current, previous) {
  if (!previous?.repos) return current;
  const prevRepo = previous.repos[current.name];
  if (!prevRepo) return current;

  let carried = false;
  const result = { ...current };
  if (current.workflowStatus === null && prevRepo.workflowStatus !== null) {
    result.workflowStatus = prevRepo.workflowStatus;
    result.workflowLastRun = prevRepo.workflowLastRun;
    result._stale_since = prevRepo._stale_since || previous.timestamp;
    carried = true;
  }
  if (current.jobCount === null && prevRepo.jobCount !== null) {
    result.jobCount = prevRepo.jobCount;
    result._stale_since = prevRepo._stale_since || previous.timestamp;
    carried = true;
  }
  if (current.lastJobsUpdate === null && prevRepo.lastJobsUpdate !== null) {
    result.lastJobsUpdate = prevRepo.lastJobsUpdate;
    result._stale_since = prevRepo._stale_since || previous.timestamp;
    carried = true;
  }
  if (carried) console.log(`  ⚠️  ${current.name}: carried forward from previous (API failure)`);
  return result;
}

function carryForwardMetric(current, previous, fieldName) {
  if (current === null && previous !== null) {
    console.log(`  ⚠️  ${fieldName}: carried forward from previous (read failure)`);
    return previous;
  }
  return current;
}

/**
 * Detect operational events by diffing current snapshot against previous.
 * Events are derived — no new data source, no race conditions.
 * Wrapped in try/catch so event detection never breaks metrics collection.
 */
function detectEvents(current, previous) {
  if (!previous) return [];
  const events = [];
  const ts = current.timestamp;

  try {
    // Pool drops/rises
    const prevTotal = previous.pipeline?.pipelineTotal;
    const currTotal = current.pipeline?.pipelineTotal;
    if (prevTotal != null && currTotal != null) {
      const delta = currTotal - prevTotal;
      const pct = prevTotal > 0 ? Math.abs(delta / prevTotal) : 0;
      if (delta < -500 || (delta < 0 && pct > 0.05)) {
        events.push({ type: 'pool_drop', severity: 'high', module: 'AGG', details: { from: prevTotal, to: currTotal, delta, pct: Math.round(pct * 100) }, timestamp: ts });
      } else if (delta > 500) {
        events.push({ type: 'pool_rise', severity: 'info', module: 'AGG', details: { from: prevTotal, to: currTotal, delta }, timestamp: ts });
      }
    }

    // Source zero / recovered
    const prevSources = previous.pipeline?.bySource || {};
    const currSources = current.pipeline?.bySource || {};
    for (const src of new Set([...Object.keys(prevSources), ...Object.keys(currSources)])) {
      const prev = prevSources[src] ?? 0;
      const curr = currSources[src] ?? 0;
      if (prev > 20 && curr === 0) {
        events.push({ type: 'source_zero', severity: 'high', module: 'AGG', source: src, details: { from: prev, to: 0 }, timestamp: ts });
      } else if (prev === 0 && curr > 0) {
        events.push({ type: 'source_recovered', severity: 'info', module: 'AGG', source: src, details: { from: 0, to: curr }, timestamp: ts });
      }
    }

    // Enrichment rate shift
    const prevEnrTotal = previous.enrichment?.totalEnriched;
    const currEnrTotal = current.enrichment?.totalEnriched;
    const prevTechUs = previous.enrichment?.totalTechUs;
    const currTechUs = current.enrichment?.totalTechUs;
    if (prevEnrTotal && currEnrTotal && prevTechUs && currTechUs) {
      const prevRate = prevEnrTotal / prevTechUs;
      const currRate = currEnrTotal / currTechUs;
      const shiftPct = prevRate > 0 ? Math.abs((currRate - prevRate) / prevRate) : 0;
      if (shiftPct > 0.05) {
        events.push({ type: 'enrichment_shift', severity: 'medium', module: 'ENR', details: { from: Math.round(prevRate * 100) / 100, to: Math.round(currRate * 100) / 100, shiftPct: Math.round(shiftPct * 100) }, timestamp: ts });
      }
    }

    // Repo workflow status transitions
    for (const [name, repo] of Object.entries(current.repos || {})) {
      const prevRepo = previous.repos?.[name];
      if (!prevRepo) continue;
      if (prevRepo.workflowStatus === 'success' && repo.workflowStatus === 'failure') {
        events.push({ type: 'repo_failure', severity: 'high', module: 'OUT', repo: name, details: { workflow: 'update-jobs' }, timestamp: ts });
      } else if (prevRepo.workflowStatus === 'failure' && repo.workflowStatus === 'success') {
        events.push({ type: 'repo_recovered', severity: 'info', module: 'OUT', repo: name, details: { workflow: 'update-jobs' }, timestamp: ts });
      }
      if (repo._stale_since && !prevRepo._stale_since) {
        events.push({ type: 'repo_stale', severity: 'medium', module: 'OUT', repo: name, details: { stale_since: repo._stale_since }, timestamp: ts });
      }
    }

    // Star milestones
    for (const [name, repo] of Object.entries(current.repos || {})) {
      const prevStars = previous.repos?.[name]?.stars;
      const currStars = repo.stars;
      if (prevStars == null || currStars == null) continue;
      const milestones = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
      for (const m of milestones) {
        if (prevStars < m && currStars >= m) {
          events.push({ type: 'star_milestone', severity: 'info', module: 'OUT', repo: name, details: { milestone: m, stars: currStars }, timestamp: ts });
        }
      }
    }
  } catch (err) {
    console.warn('  ⚠️  Event detection error (non-fatal):', err.message);
  }

  return events;
}

async function main() {
  console.log('🔍 Collecting metrics...');

  if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });

  const previous = loadPreviousSnapshot();

  const pipeline = getPipelineMetrics();
  console.log(`  Pipeline: ${pipeline?.pipelineTotal ?? 'n/a'} jobs total`);

  const stars = getStarCounts();
  const enrichment = getEnrichmentStats();
  const traffic = getTrafficData();

  // Carry forward pipeline/enrichment/traffic on read failure
  const prevPipeline = previous?.pipeline ?? null;
  const prevEnrichment = previous?.enrichment ?? null;
  const prevTraffic = previous?.traffic ?? null;
  const safePipeline = pipeline ?? carryForwardMetric(pipeline, prevPipeline, 'pipeline');
  const safeEnrichment = enrichment ?? carryForwardMetric(enrichment, prevEnrichment, 'enrichment');
  const safeTraffic = traffic ?? carryForwardMetric(traffic, prevTraffic, 'traffic');
  if (safeEnrichment) console.log(`  Enrichment: ${safeEnrichment.totalEnriched} enriched / ${safeEnrichment.totalHasDescription} have description`);
  if (safeTraffic) console.log(`  Traffic: ${safeTraffic.totalViews} views, ${safeTraffic.totalUniques} uniques, top referrer: ${safeTraffic.topReferrers[0]?.referrer || 'none'}`);

  console.log('  Fetching per-repo data...');
  const repoResults = await Promise.all(REPOS.map(getRepoMetrics));

  const mergedResults = repoResults.map(r => previous ? mergeWithPrevious(r, previous) : r);

  const repos = {};
  let operationalCount = 0, failedCount = 0;
  for (const r of mergedResults) {
    repos[r.name] = r;
    if (r.workflowStatus === 'success') operationalCount++;
    if (r.workflowStatus === 'failure') failedCount++;
    const jobStr = r.jobCount !== null ? `${r.jobCount} jobs` : 'n/a (by design)';
    const wfStr = r.workflowStatus || 'unknown';
    const staleTag = r._stale_since ? ' (stale)' : '';
    const emoji = r.workflowStatus === 'success' ? '✅' : r.workflowStatus === 'failure' ? '❌' : '⚠️';
    console.log(`  ${emoji} ${r.name}: ${jobStr}, workflow=${wfStr}${staleTag}`);
  }

  const growth = computeGrowthTrends(safePipeline);
  if (growth) {
    const sign = growth.total_delta >= 0 ? '+' : '';
    console.log(`  Week-over-week: ${sign}${growth.total_delta} jobs (${sign}${growth.total_delta_pct}%) vs ${growth.compared_to}`);
  }

  // Merge star counts into repo entries
  if (stars) {
    for (const [name, count] of Object.entries(stars)) {
      if (repos[name]) repos[name].stars = count;
    }
  }

  const snapshot_timestamp = new Date().toISOString();
  const detectedEvents = detectEvents({ pipeline: safePipeline, repos, enrichment: safeEnrichment, traffic: safeTraffic, timestamp: snapshot_timestamp }, previous);
  if (detectedEvents.length > 0) {
    console.log(`  📋 ${detectedEvents.length} event(s) detected: ${detectedEvents.map(e => e.type).join(', ')}`);
  }

  // INF-OBSERV-10: Surface stale carry-forward entries (>24h)
  const staleWarnings = [];
  const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  for (const [name, repo] of Object.entries(repos)) {
    if (repo._stale_since) {
      const staleMs = new Date(snapshot_timestamp) - new Date(repo._stale_since);
      if (staleMs > STALE_TTL_MS) {
        staleWarnings.push({
          repo: name,
          stale_since: repo._stale_since,
          stale_hours: Math.round(staleMs / 3600000 * 10) / 10,
          fields: [
            repo.workflowStatus === null ? 'workflowStatus' : null,
            repo.jobCount === null ? 'jobCount' : null,
            repo.lastJobsUpdate === null ? 'lastJobsUpdate' : null,
          ].filter(Boolean),
        });
      }
    }
  }
  if (staleWarnings.length > 0) {
    console.log(`  ⚠️  ${staleWarnings.length} repo(s) stale >24h: ${staleWarnings.map(w => w.repo + ' (' + w.stale_hours + 'h)').join(', ')}`);
  }

  const snapshot = {
    timestamp: snapshot_timestamp,
    pipeline: safePipeline,
    repos,
    enrichment: safeEnrichment,
    traffic: safeTraffic,
    summary: { operationalRepos: operationalCount, failedRepos: failedCount },
    growth,
    events: detectedEvents.length > 0 ? detectedEvents : undefined,
    stale_warnings: staleWarnings.length > 0 ? staleWarnings : undefined,
  };

  fs.writeFileSync(LATEST_FILE, JSON.stringify(snapshot, null, 2) + '\n');
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(snapshot) + '\n');

  console.log(`\n✅ latest.json written, history.jsonl appended`);
  if (failedCount > 0) console.log(`⚠️  ${failedCount} repo(s) reporting workflow failure`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
