/**
 * @zapply/job-board-shared - Location Filters Configuration
 *
 * Centralized US states, countries, and cities for location filtering
 * Replaces hardcoded lists in utils.js
 */

module.exports = {
  // US states (codes and full names)
  usStates: {
    codes: ['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia',
            'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
            'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt',
            'va', 'wa', 'wv', 'wi', 'wy', 'dc'],

    fullNames: ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
                'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
                'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
                'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
                'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
                'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
                'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
                'wisconsin', 'wyoming', 'district of columbia']
  },

  // US country indicators
  usIndicators: ['us', 'usa', 'united states', 'united states of america', 'america'],

  // Non-US countries (for filtering)
  nonUSCountries: {
    'north america': ['canada', 'mexico'],
    'europe': ['uk', 'united kingdom', 'great britain', 'britain', 'germany', 'deutschland', 'france',
                'netherlands', 'holland', 'sweden', 'norway', 'denmark', 'finland', 'ireland', 'belgium',
                'austria', 'switzerland', 'poland', 'portugal', 'greece', 'italy', 'spain', 'romania',
                'bulgaria', 'hungary', 'czech republic', 'croatia', 'serbia', 'russia', 'ukraine'],
    'baltic': ['estonia', 'latvia', 'lithuania'],
    'asia': ['india', 'singapore', 'japan', 'south korea', 'korea', 'china', 'taiwan', 'hong kong',
             'thailand', 'vietnam', 'philippines', 'indonesia', 'malaysia'],
    'middle east': ['israel', 'turkey', 'uae', 'saudi arabia'],
    'oceania': ['australia', 'new zealand'],
    'south america': ['brazil', 'argentina', 'chile', 'colombia', 'peru']
  },

  // Major US cities (for location matching)
  usCities: {
    top20: ['new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia', 'san antonio',
            'san diego', 'dallas', 'san jose', 'austin', 'jacksonville', 'san francisco', 'columbus',
            'fort worth', 'indianapolis', 'seattle', 'denver', 'washington', 'boston'],

    tech: ['san francisco', 'san jose', 'palo alto', 'mountain view', 'sunnyvale', 'cupertino',
           'seattle', 'austin', 'boston', 'denver', 'portland', 'raleigh', 'durham',
           'chicago', 'new york', 'los angeles', 'san diego'],

    all: [] // Populated from combined lists
  },

  // Non-US cities (for filtering out)
  nonUSCities: {
    // North America
    canada: ['toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'edmonton', 'quebec city'],

    // Europe
    uk: ['london', 'manchester', 'birmingham', 'glasgow', 'liverpool', 'bristol', 'edinburgh'],
    germany: ['berlin', 'munich', 'hamburg', 'cologne', 'frankfurt', 'stuttgart'],
    france: ['paris', 'marseille', 'lyon', 'toulouse', 'nice'],
    netherlands: ['amsterdam', 'rotterdam', 'the hague', 'utrecht'],
    scandinavia: ['stockholm', 'copenhagen', 'helsinki', 'oslo', 'gothenburg'],

    // Asia
    india: ['bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai'],
    eastAsia: ['tokyo', 'osaka', 'seoul', 'busan', 'singapore', 'hong kong', 'taipei', 'bangkok'],

    // Oceania
    oceania: ['sydney', 'melbourne', 'brisbane', 'perth', 'auckland'],

    // Middle East
    middleEast: ['tel aviv', 'jerusalem', 'dubai', 'abu dhabi', 'riyadh']
  },

  // State to region mapping
  regions: {
    'west': ['ca', 'or', 'wa', 'nv', 'az', 'ut', 'co', 'nm', 'ak', 'hi'],
    'midwest': ['il', 'in', 'ia', 'ks', 'mi', 'mn', 'mo', 'ne', 'nd', 'oh', 'sd', 'wi'],
    'south': ['al', 'ar', 'fl', 'ga', 'ky', 'la', 'ms', 'nc', 'ok', 'sc', 'tn', 'tx', 'va', 'wv'],
    'northeast': ['ct', 'de', 'dc', 'ma', 'md', 'me', 'nh', 'nj', 'ny', 'pa', 'ri', 'vt']
  },

  // Location normalization rules
  normalization: {
    abbreviations: {
      'sf': 'san francisco',
      'nyc': 'new york city',
      'la': 'los angeles',
      'chi': 'chicago',
      'phx': 'phoenix',
      'dal': 'dallas',
      'hou': 'houston',
      'det': 'detroit',
      'atl': 'atlanta',
      'mia': 'miami',
      'sea': 'seattle',
      'bos': 'boston',
      'dc': 'washington dc'
    },

    stateAbbreviations: {
      'calif': 'ca',
      'california': 'ca',
      'new york': 'ny',
      'washington': 'wa',
      'florida': 'fl',
      'texas': 'tx'
    }
  },

  // Helper function to check if location is US
  isUS(location) {
    if (!location) return false;

    const loc = location.toLowerCase().trim();

    // Check US indicators
    if (this.usIndicators.some(ind => loc.includes(ind))) {
      return true;
    }

    // Check US states
    if (this.usStates.codes.some(state => loc === state || loc.includes(state))) {
      return true;
    }

    // Check US state names
    if (this.usStates.fullNames.some(state => loc.includes(state))) {
      return true;
    }

    // Check US cities
    const allUSCities = [...this.usCities.top20, ...this.usCities.tech];
    if (allUSCities.some(city => loc.includes(city))) {
      return true;
    }

    // Remote defaults to US unless specified otherwise
    if (loc.includes('remote') && !this.isNonUS(location)) {
      return true;
    }

    return false;
  },

  // Helper function to check if location is non-US
  isNonUS(location) {
    if (!location) return false;

    const loc = location.toLowerCase().trim();

    // Check non-US countries
    for (const countries of Object.values(this.nonUSCountries)) {
      if (countries.some(country => loc.includes(country))) {
        return true;
      }
    }

    // Check non-US cities
    for (const cities of Object.values(this.nonUSCities)) {
      if (cities.some(city => loc.includes(city))) {
        return true;
      }
    }

    return false;
  }
};
