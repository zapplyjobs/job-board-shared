/**
 * @zapply/job-board-shared - Job ID Generation
 *
 * Single canonical function for generating consistent job IDs
 * Prevents duplicate job IDs across different job boards
 */

const crypto = require('crypto');

/**
 * Generate a consistent job ID from job data
 *
 * The ID is generated using a hash of:
 * - Company name (normalized)
 * - Job title
 * - Location (optional)
 *
 * This ensures the same job always gets the same ID,
 * regardless of when or where it's processed.
 *
 * @param {Object} job - Job data object
 * @param {string} job.company - Company name
 * @param {string} job.title - Job title
 * @param {string} [job.location] - Job location (optional)
 * @param {string} [job.url] - Job URL (optional, used as fallback)
 * @returns {string} - Consistent job ID (8 character hex)
 *
 * @example
 * generateJobId({
 *   company: 'Google',
 *   title: 'Software Engineer',
 *   location: 'Mountain View, CA'
 * });
 * // Returns: 'a1b2c3d4'
 */
function generateJobId(job) {
  if (!job) {
    throw new Error('Job object is required');
  }

  const company = normalizeCompanyName(job.company);
  const title = normalizeTitle(job.title);
  const location = job.location ? normalizeLocation(job.location) : '';

  // Create hash from normalized job data
  const hashInput = `${company}|${title}|${location}`.toLowerCase().trim();
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

  // Return first 8 characters as ID (collision-resistant for job boards)
  return hash.substring(0, 8);
}

/**
 * Normalize company name for consistent hashing
 * - Removes suffixes (Inc, LLC, Corp, etc.)
 * - Converts to lowercase
 * - Trims whitespace
 *
 * @param {string} company - Raw company name
 * @returns {string} - Normalized company name
 */
function normalizeCompanyName(company) {
  if (!company) return '';

  return company
    .toLowerCase()
    .trim()
    .replace(/\s+(inc|llc|corp|corporation|ltd|limited|gmbh|co|company)\.?$/gi, '')
    .replace(/\s+/g, ' ');
}

/**
 * Normalize job title for consistent hashing
 * - Converts to lowercase
 * - Trims whitespace
 * - Removes extra whitespace
 *
 * @param {string} title - Raw job title
 * @returns {string} - Normalized job title
 */
function normalizeTitle(title) {
  if (!title) return '';

  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Normalize location for consistent hashing
 * - Converts to lowercase
 * - Standardizes state names
 * - Trims whitespace
 *
 * @param {string} location - Raw location
 * @returns {string} - Normalized location
 */
function normalizeLocation(location) {
  if (!location) return '';

  return location
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

module.exports = {
  generateJobId,
  normalizeCompanyName,
  normalizeTitle,
  normalizeLocation
};
