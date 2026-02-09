/**
 * @zapply/job-board-shared - Structured Logging
 *
 * Centralized logging utility for consistent, parseable logs
 * Replaces console.* throughout the codebase
 */

const fs = require('fs');
const path = require('path');

// Log levels
const Levels = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

// Log level colors for terminal output
const Colors = {
  DEBUG: '\x1b[36m', // Cyan
  INFO: '\x1b[32m',  // Green
  WARN: '\x1b[33m',  // Yellow
  ERROR: '\x1b[31m', // Red
  FATAL: '\x1b[35m', // Magenta
  RESET: '\x1b[0m'
};

// Current log level (default to INFO, can be configured)
let currentLevel = Levels.INFO;
let logToFile = false;
let logFilePath = null;

/**
 * Set the minimum log level
 */
function setLevel(level) {
  const levelStr = level.toUpperCase();
  if (Levels.hasOwnProperty(levelStr)) {
    currentLevel = Levels[levelStr];
  }
}

/**
 * Enable file logging
 */
function enableFileLogging(filePath) {
  logToFile = true;
  logFilePath = filePath;
}

/**
 * Format log message with timestamp and level
 */
function formatMessage(level, message, context = {}) {
  const timestamp = new Date().toISOString();
  const contextStr = Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  return `[${timestamp}] [${level}]${contextStr} ${message}`;
}

/**
 * Write log to file if enabled
 */
function writeToFile(formattedMessage) {
  if (!logToFile || !logFilePath) return;

  try {
    fs.appendFileSync(logFilePath, formattedMessage + '\n');
  } catch (err) {
    // Silently fail to avoid infinite loop
  }
}

/**
 * Core logging function
 */
function log(level, levelName, message, context) {
  if (level < currentLevel) return;

  const formattedMessage = formatMessage(levelName, message, context);
  const color = Colors[levelName];

  // Console output with color
  console.log(`${color}${formattedMessage}${Colors.RESET}`);

  // File output without color
  writeToFile(formattedMessage);
}

/**
 * Debug level logging
 */
function debug(message, context) {
  log(Levels.DEBUG, 'DEBUG', message, context);
}

/**
 * Info level logging
 */
function info(message, context) {
  log(Levels.INFO, 'INFO', message, context);
}

/**
 * Warning level logging
 */
function warn(message, context) {
  log(Levels.WARN, 'WARN', message, context);
}

/**
 * Error level logging
 */
function error(message, context) {
  log(Levels.ERROR, 'ERROR', message, context);
}

/**
 * Fatal level logging
 */
function fatal(message, context) {
  log(Levels.FATAL, 'FATAL', message, context);
}

/**
 * Log the start of a process/operation
 */
function start(operation, context = {}) {
  info(`Starting: ${operation}`, context);
}

/**
 * Log the completion of a process/operation
 */
function complete(operation, context = {}, duration = null) {
  const contextStr = duration ? { ...context, duration } : context;
  info(`Completed: ${operation}`, contextStr);
}

/**
 * Log an error with context
 */
function logError(err, operation, context = {}) {
  const errorContext = {
    operation,
    ...context,
    error: err.message,
    stack: err.stack
  };

  if (err.stack) {
    errorContext.stack = err.stack.split('\n').slice(0, 3).join('\n'); // First 3 lines only
  }

  error(`Error in ${operation}: ${err.message}`, errorContext);
}

/**
 * Create a child logger with bound context
 */
function createChild(defaultContext) {
  return {
    debug: (message, context) => debug(message, { ...defaultContext, ...context }),
    info: (message, context) => info(message, { ...defaultContext, ...context }),
    warn: (message, context) => warn(message, { ...defaultContext, ...context }),
    error: (message, context) => error(message, { ...defaultContext, ...context }),
    fatal: (message, context) => fatal(message, { ...defaultContext, ...context }),
    start: (operation, context) => start(operation, { ...defaultContext, ...context }),
    complete: (operation, context, duration) => complete(operation, { ...defaultContext, ...context }, duration)
  };
}

/**
 * Time a function execution
 */
async function timeit(promise, operation, context = {}) {
  const startTime = Date.now();
  start(operation, context);

  try {
    const result = await promise;
    const duration = Date.now() - startTime;
    complete(operation, context, duration);
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    logError(error, operation, { ...context, duration });
    throw error;
  }
}

module.exports = {
  // Log levels
  Levels,
  setLevel,
  enableFileLogging,

  // Logging functions
  debug,
  info,
  warn,
  error,
  fatal,

  // Operation helpers
  start,
  complete,
  logError,

  // Advanced features
  createChild,
  timeit,

  // Convenience: create default logger instance
  default: {
    debug,
    info,
    warn,
    error,
    fatal,
    start,
    complete,
    logError
  }
};
