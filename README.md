# @zapplyjobs/job-board-shared

Shared utilities for ZapplyJobs job board repositories.

## Installation

```bash
npm install @zapplyjobs/job-board-shared
```

## Usage

```javascript
const {
  getJobChannelDetails,
  getJobLocationChannel,
  PostedJobsManagerV2,
  DeduplicationLogger
} = require('@zapplyjobs/job-board-shared');

// Routing requires config injection - define your channel mapping
const CHANNEL_CONFIG = {
  'tech': '123456789',
  'ai': '987654321',
  'default': '111111111'
};

const job = { job_title: 'Software Engineer', employer_name: 'Google' };
const result = getJobChannelDetails(job, CHANNEL_CONFIG);
console.log(result.category); // 'tech'
```

## Modules

### Routing
- `getJobChannelDetails(job, config)` - Main job categorization
- `getJobChannel(job, config)` - Returns just channel ID
- `getJobLocationChannel(job, config)` - Location-based routing
- `isTechRole(title)`, `isAIRole(title)`, etc. - Role detection helpers

### Utils
- `retryWithBackoff(fn, maxRetries)` - Retry with exponential backoff
- `discordApiCall(fn)` - Discord API rate limit handling
- `formatPostedDate(date)` - Date formatting
- `cleanJobDescription(text)` - Clean HTML from descriptions
- `normalizeJob(job)` - Normalize job object fields

### Data Management
- `PostedJobsManagerV2` - Track posted jobs (deduplication)
- `SubscriptionManager` - Manage user subscriptions

### Logging
- `DeduplicationLogger` - Log duplicate checks
- `DiscordPostLogger` - Log Discord posting results

### Encryption
- `encryptLog(data, password)` - AES-256-GCM encryption
- `decryptLog(data, password)` - Decryption

## Config Injection Pattern

All routing functions require config injection to avoid hardcoding channel IDs:

```javascript
// In your repo's config.js
const CHANNEL_CONFIG = {
  'tech': process.env.DISCORD_TECH_CHANNEL,
  'ai': process.env.DISCORD_AI_CHANNEL,
  // ...
};

// When calling routing functions
const { getJobChannelDetails } = require('@zapplyjobs/job-board-shared');
const result = getJobChannelDetails(job, CHANNEL_CONFIG);
```

## License

MIT
