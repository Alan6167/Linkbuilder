// Backlink filtering rules for Semrush export data

import { normalizeUrl } from './db.js';

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

function normalizeHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href;
  } catch {
    return '';
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
  const sourceUrl = normalizeHttpUrl(row[SEMRUSH_COLUMNS.SOURCE_URL] || '');
  return {
    ascore: parseInt(row[SEMRUSH_COLUMNS.PAGE_ASCORE]) || 0,
    sourceTitle: row[SEMRUSH_COLUMNS.SOURCE_TITLE] || '',
    sourceUrl,
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
    sourceDomain: extractDomain(sourceUrl),
    isBlogUrl: isBlogUrl(sourceUrl),
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

// Apply filters to parsed backlinks.
// Optional `blacklistSet` / `librarySet` are Sets of already-normalized URLs
// (from lib/db.js `getBlacklist()` / `getLibrary()`). Any backlink whose
// normalized sourceUrl matches is dropped with a descriptive filterReason.
function filterBacklinks(backlinks, config = DEFAULT_FILTER_CONFIG, blacklistSet = null, librarySet = null) {
  const c = { ...DEFAULT_FILTER_CONFIG, ...config };
  const domainBlacklistRules = normalizeDomainRules(c.domainBlacklist);
  const domainWhitelistRules = normalizeDomainRules(c.domainWhitelist);
  const hasDomainBlacklist = domainBlacklistRules.length > 0;
  const hasDomainWhitelist = domainWhitelistRules.length > 0;
  const mustContain = (c.urlMustContain || '').toLowerCase();
  const mustNotContain = (c.urlMustNotContain || '').toLowerCase();

  const filtered = backlinks.filter(bl => {
    if (!bl.sourceUrl) {
      bl.filterReason = 'invalid_url';
      return false;
    }
    const normalizedSourceUrl = normalizeUrl(bl.sourceUrl);

    // URL-level blacklist (full URL match after normalization)
    if (blacklistSet && blacklistSet.has(normalizedSourceUrl)) {
      bl.filterReason = 'url_blacklisted';
      return false;
    }

    // URL already archived to the backlinks library
    if (librarySet && librarySet.has(normalizedSourceUrl)) {
      bl.filterReason = 'already_in_library';
      return false;
    }

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
    if (hasDomainBlacklist && bl.sourceDomain) {
      if (domainBlacklistRules.some(d => domainMatchesRule(bl.sourceDomain, d))) {
        bl.filterReason = 'domain_blacklist';
        return false;
      }
    }

    // Domain whitelist (if set, only allow listed domains)
    if (hasDomainWhitelist) {
      if (!bl.sourceDomain) {
        bl.filterReason = 'invalid_domain';
        return false;
      }
      if (!domainWhitelistRules.some(d => domainMatchesRule(bl.sourceDomain, d))) {
        bl.filterReason = 'domain_whitelist';
        return false;
      }
    }

    // URL must contain keyword
    if (mustContain && !bl.sourceUrl.toLowerCase().includes(mustContain)) {
      bl.filterReason = 'url_missing_keyword';
      return false;
    }

    // URL must NOT contain keyword
    if (mustNotContain && bl.sourceUrl.toLowerCase().includes(mustNotContain)) {
      bl.filterReason = 'url_blocked_keyword';
      return false;
    }

    return true;
  });

  // Deduplicate by source domain: when the same domain has multiple rows, keep
  // the one with the highest quality score instead of whichever happened to be
  // imported first. Score honours the configured priorities (ugc / blog /
  // ascore) so a high-authority UGC link beats a no-follow noise row.
  let result = filtered;
  if (c.deduplicateByDomain) {
    const best = new Map();
    for (const bl of filtered) {
      if (!bl.sourceDomain) {
        bl.filterReason = bl.filterReason || 'invalid_domain';
        continue;
      }
      const cur = best.get(bl.sourceDomain);
      if (!cur || compareQuality(bl, cur, c) > 0) {
        if (cur) cur.filterReason = 'duplicate_domain';
        best.set(bl.sourceDomain, bl);
      } else {
        bl.filterReason = 'duplicate_domain';
      }
    }
    result = [...best.values()];
  }

  // Sort: reuse the same quality comparator so ordering and dedup agree.
  result.sort((a, b) => compareQuality(b, a, c));

  return result;
}

// Quality score for per-domain dedup and for the final sort. Higher is better.
function qualityScore(bl, c) {
  let s = 0;
  if (c.prioritizeUgc && bl.ugc) s += 1000;
  if (c.prioritizeBlogUrls && bl.isBlogUrl) s += 500;
  s += (bl.ascore || 0);
  // Tiny penalties so high-traffic spam pages and excessively long URLs lose
  // the tie-break against cleaner candidates. Capped so they can't dominate.
  s -= Math.min(bl.externalLinks || 0, 1000) * 0.01;
  s -= Math.min(bl.sourceUrl?.length || 0, 200) * 0.001;
  return s;
}

// Stable comparator: score > externalLinks (fewer wins) > sourceUrl (shorter
// wins) > 0 (keep original order).
function compareQuality(a, b, c) {
  const ds = qualityScore(a, c) - qualityScore(b, c);
  if (ds !== 0) return ds;
  const dx = (b.externalLinks || 0) - (a.externalLinks || 0);
  if (dx !== 0) return dx;
  return (b.sourceUrl?.length || 0) - (a.sourceUrl?.length || 0);
}

function domainMatchesRule(host, rule) {
  const normalizedHost = (host || '').toLowerCase().trim();
  const normalizedRule = normalizeDomainRule(rule);
  if (!normalizedHost || !normalizedRule) return false;
  return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
}

function normalizeDomainRule(rule) {
  return (rule || '').toLowerCase().trim().replace(/^\.+/, '').replace(/\.+$/, '');
}

function normalizeDomainRules(rules) {
  const out = [];
  const seen = new Set();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const normalized = normalizeDomainRule(rule);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
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
