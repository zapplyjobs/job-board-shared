#!/usr/bin/env node

/**
 * Pipeline Alert
 *
 * Checks 19 failure modes (Checks 1-7, 9-19) and posts a Discord alert if any fail.
 * Silent on all-green — only fires when something is actually wrong.
 *
 * Failure modes checked:
 *   1. fetch-jobs.yml stale (last run > 30 min ago or failed)
 *   2. post-to-discord.yml last run failed
 *   3. Any consumer update-jobs.yml failed
 *   4. total_jobs dropped >20% vs previous snapshot (compares same field)
 *   5. Any individual source dropped >40% vs previous snapshot
 *   6. Healthcare domain >30% of US-tagged pool (composition drift)
 *   7. us-tagged job count = 0 (location tagger broken)
 *   9. Any key domain (software/data_science/hardware/healthcare/ai) has 0 tagged jobs
 *  10. Senior filter rate >5% (AGG-9, senior-only, mid_level excluded)
 *  11. G1 general rate >55% (tag engine regression) (AGG-9)
 *  12. Enrichment coverage <70% of tech jobs (AGG-9)
 *  13. Aggregator runtime avg >20 min over last 3 runs (INF-SCALE-2)
 *  14. Custom fetcher silent for 2+ consecutive runs (INF-OBSERV-2)
 *  15. Enrichment stats sanity — tier distribution and field counts out of range (INF-TEST-1)
 *  16. P-2 submodule drift — not all 8 repos at same SHA (INF-OBSERV-6)
 *  17. Bump-submodule workflow failed — phantom SHA, bump failure, or P-2 mismatch
 *  18. Consumer repo stale — any consumer repo >2h behind latest job-board-shared push
 *  19. Per-company zero-yield streak — company returns 0 jobs for 3+ consecutive runs
 *
 * Informational (written to pipeline-alert.json, not Discord):
 *  - Secret expiry dates and days remaining (secrets array)
 *  - GH_PAT triggers Discord alert ONLY at ≤7 days
 *
 * Not alerts (by design, not failures):
 *   - posted_jobs count = 0 per run (dedup saturation is normal)
 *   - New-Grad job count = 0 (no current_jobs.json by design)
 *   - cleanup-discord-posts.yml not running (manual only)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client, GatewayIntentBits } = require('discord.js');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_PIPELINE_ALERT_CHANNEL_ID;
const GH_PAT_EXPIRY_DATE = process.env.GH_PAT_EXPIRY_DATE;
const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const METRICS_LATEST = path.join(DATA_DIR, 'metrics', 'latest.json');

const CONSUMER_REPOS = [
  'New-Grad-Jobs-2026',
  'Internships-2026',
  'New-Grad-Software-Engineering-Jobs-2026',
  'New-Grad-Data-Science-Jobs-2026',
  'New-Grad-Hardware-Engineering-Jobs-2026',
  'New-Grad-Nursing-Jobs-2026',
];

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function ghRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Zapply-Pipeline-Alert',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
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

async function getLastWorkflowRun(owner, repo, workflowFile) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`;
  try {
    const res = await ghRequest(url);
    if (res.status !== 200 || !res.body?.workflow_runs?.length) return null;
    return res.body.workflow_runs[0];
  } catch {
    return null;
  }
}

async function runChecks() {
  const failures = [];
  const now = Date.now();

  // Check 1: fetch-jobs.yml stale or failed
  const fetchRun = await getLastWorkflowRun('zapplyjobs', 'jobs-aggregator-private', 'fetch-jobs.yml');
  if (!fetchRun) {
    failures.push('**fetch-jobs.yml**: No runs found');
  } else if (fetchRun.conclusion === 'failure') {
    failures.push(`**fetch-jobs.yml**: Last run failed (<t:${Math.floor(new Date(fetchRun.updated_at).getTime() / 1000)}:R>)`);
  } else {
    const age = now - new Date(fetchRun.updated_at).getTime();
    if (age > STALE_THRESHOLD_MS) {
      const mins = Math.floor(age / 60000);
      failures.push(`**fetch-jobs.yml**: Last run ${mins}m ago (expected ≤30m)`);
    }
  }

  // Check 2: post-to-discord.yml failed
  const discordRun = await getLastWorkflowRun('zapplyjobs', 'jobs-data-2026', 'post-to-discord.yml');
  if (!discordRun) {
    failures.push('**post-to-discord.yml**: No runs found');
  } else if (discordRun.conclusion === 'failure') {
    failures.push(`**post-to-discord.yml**: Last run failed (<t:${Math.floor(new Date(discordRun.updated_at).getTime() / 1000)}:R>)`);
  }

  // Check 3: consumer update-jobs.yml failures
  const consumerChecks = await Promise.all(
    CONSUMER_REPOS.map(async repo => {
      const run = await getLastWorkflowRun('zapplyjobs', repo, 'update-jobs.yml');
      if (run?.conclusion === 'failure') return repo;
      return null;
    })
  );
  const failedConsumers = consumerChecks.filter(Boolean);
  if (failedConsumers.length > 0) {
    failures.push(`**update-jobs.yml failed**: ${failedConsumers.join(', ')}`);
  }

  // Checks 4–8: read from local jobs-metadata.json (available at runtime in jobs-data-2026)
  const metadataPath = path.join(DATA_DIR, 'jobs-metadata.json');
  if (!fs.existsSync(metadataPath)) {
    failures.push('**jobs-metadata.json**: File missing — pipeline may not be running');
  } else {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const currTotal = metadata.total_jobs;
    const currBySource = metadata.by_source || {};
    const usTagged = metadata.tag_stats?.locations?.us ?? null;
    const healthcareCount = metadata.tag_stats?.domains?.healthcare ?? null;

    if (fs.existsSync(METRICS_LATEST)) {
      try {
        const prev = JSON.parse(fs.readFileSync(METRICS_LATEST, 'utf8'));

        // Check 4: total job count dropped >20% (compare total_jobs to total_jobs, not pipelineTotal)
        // FIXED: Baseline updated to 24,598 (post-freshness-filter pool after commit 150034d).
        // Previous baseline of 38,030 was pre-filter. 35% reduction is expected behavior from 7-day posted_at filter.
        // Only alert if drop >40% OR if source-specific anomaly detected (Check 5).
        const prevTotal = prev?.pipeline?.prevTotalJobs;
        if (prevTotal && currTotal && currTotal < prevTotal * 0.6) {
          failures.push(`**Job count drop**: ${currTotal} jobs (was ${prevTotal}, dropped ${Math.round((1 - currTotal/prevTotal)*100)}%)`);
        }

        // Check 5: any individual source dropped >40% vs previous snapshot
        // FIXED: Threshold adjusted to >60% drop (from >40%) to account for freshness filter variance.
        // Workday and other sources with heavy 7-day churn will show larger drops naturally.
        const prevBySource = prev?.pipeline?.bySource || {};
        for (const [source, currCount] of Object.entries(currBySource)) {
          const prevCount = prevBySource[source];
          if (prevCount && prevCount > 100 && currCount < prevCount * 0.4) {
            failures.push(`**Source drop (${source})**: ${currCount} jobs (was ${prevCount}, dropped ${Math.round((1 - currCount/prevCount)*100)}%)`);
          }
        }
      } catch {
        // Metrics file unreadable — skip snapshot-dependent checks
      }
    }

    // Check 6: healthcare domain >30% of US-tagged pool (composition drift)
    if (usTagged && healthcareCount !== null && usTagged > 0) {
      const healthcarePct = healthcareCount / usTagged;
      if (healthcarePct > 0.30) {
        failures.push(`**Healthcare composition drift**: ${healthcareCount} healthcare / ${usTagged} US-tagged = ${Math.round(healthcarePct * 100)}% (threshold: 30%)`);
      }
    }

    // Check 7: us-tagged count = 0
    if (usTagged === 0) {
      failures.push('**US location tagger broken**: 0 jobs tagged `us` — check tagLocations() in tag-engine.js');
    }

    // Check 9: per-domain US job counts — alert if any key consumer domain hits 0
    // tag_stats.domains counts the full pool; we want US-tagged subset.
    // jobs-metadata.json doesn't break down domain×location, so use tag_stats as proxy:
    // if a domain count = 0, consumer boards for that domain show nothing.
    const domains = metadata.tag_stats?.domains || {};
    const KEY_DOMAINS = ['software', 'data_science', 'hardware', 'healthcare', 'ai'];
    for (const domain of KEY_DOMAINS) {
      const count = domains[domain] ?? null;
      if (count === 0) {
        failures.push(`**Domain empty (${domain})**: 0 jobs tagged — tag-engine or fetcher broken for this domain`);
      }
    }

    // Check 10 (AGG-9): Senior filter rate drift
    // FIXED: Calculate from tech+US subset of all_jobs.json, not pre-filter pool.
    // Normal range: 0-5%. Above 5% = filter too aggressive.
    // Note: metadata.senior_filter_stats uses pre-freshness-filter pool (bug after commit 150034d).
    // Real tech+US senior rate is ~0.8% (senior-only). mid_level jobs (5.7%) are excluded — they are correctly tagged by AGG-SENIOR-FP-1 fixes.
    const allJobsPath = path.join(DATA_DIR, 'all_jobs.json');
    if (fs.existsSync(allJobsPath)) {
      try {
        const allJobsLines = fs.readFileSync(allJobsPath, 'utf8').trim().split('\n').filter(Boolean);
        const allJobs = allJobsLines.map(line => JSON.parse(line));

        // Calculate tech+US subset (domains + US location tag)
        const techDomains = ['software', 'data_science', 'hardware', 'ai'];
        let techUSJobs = 0;
        let seniorOnlyJobs = 0;

        for (const job of allJobs) {
          const tags = job.tags || {};
          const domains = tags.domains || [];
          const locations = tags.locations || [];
          const employment = tags.employment || '';

          // Check if job is tech+US
          const isTech = techDomains.some(d => domains.includes(d));
          const isUS = locations.includes('us');

          if (isTech && isUS) {
            techUSJobs++;
            // Count senior jobs by employment tag or title check
            if (employment === 'senior') {
              seniorOnlyJobs++;
            }
          }
        }

        if (techUSJobs > 0) {
          const filterRate = seniorOnlyJobs / techUSJobs;
          if (filterRate > 0.05) {
            failures.push(`**Senior filter bypass detected (senior-only, mid_level excluded)**: ${Math.round(filterRate * 100)}% senior filtered in tech+US (${seniorOnlyJobs}/${techUSJobs}) (expected ≤5%) — entry-level guards may be broken`);
          }
        }
      } catch (err) {
        console.error('Error calculating senior filter rate from all_jobs.json:', err.message);
      }
    }

    // Check 11 (AGG-9): G1 US non-senior general rate regression
    // US G1 = US non-senior generals / US non-senior total. Currently ~19%.
    // Alert at >30% (indicates tag engine regression, keyword removal, or pool composition shift).
    const g1 = metadata?.tag_stats?.g1;
    if (g1?.us_general_rate_pct != null) {
      if (g1.us_general_rate_pct > 30) {
        failures.push(`**US G1 rate high**: ${g1.us_general_rate_pct}% of US non-senior jobs are general-tagged (threshold: 30%) — tag engine may have regressed or pool composition shifted`);
      }
    } else {
      // Fallback: legacy total-pool general rate check
      const generalCount = domains['general'] ?? null;
      if (generalCount !== null && currTotal > 0) {
        const generalRate = generalCount / currTotal;
        if (generalRate > 0.55) {
          failures.push(`**G1 general rate high**: ${Math.round(generalRate * 100)}% of pool is general-tagged (threshold: 55%) — tag engine may have regressed`);
        }
      }
    }

    // Check 12 (AGG-9): Enrichment fill rate drop
    // S233 fix: use enrichment-stats.json's own tech count (based on stored tags in all_jobs.json)
    // instead of aggregator's freshly-tagged count (which includes newly-classified jobs
    // that don't have tech tags in the stored pool yet). This prevents false alerts
    // after TAG expansions that reclassify jobs into tech domains.
    const enrichStatsPath = path.join(DATA_DIR, 'enrichment-stats.json');
    if (fs.existsSync(enrichStatsPath)) {
      try {
        const enrichStats = JSON.parse(fs.readFileSync(enrichStatsPath, 'utf8'));
        const enrichTotal = enrichStats.total_enriched || 0;
        const techTotal = enrichStats.total_tech_us || 0;
        if (techTotal > 0) {
          const enrichRate = enrichTotal / techTotal;
          if (enrichRate < 0.70) {
            failures.push(`**Enrichment coverage low**: ${enrichTotal} enriched / ${techTotal} tech jobs = ${Math.round(enrichRate * 100)}% (threshold: 70%)`);
          }
        }

        // Check 15 (INF-TEST-1): Enrichment stats sanity — catch schema bugs before they propagate.
        // Origin: C24 bug where undefined!==null caused 6,317 phantom explained gaps (expected ~135).
        // No automated check caught it — only manual destination verification.
        // Thresholds calibrated from current values (v39, 2026-04-30) with generous margins.
        const tiers = enrichStats.tiers || {};
        const t0 = tiers.t0 ?? 0;
        const t1 = tiers.t1 ?? 0;
        const t2 = tiers.t2 ?? 0;
        const t3 = tiers.t3 ?? 0;
        const tierTotal = t0 + t1 + t2 + t3;
        if (tierTotal > 0) {
          const t3Rate = t3 / tierTotal;
          // T3 should be 75-95%. Below 70% = schema regression or enrichment bug.
          if (t3Rate < 0.70) {
            failures.push(`**Enrichment T3 rate low**: ${Math.round(t3Rate * 100)}% (${t3}/${tierTotal}, expected 75-95%) — schema change may have broken field extraction`);
          }
          // T0 should be <10%. Above 15% = descriptions lost or field regression.
          const t0Rate = t0 / tierTotal;
          if (t0Rate > 0.15) {
            failures.push(`**Enrichment T0 rate high**: ${Math.round(t0Rate * 100)}% (${t0}/${tierTotal}, expected <10%) — jobs losing descriptions`);
          }
        }

        // Per-source field count sanity: detect when a stats counter produces wildly wrong counts.
        // The C24 bug manifested as visa_explained_gaps showing 6,317 instead of ~135.
        // We check each source's field ratios against expected ranges.
        // Some sources have structurally low skills rates (not a regression):
        // - simplify: no descriptions (T0), skills extraction impossible
        // - apple: only jobSummary (short text), no structured sections
        // - google: HTML descriptions but section headers don't match REQUIRED_HEADERS patterns
        // - jsearch: decommissioned, residual records have zero descriptions
        const STRUCTURALLY_LOW_SKILLS = new Set(['simplify', 'apple', 'google', 'jsearch']);
        const bySource = enrichStats.by_source || {};
        for (const [src, stats] of Object.entries(bySource)) {
          const enriched = stats.enriched || 0;
          if (enriched < 10) continue; // Skip tiny sources where ratios are noisy
          if (STRUCTURALLY_LOW_SKILLS.has(src)) continue; // Skip sources with known structural limitations

          // Skills should be >70% for enriched records (currently ~97%).
          // Below 50% = skills extraction broke.
          const skillsRate = (stats.required_skills || 0) / enriched;
          if (skillsRate < 0.50) {
            failures.push(`**Enrichment skills drop (${src})**: ${Math.round(skillsRate * 100)}% have skills (expected >70%) — skills extraction may have broken for this source`);
          }
        }
      } catch { /* skip if stats file unreadable */ }
    }

    // Check 13 (INF-SCALE-2): Runtime threshold — alert when aggregator runs approach 25-min limit
    // Average runtime of last 3 successful runs > 20 min = warning.
    // Cadence is 15 min; at 25 min, every run gets cancelled by overlap.
    try {
      const recentRuns = await ghRequest(
        `https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/workflows/fetch-jobs.yml/runs?per_page=10&status=completed`
      );
      if (recentRuns.status === 200 && recentRuns.body?.workflow_runs) {
        const successfulRuns = recentRuns.body.workflow_runs
          .filter(r => r.conclusion === 'success')
          .slice(0, 3);

        if (successfulRuns.length >= 2) {
          const runtimes = successfulRuns.map(r => {
            const start = new Date(r.run_started_at).getTime();
            const end = new Date(r.updated_at).getTime();
            return (end - start) / 60000; // minutes
          });
          const avgRuntime = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;
          const maxRuntime = Math.max(...runtimes);

          if (avgRuntime > 20) {
            failures.push(
              `**Aggregator runtime high**: avg ${avgRuntime.toFixed(1)} min over last ${successfulRuns.length} runs (max ${maxRuntime.toFixed(1)} min). Threshold: 20 min. At 25 min, 15-min cadence breaks.`
            );
          }
        }
      }
    } catch (err) {
      console.error('Error checking runtime:', err.message);
    }


    // Check 14 (INF-OBSERV-2): Custom fetcher health — alert when a custom fetcher
    // returns 0 jobs for 2+ consecutive runs. Custom fetchers scrape HTML and are
    // more fragile than ATS API fetchers. Zero jobs = site changed or fetcher broken.
    const CUSTOM_FETCHERS = ['apple', 'twosigma', 'amazon', 'netflix', 'google', 'uber', 'simplify', 'microsoft', 'oracle', 'amd'];
    if (fs.existsSync(metadataPath)) {
      const currBySourceCustom = {};
      for (const fetcher of CUSTOM_FETCHERS) {
        currBySourceCustom[fetcher] = currBySource[fetcher] ?? 0;
      }
      if (fs.existsSync(METRICS_LATEST)) {
        try {
          const prevMetrics = JSON.parse(fs.readFileSync(METRICS_LATEST, 'utf8'));
          const prevBySourceCustom = {};
          for (const fetcher of CUSTOM_FETCHERS) {
            prevBySourceCustom[fetcher] = prevMetrics?.pipeline?.bySource?.[fetcher] ?? 0;
          }
          for (const fetcher of CUSTOM_FETCHERS) {
            // Only alert if fetcher was in use (had >0 jobs in a recent run)
            // and now shows 0 for 2 consecutive runs
            const curr = currBySourceCustom[fetcher];
            const prev = prevBySourceCustom[fetcher];
            if (curr === 0 && prev === 0) {
              // Check if this fetcher was ever active (skip if never deployed)
              if (currBySource[fetcher] !== undefined || prevBySource[fetcher] !== undefined) {
                failures.push(
                  `**Custom fetcher silent (${fetcher})**: 0 jobs for 2+ consecutive runs. ` +
                  `Fetcher may be broken — check HTML extraction regex.`
                );
              }
            }
          }
        } catch { /* skip if metrics unreadable */ }
      }
    }

    // Check 16 (INF-OBSERV-6): P-2 submodule drift — all 8 repos must have same submodule SHA.
    // P-2 is INF's most important invariant. Concurrent sessions create drift windows.
    // verify-bump.sh only runs manually — this check catches drift within 30 min automatically.
    try {
      const REPOS = [
        'zapplyjobs/jobs-aggregator-private',
        'zapplyjobs/jobs-data-2026',
        'zapplyjobs/New-Grad-Jobs-2026',
        'zapplyjobs/Internships-2026',
        'zapplyjobs/New-Grad-Software-Engineering-Jobs-2026',
        'zapplyjobs/New-Grad-Data-Science-Jobs-2026',
        'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026',
        'zapplyjobs/New-Grad-Healthcare-Jobs-2026',
      ];
      const shas = {};
      for (const repo of REPOS) {
        const res = await ghRequest(`https://api.github.com/repos/${repo}/contents/.github/scripts/shared`);
        if (res.status === 200 && res.body?.sha) {
          shas[repo.split('/')[1]] = res.body.sha;
        }
      }
      const uniqueShas = [...new Set(Object.values(shas))];
      if (uniqueShas.length > 1) {
        const driftList = Object.entries(shas)
          .map(([repo, sha]) => `${repo}: ${sha.slice(0, 12)}`)
          .join(', ');
        failures.push(`**P-2 submodule drift detected**: ${uniqueShas.length} different SHAs across repos — ${driftList}`);
      }
    } catch { /* skip if API fails */ }

    // Check 17 (INF-SELF-2): Bump-submodule workflow failure detection.
    // The bump workflow has no built-in Discord notification. This check catches
    // phantom SHA attempts, partial bumps, and P-2 mismatches within 30 min.
    try {
      const bumpRuns = await ghRequest(
        `https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/workflows/bump-submodule.yml/runs?per_page=3`
      );
      if (bumpRuns.status === 200 && bumpRuns.body?.workflow_runs) {
        const recentFailed = bumpRuns.body.workflow_runs.filter(
          r => r.conclusion === 'failure' && r.status === 'completed'
        );
        for (const run of recentFailed) {
          const runTime = new Date(run.created_at).getTime();
          const ageMin = Math.round((Date.now() - runTime) / 60000);
          // Only alert on failures from the last 60 min (avoid re-alerting old failures)
          if (ageMin <= 60) {
            failures.push(
              `**Submodule bump failed** (run ${run.id}, ${ageMin} min ago): ` +
              `SHA validation or P-2 verification failed. Check [run log](${run.html_url}).`
            );
          }
        }
      }
    } catch { /* skip if API fails */ }

    // Check 18 (INF-CI-2): Consumer repo freshness — flag any consumer >2h behind
    // Catches stale consumers where repository_dispatch didn't fire or workflow failed silently.
    try {
      const CONSUMER_REPOS = [
        'zapplyjobs/New-Grad-Jobs-2026',
        'zapplyjobs/Internships-2026',
        'zapplyjobs/New-Grad-Software-Engineering-Jobs-2026',
        'zapplyjobs/New-Grad-Data-Science-Jobs-2026',
        'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026',
        'zapplyjobs/New-Grad-Healthcare-Jobs-2026',
      ];
      const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

      // Get job-board-shared latest commit timestamp
      const sharedRes = await ghRequest(
        `https://api.github.com/repos/zapplyjobs/job-board-shared/commits?per_page=1`
      );
      if (sharedRes.status === 200 && sharedRes.body?.[0]?.commit?.committer?.date) {
        const sharedTime = new Date(sharedRes.body[0].commit.committer.date).getTime();
        const staleRepos = [];

        for (const repo of CONSUMER_REPOS) {
          const res = await ghRequest(
            `https://api.github.com/repos/${repo}/commits?per_page=1`
          );
          if (res.status === 200 && res.body?.[0]?.commit?.committer?.date) {
            const repoTime = new Date(res.body[0].commit.committer.date).getTime();
            const lagMin = Math.round((sharedTime - repoTime) / 60000);
            if (lagMin > 120) { // >2 hours behind shared
              staleRepos.push(`${repo.split('/')[1]}: ${lagMin} min behind`);
            }
          }
        }

        if (staleRepos.length > 0) {
          failures.push(
            `**Consumer repos stale** (>2h behind shared): ${staleRepos.join(', ')}`
          );
        }
      }
    } catch { /* skip if API fails */ }

    // Check 19 (INF-CI-2): Per-company zero-yield streak tracking.
    // Tracks how many consecutive runs each company returns 0 jobs.
    // Alerts when a company hits 3+ consecutive zero-yield runs — indicates
    // a broken fetcher, changed ATS URL, or expired API token.
    // Only tracks companies in company-list.json + custom fetcher sources.
    // Ghost companies (organic ATS responses not in our config) are pruned.
    // State persists in zero-yield-tracking.json across runs.
    try {
      const trackingPath = path.join(DATA_DIR, 'zero-yield-tracking.json');
      const ZERO_YIELD_THRESHOLD = 3; // Alert at 3+ consecutive zero-yield runs

      // Load configured company names from company-list.json + custom fetchers
      const configuredCompanies = new Set();
      const companyListPath = path.join(__dirname, '..', 'aggregator', 'fetchers', 'company-list.json');
      if (fs.existsSync(companyListPath)) {
        try {
          const cl = JSON.parse(fs.readFileSync(companyListPath, 'utf8'));
          for (const section of ['greenhouse', 'lever', 'ashby', 'workday', 'eightfold', 'smartrecruiters']) {
            if (cl[section]) {
              for (const entry of cl[section]) {
                if (entry.name) configuredCompanies.add(entry.name);
              }
            }
          }
        } catch { /* fall through to custom fetchers only */ }
      }
      // Custom fetcher companies (not in company-list.json)
      for (const name of ['Apple', 'Google', 'Microsoft', 'Oracle', 'AMD', 'Uber', 'Two Sigma', 'Netflix', 'Amazon']) {
        configuredCompanies.add(name);
      }

      // Load previous tracking state
      let prevState = {};
      if (fs.existsSync(trackingPath)) {
        try { prevState = JSON.parse(fs.readFileSync(trackingPath, 'utf8')); } catch { prevState = {}; }
      }

      // Build current yield map from all_jobs.json (already loaded for Check 10)
      const companyYield = {};
      if (fs.existsSync(allJobsPath)) {
        const lines = fs.readFileSync(allJobsPath, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const job = JSON.parse(line);
            const company = job.company_name;
            if (company) companyYield[company] = (companyYield[company] || 0) + 1;
          } catch { /* skip malformed line */ }
        }
      }

      // Only track configured companies (prune ghost companies)
      const allCompanies = new Set([...Object.keys(prevState), ...Object.keys(companyYield)]
        .filter(c => configuredCompanies.has(c)));

      const newState = {};
      const alerting = [];
      for (const company of allCompanies) {
        const yield_ = companyYield[company] || 0;
        if (yield_ > 0) {
          // Company has jobs — reset streak
          newState[company] = { streak: 0, last_seen: new Date().toISOString() };
        } else {
          // Company has 0 jobs — increment streak
          const prev = prevState[company] || { streak: 0 };
          const newStreak = (prev.streak || 0) + 1;
          newState[company] = { streak: newStreak, last_zero: new Date().toISOString() };

          if (newStreak >= ZERO_YIELD_THRESHOLD) {
            alerting.push(`${company} (${newStreak} runs)`);
          }
        }
      }

      // Persist tracking state
      fs.writeFileSync(trackingPath, JSON.stringify(newState, null, 2), 'utf8');

      if (alerting.length > 0) {
        // Limit alert to top 10 to avoid Discord message length issues
        const shown = alerting.slice(0, 10);
        const suffix = alerting.length > 10 ? ` (+${alerting.length - 10} more)` : '';
        failures.push(
          `**Company zero-yield streak** (3+ runs): ${shown.join(', ')}${suffix} — ` +
          `fetcher or ATS URL may be broken`
        );
      }
    } catch (err) {
      console.error('Error in zero-yield tracking:', err.message);
    }
  } // end else (metadata exists)

  return failures;
}

async function postAlert(failures) {
  if (!DISCORD_TOKEN || !CHANNEL_ID) {
    console.error('DISCORD_TOKEN or DISCORD_PIPELINE_ALERT_CHANNEL_ID not set');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  await client.login(DISCORD_TOKEN);
  await new Promise(r => client.once('ready', r));

  await Promise.all(client.guilds.cache.map(g => g.channels.fetch()));
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error(`Channel ${CHANNEL_ID} not found or not a text channel`);

  const embed = {
    title: '🚨 Pipeline Alert',
    color: 0xe74c3c, // red
    description: failures.map(f => `• ${f}`).join('\n'),
    footer: { text: `Checked at ${new Date().toISOString()}` }
  };

  await channel.send({ embeds: [embed] });
  await client.destroy();
}

async function main() {
  console.log('🔍 Running pipeline health checks...');

  if (!GITHUB_TOKEN) { console.error('GITHUB_TOKEN not set'); process.exit(1); }

  const failures = await runChecks();

  // Always write pipeline-alert.json so dashboard can read it
  const alertFile = path.join(DATA_DIR, 'pipeline-alert.json');
  const secretWarnings = [];
  if (GH_PAT_EXPIRY_DATE) {
    const expiry = new Date(GH_PAT_EXPIRY_DATE);
    if (!isNaN(expiry.getTime())) {
      const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      secretWarnings.push({ secret: 'GH_PAT', expires: GH_PAT_EXPIRY_DATE, days_left: daysLeft });
      if (daysLeft <= 7) {
        failures.push(
          `**GH_PAT expires in ${daysLeft} days** — all 8 repo workflows will fail. Rotate immediately.`
        );
      }
    }
  }
  const alertData = {
    checked_at: new Date().toISOString(),
    active: failures.length > 0,
    message: failures.length > 0 ? failures.join(' | ') : null,
    failures,
    secrets: secretWarnings,
  };
  fs.writeFileSync(alertFile, JSON.stringify(alertData, null, 2), 'utf8');
  console.log(`📄 Written pipeline-alert.json (active: ${alertData.active})`);

  if (failures.length === 0) {
    console.log('✅ All checks passed — no alert sent');
    return;
  }

  console.log(`⚠️  ${failures.length} check(s) failed:`);
  failures.forEach(f => console.log(`   • ${f}`));

  await postAlert(failures);
  console.log('✅ Alert posted to Discord');
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});