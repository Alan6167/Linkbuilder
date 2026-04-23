// IndexedDB wrapper for Linkbuilder data storage
const DB_NAME = 'LinkbuilderDB';
const DB_VERSION = 3;

const STORES = {
  BACKLINKS: 'backlinks',
  COMMENTS: 'comments',
  DISCOVERED_SITES: 'discovered_sites',
  SETTINGS: 'settings',
  FAILURE_LOGS: 'failure_logs',
  URL_BLACKLIST: 'url_blacklist',
  BACKLINKS_LIBRARY: 'backlinks_library'
};

// URL normalization for blacklist / library membership checks.
// Strategy (locked — changing this requires a data version bump + rewrite pass):
// - lowercase scheme and host
// - preserve http vs https (same path may behave differently under each)
// - strip default ports (:80, :443)
// - drop fragment (#...)
// - preserve path trailing slash (some sites distinguish /post vs /post/)
// - preserve query string
// - strip tracking params via whitelist: utm_*, fbclid, gclid, ref
// - return original string unchanged when URL parsing fails (no throw)
function normalizeUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  try {
    const u = new URL(url);
    u.hash = '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    const params = u.searchParams;
    const toDelete = [];
    for (const k of params.keys()) {
      if (/^utm_/i.test(k) || /^(fbclid|gclid|ref)$/i.test(k)) toDelete.push(k);
    }
    for (const k of toDelete) params.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Backlinks store - imported from Semrush
      if (!db.objectStoreNames.contains(STORES.BACKLINKS)) {
        const backlinksStore = db.createObjectStore(STORES.BACKLINKS, { keyPath: 'id', autoIncrement: true });
        backlinksStore.createIndex('sourceUrl', 'sourceUrl', { unique: false });
        backlinksStore.createIndex('sourceDomain', 'sourceDomain', { unique: false });
        backlinksStore.createIndex('status', 'status', { unique: false });
        backlinksStore.createIndex('ascore', 'ascore', { unique: false });
      }

      // Comments store - published comments
      if (!db.objectStoreNames.contains(STORES.COMMENTS)) {
        const commentsStore = db.createObjectStore(STORES.COMMENTS, { keyPath: 'id', autoIncrement: true });
        commentsStore.createIndex('backlinkId', 'backlinkId', { unique: false });
        commentsStore.createIndex('publishedAt', 'publishedAt', { unique: false });
        commentsStore.createIndex('status', 'status', { unique: false });
      }

      // Discovered sites - sites found in blog comments
      if (!db.objectStoreNames.contains(STORES.DISCOVERED_SITES)) {
        const sitesStore = db.createObjectStore(STORES.DISCOVERED_SITES, { keyPath: 'id', autoIncrement: true });
        sitesStore.createIndex('domain', 'domain', { unique: true });
        sitesStore.createIndex('discoveredFrom', 'discoveredFrom', { unique: false });
      }

      // Settings store
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
      }

      // Failure logs - detailed diagnostic info for failed publishes
      if (!db.objectStoreNames.contains(STORES.FAILURE_LOGS)) {
        const logsStore = db.createObjectStore(STORES.FAILURE_LOGS, { keyPath: 'id', autoIncrement: true });
        logsStore.createIndex('sourceDomain', 'sourceDomain', { unique: false });
        logsStore.createIndex('failureType', 'failureType', { unique: false });
        logsStore.createIndex('loggedAt', 'loggedAt', { unique: false });
      }

      // URL blacklist - full-URL blacklist added by the user for failed backlinks
      if (!db.objectStoreNames.contains(STORES.URL_BLACKLIST)) {
        const bl = db.createObjectStore(STORES.URL_BLACKLIST, { keyPath: 'id', autoIncrement: true });
        // Non-unique on purpose: app-level dedup gives us freedom to change
        // normalizeUrl() rules later without triggering ConstraintError.
        bl.createIndex('sourceUrl', 'sourceUrl', { unique: false });
        bl.createIndex('sourceDomain', 'sourceDomain', { unique: false });
        bl.createIndex('addedAt', 'addedAt', { unique: false });
      }

      // Backlinks library - successfully published backlinks archived for reuse
      if (!db.objectStoreNames.contains(STORES.BACKLINKS_LIBRARY)) {
        const lib = db.createObjectStore(STORES.BACKLINKS_LIBRARY, { keyPath: 'id', autoIncrement: true });
        lib.createIndex('sourceUrl', 'sourceUrl', { unique: false });
        lib.createIndex('sourceDomain', 'sourceDomain', { unique: false });
        lib.createIndex('savedAt', 'savedAt', { unique: false });
        lib.createIndex('status', 'status', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function addRecords(storeName, records) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    let addedCount = 0;

    for (const record of records) {
      const req = store.add(record);
      req.onsuccess = () => addedCount++;
    }

    tx.oncomplete = () => resolve(addedCount);
    tx.onerror = () => reject(tx.error);
  });
}

async function getRecordsByIndex(storeName, indexName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const request = index.getAll(value);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllRecords(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function updateRecord(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(record);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteRecord(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function deleteCommentsByBacklinkId(backlinkId, statusPredicate) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.COMMENTS, 'readwrite');
    const store = tx.objectStore(STORES.COMMENTS);
    const idx = store.index('backlinkId');
    const req = idx.openCursor(IDBKeyRange.only(backlinkId));
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return;
      if (statusPredicate(cur.value.status)) cur.delete();
      cur.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearStore(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getRecordCount(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.count();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSetting(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SETTINGS, 'readonly');
    const store = tx.objectStore(STORES.SETTINGS);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result?.value);
    request.onerror = () => reject(request.error);
  });
}

async function setSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SETTINGS, 'readwrite');
    const store = tx.objectStore(STORES.SETTINGS);
    const request = store.put({ key, value });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Check if a domain already exists in backlinks
async function isDomainExists(domain) {
  const records = await getRecordsByIndex(STORES.BACKLINKS, 'sourceDomain', domain);
  return records.length > 0;
}

// ---------- URL blacklist ----------

async function addToBlacklist(url, reason) {
  const norm = normalizeUrl(url);
  if (!norm) return null;
  const existing = await getRecordsByIndex(STORES.URL_BLACKLIST, 'sourceUrl', norm);
  if (existing.length > 0) return existing[0].id;
  let sourceDomain = '';
  try { sourceDomain = new URL(norm).hostname; } catch {}
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.URL_BLACKLIST, 'readwrite');
    const store = tx.objectStore(STORES.URL_BLACKLIST);
    const req = store.add({
      sourceUrl: norm,
      sourceDomain,
      reason: reason || null,
      addedAt: new Date().toISOString()
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function isUrlBlacklisted(url) {
  const norm = normalizeUrl(url);
  if (!norm) return false;
  const hits = await getRecordsByIndex(STORES.URL_BLACKLIST, 'sourceUrl', norm);
  return hits.length > 0;
}

async function getBlacklist() {
  return getAllRecords(STORES.URL_BLACKLIST);
}

async function removeFromBlacklist(id) {
  return deleteRecord(STORES.URL_BLACKLIST, id);
}

async function clearBlacklist() {
  return clearStore(STORES.URL_BLACKLIST);
}

// ---------- Backlinks library ----------

async function addToLibrary(bl) {
  if (!bl || !bl.sourceUrl) return null;
  const norm = normalizeUrl(bl.sourceUrl);
  const existing = await getRecordsByIndex(STORES.BACKLINKS_LIBRARY, 'sourceUrl', norm);
  if (existing.length > 0) return existing[0].id;
  const record = {
    sourceUrl: norm,
    sourceDomain: bl.sourceDomain || '',
    sourceTitle: bl.sourceTitle || '',
    ascore: bl.ascore || 0,
    status: bl.status || '',
    commentedAt: bl.commentedAt || null,
    dofollowResult: (bl.dofollowResult === true) ? true : (bl.dofollowResult === false ? false : null),
    postedRel: bl.postedRel || '',
    savedAt: new Date().toISOString()
  };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.BACKLINKS_LIBRARY, 'readwrite');
    const store = tx.objectStore(STORES.BACKLINKS_LIBRARY);
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function isInLibrary(url) {
  const norm = normalizeUrl(url);
  if (!norm) return false;
  const hits = await getRecordsByIndex(STORES.BACKLINKS_LIBRARY, 'sourceUrl', norm);
  return hits.length > 0;
}

async function getLibrary() {
  return getAllRecords(STORES.BACKLINKS_LIBRARY);
}

async function removeFromLibrary(id) {
  return deleteRecord(STORES.BACKLINKS_LIBRARY, id);
}

async function clearLibrary() {
  return clearStore(STORES.BACKLINKS_LIBRARY);
}

export {
  STORES,
  openDB,
  addRecords,
  getRecordsByIndex,
  getAllRecords,
  updateRecord,
  deleteRecord,
  deleteCommentsByBacklinkId,
  clearStore,
  getRecordCount,
  getSetting,
  setSetting,
  isDomainExists,
  normalizeUrl,
  addToBlacklist,
  isUrlBlacklisted,
  getBlacklist,
  removeFromBlacklist,
  clearBlacklist,
  addToLibrary,
  isInLibrary,
  getLibrary,
  removeFromLibrary,
  clearLibrary
};
