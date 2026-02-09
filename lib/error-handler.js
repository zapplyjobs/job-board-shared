/**
 * @zapply/job-board-shared - Error Handler
 *
 * Centralized error handling utilities for consistent error management
 */

const logger = require('./logger');

/**
 * Wrap an async function with error handling
 */
async function tryCatch(fn, operation, context = {}) {
  try {
    return await fn();
  } catch (error) {
    logger.logError(error, operation, context);
    throw error; // Re-throw after logging
  }
}

/**
 * Wrap an async function with retry logic
 */
async function withRetry(fn, operation, config = {}, context = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    retryableErrors = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'SOCKET']
  } = config;

  let lastError;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`Attempt ${attempt}/${maxAttempts} for ${operation}`, context);
      const result = await fn();

      if (attempt > 1) {
        logger.info(`Success after ${attempt} attempts for ${operation}`, { ...context, attempt });
      }

      return result;
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      const isRetryable = retryableErrors.some(retryable =>
        error.code === retryable ||
        error.message.includes(retryable) ||
        error.message.includes('socket') ||
        error.message.includes('timeout')
      );

      if (!isRetryable || attempt >= maxAttempts) {
        logger.error(`Failed after ${attempt} attempts for ${operation}`, {
          ...context,
          error: error.message,
          isRetryable
        });
        throw error;
      }

      // Log retry
      logger.warn(`Retry ${attempt + 1}/${maxAttempts} for ${operation} after ${delay}ms`, {
        ...context,
        error: error.message
      });

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Execute multiple async operations in parallel with error isolation
 */
async function parallel(operations, context = {}) {
  const results = await Promise.allSettled(operations);

  const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const rejected = results.filter(r => r.status === 'rejected').map(r => r.reason);

  if (rejected.length > 0) {
    logger.warn(`${rejected.length}/${results.length} operations failed`, {
      ...context,
      failures: rejected.map(e => e.message)
    });
  }

  return { fulfilled, rejected, results };
}

/**
 * Validate required parameters
 */
function validateParams(params, required, operation) {
  const missing = required.filter(param => !params[param]);

  if (missing.length > 0) {
    const error = new Error(`Missing required parameters: ${missing.join(', ')}`);
    logger.error(`Validation failed for ${operation}`, { missing, params });
    throw error;
  }

  return true;
}

/**
 * Create a context-aware error handler
 */
function createHandler(operation) {
  return {
    async execute(fn, context = {}) {
      return tryCatch(fn, operation, context);
    },

    async retry(fn, config, context = {}) {
      return withRetry(fn, operation, config, context);
    },

    validate(params, required) {
      return validateParams(params, required, operation);
    }
  };
}

module.exports = {
  tryCatch,
  withRetry,
  parallel,
  validateParams,
  createHandler,
  logger
};
