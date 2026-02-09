/**
 * @zapply/job-board-shared
 *
 * Shared utilities, configurations, and functions for Zapply job board repositories
 *
 * Usage:
 * const shared = require('@zapply/job-board-shared');
 * const { generateJobId, isDuplicate, formatTimeAgo, logger, withRetry } = shared;
 */

const jobId = require('./lib/jobId');
const deduplication = require('./lib/deduplication');
const utils = require('./lib/utils');
const config = require('./config');
const logger = require('./lib/logger');
const errorHandler = require('./lib/error-handler');

module.exports = {
  // Job ID generation
  ...jobId,

  // Deduplication
  ...deduplication,

  // Utilities
  ...utils,

  // Configuration
  ...config,

  // Logging
  ...logger,

  // Error handling
  ...errorHandler
};

// Export specific functions for convenience
module.exports.generateJobId = utils.generateJobId;
module.exports.generateJobIdFromUrl = utils.generateJobIdFromUrl;
module.exports.generateJobIdHash = utils.generateJobIdHash;
module.exports.generateEnhancedId = utils.generateEnhancedId;
module.exports.migrateOldJobId = utils.migrateOldJobId;

module.exports.generateFingerprint = deduplication.generateFingerprint;
module.exports.generateJobFingerprint = utils.generateJobFingerprint;
module.exports.generateMinimalJobFingerprint = utils.generateMinimalJobFingerprint;
module.exports.isDuplicate = deduplication.isDuplicate;
module.exports.filterDuplicates = deduplication.filterDuplicates;
module.exports.enrichJob = deduplication.enrichJob;

module.exports.normalizeCompanyName = utils.normalizeCompanyName;
module.exports.getCompanyEmoji = utils.getCompanyEmoji;
module.exports.getCompanyCareerUrl = utils.getCompanyCareerUrl;

module.exports.formatTimeAgo = utils.formatTimeAgo;
module.exports.formatLocation = utils.formatLocation;

module.exports.isJobOlderThanWeek = utils.isJobOlderThanWeek;
module.exports.isUSOnlyJob = utils.isUSOnlyJob;

module.exports.getExperienceLevel = utils.getExperienceLevel;
module.exports.getJobCategory = utils.getJobCategory;

module.exports.delay = utils.delay;
module.exports.initCompanyDatabase = utils.initCompanyDatabase;

// Export config
module.exports.config = config;

// Export logger
module.exports.logger = logger.default;
module.exports.createChildLogger = logger.createChild;

// Export error handler
module.exports.tryCatch = errorHandler.tryCatch;
module.exports.withRetry = errorHandler.withRetry;
module.exports.parallel = errorHandler.parallel;
module.exports.validateParams = errorHandler.validateParams;
module.exports.createHandler = errorHandler.createHandler;
