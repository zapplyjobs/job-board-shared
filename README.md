# @zapply/job-board-shared

Shared utilities and functions for Zapply job board repositories.

## Installation

```bash
npm install @zapply/job-board-shared
```

Or for local development:

```bash
npm link .github/scripts/shared
```

## Usage

```javascript
const shared = require('@zapply/job-board-shared');

// Job ID generation
const id = shared.generateJobId(job);

// Deduplication
const result = shared.isDuplicate(job, existingJobs);

// Formatting
const timeAgo = shared.formatTimeAgo(job.posted_date);

// Classification
const level = shared.getExperienceLevel(job.title, job.description);
const category = shared.getJobCategory(job.title, job.description);
```

## API Reference

### Job ID Generation

| Function | Description |
|----------|-------------|
| `generateJobId(job)` | Generate ID from URL (preferred) |
| `generateJobIdFromUrl(job)` | Generate ID from job URL |
| `generateJobIdHash(job)` | Generate ID using SHA-256 hash |
| `generateEnhancedId(job)` | Generate ID with normalization (Roman numerals, abbreviations) |
| `migrateOldJobId(oldId)` | Convert old ID format to new |

### Deduplication

| Function | Description |
|----------|-------------|
| `generateFingerprint(job)` | Generate fingerprint for deduplication |
| `generateJobFingerprint(job)` | Generate content fingerprint (aggressive) |
| `generateMinimalJobFingerprint(job)` | Generate minimal fingerprint (for Simplify.jobs) |
| `isDuplicate(job, existingJobs)` | Check if job is duplicate |
| `filterDuplicates(jobs)` | Remove duplicates from array |
| `enrichJob(job)` | Add ID and fingerprint to job |

### Company Utilities

| Function | Description |
|----------|-------------|
| `normalizeCompanyName(name)` | Normalize using company database |
| `getCompanyEmoji(name)` | Get company emoji (🏢) |
| `getCompanyCareerUrl(name)` | Get company career URL |
| `initCompanyDatabase(data)` | Initialize company database |

### Formatting

| Function | Description |
|----------|-------------|
| `formatTimeAgo(dateString)` | Format as "2h", "3d", "1w", "2mo" |
| `formatLocation(city, state)` | Format as "City, State" or "Remote" |

### Filtering

| Function | Description |
|----------|-------------|
| `isJobOlderThanWeek(dateString)` | Check if job is >14 days old |
| `isUSOnlyJob(job)` | Check if job is US-only (filters international) |

### Classification

| Function | Description |
|----------|-------------|
| `getExperienceLevel(title, description)` | Get "Entry-Level", "Mid-Level", or "Senior" |
| `getJobCategory(title, description)` | Get job category (Frontend, Backend, ML, etc.) |

### Utilities

| Function | Description |
|----------|-------------|
| `delay(ms)` | Async delay (Promise-based) |
| `fetchInternshipData()` | Fetch internship sources (placeholder) |

## Data Format Support

Supports both **primary** and **legacy** job data formats:

**Primary:**
```javascript
{
  title: "Software Engineer",
  company_name: "Google",
  locations: ["Mountain View, CA"],
  url: "https://careers.google.com/..."
}
```

**Legacy:**
```javascript
{
  job_title: "Software Engineer",
  employer_name: "Google",
  job_city: "Mountain View",
  job_state: "CA",
  job_apply_link: "https://careers.google.com/..."
}
```

## Company Database

The company utilities require a `companies.json` file. Initialize with:

```javascript
const shared = require('@zapply/job-board-shared');
const companiesData = require('./companies.json');

shared.initCompanyDatabase(companiesData);
```

## Development

```bash
# Run tests
npm test
```

## License

MIT
