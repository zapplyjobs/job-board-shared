/**
 * @zapply/job-board-shared - API Limits Configuration
 *
 * Centralized API rate limits, retry logic, and processing limits
 */

module.exports = {
  // JSearch API limits
  jsearch: {
    quota: {
      jobsPerDay: 90,
      requestsPerDay: 100
    },
    retry: {
      maxAttempts: 5,
      backoffMs: 1000,
      backoffMultiplier: 2
    }
  },

  // Processing limits
  processing: {
    maxJobsPerRun: 20,
    batchSize: 50,
    timeoutMinutes: 30
  },

  // Rate limiting per domain
  domains: {
    'jsearch.org': {
      requestsPerMinute: 10,
      requestsPerHour: 100
    },
    'linkedin.com': {
      requestsPerMinute: 5,
      requestsPerHour: 30
    },
    'indeed.com': {
      requestsPerMinute: 5,
      requestsPerHour: 20
    },
    'wellfound.com': {
      requestsPerMinute: 10,
      requestsPerHour: 50
    }
  },

  // Default limits for unknown domains
  default: {
    requestsPerMinute: 5,
    requestsPerHour: 30,
    concurrent: 2
  },

  // Retry configuration
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryableStatusCodes: [408, 429, 500, 502, 503, 504]
  },

  // Socket hang up specific retry
  socketHangUp: {
    maxRetries: 5,
    retryDelayMs: 2000,
    backoff: true
  }
};
