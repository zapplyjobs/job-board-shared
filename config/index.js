/**
 * @zapply/job-board-shared - Configuration Index
 *
 * Centralized configuration exports
 */

const apiLimits = require('./api-limits');
const categories = require('./categories');
const locations = require('./locations');

module.exports = {
  // API limits and retry logic
  api: apiLimits,

  // Job categories and classification
  categories: categories,

  // Location filters and US states/cities
  locations: locations,

  // Convenience exports
  jsearchLimits: apiLimits.jsearch,
  processingLimits: apiLimits.processing,
  retryConfig: apiLimits.retry,
  socketHangUp: apiLimits.socketHangUp,  // Add this export
  jobCategories: categories.categories,
  experienceLevels: categories.experienceLevels,
  usStates: locations.usStates,
  usCities: locations.usCities
};
