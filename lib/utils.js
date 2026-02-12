/**
 * @zapply/job-board-shared - Utilities Module
 *
 * Common utility functions for job processing
 * Handles: ID generation, deduplication, company data, formatting, filtering, classification
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Company database (loaded from file in repo, fallback to empty object)
let companies = {};
let ALL_COMPANIES = [];
let COMPANY_BY_NAME = {};

/**
 * Initialize company database
 * Call this after loading the shared package in a repo
 */
function initCompanyDatabase(companiesData) {
  if (companiesData) {
    companies = companiesData;
    ALL_COMPANIES = Object.values(companies).flat();
    COMPANY_BY_NAME = {};
    ALL_COMPANIES.forEach(company => {
      COMPANY_BY_NAME[company.name.toLowerCase()] = company;
      company.api_names.forEach(name => {
        COMPANY_BY_NAME[name.toLowerCase()] = company;
      });
    });
  }
}

/**
 * Generate enhanced job ID with normalization
 * Handles title variations: Roman numerals (I vs 1), abbreviations (Sr. vs Senior)
 *
 * @param {Object} job - Job data
 * @returns {string} - Normalized job ID
 */
function generateEnhancedId(job) {
  let title = (job.title || job.job_title || '').toLowerCase().trim();

  // Normalize Roman numerals BEFORE replacing spaces
  title = title
    .replace(/\bi\b/g, '1')
    .replace(/\bii\b/g, '2')
    .replace(/\biii\b/g, '3')
    .replace(/\biv\b/g, '4')
    .replace(/\bv\b/g, '5')
    // Common abbreviations
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/\b&\b/g, 'and')
    .replace(/\s+/g, '-');

  // Normalize company name
  let company = (job.company_name || job.employer_name || job.company || '')
    .toLowerCase()
    .trim()
    .replace(/\s+(inc\.?|incorporated|llc|corp\.?|corporation|ltd\.?|limited)$/i, '')
    .replace(/\s+solutions?$/i, '')
    .replace(/\s+technologies?$/i, '')
    .replace(/\s+systems?$/i, '')
    .replace(/\s+group$/i, '')
    .replace(/\s*,\s*/g, '-')
    .replace(/\s+/g, '-');

  // Normalize location
  let city = '';
  if (job.locations && Array.isArray(job.locations) && job.locations.length > 0) {
    city = job.locations[0].toLowerCase().trim();
  } else {
    city = (job.job_city || job.location || '').toLowerCase().trim();
  }
  city = city.replace(/\s+/g, '-');

  // Remove special characters
  const normalize = (str) => str
    .replace(/[^\w-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `${normalize(company)}-${normalize(title)}-${normalize(city)}`;
}

/**
 * Generate job ID using URL (most reliable)
 *
 * @param {Object} job - Job data
 * @returns {string} - Job ID
 */
function generateJobIdFromUrl(job) {
  const jobUrl = job.url || job.job_apply_link;

  if (jobUrl) {
    try {
      const urlObj = new URL(jobUrl);
      const normalized = urlObj.hostname + urlObj.pathname.replace(/\/$/, '');
      return normalized.toLowerCase().replace(/[^\w]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    } catch (e) {
      // Invalid URL, fall through
    }
  }

  return generateEnhancedId(job);
}

/**
 * Generate job ID using SHA-256 hash (crypto-based)
 *
 * @param {Object} job - Job data
 * @returns {string} - 8-character hex ID
 */
function generateJobIdHash(job) {
  const company = normalizeCompanyNameStr(job.company_name || job.employer_name || job.company || '');
  const title = (job.title || job.job_title || '').toLowerCase().trim();
  const location = job.location || job.job_city || '';

  const hashInput = `${company}|${title}|${location}`.toLowerCase().trim();
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

  return hash.substring(0, 8);
}

/**
 * Generate job ID (unified function - tries URL first, then hash)
 *
 * @param {Object} job - Job data
 * @returns {string} - Job ID
 */
function generateJobId(job) {
  return generateJobIdFromUrl(job);
}

/**
 * Generate job fingerprint for deduplication
 *
 * @param {Object} job - Job data
 * @returns {string} - Fingerprint hash
 */
function generateJobFingerprint(job) {
  let title = (job.title || job.job_title || '').toLowerCase().trim();

  // Remove seniority variations
  title = title
    .replace(/\b(senior|sr\.?|junior|jr\.?|staff|principal|lead|associate)\b/gi, '')
    .replace(/\b(i{1,3}|iv|v|1|2|3|4|5)\b/g, '')
    .replace(/\s+-\s+[^-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const company = normalizeCompanyNameStr(job.company_name || job.employer_name || job.company || '');

  let location = '';
  if (job.locations && Array.isArray(job.locations) && job.locations.length > 0) {
    location = job.locations[0].split(',')[0];
  } else {
    location = (job.job_city || job.location || '').split(',')[0];
  }
  location = location.toLowerCase().trim();

  return `${company}::${title}::${location}`;
}

/**
 * Generate minimal fingerprint (for Simplify.jobs)
 *
 * @param {Object} job - Job data
 * @returns {string} - Minimal fingerprint
 */
function generateMinimalJobFingerprint(job) {
  let title = (job.title || job.job_title || '').toLowerCase().trim();

  // Minimal normalization
  title = title
    .replace(/[-_\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const company = normalizeCompanyNameStr(job.company_name || job.employer_name || job.company || '');

  let location = '';
  if (job.locations && Array.isArray(job.locations) && job.locations.length > 0) {
    location = job.locations[0].split(',')[0];
  } else {
    location = (job.job_city || job.location || '').split(',')[0];
  }
  location = location.toLowerCase().trim();

  return `${company}::${title}::${location}`;
}

/**
 * Migrate old job ID format to new format
 *
 * @param {string} oldId - Old job ID
 * @returns {string} - Normalized ID
 */
function migrateOldJobId(oldId) {
  return oldId
    .replace(/[^\w-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Normalize company name string (for hashing)
 *
 * @param {string} company - Company name
 * @returns {string} - Normalized name
 */
function normalizeCompanyNameStr(company) {
  if (!company) return '';

  return company
    .toLowerCase()
    .trim()
    .replace(/\s+(inc\.?|llc|corp\.?|corporation|ltd\.?|limited|gmbh|co|company)$/i, '')
    .replace(/\s+/g, ' ');
}

/**
 * Normalize company name using database
 *
 * @param {string} companyName - Company name
 * @returns {string} - Normalized name
 */
function normalizeCompanyName(companyName) {
  const company = COMPANY_BY_NAME[companyName.toLowerCase()];
  return company ? company.name : companyName;
}

/**
 * Get company emoji
 *
 * @param {string} companyName - Company name
 * @returns {string} - Emoji
 */
function getCompanyEmoji(companyName) {
  const company = COMPANY_BY_NAME[companyName.toLowerCase()];
  return company ? company.emoji : '🏢';
}

/**
 * Get company career URL
 *
 * @param {string} companyName - Company name
 * @returns {string} - Career URL
 */
function getCompanyCareerUrl(companyName) {
  const company = COMPANY_BY_NAME[companyName.toLowerCase()];
  return company ? company.career_url : '#';
}

/**
 * Format time ago
 *
 * @param {string} dateString - Date string
 * @returns {string} - Formatted time
 */
function formatTimeAgo(dateString) {
  if (!dateString) return 'Recently';

  const date = new Date(dateString);
  const now = new Date();
  const diffInHours = Math.floor((now - date) / (1000 * 60 * 60));

  if (diffInHours < 24) {
    return `${diffInHours}h`;
  } else {
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays === 1) return '1d';
    if (diffInDays < 7) return `${diffInDays}d`;
    if (diffInDays < 30) return `${Math.floor(diffInDays / 7)}w`;
    return `${Math.floor(diffInDays / 30)}mo`;
  }
}

/**
 * Check if job is older than 2 weeks
 *
 * @param {string} dateString - Date string
 * @returns {boolean} - True if older than 2 weeks
 */
function isJobOlderThanWeek(dateString) {
  if (!dateString) return false;

  // Handle relative date formats: 1d, 2w, 3mo
  const match = String(dateString).match(/^(\d+)([hdwmo])$/i);
  if (match) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'h': return value >= 336;
      case 'd': return value >= 14;
      case 'w': return value >= 2;
      case 'mo': return true;
      default: return false;
    }
  }

  // Handle ISO date strings
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return false;

  const now = new Date();
  const diffInDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  return diffInDays >= 14;
}

/**
 * Check if job is US-only
 *
 * @param {Object} job - Job data
 * @param {Object} config - Configuration object (optional)
 * @returns {boolean} - True if US-only
 */
function isUSOnlyJob(job, config) {
  // Use provided config or default to empty object
  const locConfig = config && config.locations ? config.locations : null;

  const state = (job.job_state || '').toLowerCase().trim();
  const city = (job.job_city || '').toLowerCase().trim();

  const cleanCity = city.replace(/[,\s]+/g, ' ').trim();
  const cleanState = state.replace(/[,\s]+/g, ' ').trim();

  // If config provided, use it
  if (locConfig) {
    // Check non-US countries first
    if (locConfig.isNonUS(cleanCity) || locConfig.isNonUS(cleanState)) {
      return false;
    }

    // Check if US
    return locConfig.isUS(cleanCity) || locConfig.isUS(cleanState);
  }

  // Fallback to simplified logic if no config provided
  const usIndicators = ['us', 'usa', 'united states', 'america'];
  if (usIndicators.some(i => cleanState.includes(i))) {
    return true;
  }

  // Remote defaults to US
  if (cleanCity.includes('remote') || cleanState.includes('remote')) {
    return true;
  }

  // CRITICAL FIX 2026-02-11: Default to ALLOW when location is unknown
  // Rationale:
  // 1. JSearch API filters for US jobs at API level (job_requirements parameter)
  // 2. ATS APIs (Greenhouse, Lever, Ashby, Workday) are US-focused companies
  // 3. Better to over-include (user reports false positives) than under-include (miss valid jobs)
  // 4. Previous behavior rejected 100% of JSearch jobs (empty locations)
  //
  // If both city and state are empty, assume US unless we found non-US indicators above
  // (we already checked for non-US countries/cities, so if we reach here, it's likely US)
  return true;
}

/**
 * Get experience level from job data
 *
 * @param {string} title - Job title
 * @param {string} description - Job description
 * @param {Object} config - Configuration object (optional)
 * @returns {string} - Experience level
 */
function getExperienceLevel(title, description = '', config) {
  const text = `${title} ${description}`.toLowerCase();

  // If config provided with experience levels, use it
  if (config && config.categories && config.categories.experienceLevels) {
    const levels = config.categories.experienceLevels;

    // Check Senior
    if (levels['Senior'] && levels['Senior'].some(keyword => text.includes(keyword))) {
      return 'Senior';
    }

    // Check Entry-Level
    if (levels['Entry-Level'] && levels['Entry-Level'].some(keyword => text.includes(keyword))) {
      return 'Entry-Level';
    }

    // Check Mid-Level
    if (levels['Mid-Level'] && levels['Mid-Level'].some(keyword => text.includes(keyword))) {
      return 'Mid-Level';
    }
  }

  // Fallback to default logic
  if (text.includes('senior') || text.includes('sr.') || text.includes('lead') ||
      text.includes('principal') || text.includes('staff') || text.includes('architect')) {
    return 'Senior';
  }

  if (text.includes('entry') || text.includes('junior') || text.includes('jr.') ||
      text.includes('new grad') || text.includes('graduate') || text.includes('intern') ||
      text.includes('associate') || text.includes('level 1') || text.includes('l1') ||
      text.includes('campus') || text.includes('student') || text.includes('early career')) {
    return 'Entry-Level';
  }

  // CRITICAL FIX 2026-02-11: Default to Entry-Level instead of Mid-Level
  // Reason: JSearch API already filters for under_3_years_experience, so jobs without
  // obvious keywords are likely entry-level. This prevents 100% rejection of JSearch jobs.
  // TODO: When migrating to centralized aggregator, repos will control their own filtering
  return 'Entry-Level';
}

/**
 * Get job category from title/description
 *
 * @param {string} title - Job title
 * @param {string} description - Job description
 * @param {Object} config - Configuration object (optional)
 * @returns {string} - Job category
 */
function getJobCategory(title, description = '', config) {
  const text = `${title} ${description}`.toLowerCase();

  // If config provided with keywords, use it
  if (config && config.categories && config.categories.keywords) {
    for (const [category, keywords] of Object.entries(config.categories.keywords)) {
      if (Array.isArray(keywords) && keywords.some(keyword => text.includes(keyword))) {
        return category;
      }
    }
  }

  // Fallback to default logic
  if (text.includes('ios') || text.includes('android') || text.includes('mobile')) {
    return 'Mobile Development';
  }
  if (text.includes('frontend') || text.includes('front-end') || text.includes('react') || text.includes('vue')) {
    return 'Frontend Development';
  }
  if (text.includes('backend') || text.includes('back-end') || text.includes('api') || text.includes('server')) {
    return 'Backend Development';
  }
  if (text.includes('machine learning') || text.includes('ml ') || text.includes('ai ') || text.includes('deep learning')) {
    return 'Machine Learning & AI';
  }
  if (text.includes('data scientist') || text.includes('data analyst') || text.includes('analytics')) {
    return 'Data Science & Analytics';
  }
  if (text.includes('devops') || text.includes('infrastructure') || text.includes('cloud')) {
    return 'DevOps & Infrastructure';
  }
  if (text.includes('security') || text.includes('cybersecurity')) {
    return 'Security Engineering';
  }
  if (text.includes('product manager') || text.includes('pm ')) {
    return 'Product Management';
  }
  if (text.includes('design') || text.includes('ux') || text.includes('ui')) {
    return 'Design';
  }
  if (text.includes('full stack') || text.includes('fullstack')) {
    return 'Full Stack Development';
  }

  return 'Software Engineering';
}

/**
 * Format location string
 *
 * @param {string} city - City
 * @param {string} state - State
 * @returns {string} - Formatted location
 */
function formatLocation(city, state) {
  if (!city && !state) return 'Remote';
  if (!city) return state;
  if (!state) return city;
  if (city.toLowerCase() === 'remote') return 'Remote 🏠';
  return `${city}, ${state}`;
}

/**
 * Delay execution
 *
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} - Resolves after delay
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch internship data (placeholder - actual implementation would fetch from sources)
 *
 * @returns {Object} - Internship data
 */
async function fetchInternshipData() {
  return {
    companyPrograms: [], // Empty array - feature not currently used
    sources: [
      {
        name: 'Wellfound (AngelList)',
        emogi: '🚀', // Note: typo maintained for backwards compatibility
        type: 'Job Board',
        description: 'Startup jobs and internships',
        url: 'https://wellfound.com/jobs'
      },
      {
        name: 'LinkedIn Student Jobs',
        emogi: '🔗',
        type: 'Job Board',
        description: 'LinkedIn internship listings',
        url: 'https://www.linkedin.com/jobs/student-jobs'
      }
    ],
    lastUpdated: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  };
}

module.exports = {
  // Company database
  initCompanyDatabase,
  companies,
  ALL_COMPANIES,
  COMPANY_BY_NAME,

  // ID generation
  generateJobId,
  generateJobIdFromUrl,
  generateJobIdHash,
  generateEnhancedId,
  migrateOldJobId,

  // Deduplication
  generateJobFingerprint,
  generateMinimalJobFingerprint,

  // Company utilities
  normalizeCompanyNameStr,
  normalizeCompanyName,
  getCompanyEmoji,
  getCompanyCareerUrl,

  // Formatting
  formatTimeAgo,
  formatLocation,

  // Filtering
  isJobOlderThanWeek,
  isUSOnlyJob,

  // Classification
  getExperienceLevel,
  getJobCategory,

  // Utilities
  delay,
  fetchInternshipData
};
