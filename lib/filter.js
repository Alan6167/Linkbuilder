// Backlink filtering rules for Semrush export data

// Semrush export column mapping (19 columns)
const SEMRUSH_COLUMNS = {
  PAGE_ASCORE: 0,
  SOURCE_TITLE: 1,
  SOURCE_URL: 2,
  TARGET_URL: 3,
  ANCHOR: 4,
  EXTERNAL_LINKS: 5,
  INTERNAL_LINKS: 6,
  NOFOLLOW: 7,
  SPONSORED: 8,
  UGC: 9,
  TEXT: 10,
  FRAME: 11,
  FORM: 12,
  IMAGE: 13,
  SITEWIDE: 14,
  FIRST_SEEN: 15,
  LAST_SEEN: 16,
  NEW_LINK: 17,
  LOST_LINK: 18
};

function parseBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.toLowerCase() === 'true';
  return false;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Blog-related URL patterns
const BLOG_PATTERNS = [
  /\/blog\//i,
  /\/blogs?\./i,
  /blogs?\./i,
  /\/comment-page-/i,
  /\/\d{4}\/\d{2}\//,  // date-based URL like /2024/03/
  /\/post\//i,
  /\/article\//i,
  /wordpress\.com/i,
  /blogspot\.com/i,
  /\/wp-content\//i
];

// SPAM domain patterns
const SPAM_PATTERNS = [
  /seoexpress/i,
  /seoprobox/i,
  /backlink.*boost/i,
  /link.*farm/i,
  /buy.*link/i,
  /cheap.*seo/i
];

function isBlogUrl(url) {
  return BLOG_PATTERNS.some(pattern => pattern.test(url));
}

function isSpamDomain(url) {
  return SPAM_PATTERNS.some(pattern => pattern.test(url));
}

// Parse a single row from Semrush export into a structured backlink object
function parseRow(row) {
  return {
    ascore: parseInt(row[SEMRUSH_COLUMNS.PAGE_ASCORE]) || 0,
    sourceTitle: row[SEMRUSH_COLUMNS.SOURCE_TITLE] || '',
    sourceUrl: row[SEMRUSH_COLUMNS.SOURCE_URL] || '',
    targetUrl: row[SEMRUSH_COLUMNS.TARGET_URL] || '',
    anchor: row[SEMRUSH_COLUMNS.ANCHOR] || '',
    externalLinks: parseInt(row[SEMRUSH_COLUMNS.EXTERNAL_LINKS]) || 0,
    internalLinks: parseInt(row[SEMRUSH_COLUMNS.INTERNAL_LINKS]) || 0,
    nofollow: parseBool(row[SEMRUSH_COLUMNS.NOFOLLOW]),
    sponsored: parseBool(row[SEMRUSH_COLUMNS.SPONSORED]),
    ugc: parseBool(row[SEMRUSH_COLUMNS.UGC]),
    isText: parseBool(row[SEMRUSH_COLUMNS.TEXT]),
    isFrame: parseBool(row[SEMRUSH_COLUMNS.FRAME]),
    isForm: parseBool(row[SEMRUSH_COLUMNS.FORM]),
    isImage: parseBool(row[SEMRUSH_COLUMNS.IMAGE]),
    sitewide: parseBool(row[SEMRUSH_COLUMNS.SITEWIDE]),
    firstSeen: row[SEMRUSH_COLUMNS.FIRST_SEEN] || '',
    lastSeen: row[SEMRUSH_COLUMNS.LAST_SEEN] || '',
    newLink: parseBool(row[SEMRUSH_COLUMNS.NEW_LINK]),
    lostLink: parseBool(row[SEMRUSH_COLUMNS.LOST_LINK]),
    sourceDomain: extractDomain(row[SEMRUSH_COLUMNS.SOURCE_URL]),
    // Computed fields
    isBlogUrl: isBlogUrl(row[SEMRUSH_COLUMNS.SOURCE_URL] || ''),
    isSpam: false,
    status: 'pending', // pending, analyzing, commentable, not_commentable, commented, error
    importedAt: new Date().toISOString()
  };
}

// Filter configuration with defaults
const DEFAULT_FILTER_CONFIG = {
  minAscore: 1,            // Filter out ascore = 0 (SPAM)
  maxExternalLinks: 5000,  // Filter out link farms
  filterLostLinks: true,   // Remove lost links
  filterSpamDomains: true, // Remove known SPAM patterns
  prioritizeUgc: true,     // Sort UGC links first
  prioritizeBlogUrls: true // Sort blog URLs first
};

// Apply filters to parsed backlinks
function filterBacklinks(backlinks, config = DEFAULT_FILTER_CONFIG) {
  const filtered = backlinks.filter(bl => {
    // Filter ascore = 0
    if (bl.ascore < config.minAscore) {
      bl.filterReason = 'low_ascore';
      return false;
    }

    // Filter lost links
    if (config.filterLostLinks && bl.lostLink) {
      bl.filterReason = 'lost_link';
      return false;
    }

    // Filter excessive external links (link farms)
    if (bl.externalLinks > config.maxExternalLinks) {
      bl.filterReason = 'too_many_external_links';
      return false;
    }

    // Filter SPAM domains
    if (config.filterSpamDomains && isSpamDomain(bl.sourceUrl)) {
      bl.isSpam = true;
      bl.filterReason = 'spam_domain';
      return false;
    }

    return true;
  });

  // Deduplicate by source domain
  const seenDomains = new Set();
  const deduped = filtered.filter(bl => {
    if (!bl.sourceDomain) return false;
    if (seenDomains.has(bl.sourceDomain)) return false;
    seenDomains.add(bl.sourceDomain);
    return true;
  });

  // Sort: UGC first, then blog URLs, then by ascore descending
  deduped.sort((a, b) => {
    if (config.prioritizeUgc) {
      if (a.ugc && !b.ugc) return -1;
      if (!a.ugc && b.ugc) return 1;
    }
    if (config.prioritizeBlogUrls) {
      if (a.isBlogUrl && !b.isBlogUrl) return -1;
      if (!a.isBlogUrl && b.isBlogUrl) return 1;
    }
    return b.ascore - a.ascore;
  });

  return deduped;
}

// Generate filter summary statistics
function getFilterStats(allParsed, filtered) {
  return {
    totalImported: allParsed.length,
    afterFilter: filtered.length,
    removed: allParsed.length - filtered.length,
    ugcCount: filtered.filter(b => b.ugc).length,
    blogUrlCount: filtered.filter(b => b.isBlogUrl).length,
    uniqueDomains: new Set(filtered.map(b => b.sourceDomain)).size,
    avgAscore: filtered.length > 0
      ? Math.round(filtered.reduce((sum, b) => sum + b.ascore, 0) / filtered.length)
      : 0
  };
}

export {
  SEMRUSH_COLUMNS,
  parseRow,
  filterBacklinks,
  getFilterStats,
  extractDomain,
  isBlogUrl,
  isSpamDomain,
  DEFAULT_FILTER_CONFIG
};
