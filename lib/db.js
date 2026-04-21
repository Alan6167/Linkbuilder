// IndexedDB wrapper for Linkbuilder data storage
const DB_NAME = 'LinkbuilderDB';
const DB_VERSION = 2;

const STORES = {
  BACKLINKS: 'backlinks',
  COMMENTS: 'comments',
  DISCOVERED_SITES: 'discovered_sites',
  SETTINGS: 'settings',
  FAILURE_LOGS: 'failure_logs'
};

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
  isDomainExists
};
