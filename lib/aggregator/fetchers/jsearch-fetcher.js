#!/usr/bin/env node

/**
 * JSearch API Fetcher
 *
 * Fetches jobs from JSearch API (RapidAPI)
 * Paid tier: 10,000 requests/month (330/day)
 *
 * Features:
 * - Three queries per run (3 queries × 96 runs/day = 288 requests/day, 87% of 330 quota)
 * - Query rotation (distributes queries across 15-min runs)
 *
 * UPDATED 2026-02-20: Redesigned query sets — one set per consumer domain
 * - 17 queries total (software:4, datascience:4, hardware:4, nursing:5)
 * - Rotates 3 per run: full domain coverage every ~5.7 runs (~1.4 hours)
 * - Total: 96 runs × 3 queries = 288 requests/day (87% of 330 quota)
 */

// Configuration
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const JSEARCH_BASE_URL = 'https://jsearch.p.rapidapi.com/search';
const QUERIES_PER_RUN = 3; // 3 queries per run × 96 runs/day = 288 requests/day (87% of 330 quota)

// Query sets for Tagged Streams Aggregator
// One set per consumer repo domain. Each set covers both internship and entry-level
// so the tag-engine can split them correctly downstream.
const QUERY_SETS = {
  // Software Engineering (for New-Grad-Software-Engineering-Jobs-2026 + Internships)
  software: [
    'software engineer intern',
    'software engineer new graduate entry level',
    'junior software engineer',
    'associate software engineer'
  ],
  // Data Science (for New-Grad-Data-Science-Jobs-2026 + Internships)
  datascience: [
    'data science intern',
    'data scientist entry level new graduate',
    'data analyst entry level',
    'machine learning engineer entry level'
  ],
  // Hardware Engineering (for New-Grad-Hardware-Engineering-Jobs-2026)
  hardware: [
    'hardware engineer entry level new graduate',
    'electrical engineer entry level new graduate',
    'embedded systems engineer entry level',
    'firmware engineer entry level'
  ],
  // Nursing (for New-Grad-Nursing-Jobs-2026)
  nursing: [
    'registered nurse entry level new graduate',
    'new grad nurse RN',
    'nurse practitioner entry level',
    'RN new grad',
    'travel nurse entry level'
  ]
};

// Flat list — all queries across all domains
// 17 total: rotates 3 per run (every 15 min) = full cycle every ~5.7 runs (~1.4 hours)
const ALL_QUERIES = [
  ...QUERY_SETS.software,
  ...QUERY_SETS.datascience,
  ...QUERY_SETS.hardware,
  ...QUERY_SETS.nursing
];

/**
 * Select which queries to run based on run index (not hour)
 * Rotates through query sets to ensure diverse coverage
 * @param {number} runIndex - Run index within the day (0-95, one per 15-min slot)
 * @returns {Array} - Array of query strings to run
 */
function selectQueriesForRun(runIndex) {
  // 96 runs/day (every 15 min), 17 queries total, 3 per run
  // Full cycle every ~5.7 runs (~1.4 hours) — all domains covered ~17x per day

  const startIndex = (runIndex * QUERIES_PER_RUN) % ALL_QUERIES.length;
  const queries = [];

  for (let i = 0; i < QUERIES_PER_RUN; i++) {
    const index = (startIndex + i) % ALL_QUERIES.length;
    queries.push(ALL_QUERIES[index]);
  }

  return queries;
}

/**
 * Make a single API request to JSearch
 * @param {string} query - Search query
 * @param {number} requestNum - Request number for logging
 * @returns {Promise<Array>} - Array of job objects
 */
async function makeAPIRequest(query, requestNum) {
  console.log(`📡 JSearch API - Query ${requestNum}/${QUERIES_PER_RUN}: "${query}"`);

  // Build API request
  const url = new URL(JSEARCH_BASE_URL);
  url.searchParams.append('query', `${query} United States`);
  url.searchParams.append('page', '1');
  url.searchParams.append('num_pages', 20);  // Up to 200 jobs per request (was 10, trying more)
  url.searchParams.append('date_posted', 'month');
  url.searchParams.append('country', 'us');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': JSEARCH_API_KEY,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
    }
  });

  if (!response.ok) {
    console.error(`❌ JSearch API request failed: ${response.status} ${response.statusText}`);
    return [];
  }

  const data = await response.json();
  const jobs = data.data || [];

  // Diagnostic logging
  console.log(`✅ Query ${requestNum} returned ${jobs.length} jobs`);
  if (data.jobs_count !== undefined) {
    console.log(`   API reports total available: ${data.jobs_count} jobs`);
  }
  if (data.pages !== undefined) {
    console.log(`   Pages returned: ${data.pages}, Requested: 20`);
  }
  if (data.parameters) {
    console.log(`   API parameters:`, JSON.stringify(data.parameters));
  }

  return jobs;
}

/**
 * Fetch jobs from JSearch API (multiple queries)
 * @returns {Promise<Array>} - Array of normalized job objects
 */
async function fetchFromJSearch() {
  // Check API key
  if (!JSEARCH_API_KEY || JSEARCH_API_KEY === 'YOUR_KEY_HERE') {
    console.error('❌ JSEARCH_API_KEY not set');
    return [];
  }

  console.log(`📊 Running ${QUERIES_PER_RUN} queries this run`);

  try {
    // Select queries based on 15-min run slot (not hour — hour causes 4 identical runs/hour)
    const now = new Date();
    const runIndex = now.getUTCHours() * 4 + Math.floor(now.getUTCMinutes() / 15);
    const queries = selectQueriesForRun(runIndex);

    console.log(`🕐 Run slot ${runIndex}/96: Running queries:`, queries.map((q, i) => `${i + 1}. "${q.substring(0, 40)}..."`));

    // Execute all queries for this run
    let allJobs = [];
    for (let i = 0; i < queries.length; i++) {
      const jobs = await makeAPIRequest(queries[i], i + 1);
      allJobs.push(...jobs);
    }

    console.log(`📊 Total jobs fetched this run: ${allJobs.length}`);

    return normalizeJobs(allJobs);

  } catch (error) {
    console.error('❌ JSearch API error:', error.message);
    return [];
  }
}

/**
 * Normalize JSearch jobs to common format
 * @param {Array} jobs - Raw JSearch jobs
 * @returns {Array} - Normalized job objects
 */
function normalizeJobs(jobs) {
  const helpers = require('../utils/helpers');

  return jobs.map(job => {
    try {
      const normalized = {
        // Core identification
        id: helpers.generateJobId(job, 'js'),
        fingerprint: helpers.generateFingerprint(job),

        // Job details
        title: job.job_title || '',
        company_name: job.employer_name || '',
        company_slug: helpers.slugify(job.employer_name || ''),
        location: formatLocation(job),
        remote: job.job_is_remote || false,
        url: job.job_apply_link || job.job_google_link || '',

        // Metadata
        posted_at: helpers.formatDate(job.job_posted_at_datetime_utc),
        source: 'jsearch',
        employment_types: parseEmploymentTypes(job.job_employment_type),
        experience_level: parseExperienceLevel(job),

        // Enrichment
        description: job.job_description || null,
        enriched: false,
        enriched_at: null,

        // Pre-computed filters
        is_internship: helpers.isInternship(job),
        is_new_grad: helpers.isNewGrad(job),
        is_remote: helpers.isRemote(job),
        is_us_only: helpers.isUSOnly(job),

        // Raw data reference
        _raw: {
          job_id: job.job_id,
          job_publisher: job.job_publisher,
          job_latitude: job.job_latitude,
          job_longitude: job.job_longitude
        }
      };

      return normalized;

    } catch (error) {
      console.error('⚠️ Error normalizing job:', error.message);
      return null;
    }
  }).filter(job => job !== null);
}

/**
 * Format location from JSearch job
 * @param {Object} job - JSearch job object
 * @returns {string} - Formatted location
 */
function formatLocation(job) {
  const city = job.job_city || '';
  const state = job.job_state || '';

  if (city && state) {
    return `${city}, ${state}`;
  } else if (city) {
    return city;
  } else if (state) {
    return state;
  } else if (job.job_is_remote) {
    return 'Remote';
  }

  return 'Unknown';
}

/**
 * Parse employment types from JSearch
 * @param {string|string[]} types - Employment type(s)
 * @returns {Array} - Array of employment types
 */
function parseEmploymentTypes(types) {
  if (Array.isArray(types)) {
    return types.map(t => t.toUpperCase());
  } else if (typeof types === 'string') {
    return types.split(',').map(t => t.trim().toUpperCase());
  }
  return [];
}

/**
 * Parse experience level from job
 * @param {Object} job - Job object
 * @returns {string} - Experience level
 */
function parseExperienceLevel(job) {
  const title = (job.job_title || '').toLowerCase();
  const description = (job.job_description || '').toLowerCase();

  // Senior indicators
  if (title.includes('senior') || title.includes('sr.') || title.includes('staff') ||
      title.includes('principal') || title.includes('lead')) {
    return 'senior';
  }

  // Mid indicators
  if (title.includes('mid') || title.includes('mid-level')) {
    return 'mid';
  }

  // Entry level (default)
  return 'entry';
}

module.exports = {
  fetchFromJSearch,
  QUERIES_PER_RUN,
  ALL_QUERIES
};
