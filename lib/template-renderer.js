/**
 * Template Rendering Module
 *
 * Replaces {placeholders} in template strings with actual values
 * Version: 1.0 (2026-02-12)
 */

/**
 * Replaces template variables in a string
 *
 * Supported variables:
 * - {totalCompanies} - Unique company count
 * - {currentJobs} - Active job count
 *
 * @param {string} template - Template string with {placeholders}
 * @param {Object} vars - Variables to replace
 * @param {number} vars.totalCompanies - Number of unique companies
 * @param {number} vars.currentJobs - Number of current jobs
 * @returns {string} Rendered string with placeholders replaced
 *
 * @example
 * renderTemplate(
 *   'Jobs from {totalCompanies}+ companies with {currentJobs}+ openings',
 *   { totalCompanies: 80, currentJobs: 250 }
 * )
 * // Returns: 'Jobs from 80+ companies with 250+ openings'
 */
function renderTemplate(template, vars) {
  if (!template || typeof template !== 'string') {
    return template;
  }

  let result = template;

  // Replace {totalCompanies}
  if (vars.totalCompanies !== undefined) {
    result = result.replace(/{totalCompanies}/g, vars.totalCompanies);
  }

  // Replace {currentJobs}
  if (vars.currentJobs !== undefined) {
    result = result.replace(/{currentJobs}/g, vars.currentJobs);
  }

  return result;
}

/**
 * Renders all template strings in a config object
 *
 * Only processes descriptionLine1 and descriptionLine2 fields
 *
 * @param {Object} config - Config object with template strings
 * @param {Object} vars - Variables to replace
 * @returns {Object} New config object with templates rendered
 *
 * @example
 * const config = {
 *   descriptionLine1: 'Jobs from {totalCompanies}+ companies',
 *   descriptionLine2: 'With {currentJobs}+ openings'
 * };
 * const rendered = renderConfigTemplates(config, { totalCompanies: 80, currentJobs: 250 });
 * // rendered.descriptionLine1: 'Jobs from 80+ companies'
 * // rendered.descriptionLine2: 'With 250+ openings'
 */
function renderConfigTemplates(config, vars) {
  const rendered = { ...config };

  // Render description templates
  if (rendered.descriptionLine1) {
    rendered.descriptionLine1 = renderTemplate(rendered.descriptionLine1, vars);
  }

  if (rendered.descriptionLine2) {
    rendered.descriptionLine2 = renderTemplate(rendered.descriptionLine2, vars);
  }

  return rendered;
}

/**
 * Checks if a string contains template variables
 *
 * @param {string} str - String to check
 * @returns {boolean} True if string contains {placeholders}
 *
 * @example
 * hasTemplateVariables('Jobs from {totalCompanies}+ companies')  // true
 * hasTemplateVariables('Static text')  // false
 */
function hasTemplateVariables(str) {
  if (!str || typeof str !== 'string') {
    return false;
  }

  return /{(totalCompanies|currentJobs)}/.test(str);
}

/**
 * Extracts template variable names from a string
 *
 * @param {string} str - String to extract from
 * @returns {string[]} Array of variable names found
 *
 * @example
 * extractTemplateVariables('Jobs from {totalCompanies}+ with {currentJobs}+')
 * // Returns: ['totalCompanies', 'currentJobs']
 */
function extractTemplateVariables(str) {
  if (!str || typeof str !== 'string') {
    return [];
  }

  const regex = /{(totalCompanies|currentJobs)}/g;
  const matches = [];
  let match;

  while ((match = regex.exec(str)) !== null) {
    if (!matches.includes(match[1])) {
      matches.push(match[1]);
    }
  }

  return matches;
}

module.exports = {
  renderTemplate,
  renderConfigTemplates,
  hasTemplateVariables,
  extractTemplateVariables
};
