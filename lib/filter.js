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

// Built-in blog URL patterns
const BLOG_PATTERNS = [
  /\/blog\//i,
  /\/blogs?\./i,
  /blogs?\./i,
  /\/comment-page-/i,
  /\/\d{4}\/\d{2}\//,
  /\/post\//i,
  /\/article\//i,
  /wordpress\.com/i,
  /blogspot\.com/i,
  /\/wp-content\//i
];

// Built-in SPAM patterns
const DEFAULT_SPAM_KEYWORDS = [
  'seoexpress', 'seoprobox', 'backlink-boost',
  'link-farm', 'buy-link', 'cheap-seo'
];

function isBlogUrl(url) {
  return BLOG_PATTERNS.some(pattern => pattern.test(url));
}

function isSpamDomain(url, customKeywords = []) {
  const allKeywords = [...DEFAULT_SPAM_KEYWORDS, ...customKeywords];
  const lowerUrl = url.toLowerCase();
  return allKeywords.some(kw => lowerUrl.includes(kw.toLowerCase().trim()));
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
    isBlogUrl: isBlogUrl(row[SEMRUSH_COLUMNS.SOURCE_URL] || ''),
    isSpam: false,
    status: 'pending',
    importedAt: new Date().toISOString()
  };
}

// Filter configuration with defaults
const DEFAULT_FILTER_CONFIG = {
  // Score & links
  minAscore: 1,
  maxAscore: 100,
  maxExternalLinks: 5000,
  // Link type
  filterLostLinks: true,
  filterSpamDomains: true,
  nofollowFilter: 'all',    // 'all' | 'nofollow_only' | 'dofollow_only'
  filterSitewide: false,     // true = exclude sitewide links
  filterSponsored: false,    // true = exclude sponsored links
  // Sorting
  prioritizeUgc: true,
  prioritizeBlogUrls: true,
  // Dedup
  deduplicateByDomain: true,
  // Custom SPAM keywords
  customSpamKeywords: [],
  // Domain blacklist / whitelist
  domainBlacklist: [],       // exact domains to always exclude
  domainWhitelist: [],       // if non-empty, ONLY include these domains
  // URL keyword filter
  urlMustContain: '',        // URL must contain this string (e.g. 'blog')
  urlMustNotContain: '',     // URL must NOT contain this string
};

// Apply filters to parsed backlinks
function filterBacklinks(backlinks, config = DEFAULT_FILTER_CONFIG) {
  const c = { ...DEFAULT_FILTER_CONFIG, ...config };

  const filtered = backlinks.filter(bl => {
    // Ascore range
    if (bl.ascore < c.minAscore) {
      bl.filterReason = 'low_ascore';
      return false;
    }
    if (bl.ascore > c.maxAscore) {
      bl.filterReason = 'high_ascore';
      return false;
    }

    // Lost links
    if (c.filterLostLinks && bl.lostLink) {
      bl.filterReason = 'lost_link';
      return false;
    }

    // External links count
    if (bl.externalLinks > c.maxExternalLinks) {
      bl.filterReason = 'too_many_external_links';
      return false;
    }

    // SPAM domains
    if (c.filterSpamDomains && isSpamDomain(bl.sourceUrl, c.customSpamKeywords)) {
      bl.isSpam = true;
      bl.filterReason = 'spam_domain';
      return false;
    }

    // Nofollow filter
    if (c.nofollowFilter === 'dofollow_only' && bl.nofollow) {
      bl.filterReason = 'nofollow';
      return false;
    }
    if (c.nofollowFilter === 'nofollow_only' && !bl.nofollow) {
      bl.filterReason = 'dofollow';
      return false;
    }

    // Sitewide filter
    if (c.filterSitewide && bl.sitewide) {
      bl.filterReason = 'sitewide';
      return false;
    }

    // Sponsored filter
    if (c.filterSponsored && bl.sponsored) {
      bl.filterReason = 'sponsored';
      return false;
    }

    // Domain blacklist
    if (c.domainBlacklist.length > 0 && bl.sourceDomain) {
      if (c.domainBlacklist.some(d => bl.sourceDomain.includes(d.toLowerCase().trim()))) {
        bl.filterReason = 'domain_blacklist';
        return false;
      }
    }

    // Domain whitelist (if set, only allow listed domains)
    if (c.domainWhitelist.length > 0 && bl.sourceDomain) {
      if (!c.domainWhitelist.some(d => bl.sourceDomain.includes(d.toLowerCase().trim()))) {
        bl.filterReason = 'domain_whitelist';
        return false;
      }
    }

    // URL must contain keyword
    if (c.urlMustContain && !bl.sourceUrl.toLowerCase().includes(c.urlMustContain.toLowerCase())) {
      bl.filterReason = 'url_missing_keyword';
      return false;
    }

    // URL must NOT contain keyword
    if (c.urlMustNotContain && bl.sourceUrl.toLowerCase().includes(c.urlMustNotContain.toLowerCase())) {
      bl.filterReason = 'url_blocked_keyword';
      return false;
    }

    return true;
  });

  // Deduplicate by source domain
  let result = filtered;
  if (c.deduplicateByDomain) {
    const seenDomains = new Set();
    result = filtered.filter(bl => {
      if (!bl.sourceDomain) return false;
      if (seenDomains.has(bl.sourceDomain)) return false;
      seenDomains.add(bl.sourceDomain);
      return true;
    });
  }

  // Sort
  result.sort((a, b) => {
    if (c.prioritizeUgc) {
      if (a.ugc && !b.ugc) return -1;
      if (!a.ugc && b.ugc) return 1;
    }
    if (c.prioritizeBlogUrls) {
      if (a.isBlogUrl && !b.isBlogUrl) return -1;
      if (!a.isBlogUrl && b.isBlogUrl) return 1;
    }
    return b.ascore - a.ascore;
  });

  return result;
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
