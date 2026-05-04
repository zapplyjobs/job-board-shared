#!/usr/bin/env node

/**
 * Tag Monitor - Accuracy tracking for tag engine
 *
 * Monitors tag distribution and generates accuracy reports.
 * Target: >85% accuracy (validated manually in Phase 3)
 *
 * Usage:
 *   const monitor = require('./processors/tag-monitor');
 *   const report = monitor.generateAccuracyReport(jobs);
 */

const fs = require('fs');
const path = require('path');

// Tag accuracy monitoring file
const MONITOR_FILE = path.join(process.cwd(), '.github', 'data', 'tag-monitor.json');

/**
 * Sample jobs for manual accuracy validation
 * @param {Array} jobs - All jobs
 * @param {number} sampleSize - Number of jobs to sample (default: 100)
 * @returns {Array} - Sampled jobs
 */
function sampleJobsForValidation(jobs, sampleSize = 100) {
  if (jobs.length === 0) return [];

  // Stratified sampling: ensure representation from each domain
  const sampled = [];
  const domains = ['software', 'data_science', 'hardware', 'healthcare', 'ai', 'finance', 'sales', 'operations', 'product', 'retail', 'manufacturing', 'logistics', 'marketing', 'legal', 'hr', 'general'];
  const samplesPerDomain = Math.ceil(sampleSize / domains.length);

  for (const domain of domains) {
    const domainJobs = jobs.filter(job =>
      job.tags && job.tags.domains && job.tags.domains.includes(domain)
    );

    // Random sample from this domain
    const shuffled = domainJobs.sort(() => 0.5 - Math.random());
    sampled.push(...shuffled.slice(0, samplesPerDomain));
  }

  // If we have more than needed, trim down
  return sampled.slice(0, sampleSize);
}

/**
 * Generate accuracy report with sampled jobs
 * @param {Array} jobs - All jobs
 * @returns {Object} - Accuracy report
 */
function generateAccuracyReport(jobs) {
  const sampledJobs = sampleJobsForValidation(jobs, 100);

  return {
    timestamp: new Date().toISOString(),
    total_jobs: jobs.length,
    sampled_count: sampledJobs.length,
    status: 'pending_validation', // Requires manual review
    target_accuracy: 0.85, // 85%
    samples: sampledJobs.map(job => ({
      id: job.id,
      title: job.title,
      company: job.company,
      tags: job.tags,
      // Manual validation fields (to be filled)
      validated: false,
      correct_tags: null,
      issues: []
    }))
  };
}

/**
 * Load previous monitoring data
 * @returns {Object} - Monitor data
 */
function loadMonitorData() {
  try {
    if (fs.existsSync(MONITOR_FILE)) {
      return JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8'));
    }
  } catch (error) {
    console.warn('⚠️ Error loading monitor data:', error.message);
  }

  return {
    created_at: new Date().toISOString(),
    reports: []
  };
}

/**
 * Save monitoring data
 * @param {Object} data - Monitor data
 */
function saveMonitorData(data) {
  try {
    const dir = path.dirname(MONITOR_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MONITOR_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('✅ Tag monitor data saved');
  } catch (error) {
    console.error('⚠️ Error saving monitor data:', error.message);
  }
}

/**
 * Add accuracy report to monitoring history
 * @param {Array} jobs - All jobs
 */
function recordAccuracyReport(jobs) {
  const data = loadMonitorData();
  const report = generateAccuracyReport(jobs);

  data.reports.push(report);

  // Keep only last 10 reports
  if (data.reports.length > 10) {
    data.reports = data.reports.slice(-10);
  }

  saveMonitorData(data);

  return report;
}

/**
 * Calculate tag distribution (for monitoring tag health)
 * @param {Array} jobs - All jobs
 * @returns {Object} - Tag distribution statistics
 */
function calculateTagDistribution(jobs) {
  const distribution = {
    employment: {},
    domains: {},
    locations: {},
    experience: {},
    special: {},
    total: jobs.length
  };

  jobs.forEach(job => {
    if (!job.tags) return;

    // Count employment (mutually exclusive)
    if (job.tags.employment) {
      distribution.employment[job.tags.employment] =
        (distribution.employment[job.tags.employment] || 0) + 1;
    }

    // Count domains (multi-select)
    if (job.tags.domains) {
      job.tags.domains.forEach(domain => {
        distribution.domains[domain] =
          (distribution.domains[domain] || 0) + 1;
      });
    }

    // Count locations (multi-select)
    if (job.tags.locations) {
      job.tags.locations.forEach(location => {
        distribution.locations[location] =
          (distribution.locations[location] || 0) + 1;
      });
    }

    // Count experience (mutually exclusive)
    if (job.tags.experience) {
      distribution.experience[job.tags.experience] =
        (distribution.experience[job.tags.experience] || 0) + 1;
    }

    // Count special (multi-select)
    if (job.tags.special) {
      job.tags.special.forEach(tag => {
        distribution.special[tag] =
          (distribution.special[tag] || 0) + 1;
      });
    }
  });

  return distribution;
}

/**
 * Validate tag health (check for anomalies)
 * @param {Object} distribution - Tag distribution from calculateTagDistribution
 * @returns {Array} - List of warnings
 */
function validateTagHealth(distribution) {
  const warnings = [];
  const total = distribution.total;

  // Check for low tag coverage
  const untagged = total - Object.values(distribution.employment).reduce((a, b) => a + b, 0);
  if (untagged > total * 0.05) {
    warnings.push(`${untagged} jobs (${((untagged/total)*100).toFixed(1)}%) missing employment tags`);
  }

  // Check for domain imbalance
  const domainCounts = Object.values(distribution.domains);
  const maxDomain = Math.max(...domainCounts);
  const minDomain = Math.min(...domainCounts);
  if (maxDomain > minDomain * 10) {
    warnings.push(`Domain imbalance: max ${maxDomain} vs min ${minDomain} jobs`);
  }

  // Check for low remote tag coverage
  const remoteJobs = distribution.locations.remote || 0;
  if (remoteJobs < total * 0.1) {
    warnings.push(`Only ${remoteJobs} (${((remoteJobs/total)*100).toFixed(1)}%) jobs tagged as remote`);
  }

  return warnings;
}

/**
 * Print tag distribution summary
 * @param {Array} jobs - All jobs
 */
function printTagDistribution(jobs) {
  const distribution = calculateTagDistribution(jobs);
  const warnings = validateTagHealth(distribution);

  console.log('');
  console.log('📊 Tag Distribution Summary:');
  console.log('━'.repeat(60));

  // Employment tags
  console.log('Employment:');
  for (const [tag, count] of Object.entries(distribution.employment)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Domain tags
  console.log('Domains:');
  for (const [tag, count] of Object.entries(distribution.domains)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Location tags
  console.log('Locations:');
  for (const [tag, count] of Object.entries(distribution.locations)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Warnings
  if (warnings.length > 0) {
    console.log('');
    console.log('⚠️ Health Warnings:');
    warnings.forEach(w => console.log(`  - ${w}`));
  }

  console.log('');
}

/**
 * Check pipeline-code drift for domain tags.
 * Samples US jobs, re-runs tagDomains() on title-only, compares to pipeline tags.
 * Pipeline tags may include carry-forward from description fallback; fresh tags won't.
 * High drift means many jobs have stale tags from prior pipeline runs.
 *
 * TAG-AUDIT-4: Drift detection — flag if >5% drift.
 *
 * @param {Array} jobs - Full pool of tagged jobs (post-merge)
 * @param {Function} tagDomainsFn - tag-engine's tagDomains function
 * @param {number} sampleSize - Jobs to sample (default: 500)
 * @returns {Object} - Drift report
 */
function checkTagDrift(jobs, tagDomainsFn, sampleSize = 500) {
  const usJobs = jobs.filter(j => j.locations && j.locations.includes('us'));
  if (usJobs.length === 0) return { drift_rate: 0, sample_size: 0, drifted: 0, warnings: [] };

  // Sample jobs (deterministic shuffle using job id for reproducibility)
  const sorted = [...usJobs].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const step = Math.max(1, Math.floor(sorted.length / sampleSize));
  const sampled = [];
  for (let i = 0; i < sorted.length && sampled.length < sampleSize; i += step) {
    sampled.push(sorted[i]);
  }

  let drifted = 0;
  const driftDetails = { domain_changed: 0, employment_changed: 0 };
  const examples = [];

  for (const job of sampled) {
    const freshTags = tagDomainsFn(job);
    const pipelineDomains = (job.tags && job.tags.domains) || [];
    const freshDomains = freshTags || [];

    // Compare domain tags (sorted for stable comparison)
    const pd = [...pipelineDomains].sort().join(',');
    const fd = [...freshDomains].sort().join(',');

    if (pd !== fd) {
      drifted++;
      driftDetails.domain_changed++;
      if (examples.length < 5) {
        examples.push({
          title: (job.title || '').substring(0, 60),
          pipeline: pipelineDomains,
          fresh: freshDomains,
        });
      }
    }
  }

  const driftRate = sampled.length > 0 ? drifted / sampled.length : 0;
  const warnings = [];
  const DRIFT_THRESHOLD = 0.05;
  if (driftRate > DRIFT_THRESHOLD) {
    warnings.push(`Drift rate ${(driftRate * 100).toFixed(1)}% exceeds ${(DRIFT_THRESHOLD * 100)}% threshold (${drifted}/${sampled.length} jobs)`);
  }

  return {
    drift_rate: driftRate,
    drift_pct: (driftRate * 100).toFixed(1) + '%',
    sample_size: sampled.length,
    drifted,
    details: driftDetails,
    examples,
    warnings,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Print drift report to console
 * @param {Object} report - Drift report from checkTagDrift
 */
function printDriftReport(report) {
  console.log('');
  console.log('🔍 Tag Drift Detection (TAG-AUDIT-4):');
  console.log('━'.repeat(60));
  console.log(`  Sample: ${report.sample_size} jobs`);
  console.log(`  Drifted: ${report.drifted} (${report.drift_pct})`);
  console.log(`  Domain changes: ${report.details.domain_changed}`);
  if (report.examples.length > 0) {
    console.log('  Examples:');
    for (const ex of report.examples) {
      console.log(`    "${ex.title}"`);
      console.log(`      Pipeline: ${ex.pipeline.join(', ')} → Fresh: ${ex.fresh.join(', ')}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log('  ⚠️  WARNINGS:');
    for (const w of report.warnings) {
      console.log(`    - ${w}`);
    }
  } else {
    console.log('  ✅ Drift within threshold');
  }
  console.log('');
}

/**
 * Check per-domain precision for consumer-facing domains.
 * Detects common FP patterns: non-SWE titles in software, supply chain in HW,
 * sales in healthcare, staffing in senior, etc.
 *
 * TAG-AUDIT-5: Automated precision spot-check.
 *
 * @param {Array} jobs - Full pool of tagged jobs (post-merge)
 * @param {number} threshold - FP rate threshold (default: 0.03 = 3%)
 * @returns {Object} - Precision report per domain
 */
function checkDomainPrecision(jobs, threshold = 0.03) {
  const usJobs = jobs.filter(j => j.locations && j.locations.includes('us'));

  // Consumer-facing domains with their FP detection rules
  // Updated TAG-AUDIT-8: added regression patterns for B7-B15 fixes
  const domainChecks = {
    software: {
      label: 'Software',
      jobs: usJobs.filter(j => j.tags && j.tags.domains && j.tags.domains.includes('software')),
      fpPatterns: [
        { pattern: /\b(supply chain|procurement|warehouse|shipping|receiving|inventory)\b/i, reason: 'supply chain/logistics' },
        { pattern: /\b(scrum master|agile coach)\b/i, reason: 'agile process (not SWE)' },
        { pattern: /\b(training program manager|people program|material program|associate program manager)\b/i, reason: 'non-tech PM' },
        { pattern: /\btechnical writer\b/i, reason: 'documentation (not SWE)' },
        { pattern: /\b(it support|help desk|service desk)\b/i, reason: 'IT support (not SWE)' },
        { pattern: /\bstaffing\b/i, reason: 'staffing (not senior)' },
        // Regression patterns (TAG-PRECISION-4/5/8): detect if removed keywords re-appear
        { pattern: /\b(project engineer).*(hvac|controls|electrical|automation|power|weapons|infrastructure|fire protection|commissioning|construction|piping)\b/i, reason: 'non-SWE project engineer regression' },
        { pattern: /\bsystems analyst\b(?!.*(?:engineer|developer|architect|software))\b/i, reason: 'non-SWE systems analyst regression' },
      ],
    },
    hardware: {
      label: 'Hardware',
      jobs: usJobs.filter(j => j.tags && j.tags.domains && j.tags.domains.includes('hardware')),
      fpPatterns: [
        { pattern: /\b(supply chain|procurement|warehouse)\b/i, reason: 'supply chain/logistics' },
        { pattern: /\b(quality engineer|quality assurance).*(supply chain|food|safety)\b/i, reason: 'quality/safety (not HW eng)' },
        // Regression pattern (TAG-PRECISION-7): service technician should be filtered
        { pattern: /\bservice technician\b/i, reason: 'service technician regression (not HW eng)' },
      ],
    },
    healthcare: {
      label: 'Healthcare',
      jobs: usJobs.filter(j => j.tags && j.tags.domains && j.tags.domains.includes('healthcare')),
      fpPatterns: [
        { pattern: /\b(sales|territory|account manager).*(oncology|cardiovascular|pharma)/i, reason: 'pharma sales (not clinical)' },
        { pattern: /\b(oncology|cardiovascular).*(sales|territory|account)/i, reason: 'pharma sales (not clinical)' },
        // Regression pattern (TAG-PRECISION-9/10): research associate / chemist in non-clinical context
        { pattern: /\b(research associate)\b.*\b(equity|investment|crypto|strategy|creator)\b/i, reason: 'non-clinical research associate regression' },
      ],
    },
  };

  const report = { domains: {}, warnings: [], timestamp: new Date().toISOString() };

  for (const [domain, check] of Object.entries(domainChecks)) {
    const total = check.jobs.length;
    if (total === 0) continue;

    const fps = [];
    for (const job of check.jobs) {
      const title = job.title || '';
      for (const { pattern, reason } of check.fpPatterns) {
        if (pattern.test(title)) {
          fps.push({ title: title.substring(0, 60), company: job.company_name || job.company || '', reason });
          break; // One FP flag per job
        }
      }
    }

    const fpRate = fps.length / total;
    const domainReport = {
      label: check.label,
      total,
      fps: fps.length,
      fp_rate: fpRate,
      fp_pct: (fpRate * 100).toFixed(2) + '%',
      examples: fps.slice(0, 5),
    };

    report.domains[domain] = domainReport;

    if (fpRate > threshold) {
      report.warnings.push(
        `${check.label}: ${(fpRate * 100).toFixed(2)}% FP rate exceeds ${(threshold * 100)}% threshold (${fps.length}/${total} jobs)`
      );
    }
  }

  return report;
}

/**
 * Print precision report to console
 * @param {Object} report - Precision report from checkDomainPrecision
 */
function printPrecisionReport(report) {
  console.log('');
  console.log('🎯 Domain Precision Check (TAG-AUDIT-5):');
  console.log('━'.repeat(60));
  for (const [domain, dr] of Object.entries(report.domains)) {
    const status = parseFloat(dr.fp_pct) > 3 ? '⚠️ ' : '✅';
    console.log(`  ${status} ${dr.label}: ${dr.fps} FPs / ${dr.total} total (${dr.fp_pct})`);
    if (dr.examples.length > 0) {
      for (const ex of dr.examples.slice(0, 3)) {
        console.log(`     - "${ex.title}" (${ex.company}) — ${ex.reason}`);
      }
    }
  }
  if (report.warnings.length > 0) {
    console.log('  ⚠️  PRECISION WARNINGS:');
    for (const w of report.warnings) {
      console.log(`    - ${w}`);
    }
  }
  console.log('');
}

/**
 * Check per-keyword match health for domain keyword arrays.
 * Counts how many jobs each keyword matches and flags high-volume keywords
 * that may indicate over-matching or keyword drift.
 *
 * @param {Array} jobs - Full pool of tagged jobs
 * @param {Object} domainKeywords - Map of domain name to keyword array (from tag-engine exports)
 * @param {number} volumeThreshold - Flag keywords matching > this fraction of domain jobs (default: 0.15)
 * @returns {Object} - Per-keyword health report
 */
function checkKeywordHealth(jobs, domainKeywords, volumeThreshold = 0.15) {
  const usJobs = jobs.filter(j => j.locations && j.locations.includes('us'));

  const report = {
    timestamp: new Date().toISOString(),
    domains: {},
    warnings: [],
  };

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (!Array.isArray(keywords) || keywords.length === 0) continue;

    const domainJobs = usJobs.filter(j =>
      j.tags && j.tags.domains && j.tags.domains.includes(domain)
    );

    if (domainJobs.length === 0) continue;

    const keywordMatches = [];
    for (const kw of keywords) {
      const matched = domainJobs.filter(j =>
        (j.title || '').toLowerCase().includes(kw.toLowerCase())
      );
      keywordMatches.push({
        keyword: kw,
        matches: matched.length,
        rate: matched.length / domainJobs.length,
        rate_pct: (matched.length / domainJobs.length * 100).toFixed(1) + '%',
      });
    }

    keywordMatches.sort((a, b) => b.matches - a.matches);

    const highVolume = keywordMatches.filter(km => km.rate > volumeThreshold);
    const topContributors = keywordMatches.filter(km => km.matches > 0).slice(0, 10);

    report.domains[domain] = {
      total_jobs: domainJobs.length,
      keyword_count: keywords.length,
      keywords_with_matches: keywordMatches.filter(km => km.matches > 0).length,
      top_contributors: topContributors,
      high_volume: highVolume.map(km =>
        `${km.keyword} (${km.matches} jobs, ${km.rate_pct} of domain)`
      ),
    };

    for (const km of highVolume) {
      report.warnings.push(
        `${domain}: keyword "${km.keyword}" matches ${km.matches} jobs (${km.rate_pct} of domain) — potential over-match`
      );
    }
  }

  return report;
}

/**
 * Print keyword health report to console
 * @param {Object} report - Report from checkKeywordHealth
 */
function printKeywordHealthReport(report) {
  console.log('');
  console.log('📋 Keyword Health Check:');
  console.log('━'.repeat(60));
  for (const [domain, dr] of Object.entries(report.domains)) {
    console.log(`  ${domain}: ${dr.keywords_with_matches}/${dr.keyword_count} keywords active (${dr.total_jobs} jobs)`);
    if (dr.top_contributors.length > 0) {
      for (const tc of dr.top_contributors.slice(0, 5)) {
        console.log(`    - "${tc.keyword}": ${tc.matches} matches (${tc.rate_pct})`);
      }
    }
    if (dr.high_volume.length > 0) {
      for (const hv of dr.high_volume) {
        console.log(`    ⚠️  ${hv}`);
      }
    }
  }
  if (report.warnings.length > 0) {
    console.log('  ⚠️  KEYWORD WARNINGS:');
    for (const w of report.warnings) {
      console.log(`    - ${w}`);
    }
  }
  console.log('');
}

module.exports = {
  sampleJobsForValidation,
  generateAccuracyReport,
  recordAccuracyReport,
  calculateTagDistribution,
  validateTagHealth,
  printTagDistribution,
  loadMonitorData,
  saveMonitorData,
  checkTagDrift,
  printDriftReport,
  checkDomainPrecision,
  printPrecisionReport,
  checkKeywordHealth,
  printKeywordHealthReport,
};
