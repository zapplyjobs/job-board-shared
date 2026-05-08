#!/usr/bin/env node

/**
 * Aggregator Consumer - Shared Library
 *
 * Fetches jobs from the centralized jobs-aggregator-private repository.
 * This is the single source of truth for job data fetching across all repos.
 *
 * Usage:
 *   const { createAggregatorConsumer } = require('./aggregator-consumer');
 *   const fetcher = createAggregatorConsumer({ filters: { employment: 'internship' } });
 *   const jobs = await fetcher.fetchJobs();
 *
 * Architecture:
 * - Single centralized aggregator (jobs-aggregator-private)
 * - All repos consume from aggregator
 * - Aggregator handles JSearch + ATS + senior filtering + deduplication
 * - Repos apply domain-specific filters
 */

const https = require('https');

// Aggregator URLs (PUBLIC repo - plain GET, no authentication required)
const AGGREGATOR_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/all_jobs.json';
const METADATA_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/jobs-metadata.json';
const ENRICHED_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/enriched_jobs.json';

/**
 * Fetch JSONL file from aggregator
 * @param {Object} options - Fetch options
 * @param {string} options.url - URL to fetch (default: AGGREGATOR_URL)
 * @returns {Promise<Array>} - Array of job objects
 */
async function fetchJobsFromAggregator(options = {}) {
  const url = options.url || `${AGGREGATOR_URL}?t=${Date.now()}`;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      headers: { 'User-Agent': 'Zapply-JobBoard' }
    };

    https.get(url, requestOptions, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          // Parse JSONL (one JSON per line)
          const lines = data.trim().split('\n').filter(line => line);
          const jobs = lines.map(line => {
            try {
              return JSON.parse(line);
            } catch (error) {
              console.warn('⚠️ Failed to parse aggregator line:', line.substring(0, 50));
              return null;
            }
          }).filter(job => job !== null);

          resolve(jobs);
        } catch (error) {
          reject(new Error(`Failed to parse aggregator JSONL: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch metadata from aggregator
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} - Metadata object
 */
async function fetchMetadata(options = {}) {
  const url = options.url || `${METADATA_URL}?t=${Date.now()}`;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      headers: { 'User-Agent': 'Zapply-JobBoard' }
    };

    https.get(url, requestOptions, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Failed to parse metadata: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch enriched jobs data and merge into job array by ID.
 * Returns the input jobs array with enrichment fields added where available.
 * Enrichment fields: required_skills, sponsors_visa, visa_question_present,
 * is_simple_apply, summary_line, is_remote (from enricher).
 * Silent on failure — returns jobs unchanged if enriched_jobs.json unavailable.
 */
async function mergeEnrichmentData(jobs) {
  try {
    const enrichedRaw = await fetchJobsFromAggregator({ url: `${ENRICHED_URL}?t=${Date.now()}` });
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
      // Support both aggregator format (job.id) and consumer format (job.job_id)
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
          summary_line: enriched.summary_line || null,
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

/**
 * Filter jobs by tags
 * @param {Array} jobs - Array of tagged jobs
 * @param {Object} filters - Tag filters
 * @param {string} filters.employment - Employment type (exact match)
 * @param {Array<string>} filters.domains - Domain tags (any match)
 * @param {Array<string>} filters.locations - Location tags (any match)
 * @param {string} filters.experience - Experience level (exact match)
 * @param {Array<string>} filters.special - Special tags (any match)
 * @returns {Array} - Filtered jobs
 */
function filterByTags(jobs, filters = {}) {
  if (!Array.isArray(jobs)) {
    console.warn('filterByTags: jobs is not an array');
    return [];
  }

  return jobs.filter(job => {
    // Skip jobs without tags (unless no filters specified)
    if (!job.tags && Object.keys(filters).length > 0) {
      return false;
    }

    // Employment filter (mutually exclusive - exact match)
    if (filters.employment && job.tags?.employment !== filters.employment) {
      return false;
    }

    // Domains filter (multi-select - any match)
    if (filters.domains && filters.domains.length > 0) {
      if (!job.tags?.domains || !Array.isArray(job.tags.domains)) {
        return false;
      }
      const hasMatchingDomain = filters.domains.some(d => job.tags.domains.includes(d));
      if (!hasMatchingDomain) {
        return false;
      }
    }

    // Locations filter (multi-select - any match)
    if (filters.locations && filters.locations.length > 0) {
      if (!job.tags?.locations || !Array.isArray(job.tags.locations)) {
        return false;
      }
      const hasMatchingLocation = filters.locations.some(l => job.tags.locations.includes(l));
      if (!hasMatchingLocation) {
        return false;
      }
    }

    // Experience filter (mutually exclusive - exact match)
    if (filters.experience && job.tags?.experience !== filters.experience) {
      return false;
    }

    // Special filter (multi-select - any match)
    if (filters.special && filters.special.length > 0) {
      if (!job.tags?.special || !Array.isArray(job.tags.special)) {
        return true; // No special tags is OK
      }
      const hasMatchingSpecial = filters.special.some(s => job.tags.special.includes(s));
      if (!hasMatchingSpecial) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Convert aggregator job format to repo-specific format
 * @param {Object} aggregatorJob - Job from aggregator
 * @param {Object} options - Conversion options
 * @returns {Object} - Job in repo format
 */
function convertJobFormat(aggregatorJob, options = {}) {
  // location is a plain string (e.g. "New York, NY", "Remote - USA", "Remote")
  // job_city / job_state are pre-parsed by source-specific adapters (e.g. parseGreenhouseLocation)
  const jobCity = aggregatorJob.job_city || '';
  const jobState = aggregatorJob.job_state || '';
  // Only label as United States when us tag is explicitly present — never default
  const isUS = aggregatorJob.tags?.locations?.includes('us');
  const jobCountry = isUS ? 'United States' : '';

  return {
    // Core fields (standard format used by all repos)
    job_id: aggregatorJob.id,
    job_title: aggregatorJob.title,
    employer_name: aggregatorJob.company_name,
    job_city: jobCity,
    job_state: jobState,
    job_country: jobCountry,
    job_is_remote: aggregatorJob.tags?.locations?.includes('remote') || false,
    // OUT-LOCATION-3: Preserve full location string for WD "City, ST + N more" format
    job_location: aggregatorJob.location || null,
    job_apply_link: aggregatorJob.apply_url || aggregatorJob.url,
    job_posted_at_datetime_utc: aggregatorJob.posted_at,
    // DATA-5: ATS sources (Ashby/Greenhouse/Lever) use string employment_type field.
    // JSearch uses employment_types[] array. Prefer ATS string when present — it has
    // richer values (Part-time, Contract) that the array path defaults to FULLTIME.
    job_employment_type: aggregatorJob.employment_type || aggregatorJob.employment_types?.join(',') || 'FULLTIME',
    // DATA-2: Lever salary data (min/max/currency/interval). Null for all other sources.
    // Use min != null check — Ashby returns empty {} which is truthy, must not pass through.
    salary: aggregatorJob.salary?.min != null ? aggregatorJob.salary : null,

    // Metadata
    fingerprint: aggregatorJob.fingerprint,
    tags: aggregatorJob.tags,
    _source: 'aggregator',
    _original_source: aggregatorJob.source || 'unknown'
  };
}

/**
 * Create an aggregator consumer with specific filters
 * Factory pattern for creating repo-specific consumers
 *
 * @param {Object} config - Configuration
 * @param {Object} config.filters - Tag filters to apply
 * @param {Function} config.formatConverter - Custom format converter (optional)
 * @param {boolean} config.verbose - Enable verbose logging
 * @returns {Object} - Consumer object with fetchJobs and fetchJobsWithDiagnostics methods
 */
function createAggregatorConsumer(config = {}) {
  const { filters = {}, formatConverter = convertJobFormat, verbose = false } = config;

  return {
    /**
     * Fetch and filter jobs from aggregator
     * @returns {Promise<Array>} - Filtered and formatted jobs
     */
    async fetchJobs() {
      const result = await this.fetchJobsWithDiagnostics();
      return result.jobs;
    },

    /**
     * Fetch and filter jobs, returning diagnostic counts alongside jobs.
     * Use this instead of fetchJobs() when you need structured metrics.
     * @returns {Promise<{jobs: Array, diagnostics: Object}>}
     *   diagnostics: { total_fetched, after_14day_filter, after_tag_filter, final_count }
     */
    async fetchJobsWithDiagnostics() {
      try {
        if (verbose) {
          console.log('📡 Fetching from centralized aggregator...');
          console.log('   URL:', AGGREGATOR_URL);
          if (Object.keys(filters).length > 0) {
            console.log('   Filters:', JSON.stringify(filters));
          }
        }

        // Fetch all jobs from aggregator
        const allJobs = await fetchJobsFromAggregator();

        if (verbose) {
          console.log(`✅ Aggregator returned: ${allJobs.length} total jobs`);
        }

        // Apply 7-day date filter (aggregator outputs full window; consumer trims to active)
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentJobs = allJobs.filter(job => {
          const postedAt = job.posted_at ? new Date(job.posted_at) : null;
          return postedAt && postedAt >= cutoff;
        });

        if (verbose) {
          console.log(`📅 After 7-day filter: ${recentJobs.length} jobs (removed ${allJobs.length - recentJobs.length} older)`);
        }

        // Apply tag filters if specified
        let filteredJobs = recentJobs;
        if (Object.keys(filters).length > 0) {
          filteredJobs = filterByTags(recentJobs, filters);
          if (verbose) {
            console.log(`🏷️  After filtering: ${filteredJobs.length} jobs`);
          }
        }

        // Convert to repo format
        const formattedJobs = filteredJobs.map(job => formatConverter(job, config));

        // Merge enrichment data (skills, visa, summary) into jobs for README display.
        // mergeEnrichmentData fetches enriched_jobs.json and adds job.enrichment = {...}.
        // Fails silently if enriched_jobs.json unavailable — jobs pass through unchanged.
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
            final_count: formattedJobs.length
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
            error: error.message
          }
        };
      }
    },

    /**
     * Fetch metadata from aggregator
     * @returns {Promise<Object>} - Metadata object
     */
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
