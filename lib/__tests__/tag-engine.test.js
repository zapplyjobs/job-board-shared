/**
 * Regression tests for tag-engine.js
 *
 * Covers: tagEmployment (entry-lock, senior, mid, internship, fake-intern detection)
 *         tagDomains (software keywords, hardware keywords, software-primary guard,
 *                     department rules, O*NET fallback, description phrases)
 *
 * Run: node lib/__tests__/tag-engine.test.js
 * From: job-board-shared/ root
 */

const assert = require('assert');
const { tagEmployment, tagDomains, tagJob } = require('../aggregator/processors/tag-engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function makeJob(title, extra = {}) {
  return { title, ...extra };
}

// ─── tagEmployment ───────────────────────────────────────────────────────────

console.log('\n=== tagEmployment ===');

// Entry-lock patterns (should return entry_level even with senior-sounding words)
test('associate director → senior (OUT-SENIOR-1)', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Director')), 'senior');
});

test('assistant vice president → entry_level (TAG-22)', () => {
  assert.strictEqual(tagEmployment(makeJob('Assistant Vice President')), 'entry_level');
});

test('assistant VP → entry_level (TAG-22)', () => {
  assert.strictEqual(tagEmployment(makeJob('Assistant VP, Technology')), 'entry_level');
});

test('sr. associate → entry_level (TAG-22)', () => {
  assert.strictEqual(tagEmployment(makeJob('Sr. Associate')), 'entry_level');
});

test('associate architect → senior (OUT-SENIOR-1)', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Architect')), 'senior');
});

test('senior associate → entry_level (TAG-24)', () => {
  assert.strictEqual(tagEmployment(makeJob('Senior Associate')), 'entry_level');
});

test('principal associate → entry_level (TAG-24)', () => {
  assert.strictEqual(tagEmployment(makeJob('Principal Associate')), 'entry_level');
});

test('executive assistant → entry_level (TAG-25)', () => {
  assert.strictEqual(tagEmployment(makeJob('Executive Assistant')), 'entry_level');
});

test('senior executive assistant → entry_level (TAG-25)', () => {
  assert.strictEqual(tagEmployment(makeJob('Senior Executive Assistant')), 'entry_level');
});

test('new grad → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('New Grad Software Engineer')), 'entry_level');
});

test('junior → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Junior Developer')), 'entry_level');
});

test('entry-level → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Entry-Level Analyst')), 'entry_level');
});

test('early career → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Early Career Engineer')), 'entry_level');
});

test('campus hire → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Campus Hire Program')), 'entry_level');
});

test('trainee → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Management Trainee')), 'entry_level');
});

// Senior patterns (should return senior)
test('senior → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Senior Software Engineer')), 'senior');
});

test('sr. → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Sr. Developer')), 'senior');
});

test('principal (standalone) → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Principal Engineer')), 'senior');
});

test('staff → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Staff Engineer')), 'senior');
});

test('lead → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Lead Developer')), 'senior');
});

test('director → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Director of Engineering')), 'senior');
});

test('VP → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('VP of Engineering')), 'senior');
});

test('vice president → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Vice President, Technology')), 'senior');
});

test('architect → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Solutions Architect')), 'senior');
});

test('distinguished → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Distinguished Engineer')), 'senior');
});

// Mid-level patterns
test('mid-level → mid_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Mid-Level Engineer')), 'mid_level');
});

test('SDE II → mid_level', () => {
  assert.strictEqual(tagEmployment(makeJob('SDE II')), 'mid_level');
});

test('SWE II → mid_level', () => {
  assert.strictEqual(tagEmployment(makeJob('SWE II')), 'mid_level');
});

test('L4 → mid_level', () => {
  assert.strictEqual(tagEmployment(makeJob('L4 Engineer')), 'mid_level');
});

// Internship patterns
test('internship title → internship', () => {
  assert.strictEqual(tagEmployment(makeJob('Software Engineering Intern')), 'internship');
});

test('intern title → internship', () => {
  assert.strictEqual(tagEmployment(makeJob('Summer Intern')), 'internship');
});

test('co-op title → internship', () => {
  assert.strictEqual(tagEmployment(makeJob('Software Co-op')), 'internship');
});

test('summer 2026 title → internship', () => {
  assert.strictEqual(tagEmployment(makeJob('Summer 2026 Analyst')), 'internship');
});

// Fake internship detection
test('senior intern → NOT internship', () => {
  const result = tagEmployment(makeJob('Senior Intern'));
  assert.notStrictEqual(result, 'internship');
});

test('principal intern → NOT internship', () => {
  const result = tagEmployment(makeJob('Principal Intern'));
  assert.notStrictEqual(result, 'internship');
});

// Default
test('plain software engineer → entry_level (default)', () => {
  assert.strictEqual(tagEmployment(makeJob('Software Engineer')), 'entry_level');
});

test('data scientist → entry_level (default)', () => {
  assert.strictEqual(tagEmployment(makeJob('Data Scientist')), 'entry_level');
});

// Edge cases
test('Internal Medicine → NOT internship', () => {
  assert.notStrictEqual(tagEmployment(makeJob('Internal Medicine Physician')), 'internship');
});

test('associate engineer → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Engineer')), 'entry_level');
});

test('associate analyst → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Analyst')), 'entry_level');
});

test('associate developer → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Developer')), 'entry_level');
});

test('Hawaii → NOT mid_level (word-boundary safety)', () => {
  // "Manager" is NOT in senior keywords — correctly entry_level
  assert.strictEqual(tagEmployment(makeJob('Hawaii Regional Manager')), 'entry_level');
});

// ─── tagDomains ──────────────────────────────────────────────────────────────

console.log('\n=== tagDomains ===');

// Software keywords
test('software engineer → software', () => {
  assert.ok(tagDomains(makeJob('Software Engineer')).includes('software'));
});

test('frontend developer → software', () => {
  assert.ok(tagDomains(makeJob('Frontend Developer')).includes('software'));
});

test('backend engineer → software', () => {
  assert.ok(tagDomains(makeJob('Backend Engineer')).includes('software'));
});

test('devops engineer → software', () => {
  assert.ok(tagDomains(makeJob('DevOps Engineer')).includes('software'));
});

test('full stack developer → software', () => {
  assert.ok(tagDomains(makeJob('Full Stack Developer')).includes('software'));
});

test('data scientist → data_science', () => {
  assert.ok(tagDomains(makeJob('Data Scientist')).includes('data_science'));
});

test('machine learning engineer → ai', () => {
  assert.ok(tagDomains(makeJob('Machine Learning Engineer')).includes('ai'));
});

// Hardware keywords
test('embedded systems engineer → hardware', () => {
  assert.ok(tagDomains(makeJob('Embedded Systems Engineer')).includes('hardware'));
});

test('electrical engineer → hardware', () => {
  assert.ok(tagDomains(makeJob('Electrical Engineer')).includes('hardware'));
});

test('RFIC engineer → hardware (TAG-26)', () => {
  assert.ok(tagDomains(makeJob('RFIC Engineer')).includes('hardware'));
});

test('device physics → hardware (TAG-26)', () => {
  assert.ok(tagDomains(makeJob('Device Physics Engineer')).includes('hardware'));
});

test('hardware reliability → hardware (TAG-26)', () => {
  assert.ok(tagDomains(makeJob('Hardware Reliability Specialist')).includes('hardware'));
});

// Software-primary guard (TAG-22)
test('software test engineer → NOT hardware', () => {
  const domains = tagDomains(makeJob('Software Test Engineer'));
  assert.ok(!domains.includes('hardware'), `Expected no hardware, got: ${domains.join(',')}`);
});

test('software quality engineer → NOT hardware', () => {
  const domains = tagDomains(makeJob('Software Quality Engineer'));
  assert.ok(!domains.includes('hardware'), `Expected no hardware, got: ${domains.join(',')}`);
});

test('embedded systems engineer → hardware (not blocked by guard)', () => {
  const domains = tagDomains(makeJob('Embedded Systems Engineer'));
  assert.ok(domains.includes('hardware'), `Expected hardware, got: ${domains.join(',')}`);
});

// Department-based classification
test('dept: software engineering → software', () => {
  const domains = tagDomains(makeJob('Engineer', { department: 'Software Engineering' }));
  assert.ok(domains.includes('software'));
});

test('dept: data science → ai (DEPT_RULES order: AI rule matches first)', () => {
  const domains = tagDomains(makeJob('Analyst', { department: 'Data Science' }));
  assert.ok(domains.includes('ai'));
});

test('dept: hardware → hardware', () => {
  const domains = tagDomains(makeJob('Engineer', { department: 'Hardware Engineering' }));
  assert.ok(domains.includes('hardware'));
});

test('dept: sales → sales', () => {
  const domains = tagDomains(makeJob('Specialist', { department: 'Sales' }));
  assert.ok(domains.includes('sales'));
});

test('dept: marketing → marketing', () => {
  const domains = tagDomains(makeJob('Manager', { department: 'Marketing' }));
  assert.ok(domains.includes('marketing'));
});

test('dept: finance → finance', () => {
  const domains = tagDomains(makeJob('Analyst', { department: 'Finance' }));
  assert.ok(domains.includes('finance'));
});

test('dept: legal → legal', () => {
  const domains = tagDomains(makeJob('Counsel', { department: 'Legal' }));
  assert.ok(domains.includes('legal'));
});

test('dept: operations → operations', () => {
  const domains = tagDomains(makeJob('Manager', { department: 'Operations' }));
  assert.ok(domains.includes('operations'));
});

test('dept: manufacturing → manufacturing', () => {
  const domains = tagDomains(makeJob('Technician', { department: 'Manufacturing' }));
  assert.ok(domains.includes('manufacturing'));
});

test('dept: nursing → healthcare', () => {
  const domains = tagDomains(makeJob('Nurse', { department: 'Nursing' }));
  assert.ok(domains.includes('healthcare'));
});

// Healthcare keywords
test('registered nurse → healthcare', () => {
  assert.ok(tagDomains(makeJob('Registered Nurse')).includes('healthcare'));
});

test('pharmacy technician → healthcare', () => {
  assert.ok(tagDomains(makeJob('Pharmacy Technician')).includes('healthcare'));
});

test('physical therapist → healthcare', () => {
  assert.ok(tagDomains(makeJob('Physical Therapist')).includes('healthcare'));
});

// General fallback
test('generic title with no keywords → empty or general', () => {
  const domains = tagDomains(makeJob('Specialist I'));
  // Should not falsely classify into a domain
  const techDomains = ['software', 'hardware', 'ai', 'data_science'];
  const falseClassifications = domains.filter(d => techDomains.includes(d));
  assert.strictEqual(falseClassifications.length, 0, `Unexpected tech domains: ${falseClassifications.join(',')}`);
});

// ─── tagJob integration ──────────────────────────────────────────────────────

console.log('\n=== tagJob (integration) ===');

test('tagJob adds tags property', () => {
  const job = tagJob(makeJob('Software Engineer'));
  assert.ok(job.tags, 'tagJob should add tags property');
  assert.ok(job.tags.domains, 'tags should have domains');
  assert.strictEqual(job.tags.employment, 'entry_level');
});

test('tagJob internship detection', () => {
  const job = tagJob(makeJob('Summer 2026 Software Engineering Intern'));
  assert.strictEqual(job.tags.employment, 'internship');
});

test('tagJob senior + software domain', () => {
  const job = tagJob(makeJob('Senior Software Engineer'));
  assert.strictEqual(job.tags.employment, 'senior');
  assert.ok(job.tags.domains.includes('software'));
});

test('tagJob associate director is senior + domain correct (OUT-SENIOR-1)', () => {
  const job = tagJob(makeJob('Associate Director of Software Engineering'));
  assert.strictEqual(job.tags.employment, 'senior');
  assert.ok(job.tags.domains.includes('software'));
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('\nFAILURES DETECTED — fix before committing.');
  process.exit(1);
} else {
  console.log('All tests passed.');
}
