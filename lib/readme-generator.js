/**
 * Shared README Generator Library
 *
 * Extracted from duplicated readme-generator.js files in SEO repos.
 * Bug #1 (2026-02-13) proved code duplication = 4x fix effort.
 *
 * Factory function pattern: createReadmeGenerator(config, jobCategories, repoRoot)
 * Returns object with all README generation functions.
 */

const fs = require("fs");
const path = require("path");

/**
 * Create README generator with repo-specific configuration
 *
 * @param {Object} config - Validated repo config (from config.js)
 * @param {Object} jobCategories - Job categories with keywords (from job_categories.json)
 * @param {string} repoRoot - Absolute path to repo root (process.cwd())
 * @returns {Object} README generator functions
 */
function createReadmeGenerator(config, jobCategories, repoRoot) {
  // Import shared utilities
  const { logger } = require(path.join(__dirname, "../index.js"));
  // template-renderer.js removed (N-6) — config strings used directly

  // Import repo-specific utilities using repoRoot
  const utils = require(path.join(repoRoot, '.github/scripts/job-fetcher/utils.js'));
  const {
    companies,
    ALL_COMPANIES,
    getCompanyEmoji,
    getCompanyCareerUrl,
    formatTimeAgo,
    getExperienceLevel,
    formatLocation,
    generateMinimalJobFingerprint,
  } = utils;

  // Path to repo root README.md
  const REPO_README_PATH = path.join(repoRoot, 'README.md');

  // Filter jobs by age (1 week = 7 days)
  function filterJobsByAge(allJobs) {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const currentJobs = allJobs.filter(job => {
      const dateValue = job.job_posted_at_datetime_utc;

      // Handle null/undefined/invalid dates - assume recent (Bug #1 fix)
      if (!dateValue) {
        return true;  // Keep jobs with no date
      }

      const jobDate = new Date(dateValue);
      if (isNaN(jobDate.getTime())) {
        return true;  // Keep jobs with unparseable dates
      }

      return jobDate >= oneWeekAgo;
    });

    const archivedJobs = allJobs.filter(job => {
      const dateValue = job.job_posted_at_datetime_utc;

      // Only archive jobs with valid dates (Bug #1 fix)
      if (!dateValue) {
        return false;  // Don't archive jobs with no date
      }

      const jobDate = new Date(dateValue);
      if (isNaN(jobDate.getTime())) {
        return false;  // Don't archive jobs with unparseable dates
      }

      return jobDate < oneWeekAgo;
    });

    return { currentJobs, archivedJobs };
  }

  // Filter out senior positions - only keep Entry-Level and Mid-Level
  function filterOutSeniorPositions(jobs) {
    return jobs.filter(job => {
      const level = getExperienceLevel(job.job_title);
      return level !== "Senior";
    });
  }

  // Helper function to categorize a job based on keywords
  function getJobCategoryFromKeywords(jobTitle, jobDescription = '') {
    // Title only — descriptions cause false positives for short keywords
    // e.g. "ios" matches "previous", "curious" in description text
    const titleText = (jobTitle || '').toLowerCase();

    // Check each category's keywords
    // Keywords prefixed with "~" use word-boundary matching (no adjacent a-z chars)
    // e.g. "~rn" matches "Staff RN," and "RN - ICU" but NOT "intern"
    for (const [categoryKey, categoryData] of Object.entries(jobCategories)) {
      for (const keyword of categoryData.keywords) {
        if (keyword.startsWith('~')) {
          const word = keyword.slice(1);
          const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp('(?<![a-z])' + escaped + '(?![a-z])', 'i');
          if (regex.test(titleText)) return categoryKey;
        } else if (titleText.includes(keyword.toLowerCase())) {
          return categoryKey;
        }
      }
    }

    return config.defaultCategory; // From config (varies per repo)
  }

  // Generate job table — flat per-category, sorted newest-first
  function generateJobTable(jobs) {
    logger.debug('Starting generateJobTable', { total_jobs: jobs.length });

    jobs = filterOutSeniorPositions(jobs);
    logger.debug('After filtering seniors', { remaining_jobs: jobs.length });

    if (jobs.length === 0) {
      return `| Company | Role | Location | Posted | Apply |
|---------|------|----------|--------|-------|
| *No current openings* | *Check back tomorrow* | *-* | *-* | *-* |`;
    }

    // Categorize all jobs
    const jobsByCategory = {};
    jobs.forEach((job) => {
      const categoryKey = getJobCategoryFromKeywords(job.job_title);
      if (!jobsByCategory[categoryKey]) {
        jobsByCategory[categoryKey] = [];
      }
      jobsByCategory[categoryKey].push(job);
    });

    let output = "";

    // One collapsible section per category, flat table inside sorted newest-first
    Object.entries(jobCategories).forEach(([categoryKey, categoryData]) => {
      const categoryJobs = jobsByCategory[categoryKey];
      if (!categoryJobs || categoryJobs.length === 0) return;

      // Sort newest-first; null dates sort to end
      categoryJobs.sort((a, b) => {
        const dateA = a.job_posted_at_datetime_utc ? new Date(a.job_posted_at_datetime_utc) : new Date(0);
        const dateB = b.job_posted_at_datetime_utc ? new Date(b.job_posted_at_datetime_utc) : new Date(0);
        return dateB - dateA;
      });

      // Dedup by (title, employer, location) — keep newest occurrence only.
      // Hospitals post the same role at the same campus under multiple req IDs;
      // all look identical to users. Sort is newest-first so first occurrence wins.
      const seenDisplayKeys = new Set();
      const dedupedJobs = categoryJobs.filter(job => {
        const key = `${(job.job_title || '').toLowerCase()}|${(job.employer_name || '').toLowerCase()}|${(job.job_city || '')}|${(job.job_state || '')}`;
        if (seenDisplayKeys.has(key)) return false;
        seenDisplayKeys.add(key);
        return true;
      });

      // Cap display: max 3 per company (prevents prolific posters from monopolizing),
      // then take the 200 newest overall. Without per-company cap, a single company
      // with 600 postings would consume the entire visible table.
      const PER_COMPANY_CAP = 3;
      const TOTAL_CAP = 200;
      const perCompanyCount = {};
      const cappedJobs = dedupedJobs.filter(job => {
        const co = (job.employer_name || '').toLowerCase();
        perCompanyCount[co] = (perCompanyCount[co] || 0) + 1;
        return perCompanyCount[co] <= PER_COMPANY_CAP;
      });
      const displayJobs = cappedJobs.slice(0, TOTAL_CAP);

      output += `<details>\n`;
      output += `<summary><h3>${categoryData.emoji} <strong>${categoryData.title}</strong></h3></summary>\n\n`;
      output += `| Company | Role | Location | Posted | **Apply** |\n`;
      output += `|---------|------|----------|--------|----------|\n`;

      displayJobs.forEach((job) => {
        // Sanitize user-controlled fields — pipe chars break markdown table columns
        const companyName = (job.employer_name || '').replace(/\|/g, '').trim();
        const role = (job.job_title || '').replace(/\|/g, ' ').trim();
        const emoji = getCompanyEmoji(job.employer_name);
        const locationRaw = formatLocation(job.job_city, job.job_state);
        const locationTrunc = locationRaw.length > 20 ? locationRaw.substring(0, 17) + "..." : locationRaw;
        const location = locationTrunc.replace(/\|/g, '').trim();
        const posted = formatTimeAgo(job.job_posted_at_datetime_utc);
        const applyLink = job.job_apply_link || getCompanyCareerUrl(job.employer_name);

        output += `| ${emoji} **${companyName}** | ${role} | ${location} | ${posted} | [<img src="images/apply.png" width="75" alt="Apply">](${applyLink}) |\n`;
      });

      output += `\n<p align="center">Apply for more jobs at</p>\n<p align="center"><a href="https://softwarejobs.dev/"><img src="images/softwarejobs-button.png" height="40" alt="See more jobs on softwarejobs.dev"></a></p>\n\n`;
      output += `</details>\n\n`;
    });

    logger.debug('Finished generating job table', { total_jobs: jobs.length });
    return output;
  }

  function generateInternshipSection(internshipData) {
    if (!internshipData) return "";

    return `
---

## SWE Internships 2026

<img src="images/${config.repoPrefix}-internships.png" alt="Software engineering internships for 2026.">

### 🏢 **FAANG+ Internship Programs**

| Company | Program | Application Link |
|---------|---------|------------------|
${internshipData.companyPrograms
  .map((program) => {
    const companyObj = ALL_COMPANIES.find((c) => c.name === program.company);
    const emoji = companyObj ? companyObj.emoji : "🏢";
    return `| ${emoji} **${program.company}** | ${program.program} | <p align="center">[<img src="images/apply.png" width="75" alt="Apply button">](${program.url})</p> |`;
  })
  .join("\n")}

### 📚 **Top Software Internship Resources**

| Platform | Type | Description | Link |
|----------|------|-------------|------|
${internshipData.sources
  .map(
    (source) =>
      `| **${source.emogi} ${source.name}** | ${source.type} | ${source.description} | [<img src="images/${config.repoPrefix}-visit.png" width="75" alt="Visit button">](${source.url}) |`
  )
  .join("\n")}

`;
  }

  function generateArchivedSection(archivedJobs, stats) {
    if (archivedJobs.length === 0) return "";

    archivedJobs = filterOutSeniorPositions(archivedJobs);

    // Get top category from archived jobs
    const categoryCounts = {};
    archivedJobs.forEach(job => {
      const cat = getJobCategoryFromKeywords(job.job_title);
      const catTitle = jobCategories[cat]?.title || 'Software Engineering';
      categoryCounts[catTitle] = (categoryCounts[catTitle] || 0) + 1;
    });
    const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Software Engineering';

    return `
---

<details>
<summary><h2>🗂️ <strong>ARCHIVED SWE JOBS</strong> - ${
      archivedJobs.length
    } Older Positions (7+ days old) - Click to Expand 👆</h2></summary>

### 📊 **Archived Job Stats**
- **📁 Total Jobs**: ${archivedJobs.length} positions
- **🏢 Companies**: ${Object.keys(stats.totalByCompany).length} companies
- **🏷️ Top Category**: ${topCategory}

${generateJobTable(archivedJobs)}

</details>

---

`;
  }

  // Generate comprehensive README
  async function generateReadme(currentJobs, archivedJobs = [], internshipData = null, stats = null) {
    const currentDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Filter senior positions
    currentJobs = filterOutSeniorPositions(currentJobs);

    // Calculate stats from currentJobs only (not archived)
    const currentStats = {
      byLevel: {},
      byLocation: {},
      byCategory: {},
      totalByCompany: {}
    };

    currentJobs.forEach(job => {
      // Count by level
      const level = getExperienceLevel(job.job_title);
      currentStats.byLevel[level] = (currentStats.byLevel[level] || 0) + 1;

      // Count by location
      const location = formatLocation(job.job_city, job.job_state);
      currentStats.byLocation[location] = (currentStats.byLocation[location] || 0) + 1;

      // Count by category (using new job categories)
      const categoryKey = getJobCategoryFromKeywords(job.job_title);
      const categoryTitle = jobCategories[categoryKey]?.title || 'Software Engineering';
      currentStats.byCategory[categoryTitle] = (currentStats.byCategory[categoryTitle] || 0) + 1;

      // Count by company
      const company = job.employer_name;
      currentStats.totalByCompany[company] = (currentStats.totalByCompany[company] || 0) + 1;
    });

    const totalCompanies = Object.keys(currentStats.totalByCompany).length;

    // Get top category for badge
    const topCategoryEntry = Object.entries(currentStats.byCategory).sort((a, b) => b[1] - a[1])[0];
    const topCategory = topCategoryEntry?.[0] || 'Software Engineering';
    const topCategoryCount = topCategoryEntry?.[1] || 0;
    const topCategoryBadge = topCategory.replace(/\s+/g, '_');

    // Replace placeholders in config description strings
    const replacePlaceholders = (str) => str
      ? str.replace(/\{totalCompanies\}/g, totalCompanies).replace(/\{currentJobs\}/g, currentJobs.length)
      : str;
    const renderedConfig = {
      descriptionLine1: replacePlaceholders(config.descriptionLine1),
      descriptionLine2: replacePlaceholders(config.descriptionLine2)
    };

    const refTags = { int: 'gh-internships', ngj: 'gh-newgrad-jobs', sej: 'gh-newgrad-swe', dsj: 'gh-newgrad-datascience', hej: 'gh-newgrad-hardware', hcj: 'gh-newgrad-healthcare' };
    const refTag = refTags[config.repoPrefix] || 'gh-github';

    return `



<div align="center">

<!-- Banner -->
<img src="images/${config.repoPrefix}-heading.png" alt="${config.headingImageAlt}">

# ${config.title}

${config.tagline}

</div>

<p align="center">${renderedConfig.descriptionLine1}</p>

<div align="center">

![${config.jobCountBadgeLabel || 'Total Jobs'}](https://img.shields.io/badge/${(config.jobCountBadgeLabel || 'Total Jobs').replace(/ /g, '_')}-${currentJobs.length}-brightgreen?style=flat&logo=briefcase)
![Companies](https://img.shields.io/badge/Companies-${totalCompanies}-blue?style=flat&logo=building)
![${topCategory}](https://img.shields.io/badge/${topCategoryBadge}-${topCategoryCount}-red?style=flat&logo=star)
![Updated](https://img.shields.io/badge/Updated-Every_15_Minutes-orange?style=flat&logo=calendar)

</div>

> [!${config.noteType}]
> ${config.noteText}

---

## **Website & Autofill Extension**

![Apply to jobs in seconds with Zapply.](images/zapply.png)

Explore Zapply's website and check out:

- Our chrome extension that autofills your job applications in seconds.
- A dedicated job board with the latest jobs for various types of roles.
- User account providing multiple profiles for different resume roles.
- Job application tracking with streaks to unlock commitment awards.

Experience an advanced career journey with us! 🚀

<p align="center">
  <a href="https://zapply.jobs/?ref=${refTag}"><img src="images/zapply-button-2.png" alt="Visit Our Website" width="600"></a>
</p>

## Explore Around

<img src="images/community.png" alt="Explore Around">

Connect and seek advice from a growing network of fellow students and new grads.

<p align="center">
  <a href="https://discord.gg/UswBsduwcD"><img src="images/discord-2d.png" alt="Discord" width="250"></a>
  &nbsp;&nbsp;
  <a href="https://www.instagram.com/zapplyjobs"><img src="images/instagram-icon-2d.png" alt="Instagram" height="75"></a>
  &nbsp;&nbsp;
  <a href="https://www.tiktok.com/@zapply.jobs"><img src="images/tiktok-icon-2d.png" alt="TikTok" height="75"></a>
</p>

---

<img src="images/${config.repoPrefix}-listings.png" alt="Fresh 2026 job listings (under 1 week).">

${generateJobTable(currentJobs)}

${config.features.internships && internshipData ? generateInternshipSection(internshipData) : ''}

---

${config.features.moreResources ? `<img src="images/more-resources.png" alt="Jobs and templates in our other repos.">

${(() => {
  const allButtons = [
    { prefix: 'ngj', url: 'https://github.com/zapplyjobs/New-Grad-Jobs-2026', img: 'repo-ngj.png', alt: 'New Grad Jobs 2026' },
    { prefix: 'sej', url: 'https://github.com/zapplyjobs/New-Grad-Software-Engineering-Jobs-2026', img: 'repo-sej.png', alt: 'Software Engineering Jobs' },
    { prefix: 'dsj', url: 'https://github.com/zapplyjobs/New-Grad-Data-Science-Jobs-2026', img: 'repo-dsj.png', alt: 'Data Science Jobs' },
    { prefix: 'hej', url: 'https://github.com/zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026', img: 'repo-hej.png', alt: 'Hardware Engineering Jobs' },
    { prefix: 'hcj', url: 'https://github.com/zapplyjobs/New-Grad-Healthcare-Jobs-2026', img: 'repo-hcj.png', alt: 'Healthcare Jobs' },
    { prefix: 'rss', url: 'https://github.com/zapplyjobs/resume-samples-2026', img: 'repo-rss.png', alt: 'Resume Samples' },
    { prefix: 'ihb', url: 'https://github.com/zapplyjobs/interview-handbook-2026', img: 'repo-ihb.png', alt: 'Interview Handbook' },
    { prefix: 'int', url: 'https://github.com/zapplyjobs/Internships-2026', img: 'repo-int.png', alt: 'Internships 2026' },
    { prefix: 'rifu', url: 'https://github.com/zapplyjobs/Research-Internships-for-Undergraduates', img: 'repo-rifu.png', alt: 'Research Internships' },
    { prefix: 'uci', url: 'https://github.com/zapplyjobs/underclassmen-internships', img: 'repo-uci.png', alt: 'Underclassmen Internships' },
  ].filter(b => b.prefix !== config.repoPrefix);
  const rows = [];
  for (let i = 0; i < allButtons.length; i += 3) {
    const row = allButtons.slice(i, i + 3);
    rows.push(`<p align="center">\n${row.map(b => `  <a href="${b.url}"><img src="images/${b.img}" alt="${b.alt}" height="40"></a>`).join('\n  &nbsp;&nbsp;\n')}\n</p>`);
  }
  return rows.join('\n');
})()}

---

` : ''}<img src="images/contributor.png" alt="Become a Contributor">

Add new jobs to our listings keeping in mind the following:

- Located in the US.
- Openings are currently accepting applications and not older than 1 week.
- Create a new issue to submit different job positions.
- Update a job by submitting an issue with the job URL and required changes.

Our team reviews within 24-48 hours and approved jobs are added to the main list!

Questions? Create a miscellaneous issue, and we'll assist! 🙏

${archivedJobs.length > 0 ? generateArchivedSection(archivedJobs, currentStats) : ""}

<div align="center">

**🎯 ${currentJobs.length} current opportunities from ${totalCompanies} companies**

**Found this helpful? Give it a ⭐ to support Zapply!**

*Not affiliated with any companies listed. All applications redirect to official career pages.*

---

**Last Updated**: ${currentDate}

</div>`;
  }

  // Update README file
  async function updateReadme(currentJobs, existingArchivedJobs = [], internshipData, stats) {
    try {
      logger.info('Generating README content');

      // Jobs are already filtered by processJobs() - no need to re-filter
      // currentJobs: jobs <7 days old, existingArchivedJobs: jobs >7 days old

      const archivedJobs = existingArchivedJobs;

      logger.info('Using pre-filtered jobs', {
        current: currentJobs.length,
        archived: archivedJobs.length
      });

      const readmeContent = await generateReadme(
        currentJobs,
        archivedJobs,
        internshipData,
        stats
      );
      fs.writeFileSync(REPO_README_PATH, readmeContent, "utf8");

      logger.info('README.md updated successfully', {
        current_jobs: currentJobs.length,
        archived_jobs: archivedJobs.length,
        companies: Object.keys(stats?.totalByCompany || {}).length
      });
    } catch (err) {
      logger.error('Error updating README', {
        error: err.message,
        stack: err.stack
      });
      throw err;
    }
  }

  // Return all generator functions
  return {
    generateJobTable,
    generateInternshipSection,
    generateArchivedSection,
    generateReadme,
    updateReadme,
    filterJobsByAge,
    filterOutSeniorPositions,
  };
}

module.exports = { createReadmeGenerator };
