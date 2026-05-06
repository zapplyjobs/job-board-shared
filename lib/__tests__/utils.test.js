/**
 * Unit tests for utils.js
 * Target: 85% coverage
 */

const utils = require('../utils');

describe('Utils Module', () => {
  describe('Company Database', () => {
    test('initCompanyDatabase() initializes company data structures', () => {
      const companiesData = {
        'FAANG': [
          { name: 'Google', api_names: ['google llc', 'alphabet'], emoji: '🔍', career_url: 'https://careers.google.com' },
          { name: 'Meta', api_names: ['facebook', 'meta platforms'], emoji: '👍', career_url: 'https://metacareers.com' }
        ]
      };

      utils.initCompanyDatabase(companiesData);

      // Check that database was populated
      const allCompanies = utils.ALL_COMPANIES;
      const companyByName = utils.COMPANY_BY_NAME;

      expect(allCompanies.length).toBe(2);
      expect(companyByName['google']).toBeDefined();
      expect(companyByName['facebook']).toBeDefined();
      expect(companyByName['google'].name).toBe('Google');
    });

    test('initCompanyDatabase() handles null input', () => {
      utils.initCompanyDatabase(null);
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('ID Generation', () => {
    test('generateJobIdFromUrl() extracts ID from URL', () => {
      const job = {
        url: 'https://jobs.lever.co/example/abc-123-software-engineer'
      };

      const id = utils.generateJobIdFromUrl(job);

      expect(id).toContain('jobs-lever-co');
      expect(id).toContain('example');
      expect(id).toContain('abc-123-software-engineer');
    });

    test('generateJobIdFromUrl() falls back to enhanced ID for invalid URL', () => {
      const job = {
        url: 'invalid-url',
        company_name: 'Google',
        title: 'Software Engineer',
        job_city: 'San Francisco'
      };

      const id = utils.generateJobIdFromUrl(job);

      expect(id).toContain('google');
      expect(id).toContain('software-engineer');
    });

    test('generateJobIdFromUrl() uses enhanced ID when no URL', () => {
      const job = {
        company_name: 'Google',
        title: 'Software Engineer',
        job_city: 'Mountain View'
      };

      const id = utils.generateJobIdFromUrl(job);

      expect(id).toContain('google');
      expect(id).toContain('software-engineer');
      expect(id).toContain('mountain-view');
    });

    test('generateEnhancedId() normalizes Roman numerals', () => {
      const job = {
        company_name: 'Example Corp',
        title: 'Software Engineer I',
        job_city: 'Seattle'
      };

      const id = utils.generateEnhancedId(job);

      expect(id).toContain('1'); // I -> 1
    });

    test('generateEnhancedId() normalizes abbreviations', () => {
      const job = {
        company_name: 'Example Corp',
        title: 'Sr. Software Engineer',
        job_city: 'Austin'
      };

      const id = utils.generateEnhancedId(job);

      expect(id).toContain('senior');
    });

    test('generateEnhancedId() strips company suffixes', () => {
      const job = {
        company_name: 'Example Inc.',
        title: 'Engineer',
        job_city: 'NYC'
      };

      const id = utils.generateEnhancedId(job);

      expect(id).not.toContain('inc');
    });

    test('generateEnhancedId() handles locations array', () => {
      const job = {
        company_name: 'Google',
        title: 'Engineer',
        locations: ['San Francisco', 'Seattle']
      };

      const id = utils.generateEnhancedId(job);

      expect(id).toContain('san-francisco'); // Uses first location
    });

    test('generateEnhancedId() handles employer_name field', () => {
      const job = {
        employer_name: 'Meta',
        job_title: 'Engineer',
        location: 'Menlo Park'
      };

      const id = utils.generateEnhancedId(job);

      expect(id).toContain('meta');
      expect(id).toContain('engineer');
    });

    test('generateJobIdHash() creates consistent 8-char hash', () => {
      const job = {
        company_name: 'Google',
        title: 'Software Engineer',
        location: 'San Francisco'
      };

      const hash1 = utils.generateJobIdHash(job);
      const hash2 = utils.generateJobIdHash(job);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(8);
      expect(/^[0-9a-f]{8}$/.test(hash1)).toBe(true);
    });

    test('generateJobId() uses URL-based ID', () => {
      const job = {
        url: 'https://example.com/jobs/123',
        company_name: 'Example'
      };

      const id = utils.generateJobId(job);

      expect(id).toContain('example-com');
    });

    test('migrateOldJobId() normalizes old format', () => {
      const oldId = 'google@software#engineer-2024';
      const newId = utils.migrateOldJobId(oldId);

      // Special characters become dashes, multiple dashes collapsed
      expect(newId).toContain('google');
      expect(newId).toContain('software');
      expect(newId).toContain('engineer');
      expect(newId).not.toContain('@');
      expect(newId).not.toContain('#');
    });
  });

  describe('Fingerprint Generation', () => {
    test('generateJobFingerprint() creates deduplication key', () => {
      const job = {
        company_name: 'Google',
        title: 'Senior Software Engineer',
        location: 'San Francisco, CA'
      };

      const fingerprint = utils.generateJobFingerprint(job);

      expect(fingerprint).toContain('google');
      expect(fingerprint).toContain('software engineer'); // 'senior' removed
      expect(fingerprint).toContain('san francisco');
    });

    test('generateJobFingerprint() removes seniority variations', () => {
      const job1 = {
        company_name: 'Google',
        title: 'Senior Software Engineer',
        location: 'SF'
      };
      const job2 = {
        company_name: 'Google',
        title: 'Software Engineer II',
        location: 'SF'
      };

      const fp1 = utils.generateJobFingerprint(job1);
      const fp2 = utils.generateJobFingerprint(job2);

      // Should be similar (both remove seniority)
      expect(fp1).toContain('software engineer');
      expect(fp2).toContain('software engineer');
    });

    test('generateMinimalJobFingerprint() preserves more details', () => {
      const job = {
        company_name: 'Google',
        title: 'Software Engineer - Backend',
        locations: ['San Francisco, CA']
      };

      const fingerprint = utils.generateMinimalJobFingerprint(job);

      expect(fingerprint).toContain('google');
      expect(fingerprint).toContain('software engineer - backend');
      expect(fingerprint).toContain('san francisco');
    });

    test('generateMinimalJobFingerprint() handles locations array', () => {
      const job = {
        company_name: 'Meta',
        title: 'Engineer',
        locations: ['Menlo Park, CA', 'Seattle, WA']
      };

      const fingerprint = utils.generateMinimalJobFingerprint(job);

      expect(fingerprint).toContain('menlo park'); // Uses first location
    });
  });

  describe('Company Name Normalization', () => {
    test('normalizeCompanyNameStr() removes suffixes', () => {
      expect(utils.normalizeCompanyNameStr('Google Inc.')).toBe('google');
      expect(utils.normalizeCompanyNameStr('Meta LLC')).toBe('meta');
      expect(utils.normalizeCompanyNameStr('Apple Corp.')).toBe('apple');
      expect(utils.normalizeCompanyNameStr('Amazon Limited')).toBe('amazon');
    });

    test('normalizeCompanyNameStr() handles empty input', () => {
      expect(utils.normalizeCompanyNameStr('')).toBe('');
      expect(utils.normalizeCompanyNameStr(null)).toBe('');
      expect(utils.normalizeCompanyNameStr(undefined)).toBe('');
    });

    test('normalizeCompanyName() uses database', () => {
      const companiesData = {
        'Tech': [
          { name: 'Google', api_names: ['alphabet'], emoji: '🔍', career_url: '' }
        ]
      };
      utils.initCompanyDatabase(companiesData);

      expect(utils.normalizeCompanyName('alphabet')).toBe('Google');
      expect(utils.normalizeCompanyName('unknown')).toBe('unknown');
    });

    test('getCompanyEmoji() returns emoji from database', () => {
      const companiesData = {
        'Tech': [
          { name: 'Google', api_names: [], emoji: '🔍', career_url: '' }
        ]
      };
      utils.initCompanyDatabase(companiesData);

      expect(utils.getCompanyEmoji('Google')).toBe('🔍');
      expect(utils.getCompanyEmoji('Unknown')).toBe('🏢');
    });

    test('getCompanyCareerUrl() returns URL from database', () => {
      const companiesData = {
        'Tech': [
          { name: 'Google', api_names: [], emoji: '', career_url: 'https://careers.google.com' }
        ]
      };
      utils.initCompanyDatabase(companiesData);

      expect(utils.getCompanyCareerUrl('Google')).toBe('https://careers.google.com');
      expect(utils.getCompanyCareerUrl('Unknown')).toBe('#');
    });
  });

  describe('Time Formatting', () => {
    test('formatTimeAgo() formats hours', () => {
      const now = new Date();
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);

      expect(utils.formatTimeAgo(twoHoursAgo.toISOString())).toBe('2h');
    });

    test('formatTimeAgo() formats days', () => {
      const now = new Date();
      const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);

      expect(utils.formatTimeAgo(threeDaysAgo.toISOString())).toBe('3d');
    });

    test('formatTimeAgo() formats weeks', () => {
      const now = new Date();
      const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

      expect(utils.formatTimeAgo(twoWeeksAgo.toISOString())).toBe('2w');
    });

    test('formatTimeAgo() formats months', () => {
      const now = new Date();
      const twoMonthsAgo = new Date(now - 60 * 24 * 60 * 60 * 1000);

      expect(utils.formatTimeAgo(twoMonthsAgo.toISOString())).toBe('2mo');
    });

    test('formatTimeAgo() handles null input', () => {
      expect(utils.formatTimeAgo(null)).toBe('Recently');
      expect(utils.formatTimeAgo('')).toBe('Recently');
    });

    test('isJobOlderThanWeek() detects old jobs (ISO dates)', () => {
      const now = new Date();
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
      const fifteenDaysAgo = new Date(now - 15 * 24 * 60 * 60 * 1000);

      expect(utils.isJobOlderThanWeek(tenDaysAgo.toISOString())).toBe(false);
      expect(utils.isJobOlderThanWeek(fifteenDaysAgo.toISOString())).toBe(true);
    });

    test('isJobOlderThanWeek() handles relative formats', () => {
      expect(utils.isJobOlderThanWeek('1d')).toBe(false);
      expect(utils.isJobOlderThanWeek('15d')).toBe(true);
      expect(utils.isJobOlderThanWeek('1w')).toBe(false);
      expect(utils.isJobOlderThanWeek('2w')).toBe(true);
      expect(utils.isJobOlderThanWeek('1m')).toBe(true); // 'm' for month (matches 'mo' case)
      expect(utils.isJobOlderThanWeek('336h')).toBe(true); // 336 hours = 14 days
      expect(utils.isJobOlderThanWeek('200h')).toBe(false); // < 336 hours
    });

    test('isJobOlderThanWeek() handles invalid input', () => {
      expect(utils.isJobOlderThanWeek(null)).toBe(false);
      expect(utils.isJobOlderThanWeek('invalid')).toBe(false);
    });
  });

  describe('Location Filtering', () => {
    test('isUSOnlyJob() returns true for US locations', () => {
      const job = {
        job_city: 'San Francisco',
        job_state: 'California'
      };

      expect(utils.isUSOnlyJob(job)).toBe(true);
    });

    test('isUSOnlyJob() returns true for remote jobs', () => {
      const job = {
        job_city: 'Remote',
        job_state: ''
      };

      expect(utils.isUSOnlyJob(job)).toBe(true);
    });

    test('isUSOnlyJob() defaults to true for empty locations (JSearch fix)', () => {
      const job = {
        job_city: '',
        job_state: ''
      };

      // After 2026-02-11 fix: default to true (assume US)
      expect(utils.isUSOnlyJob(job)).toBe(true);
    });

    test('isUSOnlyJob() uses config when provided', () => {
      const config = {
        locations: {
          isNonUS: (loc) => loc.includes('london') || loc.includes('canada'),
          isUS: (loc) => loc.includes('usa') || loc.includes('california')
        }
      };

      const usJob = { job_city: 'San Jose', job_state: 'California' };
      const nonUSJob = { job_city: 'London', job_state: '' };

      expect(utils.isUSOnlyJob(usJob, config)).toBe(true);
      expect(utils.isUSOnlyJob(nonUSJob, config)).toBe(false);
    });
  });

  describe('Experience Level Classification', () => {
    test('getExperienceLevel() detects senior roles', () => {
      expect(utils.getExperienceLevel('Senior Software Engineer')).toBe('Senior');
      expect(utils.getExperienceLevel('Sr. Engineer')).toBe('Senior');
      expect(utils.getExperienceLevel('Lead Developer')).toBe('Senior');
      expect(utils.getExperienceLevel('Principal Engineer')).toBe('Senior');
      expect(utils.getExperienceLevel('Staff Engineer')).toBe('Senior');
    });

    test('getExperienceLevel() detects entry-level roles', () => {
      expect(utils.getExperienceLevel('Junior Engineer')).toBe('Entry-Level');
      expect(utils.getExperienceLevel('Entry Level Developer')).toBe('Entry-Level');
      expect(utils.getExperienceLevel('New Grad Software Engineer')).toBe('Entry-Level');
      expect(utils.getExperienceLevel('Associate Engineer')).toBe('Entry-Level');
      expect(utils.getExperienceLevel('Intern Software Engineer')).toBe('Entry-Level');
    });

    test('getExperienceLevel() defaults to Entry-Level (JSearch fix)', () => {
      // After 2026-02-11 fix: default to Entry-Level instead of Mid-Level
      expect(utils.getExperienceLevel('Software Engineer')).toBe('Entry-Level');
    });

    test('getExperienceLevel() uses description when provided', () => {
      const title = 'Software Engineer';
      const description = 'We are looking for a senior developer with 10 years experience';

      expect(utils.getExperienceLevel(title, description)).toBe('Senior');
    });

    test('getExperienceLevel() uses config when provided', () => {
      const config = {
        categories: {
          experienceLevels: {
            'Senior': ['expert', 'veteran'],
            'Entry-Level': ['beginner', 'newbie'],
            'Mid-Level': ['intermediate']
          }
        }
      };

      expect(utils.getExperienceLevel('Expert Engineer', '', config)).toBe('Senior');
      expect(utils.getExperienceLevel('Beginner Engineer', '', config)).toBe('Entry-Level');
    });
  });

  describe('Job Category Classification', () => {
    test('getJobCategory() detects mobile development', () => {
      expect(utils.getJobCategory('iOS Developer')).toBe('Mobile Development');
      expect(utils.getJobCategory('Android Engineer')).toBe('Mobile Development');
      expect(utils.getJobCategory('Mobile Software Engineer')).toBe('Mobile Development');
    });

    test('getJobCategory() detects frontend development', () => {
      expect(utils.getJobCategory('Frontend Engineer')).toBe('Frontend Development');
      expect(utils.getJobCategory('React Developer')).toBe('Frontend Development');
      expect(utils.getJobCategory('Vue.js Engineer')).toBe('Frontend Development');
    });

    test('getJobCategory() detects backend development', () => {
      expect(utils.getJobCategory('Backend Engineer')).toBe('Backend Development');
      expect(utils.getJobCategory('API Developer')).toBe('Backend Development');
      expect(utils.getJobCategory('Server Engineer')).toBe('Backend Development');
    });

    test('getJobCategory() detects ML/AI roles', () => {
      expect(utils.getJobCategory('Machine Learning Engineer')).toBe('Machine Learning & AI');
      expect(utils.getJobCategory('ML Engineer')).toBe('Machine Learning & AI');
      expect(utils.getJobCategory('AI Researcher')).toBe('Machine Learning & AI');
    });

    test('getJobCategory() detects data roles', () => {
      expect(utils.getJobCategory('Data Scientist')).toBe('Data Science & Analytics');
      expect(utils.getJobCategory('Data Analyst')).toBe('Data Science & Analytics');
    });

    test('getJobCategory() detects DevOps roles', () => {
      expect(utils.getJobCategory('DevOps Engineer')).toBe('DevOps & Infrastructure');
      expect(utils.getJobCategory('Cloud Engineer')).toBe('DevOps & Infrastructure');
      expect(utils.getJobCategory('Infrastructure Engineer')).toBe('DevOps & Infrastructure');
    });

    test('getJobCategory() detects Security roles', () => {
      expect(utils.getJobCategory('Security Engineer')).toBe('Security Engineering');
      expect(utils.getJobCategory('Cybersecurity Analyst')).toBe('Security Engineering');
    });

    test('getJobCategory() detects Product Management', () => {
      expect(utils.getJobCategory('Product Manager')).toBe('Product Management');
      expect(utils.getJobCategory('PM Lead')).toBe('Product Management');
    });

    test('getJobCategory() detects Design roles', () => {
      expect(utils.getJobCategory('UX Designer')).toBe('Design');
      expect(utils.getJobCategory('UI Engineer')).toBe('Design');
    });

    test('getJobCategory() detects Full Stack', () => {
      expect(utils.getJobCategory('Full Stack Developer')).toBe('Full Stack Development');
      expect(utils.getJobCategory('Fullstack Engineer')).toBe('Full Stack Development');
    });

    test('getJobCategory() defaults to Software Engineering', () => {
      expect(utils.getJobCategory('Engineer')).toBe('Software Engineering');
      expect(utils.getJobCategory('Developer')).toBe('Software Engineering');
    });

    test('getJobCategory() uses config when provided', () => {
      const config = {
        categories: {
          keywords: {
            'Blockchain': ['blockchain', 'web3', 'crypto'],
            'Gaming': ['game', 'unity', 'unreal']
          }
        }
      };

      expect(utils.getJobCategory('Blockchain Engineer', '', config)).toBe('Blockchain');
      expect(utils.getJobCategory('Unity Developer', '', config)).toBe('Gaming');
    });

    test('getJobCategory() uses description when provided', () => {
      const title = 'Software Engineer';
      const description = 'We need someone experienced in React and Vue.js';

      expect(utils.getJobCategory(title, description)).toBe('Frontend Development');
    });
  });

  describe('Location Formatting', () => {
    test('formatLocation() formats city and state', () => {
      expect(utils.formatLocation('San Francisco', 'CA')).toBe('San Francisco, CA');
    });

    test('formatLocation() handles missing city', () => {
      expect(utils.formatLocation('', 'CA')).toBe('CA');
    });

    test('formatLocation() handles missing state', () => {
      expect(utils.formatLocation('Seattle', '')).toBe('Seattle');
    });

    test('formatLocation() defaults to Remote', () => {
      expect(utils.formatLocation('', '')).toBe('Remote');
    });

    test('formatLocation() adds emoji for remote', () => {
      expect(utils.formatLocation('Remote', 'CA')).toBe('Remote 🏠');
    });
  });

  describe('Utility Functions', () => {
    test('delay() waits specified time', async () => {
      const start = Date.now();
      await utils.delay(100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow 10ms margin
      expect(elapsed).toBeLessThan(150);
    });

    test('fetchInternshipData() returns data structure', async () => {
      const data = await utils.fetchInternshipData();

      expect(data).toHaveProperty('sources');
      expect(data).toHaveProperty('lastUpdated');
      expect(Array.isArray(data.sources)).toBe(true);
      expect(data.sources.length).toBeGreaterThan(0);
    });
  });

  describe('Module Exports', () => {
    test('exports all required functions', () => {
      expect(utils).toHaveProperty('initCompanyDatabase');
      expect(utils).toHaveProperty('generateJobId');
      expect(utils).toHaveProperty('generateJobFingerprint');
      expect(utils).toHaveProperty('normalizeCompanyNameStr');
      expect(utils).toHaveProperty('formatTimeAgo');
      expect(utils).toHaveProperty('isJobOlderThanWeek');
      expect(utils).toHaveProperty('isUSOnlyJob');
      expect(utils).toHaveProperty('getExperienceLevel');
      expect(utils).toHaveProperty('getJobCategory');
      expect(utils).toHaveProperty('formatLocation');
      expect(utils).toHaveProperty('delay');
    });
  });
});
