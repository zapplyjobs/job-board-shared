/**
 * Config Validation Module
 *
 * Validates job board config files for correctness and completeness
 * Version: 1.0 (2026-02-12)
 */

const fs = require('fs');
const path = require('path');

/**
 * Validates config schema version
 * @param {Object} config - Config object to validate
 * @throws {Error} If version is invalid or unsupported
 */
function validateVersion(config) {
  const SUPPORTED_VERSION = 1;

  if (!config.version) {
    throw new Error('Missing config.version field');
  }

  if (typeof config.version !== 'number') {
    throw new Error(`config.version must be a number, got: ${typeof config.version}`);
  }

  if (config.version !== SUPPORTED_VERSION) {
    throw new Error(`Unsupported config version: ${config.version}. Expected: ${SUPPORTED_VERSION}`);
  }
}

/**
 * Validates required fields are present and non-empty
 * @param {Object} config - Config object to validate
 * @throws {Error} If required fields are missing or invalid
 */
function validateRequiredFields(config) {
  const requiredStringFields = [
    'repoPrefix',
    'headingImageAlt',
    'title',
    'descriptionLine1',
    'noteType',
    'noteText',
    'defaultCategory'
  ];

  for (const field of requiredStringFields) {
    if (!config[field]) {
      throw new Error(`Missing required field: config.${field}`);
    }

    if (typeof config[field] !== 'string') {
      throw new Error(`config.${field} must be a string, got: ${typeof config[field]}`);
    }

    if (config[field].trim() === '') {
      throw new Error(`config.${field} cannot be empty`);
    }
  }

  // Optional string fields (can be empty)
  const optionalStringFields = ['tagline', 'descriptionLine2', 'jobsSectionHeader'];
  for (const field of optionalStringFields) {
    if (config[field] !== undefined && typeof config[field] !== 'string') {
      throw new Error(`config.${field} must be a string if provided, got: ${typeof config[field]}`);
    }
  }

  // Validate features object
  if (!config.features || typeof config.features !== 'object') {
    throw new Error('Missing or invalid config.features object');
  }

  if (typeof config.features.internships !== 'boolean') {
    throw new Error('config.features.internships must be a boolean');
  }

  if (typeof config.features.moreResources !== 'boolean') {
    throw new Error('config.features.moreResources must be a boolean');
  }
}

/**
 * Validates repoPrefix format
 * @param {Object} config - Config object to validate
 * @throws {Error} If repoPrefix format is invalid
 */
function validateRepoPrefix(config) {
  const prefix = config.repoPrefix;

  if (prefix.length < 2) {
    throw new Error(`config.repoPrefix too short: "${prefix}" (minimum 2 characters)`);
  }

  if (!/^[a-z0-9]+$/.test(prefix)) {
    throw new Error(`config.repoPrefix must be lowercase alphanumeric only: "${prefix}"`);
  }
}

/**
 * Validates noteType value
 * @param {Object} config - Config object to validate
 * @throws {Error} If noteType is invalid
 */
function validateNoteType(config) {
  const validTypes = ['NOTE', 'TIP'];

  if (!validTypes.includes(config.noteType)) {
    throw new Error(`config.noteType must be one of: ${validTypes.join(', ')}. Got: "${config.noteType}"`);
  }
}

/**
 * Validates required image files exist
 * @param {Object} config - Config object to validate
 * @param {string} repoRoot - Path to repository root
 * @throws {Error} If required images are missing
 */
function validateImages(config, repoRoot) {
  const requiredImages = [
    `images/${config.repoPrefix}-heading.png`,
    `images/${config.repoPrefix}-listings.png`
  ];

  // Add internship images if feature enabled
  if (config.features.internships) {
    requiredImages.push(`images/${config.repoPrefix}-internships.png`);
    requiredImages.push(`images/${config.repoPrefix}-visit.png`);
  }

  const missingImages = [];

  for (const imgPath of requiredImages) {
    const fullPath = path.join(repoRoot, imgPath);
    if (!fs.existsSync(fullPath)) {
      missingImages.push(imgPath);
    }
  }

  if (missingImages.length > 0) {
    throw new Error(`Missing required images:\n  - ${missingImages.join('\n  - ')}`);
  }
}

/**
 * Validates job_categories.json exists
 * @param {Object} config - Config object to validate
 * @param {string} repoRoot - Path to repository root
 * @throws {Error} If job_categories.json is missing or invalid
 */
function validateCategoriesFile(config, repoRoot) {
  const categoriesPath = path.join(
    repoRoot,
    '.github/scripts/job-fetcher/job_categories.json'
  );

  if (!fs.existsSync(categoriesPath)) {
    throw new Error(`Missing job_categories.json at: ${categoriesPath}`);
  }

  // Load and parse to ensure it's valid JSON
  try {
    const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));

    // Check if defaultCategory exists in categories
    if (!categories[config.defaultCategory]) {
      throw new Error(
        `config.defaultCategory "${config.defaultCategory}" not found in job_categories.json. ` +
        `Available categories: ${Object.keys(categories).join(', ')}`
      );
    }
  } catch (error) {
    if (error.message.includes('defaultCategory')) {
      throw error; // Re-throw our custom error
    }
    throw new Error(`Invalid job_categories.json: ${error.message}`);
  }
}

/**
 * Main validation function - validates entire config
 * @param {Object} config - Config object to validate
 * @param {string} [repoRoot=process.cwd()] - Path to repository root
 * @returns {boolean} True if validation passes
 * @throws {Error} If validation fails
 */
function validateConfig(config, repoRoot = process.cwd()) {
  // Run all validations
  validateVersion(config);
  validateRequiredFields(config);
  validateRepoPrefix(config);
  validateNoteType(config);
  validateImages(config, repoRoot);
  validateCategoriesFile(config, repoRoot);

  return true;
}

module.exports = {
  validateConfig,
  validateVersion,
  validateRequiredFields,
  validateRepoPrefix,
  validateNoteType,
  validateImages,
  validateCategoriesFile
};
