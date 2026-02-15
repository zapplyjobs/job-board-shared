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

// Aggregator URLs (PRIVATE repo - requires authentication)
const AGGREGATOR_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-aggregator-private/main/.github/data/all_jobs.json';
const METADATA_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-aggregator-private/main/.github/data/jobs-metadata.json';

/**
 * Fetch JSONL file from aggregator
 * @param {Object} options - Fetch options
 * @param {string} options.url - URL to fetch (default: AGGREGATOR_URL)
 * @param {string} options.token - GitHub token for authentication
 * @returns {Promise<Array>} - Array of job objects
 */
async function fetchJobsFromAggregator(options = {}) {
  const url = options.url || AGGREGATOR_URL;
  const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_PAT;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      headers: token ? { 'Authorization': `token ${token}` } : {}
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
  const url = options.url || METADATA_URL;
  const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_PAT;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      headers: token ? { 'Authorization': `token ${token}` } : {}
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
  // Extract location from aggregator's location object
  const location = aggregatorJob.location || {};
  const jobCity = location.city || aggregatorJob.job_city || '';
  const jobState = location.state || location.region || '';
  const jobCountry = location.country || 'US';

  return {
    // Core fields (standard format used by all repos)
    job_id: aggregatorJob.id,
    job_title: aggregatorJob.title,
    employer_name: aggregatorJob.company_name,
    job_city: jobCity,
    job_state: jobState,
    job_country: jobCountry === 'US' ? 'United States' : jobCountry,
    job_is_remote: aggregatorJob.tags?.locations?.includes('remote') || false,
    job_apply_link: aggregatorJob.apply_url || aggregatorJob.url,
    job_posted_at_datetime_utc: aggregatorJob.posted_at,
    job_description: aggregatorJob.description || null,
    job_employment_type: aggregatorJob.employment_types?.join(',') || 'FULLTIME',

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
 * @returns {Object} - Consumer object with fetchJobs method
 */
function createAggregatorConsumer(config = {}) {
  const { filters = {}, formatConverter = convertJobFormat, verbose = false } = config;

  return {
    /**
     * Fetch and filter jobs from aggregator
     * @returns {Promise<Array>} - Filtered and formatted jobs
     */
    async fetchJobs() {
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

        // Apply filters if specified
        let filteredJobs = allJobs;
        if (Object.keys(filters).length > 0) {
          filteredJobs = filterByTags(allJobs, filters);
          if (verbose) {
            console.log(`🏷️  After filtering: ${filteredJobs.length} jobs`);
          }
        }

        // Convert to repo format
        const formattedJobs = filteredJobs.map(job => formatConverter(job, config));

        if (verbose) {
          console.log(`✅ Formatted ${formattedJobs.length} jobs for consumption`);
        }

        return formattedJobs;
      } catch (error) {
        console.error('❌ Error fetching from aggregator:', error.message);
        // Return empty array on failure (don't crash workflow)
        return [];
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
  filterByTags,
  convertJobFormat,
  AGGREGATOR_URL,
  METADATA_URL
};
