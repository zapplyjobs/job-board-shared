/**
 * @zapply/job-board-shared - Job Deduplication
 *
 * Fingerprint-based deduplication strategy to prevent duplicate job postings
 * Uses multiple methods to detect duplicates across different sources
 */

const crypto = require('crypto');
const { generateJobId } = require('./jobId');

/**
 * Generate a fingerprint for a job posting
 *
 * The fingerprint combines multiple attributes to create a unique signature:
 * - Company name
 * - Job title
 * - Location
 * - Experience level
 * - Employment type
 *
 * Jobs with the same fingerprint are considered duplicates.
 *
 * @param {Object} job - Job data object
 * @returns {string} - Job fingerprint (hex hash)
 *
 * @example
 * generateFingerprint({
 *   company: 'Google',
 *   title: 'Software Engineer',
 *   location: 'Mountain View, CA',
 *   experience_level: 'Entry',
 *   employment_type: 'Full-time'
 * });
 * // Returns: 'abc123...'
 */
function generateFingerprint(job) {
  if (!job) {
    throw new Error('Job object is required');
  }

  const parts = [
    job.company || '',
    job.title || '',
    job.location || '',
    job.experience_level || '',
    job.employment_type || ''
  ];

  // Normalize and join parts
  const normalized = parts
    .map(p => p.toLowerCase().trim())
    .join('|');

  // Create SHA-256 hash
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Check if a job is a duplicate of existing jobs
 *
 * Uses both ID and fingerprint for robust deduplication:
 * - ID: Fast check for exact matches
 * - Fingerprint: Detects similar jobs (e.g., same posting from different sources)
 *
 * @param {Object} job - Job to check
 * @param {Array} existingJobs - Array of existing jobs with id and fingerprint
 * @returns {Object} - { isDuplicate: boolean, match: Object|null, reason: string }
 *
 * @example
 * const result = isDuplicate(newJob, existingJobs);
 * if (result.isDuplicate) {
 *   console.log('Duplicate found:', result.match.id, result.reason);
 * }
 */
function isDuplicate(job, existingJobs) {
  if (!job || !Array.isArray(existingJobs)) {
    return { isDuplicate: false, match: null, reason: 'Invalid input' };
  }

  // Generate ID and fingerprint for the job
  const jobId = generateJobId(job);
  const fingerprint = generateFingerprint(job);

  // Check 1: Exact ID match
  const idMatch = existingJobs.find(j => j.id === jobId);
  if (idMatch) {
    return {
      isDuplicate: true,
      match: idMatch,
      reason: 'ID match (same company, title, location)'
    };
  }

  // Check 2: Fingerprint match (similar job, possibly from different source)
  const fingerprintMatch = existingJobs.find(j => j.fingerprint === fingerprint);
  if (fingerprintMatch) {
    return {
      isDuplicate: true,
      match: fingerprintMatch,
      reason: 'Fingerprint match (similar job attributes)'
    };
  }

  return { isDuplicate: false, match: null, reason: 'No match found' };
}

/**
 * Filter duplicates from an array of jobs
 *
 * Returns only unique jobs, removing duplicates based on:
 * 1. Job ID (exact match)
 * 2. Fingerprint (similar jobs)
 *
 * @param {Array} jobs - Array of job objects
 * @returns {Array} - Array of unique jobs with id and fingerprint added
 *
 * @example
 * const jobs = [job1, job2, job3, duplicateJob1];
 * const uniqueJobs = filterDuplicates(jobs);
 * // Returns: [job1, job2, job3] (with duplicateJob1 removed)
 */
function filterDuplicates(jobs) {
  if (!Array.isArray(jobs)) return [];

  const seen = new Set(); // Track seen IDs
  const seenFingerprints = new Set(); // Track seen fingerprints
  const uniqueJobs = [];

  for (const job of jobs) {
    // Add ID and fingerprint to each job
    job.id = job.id || generateJobId(job);
    job.fingerprint = job.fingerprint || generateFingerprint(job);

    // Skip if we've seen this ID or fingerprint
    if (seen.has(job.id) || seenFingerprints.has(job.fingerprint)) {
      continue;
    }

    seen.add(job.id);
    seenFingerprints.add(job.fingerprint);
    uniqueJobs.push(job);
  }

  return uniqueJobs;
}

/**
 * Add ID and fingerprint to a job object
 *
 * Utility function to enrich job data with unique identifiers.
 *
 * @param {Object} job - Job object
 * @returns {Object} - Job object with id and fingerprint added
 */
function enrichJob(job) {
  if (!job) return null;

  return {
    ...job,
    id: job.id || generateJobId(job),
    fingerprint: job.fingerprint || generateFingerprint(job)
  };
}

module.exports = {
  generateFingerprint,
  isDuplicate,
  filterDuplicates,
  enrichJob
};
