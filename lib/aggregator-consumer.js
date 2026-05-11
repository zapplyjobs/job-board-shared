#!/usr/bin/env node

/**
 * Aggregator Consumer - Shared Library
 *
 * Fetches jobs from the centralized jobs-aggregator-private repository.
 * Supports two data sources:
 *   1. R2 (Cloudflare R2) — when R2_BUCKET_NAME env var is set (preferred)
 *   2. HTTPS (raw.githubusercontent.com) — fallback when R2 not configured
 *
 * Architecture:
 * - Single centralized aggregator (jobs-aggregator-private)
 * - All repos consume from aggregator
 * - Aggregator handles JSearch + ATS + senior filtering + deduplication
 * - Repos apply domain-specific filters
 */

const https = require('https');

// HTTPS fallback URLs (PUBLIC repo - plain GET, no authentication required)
const AGGREGATOR_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/all_jobs.json';
const METADATA_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/jobs-metadata.json';
const ENRICHED_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/enriched_jobs.json';

// R2 keys (data/ prefix matches aggregator upload path)
const R2_KEY_ALL_JOBS = 'data/all_jobs.json';
const R2_KEY_METADATA = 'data/jobs-metadata.json';
const R2_KEY_ENRICHED = 'data/enriched_jobs.json';

function isR2Configured() {
  return !!(process.env.R2_BUCKET_NAME && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT);
}

function getR2Client() {
  if (!isR2Configured()) return null;
  try {
    const { createR2Client } = require('./storage/r2-client');
    return createR2Client();
  } catch {
    return null;
  }
}

/**
 * Download and parse JSONL from R2 or HTTPS.
 * R2 preferred when configured; HTTPS as fallback.
 */
async function fetchJsonlFromSource(options = {}) {
  const { r2Key, httpsUrl, label } = options;

  // Try R2 first if configured
  if (isR2Configured()) {
    const r2 = getR2Client();
    if (r2) {
      try {
        const data = await r2.downloadJson(r2Key);
        if (data) {
          // R2 stores JSON — may be array or JSONL
          if (Array.isArray(data)) {
            console.log(`   R2: ${label} loaded (${data.length} items)`);
            return data;
          }
          // Single object — wrap in array
          console.log(`   R2: ${label} loaded (1 item)`);
          return [data];
        }
        console.warn(`   R2: ${label} not found, falling back to HTTPS`);
      } catch (err) {
        console.warn(`   R2: ${label} failed (${err.message}), falling back to HTTPS`);
      }
    }
  }

  // HTTPS fallback
  const url = httpsUrl || `${AGGREGATOR_URL}?t=${Date.now()}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Zapply-JobBoard' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const lines = data.trim().split('\n').filter(line => line);
          const jobs = lines.map(line => {
            try { return JSON.parse(line); }
            catch { return null; }
          }).filter(job => job !== null);
          resolve(jobs);
        } catch (error) {
          reject(new Error(`Failed to parse JSONL: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch jobs from aggregator (R2 or HTTPS).
 */
async function fetchJobsFromAggregator(options = {}) {
  if (options.url) {
    // Explicit URL override — always HTTPS
    return fetchJsonlFromSource({ httpsUrl: options.url, label: 'all_jobs.json' });
  }
  return fetchJsonlFromSource({
    r2Key: R2_KEY_ALL_JOBS,
    httpsUrl: `${AGGREGATOR_URL}?t=${Date.now()}`,
    label: 'all_jobs.json'
  });
}

/**
 * Fetch metadata from aggregator (R2 or HTTPS).
 */
async function fetchMetadata(options = {}) {
  if (options.url) {
    return fetchJsonlFromSource({ httpsUrl: options.url, label: 'metadata' });
  }
  // Metadata is a single JSON object, not JSONL
  if (isR2Configured()) {
    const r2 = getR2Client();
    if (r2) {
      try {
        const data = await r2.downloadJson(R2_KEY_METADATA);
        if (data) return data;
        console.warn('   R2: metadata not found, falling back to HTTPS');
      } catch (err) {
        console.warn(`   R2: metadata failed (${err.message}), falling back to HTTPS`);
      }
    }
  }

  const url = `${METADATA_URL}?t=${Date.now()}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Zapply-JobBoard' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (error) { reject(new Error(`Failed to parse metadata: ${error.message}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch enriched jobs data and merge into job array by ID.
 * Silent on failure — returns jobs unchanged if enriched_jobs.json unavailable.
 */
async function mergeEnrichmentData(jobs) {
  try {
    let enrichedRaw;
    if (isR2Configured()) {
      const r2 = getR2Client();
      if (r2) {
        try {
          enrichedRaw = await r2.downloadJson(R2_KEY_ENRICHED);
          if (enrichedRaw) {
            console.log(`   R2: enriched_jobs loaded (${Array.isArray(enrichedRaw) ? enrichedRaw.length : '?'} items)`);
          }
        } catch (err) {
          console.warn(`   R2: enriched_jobs failed (${err.message}), falling back to HTTPS`);
        }
      }
    }
    if (!enrichedRaw) {
      enrichedRaw = await fetchJobsFromAggregator({ url: `${ENRICHED_URL}?t=${Date.now()}` });
    }
    if (!Array.isArray(enrichedRaw) || enrichedRaw.length === 0) {
      console.log(`   ⚠️ Enrichment data empty or invalid — visa column will be blank for all ${jobs.length} jobs`);
      return jobs;
    }
    const enrichedMap = new Map();
    for (const ej of enrichedRaw) {
      enrichedMap.set(ej.id, ej);
    }
    let merged = 0;
    for (const job of jobs) {
      const enriched = enrichedMap.get(job.id) || enrichedMap.get(job.job_id);
      if (enriched) {
        job.enrichment = {
          required_skills: enriched.required_skills || [],
          nice_to_have_skills: enriched.nice_to_have_skills || [],
          sponsors_visa: enriched.sponsors_visa,
          possible_sponsor: enriched.possible_sponsor,
          visa_question_present: enriched.visa_question_present || false,
          is_simple_apply: enriched.is_simple_apply || false,
          is_remote: enriched.is_remote || false,
          has_description: enriched.has_description || false,
          min_degree: enriched.min_degree,
          experience_level_from_desc: enriched.experience_level_from_desc,
          question_count: enriched.question_count,
        };
        merged++;
      }
    }
    const pct = merged / jobs.length * 100;
    console.log(`   📊 Enrichment merged: ${merged}/${jobs.length} jobs (${pct.toFixed(0)}%)`);
    if (pct < 10 && jobs.length > 100) {
      console.log(`   ⚠️ Enrichment merge rate ${pct.toFixed(1)}% is critically low — enriched_jobs.json may be stale or malformed`);
    }
    return jobs;
  } catch (err) {
    console.log(`   ⚠️ Enrichment merge failed: ${err.message} — visa column will be blank for all ${jobs.length} jobs`);
    return jobs;
  }
}

function filterByTags(jobs, filters = {}) {
  if (!Array.isArray(jobs)) {
    console.warn('filterByTags: jobs is not an array');
    return [];
  }
  return jobs.filter(job => {
    if (!job.tags && Object.keys(filters).length > 0) return false;
    if (filters.employment && job.tags?.employment !== filters.employment) return false;
    if (filters.domains && filters.domains.length > 0) {
      if (!job.tags?.domains || !Array.isArray(job.tags.domains)) return false;
      if (!filters.domains.some(d => job.tags.domains.includes(d))) return false;
    }
    if (filters.locations && filters.locations.length > 0) {
      if (!job.tags?.locations || !Array.isArray(job.tags.locations)) return false;
      if (!filters.locations.some(l => job.tags.locations.includes(l))) return false;
    }
    if (filters.experience && job.tags?.experience !== filters.experience) return false;
    if (filters.special && filters.special.length > 0) {
      if (!job.tags?.special || !Array.isArray(job.tags.special)) return true;
      if (!filters.special.some(s => job.tags.special.includes(s))) return false;
    }
    return true;
  });
}

function convertJobFormat(aggregatorJob, options = {}) {
  const jobCity = aggregatorJob.job_city || '';
  const jobState = aggregatorJob.job_state || '';
  const isUS = aggregatorJob.tags?.locations?.includes('us');
  const jobCountry = isUS ? 'United States' : '';
  return {
    job_id: aggregatorJob.id,
    job_title: aggregatorJob.title,
    employer_name: aggregatorJob.company_name,
    job_city: jobCity,
    job_state: jobState,
    job_country: jobCountry,
    job_is_remote: aggregatorJob.tags?.locations?.includes('remote') || false,
    job_location: aggregatorJob.location || null,
    job_apply_link: aggregatorJob.apply_url || aggregatorJob.url,
    job_posted_at_datetime_utc: aggregatorJob.posted_at,
    job_employment_type: aggregatorJob.employment_type || aggregatorJob.employment_types?.join(',') || 'FULLTIME',
    salary: aggregatorJob.salary?.min != null ? aggregatorJob.salary : null,
    fingerprint: aggregatorJob.fingerprint,
    tags: aggregatorJob.tags,
    _source: 'aggregator',
    _original_source: aggregatorJob.source || 'unknown'
  };
}

function createAggregatorConsumer(config = {}) {
  const { filters = {}, formatConverter = convertJobFormat, verbose = false } = config;
  const dataSource = isR2Configured() ? 'R2' : 'HTTPS';

  return {
    async fetchJobs() {
      const result = await this.fetchJobsWithDiagnostics();
      return result.jobs;
    },

    async fetchJobsWithDiagnostics() {
      try {
        if (verbose) {
          console.log(`📡 Fetching from centralized aggregator via ${dataSource}...`);
          if (Object.keys(filters).length > 0) {
            console.log('   Filters:', JSON.stringify(filters));
          }
        }

        const allJobs = await fetchJobsFromAggregator();

        if (verbose) {
          console.log(`✅ Aggregator returned: ${allJobs.length} total jobs`);
        }

        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentJobs = allJobs.filter(job => {
          const postedAt = job.posted_at ? new Date(job.posted_at) : null;
          return postedAt && postedAt >= cutoff;
        });

        if (verbose) {
          console.log(`📅 After 7-day filter: ${recentJobs.length} jobs (removed ${allJobs.length - recentJobs.length} older)`);
        }

        let filteredJobs = recentJobs;
        if (Object.keys(filters).length > 0) {
          filteredJobs = filterByTags(recentJobs, filters);
          if (verbose) {
            console.log(`🏷️  After filtering: ${filteredJobs.length} jobs`);
          }
        }

        const formattedJobs = filteredJobs.map(job => formatConverter(job, config));
        await mergeEnrichmentData(formattedJobs);

        if (verbose) {
          console.log(`✅ Formatted ${formattedJobs.length} jobs for consumption`);
        }

        return {
          jobs: formattedJobs,
          diagnostics: {
            total_fetched: allJobs.length,
            after_14day_filter: recentJobs.length,
            after_tag_filter: filteredJobs.length,
            final_count: formattedJobs.length,
            data_source: dataSource,
          }
        };
      } catch (error) {
        console.error('❌ Error fetching from aggregator:', error.message);
        return {
          jobs: [],
          diagnostics: {
            total_fetched: 0,
            after_14day_filter: 0,
            after_tag_filter: 0,
            final_count: 0,
            data_source: dataSource,
            error: error.message
          }
        };
      }
    },

    async fetchMetadata() {
      try {
        return await fetchMetadata();
      } catch (error) {
        console.error('❌ Error fetching metadata:', error.message);
        return null;
      }
    }
  };
}

module.exports = {
  createAggregatorConsumer,
  fetchJobsFromAggregator,
  fetchMetadata,
  mergeEnrichmentData,
  filterByTags,
  convertJobFormat,
  AGGREGATOR_URL,
  METADATA_URL,
  ENRICHED_URL
};