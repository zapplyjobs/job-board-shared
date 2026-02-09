/**
 * @zapply/job-board-shared - Job Categories Configuration
 *
 * Centralized job category mappings and classifications
 */

module.exports = {
  // Primary job categories
  categories: {
    'Software Engineering': 'Software Engineering',
    'Frontend Development': 'Frontend Development',
    'Backend Development': 'Backend Development',
    'Full Stack Development': 'Full Stack Development',
    'Mobile Development': 'Mobile Development',
    'Machine Learning & AI': 'Machine Learning & AI',
    'Data Science & Analytics': 'Data Science & Analytics',
    'DevOps & Infrastructure': 'DevOps & Infrastructure',
    'Security Engineering': 'Security Engineering',
    'Product Management': 'Product Management',
    'Design': 'Design'
  },

  // Category keywords for classification
  keywords: {
    'Mobile Development': ['ios', 'android', 'mobile', 'react native', 'flutter', 'swift', 'kotlin'],
    'Frontend Development': ['frontend', 'front-end', 'react', 'vue', 'angular', 'ui', 'ux engineer'],
    'Backend Development': ['backend', 'back-end', 'api', 'server', 'microservices'],
    'Full Stack Development': ['full stack', 'fullstack', 'full-stack'],
    'Machine Learning & AI': ['machine learning', 'ml ', 'ai ', 'artificial intelligence', 'deep learning', 'nlp', 'computer vision'],
    'Data Science & Analytics': ['data scientist', 'data analyst', 'analytics', 'data engineer', 'business intelligence'],
    'DevOps & Infrastructure': ['devops', 'infrastructure', 'cloud', 'platform', 'sre', 'site reliability'],
    'Security Engineering': ['security', 'cybersecurity', 'infosec', 'information security'],
    'Product Management': ['product manager', 'product owner', 'pm ', 'product lead'],
    'Design': ['design', 'ux ', 'ui ', 'user experience', 'user interface', 'graphic design', 'product design']
  },

  // Experience level mappings
  experienceLevels: {
    'Entry-Level': ['entry', 'junior', 'jr.', 'intern', 'internship', 'associate', 'level 1', 'l1', 'campus', 'student', 'new grad', 'graduate', 'early career', '0-2 years'],
    'Mid-Level': ['mid', 'mid-level', '3-5 years', '4-6 years'],
    'Senior': ['senior', 'sr.', 'lead', 'principal', 'staff', 'architect', '5+ years', 'senior level']
  },

  // Employment type mappings
  employmentTypes: {
    'Full-time': ['full-time', 'full time', 'permanent', 'ft'],
    'Part-time': ['part-time', 'part time', 'pt'],
    'Contract': ['contract', 'contractor', 'contractor'],
    'Internship': ['internship', 'intern'],
    'Co-op': ['co-op', 'co-op', 'coop']
  },

  // Default category when no match found
  defaultCategory: 'Software Engineering',

  // Default experience level when no match found
  defaultExperienceLevel: 'Mid-Level'
};
