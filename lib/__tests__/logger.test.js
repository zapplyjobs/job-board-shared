/**
 * Unit tests for logger.js
 * Target: 90% coverage
 */

const logger = require('../logger');
const fs = require('fs');
const path = require('path');

describe('Logger', () => {
  let consoleLogSpy;
  let processExitSpy;

  beforeEach(() => {
    // Spy on console.log
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // Spy on process.exit but prevent actual exit
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original functions
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('Log Levels', () => {
    test('debug() logs at DEBUG level', () => {
      logger.setLevel('DEBUG');
      logger.debug('Test debug message');

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('[DEBUG]');
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Test debug message');
    });

    test('info() logs at INFO level', () => {
      logger.setLevel('INFO');
      logger.info('Test info message');

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('[INFO]');
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Test info message');
    });

    test('warn() logs at WARN level', () => {
      logger.setLevel('WARN');
      logger.warn('Test warning message');

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('[WARN]');
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Test warning message');
    });

    test('error() logs at ERROR level', () => {
      logger.setLevel('ERROR');
      logger.error('Test error message');

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('[ERROR]');
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Test error message');
    });

    test('fatal() logs at FATAL level and exits process', () => {
      logger.setLevel('FATAL');
      logger.fatal('Test fatal message');

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('[FATAL]');
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Test fatal message');

      // CRITICAL: Verify process.exit(1) is called
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('Log Level Filtering', () => {
    test('setLevel() filters out lower-level logs', () => {
      logger.setLevel('ERROR');

      logger.debug('Should not appear');
      logger.info('Should not appear');
      logger.warn('Should not appear');
      logger.error('Should appear');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy.mock.calls[0][0]).toContain('[ERROR]');
    });

    test('setLevel() with invalid level is ignored', () => {
      logger.setLevel('INFO');
      logger.setLevel('INVALID_LEVEL');

      logger.info('Test message');
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    test('default log level is INFO', () => {
      logger.setLevel('INFO');

      logger.debug('Should not appear');
      logger.info('Should appear');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Context Handling', () => {
    test('logs with context in CI environment', () => {
      const originalCI = process.env.CI;
      process.env.CI = 'true';

      logger.setLevel('INFO');
      logger.info('Test message', { count: 42, status: 'success' });

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).toContain('"count":42');
      expect(logOutput).toContain('"status":"success"');

      process.env.CI = originalCI;
    });

    test('logs with all context in local environment', () => {
      const originalCI = process.env.CI;
      const originalGithubActions = process.env.GITHUB_ACTIONS;
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      logger.setLevel('INFO');
      logger.info('Test message', { key1: 'value1', key2: 'value2' });

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).toContain('"key1":"value1"');
      expect(logOutput).toContain('"key2":"value2"');

      process.env.CI = originalCI;
      process.env.GITHUB_ACTIONS = originalGithubActions;
    });

    test('handles empty context', () => {
      logger.setLevel('INFO');
      logger.info('Test message', {});

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).toContain('Test message');
    });

    test('handles undefined context', () => {
      logger.setLevel('INFO');
      logger.info('Test message');

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).toContain('Test message');
    });
  });

  describe('Operation Helpers', () => {
    test('start() logs operation start', () => {
      logger.setLevel('INFO');
      logger.start('fetch-jobs');

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Starting: fetch-jobs');
    });

    test('complete() logs operation completion without duration', () => {
      logger.setLevel('INFO');
      logger.complete('fetch-jobs', { count: 10 });

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Completed: fetch-jobs');
    });

    test('complete() logs operation completion with duration', () => {
      // Disable CI mode to see all context including duration
      const originalCI = process.env.CI;
      const originalGithubActions = process.env.GITHUB_ACTIONS;
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      logger.setLevel('INFO');
      logger.complete('fetch-jobs', { count: 10 }, 1500);

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).toContain('Completed: fetch-jobs');
      expect(logOutput).toContain('"duration":1500');

      process.env.CI = originalCI;
      process.env.GITHUB_ACTIONS = originalGithubActions;
    });

    test('logError() logs error with stack trace', () => {
      logger.setLevel('ERROR');
      const error = new Error('Test error');
      logger.logError(error, 'fetch-jobs', { attempt: 1 });

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).toContain('[ERROR]');
      expect(logOutput).toContain('Error in fetch-jobs');
      expect(logOutput).toContain('"error":"Test error"');
    });

    test('logError() handles error without stack', () => {
      logger.setLevel('ERROR');
      const error = { message: 'Simple error' };
      logger.logError(error, 'fetch-jobs');

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Simple error');
    });
  });

  describe('Child Logger', () => {
    test('createChild() creates logger with bound context', () => {
      // Disable CI mode to see all context
      const originalCI = process.env.CI;
      const originalGithubActions = process.env.GITHUB_ACTIONS;
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      logger.setLevel('INFO');
      const child = logger.createChild({ source: 'jsearch' });

      child.info('Test message', { count: 5 });

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).toContain('"source":"jsearch"');
      expect(logOutput).toContain('"count":5');

      process.env.CI = originalCI;
      process.env.GITHUB_ACTIONS = originalGithubActions;
    });

    test('createChild() merges context correctly', () => {
      // Disable CI mode to see all context
      const originalCI = process.env.CI;
      const originalGithubActions = process.env.GITHUB_ACTIONS;
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      logger.setLevel('INFO');
      const child = logger.createChild({ source: 'jsearch', query: 'default' });

      child.info('Test', { query: 'override' });

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).toContain('"source":"jsearch"');
      expect(logOutput).toContain('"query":"override"');

      process.env.CI = originalCI;
      process.env.GITHUB_ACTIONS = originalGithubActions;
    });

    test('createChild() supports all log levels', () => {
      const originalCI = process.env.CI;
      const originalGithubActions = process.env.GITHUB_ACTIONS;
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      logger.setLevel('DEBUG');
      const child = logger.createChild({ source: 'test' });

      child.debug('Debug test');
      child.warn('Warn test');
      child.error('Error test');
      child.fatal('Fatal test');

      expect(consoleLogSpy).toHaveBeenCalledTimes(4);
      expect(processExitSpy).toHaveBeenCalledWith(1);

      process.env.CI = originalCI;
      process.env.GITHUB_ACTIONS = originalGithubActions;
    });

    test('createChild() supports operation helpers', () => {
      const originalCI = process.env.CI;
      const originalGithubActions = process.env.GITHUB_ACTIONS;
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      logger.setLevel('INFO');
      const child = logger.createChild({ source: 'test' });

      child.start('operation');
      child.complete('operation', {}, 100);

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Starting: operation');
      expect(consoleLogSpy.mock.calls[1][0]).toContain('Completed: operation');

      process.env.CI = originalCI;
      process.env.GITHUB_ACTIONS = originalGithubActions;
    });
  });

  describe('Timeit Function', () => {
    test('timeit() logs start and complete with duration', async () => {
      // Disable CI mode to see all context including duration
      const originalCI = process.env.CI;
      const originalGithubActions = process.env.GITHUB_ACTIONS;
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      logger.setLevel('INFO');

      const promise = new Promise(resolve => setTimeout(() => resolve('result'), 100));
      const result = await logger.timeit(promise, 'test-operation');

      expect(result).toBe('result');
      expect(consoleLogSpy).toHaveBeenCalledTimes(2); // start + complete
      expect(consoleLogSpy.mock.calls[0][0]).toContain('Starting: test-operation');
      expect(consoleLogSpy.mock.calls[1][0]).toContain('Completed: test-operation');
      expect(consoleLogSpy.mock.calls[1][0]).toContain('"duration"');

      process.env.CI = originalCI;
      process.env.GITHUB_ACTIONS = originalGithubActions;
    });

    test('timeit() logs error and rethrows on failure', async () => {
      logger.setLevel('ERROR');

      const promise = Promise.reject(new Error('Test error'));

      await expect(
        logger.timeit(promise, 'failing-operation')
      ).rejects.toThrow('Test error');

      expect(consoleLogSpy).toHaveBeenCalled();
      const errorLog = consoleLogSpy.mock.calls.find(call =>
        call[0].includes('[ERROR]')
      );
      expect(errorLog).toBeDefined();
    });
  });

  describe('File Logging', () => {
    const testLogFile = path.join(__dirname, 'test.log');

    afterEach(() => {
      // Clean up test log file
      if (fs.existsSync(testLogFile)) {
        fs.unlinkSync(testLogFile);
      }
    });

    test('enableFileLogging() writes logs to file', () => {
      logger.enableFileLogging(testLogFile);
      logger.setLevel('INFO');
      logger.info('Test file logging');

      expect(fs.existsSync(testLogFile)).toBe(true);
      const content = fs.readFileSync(testLogFile, 'utf8');
      expect(content).toContain('[INFO]');
      expect(content).toContain('Test file logging');
    });

    test('file logging handles write errors gracefully', () => {
      logger.enableFileLogging('/invalid/path/test.log');
      logger.setLevel('INFO');

      // Should not throw
      expect(() => {
        logger.info('Test message');
      }).not.toThrow();

      expect(consoleLogSpy).toHaveBeenCalled();
    });
  });

  describe('Timestamp Format', () => {
    test('logs include ISO 8601 timestamp', () => {
      logger.setLevel('INFO');
      logger.info('Test message');

      expect(consoleLogSpy).toHaveBeenCalled();
      const logOutput = consoleLogSpy.mock.calls[0][0];

      // Check for ISO 8601 format: [YYYY-MM-DDTHH:MM:SS.sssZ]
      expect(logOutput).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });
  });

  describe('Module Exports', () => {
    test('exports all required functions', () => {
      expect(logger).toHaveProperty('debug');
      expect(logger).toHaveProperty('info');
      expect(logger).toHaveProperty('warn');
      expect(logger).toHaveProperty('error');
      expect(logger).toHaveProperty('fatal');
      expect(logger).toHaveProperty('start');
      expect(logger).toHaveProperty('complete');
      expect(logger).toHaveProperty('logError');
      expect(logger).toHaveProperty('createChild');
      expect(logger).toHaveProperty('timeit');
      expect(logger).toHaveProperty('Levels');
      expect(logger).toHaveProperty('setLevel');
      expect(logger).toHaveProperty('enableFileLogging');
    });

    test('Levels object has correct values', () => {
      expect(logger.Levels).toEqual({
        DEBUG: 0,
        INFO: 1,
        WARN: 2,
        ERROR: 3,
        FATAL: 4
      });
    });

    test('default export contains core functions', () => {
      expect(logger.default).toHaveProperty('debug');
      expect(logger.default).toHaveProperty('info');
      expect(logger.default).toHaveProperty('warn');
      expect(logger.default).toHaveProperty('error');
      expect(logger.default).toHaveProperty('fatal');
    });
  });
});
