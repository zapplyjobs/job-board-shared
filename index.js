/**
 * @zapply/job-board-shared
 *
 * Shared utilities, configurations, and functions for Zapply job board repositories
 *
 * Usage:
 * const shared = require('@zapply/job-board-shared');
 * const { generateJobId, formatTimeAgo, logger } = shared;
 */

const utils = require('./lib/utils');
const config = require('./config');
const linkHealth = require('./lib/link-health-filter');

// Minimal logger — lib/logger.js was removed in N-6 cleanup
const _log = (level, msg, ctx) => {
  const ts = new Date().toISOString();
  const ctxStr = ctx && Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
  console.log(`[${ts}] [${level}]${ctxStr} ${msg}`);
};
const _logger = {
  debug:    (msg, ctx) => _log('DEBUG', msg, ctx),
  info:     (msg, ctx) => _log('INFO',  msg, ctx),
  warn:     (msg, ctx) => _log('WARN',  msg, ctx),
  error:    (msg, ctx) => _log('ERROR', msg, ctx),
  fatal:    (msg, ctx) => { _log('FATAL', msg, ctx); },
  start:    (msg, ctx) => _log('START', msg, ctx),
  complete: (msg, ctx) => _log('DONE',  msg, ctx),
  logError: (msg, ctx) => _log('ERROR', msg, ctx),
};

module.exports = {
  // Utilities
  ...utils,

  // Configuration
  ...config,

  // Logger
  logger: _logger,

  // Link health
  ...linkHealth,
};

// Export specific functions for convenience
module.exports.generateJobId = utils.generateJobId;
module.exports.generateJobIdFromUrl = utils.generateJobIdFromUrl;
module.exports.generateJobIdHash = utils.generateJobIdHash;
module.exports.generateEnhancedId = utils.generateEnhancedId;
module.exports.migrateOldJobId = utils.migrateOldJobId;

module.exports.generateJobFingerprint = utils.generateJobFingerprint;
module.exports.generateMinimalJobFingerprint = utils.generateMinimalJobFingerprint;

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
