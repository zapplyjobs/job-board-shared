#!/usr/bin/env node

/**
 * JSearch API Fetcher
 *
 * Fetches jobs from JSearch API (RapidAPI)
 * Paid tier: 10,000 requests/month (~333/day)
 *
 * Features:
 * - Three queries per run (3 queries × 96 runs/day = 288 requests/day, 86% of quota)
 * - Query rotation (distributes queries across 15-min runs)
 *
 * UPDATED 2026-02-20: Redesigned query sets — one set per consumer domain
 * UPDATED 2026-02-28 (JS-3): 4 weak/dead queries replaced; DS publisher exclusions added
 * - 17 queries total (software:4, datascience:4, hardware:5, nursing:4)
 * - Rotates 3 per run: full domain coverage every ~5.3 runs (~1.3 hours)
 * - Total: 96 runs × 3 queries = 288 requests/day (87% of 330 quota)
 */

// Configuration
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const JSEARCH_BASE_URL = 'https://jsearch.p.rapidapi.com/search';
const QUERIES_PER_RUN = 3; // 3 queries per run × 96 runs/day = 288 requests/day (86% of ~333 quota)

// Per-run stats (accumulated during fetchFromJSearch, read by getUsageStats)
const runStats = {
  queries: [] // { query, count } per request this run
};

// Query sets for Tagged Streams Aggregator
// One set per consumer repo domain. Each set covers both internship and entry-level
// so the tag-engine can split them correctly downstream.
const QUERY_SETS = {
  // Software Engineering (for New-Grad-Software-Engineering-Jobs-2026 + Internships)
  software: [
    'software engineer intern',
    'new grad software engineer',
    'junior software engineer',
    'associate software engineer'
  ],
  // Data Science (for New-Grad-Data-Science-Jobs-2026 + Internships)
  datascience: [
    'data science intern',
    'entry level data scientist',
    'data analyst entry level',
    'machine learning engineer entry level'
  ],
  // Hardware Engineering (for New-Grad-Hardware-Engineering-Jobs-2026)
  hardware: [
    'entry level hardware engineer',
    'electrical engineer entry level new graduate',
    'embedded systems engineer entry level',
    'firmware engineer entry level',
    'hardware engineer intern'
  ],
  // Nursing (for New-Grad-Nursing-Jobs-2026)
  nursing: [
    'registered nurse entry level new graduate',
    'new grad nurse RN',
    'nurse residency program 2026',
    'RN fellowship entry level'
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

// Publishers to exclude globally — aggregators/scrapers that redirect apply links
// through their own platforms instead of directly to the employer. All 961 bad links
// in consumer repos trace back to these domains (JS-BAD-LINKS audit, S101).
const GLOBAL_EXCLUDE_PUBLISHERS = [
  'LinkedIn',
  'ZipRecruiter',
  'BeBee',
  'Jobilize',
  'Talent.com',
  'Snagajob',
  'Lensa',
  'Learn4Good',
  'Jooble',
  'Adzuna',
  'CollegeRecruiter',
  'Indeed',
  'Glassdoor',
  'Monster',
];

// Employers to exclude post-fetch — staffing agencies that post via aggregator publishers
// (LinkedIn, Monster, etc.) so exclude_job_publishers has no effect on them.
// JS-NOISE-1 incorrectly put these in GLOBAL_EXCLUDE_PUBLISHERS — they are employers, not publishers.
const GLOBAL_EXCLUDE_EMPLOYERS = [
  'VirtualVocations',
  'SynergisticIT',
  'YO IT Consulting',
];

// Aggregator domains — apply URLs pointing here are indirect (not employer-direct).
// Used to compute is_direct_apply flag on JSearch records (Decision 2, S137).
const INDIRECT_APPLY_DOMAINS = [
  'linkedin.com',
  'ziprecruiter.com',
  'indeed.com',
  'glassdoor.com',
  'monster.com',
  'bebee.com',
  'jobilize.com',
  'jooble.org',
  'talent.com',
  'learn4good.com',
  'snagajob.com',
  'adzuna.com',
  'lensa.com',
  'collegerecruiter.com',
  'dice.com',
  'simplyhired.com',
  'jobright.ai',
  'builtin.com',
  'tealhq.com',
  'wayup.com',
  'prosple.com',
  'jobleads.com',
  'sercanto.com',
  'digitalhire.com',
  'womenforhire.com',
  'jobtrees.com',
  'jobserve.com',
  'whatjobs.com',
  'trabajo.org',
  'jobrapido.com',
  'efinancialcareers.com',
];

/**
 * Returns true if the apply URL goes directly to an employer or ATS platform,
 * false if it routes through a job aggregator.
 * @param {string} url
 * @returns {boolean}
 */
function isDirectApply(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return !INDIRECT_APPLY_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// Publishers to exclude for nursing queries — pure job aggregators that add noise
// (Jobilize, BeBee, etc. re-post staffing agency listings with poor apply-link quality)
const NURSING_EXCLUDE_PUBLISHERS = [
  'Jobilize',
  'BeBee',
  'Medical Hirings - Talent Rush HQ',
  'Hispanic-Jobs.com',
  'GetHiredToday - Women For Hire',
  'Lensa',
];

/**
 * Select which queries to run based on run index (not hour)
 * Rotates through query sets to ensure diverse coverage
 * @param {number} runIndex - Run index within the day (0-95, one per 15-min slot)
 * @returns {Array} - Array of query strings to run
 */
function selectQueriesForRun(runIndex) {
  // 96 runs/day (every 15 min), 16 queries total, 3 per run
  // Full cycle every ~5.3 runs (~1.3 hours) — all domains covered ~18x per day

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
async function makeAPIRequest(query, requestNum, extraParams = {}) {
  console.log(`📡 JSearch API - Query ${requestNum}/${QUERIES_PER_RUN}: "${query}"`);

  // Build API request
  const url = new URL(JSEARCH_BASE_URL);
  url.searchParams.append('query', `${query} United States`);
  url.searchParams.append('page', '1');
  url.searchParams.append('num_pages', 1);  // 1 page = 10 jobs per request (20 caused 3x quota cost per allthingsdev.co docs)
  url.searchParams.append('date_posted', 'week');
  url.searchParams.append('country', 'us');
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.append(k, v);
  }

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

  // Accumulate per-query yield for getUsageStats()
  runStats.queries.push({ query, count: jobs.length });

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
    const nursingQuerySet = new Set(QUERY_SETS.nursing);
    const nursingExtraParams = {
      job_requirements: 'no_experience',
      exclude_job_publishers: [...GLOBAL_EXCLUDE_PUBLISHERS, ...NURSING_EXCLUDE_PUBLISHERS].join(','),
    };

    const dsQuerySet = new Set(QUERY_SETS.datascience);
    const dsExtraParams = {
      exclude_job_publishers: GLOBAL_EXCLUDE_PUBLISHERS.join(','),
    };

    const defaultExtraParams = {
      exclude_job_publishers: GLOBAL_EXCLUDE_PUBLISHERS.join(','),
    };

    let allJobs = [];
    for (let i = 0; i < queries.length; i++) {
      const isNursing = nursingQuerySet.has(queries[i]);
      const isDS = dsQuerySet.has(queries[i]);
      const extraParams = isNursing ? nursingExtraParams : isDS ? dsExtraParams : defaultExtraParams;
      const jobs = await makeAPIRequest(queries[i], i + 1, extraParams);
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

  return jobs.filter(job => {
    if (GLOBAL_EXCLUDE_EMPLOYERS.includes(job.employer_name)) {
      console.log(`⛔ Excluded employer: ${job.employer_name}`);
      return false;
    }
    return true;
  }).map(job => {
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
        url: (job.job_apply_link || job.job_google_link || '').replace(/[?&]utm_[^&]*/g, '').replace(/[?&]$/, ''),
        is_direct_apply: isDirectApply(job.job_apply_link || job.job_google_link || ''),

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

/**
 * Return per-query yield stats for this run (used by index.js for metadata)
 * @returns {Object} - { queries: [{query, count}], total }
 */
function getUsageStats() {
  const total = runStats.queries.reduce((sum, q) => sum + q.count, 0);
  return {
    queries: runStats.queries,
    total_fetched: total
  };
}

module.exports = {
  fetchFromJSearch,
  getUsageStats,
  QUERIES_PER_RUN,
  ALL_QUERIES
};
