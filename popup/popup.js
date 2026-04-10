import { STORES, addRecords, getAllRecords, updateRecord, clearStore, getRecordCount, getSetting, setSetting } from '../lib/db.js';
import { parseRow, filterBacklinks, getFilterStats, DEFAULT_FILTER_CONFIG } from '../lib/filter.js';
import { generateComment, analyzePageForComments } from '../lib/gemini.js';

// ========== State ==========
let parsedBacklinks = [];
let filteredBacklinks = [];
let currentPage = 1;
const PAGE_SIZE = 20;

// ========== Tab Navigation ==========
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'backlinks') loadBacklinksList();
    if (tab.dataset.tab === 'settings') loadSettings();
  });
});

// ========== Import Tab ==========
const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('file-input');

uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) processFile(file);
});

async function processFile(file) {
  const progressSection = document.getElementById('import-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const statsSection = document.getElementById('import-stats');

  progressSection.hidden = false;
  statsSection.hidden = true;
  progressFill.style.width = '10%';
  progressText.textContent = 'Reading file...';

  try {
    const data = await file.arrayBuffer();
    progressFill.style.width = '30%';
    progressText.textContent = 'Parsing Excel...';

    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    progressFill.style.width = '50%';
    progressText.textContent = 'Filtering backlinks...';

    // Skip header row
    const dataRows = rows.slice(1).filter(row => row.length >= 19);

    // Parse all rows
    parsedBacklinks = dataRows.map(row => parseRow(row));

    progressFill.style.width = '70%';
    progressText.textContent = 'Applying filters...';

    // Get filter config from settings
    const config = await getFilterConfig();
    filteredBacklinks = filterBacklinks(parsedBacklinks, config);

    progressFill.style.width = '100%';
    progressText.textContent = 'Done!';

    // Show stats
    const stats = getFilterStats(parsedBacklinks, filteredBacklinks);
    document.getElementById('stat-total').textContent = stats.totalImported;
    document.getElementById('stat-filtered').textContent = stats.afterFilter;
    document.getElementById('stat-ugc').textContent = stats.ugcCount;
    document.getElementById('stat-blog').textContent = stats.blogUrlCount;
    statsSection.hidden = false;

  } catch (err) {
    progressText.textContent = `Error: ${err.message}`;
    progressFill.style.width = '0%';
    console.error('Import error:', err);
  }
}

// Save imported data to IndexedDB
document.getElementById('btn-save-import').addEventListener('click', async () => {
  if (filteredBacklinks.length === 0) return;

  const btn = document.getElementById('btn-save-import');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const count = await addRecords(STORES.BACKLINKS, filteredBacklinks);
    btn.textContent = `Saved ${count} records!`;
    setTimeout(() => {
      btn.textContent = 'Save to Database';
      btn.disabled = false;
    }, 2000);
  } catch (err) {
    btn.textContent = `Error: ${err.message}`;
    btn.disabled = false;
  }
});

// ========== Backlinks Tab ==========
async function loadBacklinksList() {
  const list = document.getElementById('backlinks-list');
  const filterStatus = document.getElementById('filter-status').value;

  let backlinks = await getAllRecords(STORES.BACKLINKS);

  if (filterStatus !== 'all') {
    backlinks = backlinks.filter(b => b.status === filterStatus);
  }

  if (backlinks.length === 0) {
    list.innerHTML = '<p class="empty-state">No backlinks found. Import data from the Import tab.</p>';
    document.getElementById('pagination').hidden = true;
    return;
  }

  // Pagination
  const totalPages = Math.ceil(backlinks.length / PAGE_SIZE);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = backlinks.slice(start, start + PAGE_SIZE);

  list.innerHTML = pageItems.map(bl => `
    <div class="list-item" data-id="${bl.id}">
      <div class="list-item-header">
        <span class="list-item-title" title="${escapeHtml(bl.sourceTitle)}">${escapeHtml(bl.sourceTitle)}</span>
        <span class="badge badge-${bl.status}">${bl.status}</span>
      </div>
      <div class="list-item-url" title="${escapeHtml(bl.sourceUrl)}">${escapeHtml(bl.sourceUrl)}</div>
      <div class="list-item-meta">
        <span>Score: ${bl.ascore}</span>
        <span>Ext: ${bl.externalLinks}</span>
        ${bl.ugc ? '<span class="badge badge-ugc">UGC</span>' : ''}
        ${bl.isBlogUrl ? '<span class="badge badge-commentable">Blog</span>' : ''}
        ${bl.nofollow ? '<span>nofollow</span>' : '<span>dofollow</span>'}
      </div>
    </div>
  `).join('');

  // Pagination controls
  const pagination = document.getElementById('pagination');
  if (totalPages > 1) {
    pagination.hidden = false;
    document.getElementById('page-info').textContent = `Page ${currentPage} / ${totalPages}`;
    document.getElementById('btn-prev').disabled = currentPage === 1;
    document.getElementById('btn-next').disabled = currentPage === totalPages;
  } else {
    pagination.hidden = true;
  }
}

document.getElementById('filter-status').addEventListener('change', () => {
  currentPage = 1;
  loadBacklinksList();
});

document.getElementById('btn-prev').addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; loadBacklinksList(); }
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentPage++;
  loadBacklinksList();
});

// Analyze all pending backlinks
document.getElementById('btn-analyze-all').addEventListener('click', async () => {
  const apiKey = await getSetting('geminiApiKey');
  if (!apiKey) {
    alert('Please set your Gemini API key in Settings first.');
    return;
  }

  const backlinks = await getAllRecords(STORES.BACKLINKS);
  const pending = backlinks.filter(b => b.status === 'pending');

  if (pending.length === 0) {
    alert('No pending backlinks to analyze.');
    return;
  }

  const btn = document.getElementById('btn-analyze-all');
  btn.disabled = true;

  for (let i = 0; i < pending.length; i++) {
    btn.textContent = `Analyzing ${i + 1}/${pending.length}...`;
    const bl = pending[i];

    try {
      bl.status = 'analyzing';
      await updateRecord(STORES.BACKLINKS, bl);

      // Open tab, get HTML, analyze with AI
      const { tabId } = await chrome.runtime.sendMessage({ type: 'analyzeUrl', url: bl.sourceUrl });

      // Wait for page to load
      await new Promise(resolve => setTimeout(resolve, 3000));

      const { html } = await chrome.runtime.sendMessage({ type: 'getPageHtml', tabId });

      if (html) {
        const analysis = await analyzePageForComments(apiKey, html, bl.sourceUrl);
        bl.commentFormAnalysis = analysis;
        bl.status = analysis.hasCommentForm && !analysis.requiresLogin ? 'commentable' : 'not_commentable';

        // Extract comment links for snowball discovery
        try {
          const links = await chrome.tabs.sendMessage(tabId, { type: 'extractCommentLinks' });
          if (links?.links?.length > 0) {
            await addRecords(STORES.DISCOVERED_SITES, links.links);
          }
        } catch { /* content script may not be ready */ }
      } else {
        bl.status = 'error';
      }

      await chrome.runtime.sendMessage({ type: 'closeTab', tabId });
    } catch (err) {
      bl.status = 'error';
      bl.errorMessage = err.message;
    }

    await updateRecord(STORES.BACKLINKS, bl);
    await loadBacklinksList();
  }

  btn.textContent = 'Analyze All';
  btn.disabled = false;
});

// ========== Publish Tab ==========
document.getElementById('btn-start-publish').addEventListener('click', async () => {
  const name = document.getElementById('pub-name').value.trim();
  const email = document.getElementById('pub-email').value.trim();
  const website = document.getElementById('pub-website').value.trim();
  const mode = document.getElementById('pub-mode').value;

  if (!name || !email || !website) {
    alert('Please fill in your name, email, and website URL.');
    return;
  }

  const apiKey = await getSetting('geminiApiKey');
  if (!apiKey) {
    alert('Please set your Gemini API key in Settings first.');
    return;
  }

  // Save publish settings
  await setSetting('publishName', name);
  await setSetting('publishEmail', email);
  await setSetting('publishWebsite', website);
  await setSetting('publishMode', mode);

  const backlinks = await getAllRecords(STORES.BACKLINKS);
  const commentable = backlinks.filter(b => b.status === 'commentable');

  if (commentable.length === 0) {
    alert('No commentable backlinks found. Analyze backlinks first.');
    return;
  }

  const logArea = document.getElementById('publish-log');
  const logEntries = document.getElementById('log-entries');
  logArea.hidden = false;
  logEntries.innerHTML = '';

  const btn = document.getElementById('btn-start-publish');
  btn.disabled = true;
  btn.textContent = 'Publishing...';

  for (const bl of commentable) {
    try {
      addLog(logEntries, `Opening: ${bl.sourceUrl}`, 'info');

      // Open the page
      const { tabId } = await chrome.runtime.sendMessage({ type: 'analyzeUrl', url: bl.sourceUrl });
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Get page info for comment generation
      let pageInfo;
      try {
        pageInfo = await chrome.tabs.sendMessage(tabId, { type: 'getPageInfo' });
      } catch {
        pageInfo = { title: bl.sourceTitle, url: bl.sourceUrl, contentExcerpt: '' };
      }

      // Generate comment with AI
      addLog(logEntries, 'Generating comment...', 'info');
      const commentText = await generateComment(apiKey, {
        title: pageInfo.title,
        content: pageInfo.contentExcerpt,
        url: bl.sourceUrl,
        myWebsiteName: name,
        myWebsiteUrl: website
      });

      addLog(logEntries, `Comment: "${commentText.substring(0, 80)}..."`, 'info');

      // Fill the form
      const formData = {
        name: name,
        email: email,
        website: website,
        comment: commentText
      };

      const fieldSelectors = bl.commentFormAnalysis?.fields || {};
      await chrome.runtime.sendMessage({
        type: 'fillCommentForm',
        tabId,
        formData,
        fieldSelectors
      });

      addLog(logEntries, 'Form filled!', 'success');

      if (mode === 'auto') {
        // Auto submit
        const submitResult = await chrome.runtime.sendMessage({
          type: 'submitCommentForm',
          tabId,
          submitSelector: bl.commentFormAnalysis?.submitButton
        });

        if (submitResult.success) {
          addLog(logEntries, 'Comment submitted!', 'success');
          bl.status = 'commented';
        } else {
          addLog(logEntries, 'Submit failed: ' + (submitResult.error || 'unknown'), 'error');
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        await chrome.runtime.sendMessage({ type: 'closeTab', tabId });
      } else {
        // Semi-auto: leave tab open for user to review and submit manually
        addLog(logEntries, 'Review the comment and click submit manually.', 'info');
        // Wait for user - don't close tab
      }

      // Save comment record
      await addRecords(STORES.COMMENTS, [{
        backlinkId: bl.id,
        sourceUrl: bl.sourceUrl,
        commentText,
        name,
        email,
        website,
        mode,
        status: bl.status === 'commented' ? 'published' : 'pending_review',
        publishedAt: new Date().toISOString()
      }]);

      await updateRecord(STORES.BACKLINKS, bl);

    } catch (err) {
      addLog(logEntries, `Error: ${err.message}`, 'error');
    }
  }

  btn.textContent = 'Start Publishing';
  btn.disabled = false;
  addLog(logEntries, `Done! Processed ${commentable.length} backlinks.`, 'success');
});

function addLog(container, message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// ========== Settings Tab ==========
async function loadSettings() {
  const apiKey = await getSetting('geminiApiKey');
  if (apiKey) document.getElementById('setting-api-key').value = apiKey;

  const pubName = await getSetting('publishName');
  if (pubName) document.getElementById('pub-name').value = pubName;

  const pubEmail = await getSetting('publishEmail');
  if (pubEmail) document.getElementById('pub-email').value = pubEmail;

  const pubWebsite = await getSetting('publishWebsite');
  if (pubWebsite) document.getElementById('pub-website').value = pubWebsite;

  // Load DB stats
  document.getElementById('db-backlinks').textContent = await getRecordCount(STORES.BACKLINKS);
  document.getElementById('db-comments').textContent = await getRecordCount(STORES.COMMENTS);
  document.getElementById('db-sites').textContent = await getRecordCount(STORES.DISCOVERED_SITES);
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  await setSetting('geminiApiKey', document.getElementById('setting-api-key').value.trim());
  await setSetting('minAscore', parseInt(document.getElementById('setting-min-ascore').value) || 1);
  await setSetting('maxExternalLinks', parseInt(document.getElementById('setting-max-external').value) || 5000);
  await setSetting('filterLostLinks', document.getElementById('setting-filter-lost').checked);
  await setSetting('filterSpamDomains', document.getElementById('setting-filter-spam').checked);

  const btn = document.getElementById('btn-save-settings');
  btn.textContent = 'Saved!';
  setTimeout(() => btn.textContent = 'Save Settings', 1500);
});

// Export backlinks as CSV
document.getElementById('btn-export-backlinks').addEventListener('click', async () => {
  const backlinks = await getAllRecords(STORES.BACKLINKS);
  downloadCSV(backlinks, 'backlinks-export.csv',
    ['sourceUrl', 'sourceTitle', 'sourceDomain', 'ascore', 'status', 'ugc', 'nofollow', 'isBlogUrl', 'externalLinks']);
});

// Export discovered sites as CSV
document.getElementById('btn-export-discovered').addEventListener('click', async () => {
  const sites = await getAllRecords(STORES.DISCOVERED_SITES);
  downloadCSV(sites, 'discovered-sites.csv',
    ['domain', 'url', 'anchorText', 'discoveredFrom', 'discoveredAt']);
});

// Clear all data
document.getElementById('btn-clear-data').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to clear ALL data? This cannot be undone.')) return;

  await clearStore(STORES.BACKLINKS);
  await clearStore(STORES.COMMENTS);
  await clearStore(STORES.DISCOVERED_SITES);

  await loadSettings();
  alert('All data cleared.');
});

// ========== Utility Functions ==========
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function downloadCSV(data, filename, columns) {
  if (data.length === 0) {
    alert('No data to export.');
    return;
  }

  const header = columns.join(',');
  const rows = data.map(item =>
    columns.map(col => {
      const val = item[col] ?? '';
      return `"${String(val).replace(/"/g, '""')}"`;
    }).join(',')
  );

  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function getFilterConfig() {
  const minAscore = await getSetting('minAscore');
  const maxExternalLinks = await getSetting('maxExternalLinks');
  const filterLostLinks = await getSetting('filterLostLinks');
  const filterSpamDomains = await getSetting('filterSpamDomains');

  return {
    ...DEFAULT_FILTER_CONFIG,
    ...(minAscore != null && { minAscore }),
    ...(maxExternalLinks != null && { maxExternalLinks }),
    ...(filterLostLinks != null && { filterLostLinks }),
    ...(filterSpamDomains != null && { filterSpamDomains })
  };
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
});
