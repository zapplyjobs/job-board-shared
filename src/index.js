/**
 * @zapplyjobs/job-board-shared
 * Shared utilities for ZapplyJobs job board repositories
 */

// Routing
const { getJobChannelDetails, getJobChannel, isTechRole, isNonTechRole, isAIRole, isDataScienceRole } = require('./routing/router');
const { getJobLocationChannel } = require('./routing/location');

// Utils
const { retryWithBackoff, isRetryableError, discordApiCall, logError } = require('./utils/error-handler');
const { formatPostedDate, cleanJobDescription } = require('./utils/job-formatters');
const { normalizeJob } = require('./utils/job-normalizer');

// Data Management
const PostedJobsManagerV2 = require('./data/posted-jobs-manager-v2');
const SubscriptionManager = require('./data/subscription-manager');

// Logging
const DeduplicationLogger = require('./deduplication-logger');
const DiscordPostLogger = require('./discord-post-logger');

// Encryption
const { encryptLog, decryptLog } = require('./encryption-utils');

module.exports = {
  // Routing - require config injection
  getJobChannelDetails,
  getJobChannel,
  getJobLocationChannel,
  // Role detection helpers
  isTechRole,
  isNonTechRole,
  isAIRole,
  isDataScienceRole,

  // Utils - pure functions
  retryWithBackoff,
  isRetryableError,
  discordApiCall,
  logError,
  formatPostedDate,
  cleanJobDescription,
  normalizeJob,

  // Data Management - class-based
  PostedJobsManagerV2,
  SubscriptionManager,

  // Logging
  DeduplicationLogger,
  DiscordPostLogger,

  // Encryption
  encryptLog,
  decryptLog
};
