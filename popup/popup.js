import { STORES, addRecords, getAllRecords, updateRecord, deleteRecord, clearStore, getRecordCount, getSetting, setSetting } from '../lib/db.js';
import { parseRow, filterBacklinks, getFilterStats, DEFAULT_FILTER_CONFIG } from '../lib/filter.js';
import { generateComment, setRateLimitCallback, formatLink, setProvider, getProvider } from '../lib/gemini.js';
import { t, setLanguage, getLanguage } from '../lib/i18n.js';

// ========== State ==========
let parsedBacklinks = [];
let filteredBacklinks = [];
let currentPage = 1;
const PAGE_SIZE = 20;
let analyzeRunning = false;
let publishRunning = false;

// ========== i18n ==========
document.getElementById('lang-toggle').addEventListener('click', async () => {
  const newLang = getLanguage() === 'zh' ? 'en' : 'zh';
  setLanguage(newLang);
  await setSetting('language', newLang);
  document.getElementById('setting-language').value = newLang;
});

document.getElementById('setting-language').addEventListener('change', async (e) => {
  setLanguage(e.target.value);
  await setSetting('language', e.target.value);
});

// ========== Tab Navigation ==========
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'backlinks') loadBacklinksList();
    if (tab.dataset.tab === 'publish') { loadSiteProfiles(); checkResumeTask(); }
    if (tab.dataset.tab === 'settings') loadSettings();
  });
});

// ========== Import Tab ==========

// Sub-tab switching
document.querySelectorAll('.sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sub-tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`subtab-${tab.dataset.subtab}`).classList.add('active');
  });
});

// -- Excel import --
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
  progressText.textContent = t('import.reading');

  try {
    const data = await file.arrayBuffer();
    progressFill.style.width = '30%';
    progressText.textContent = t('import.parsing');

    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    progressFill.style.width = '50%';
    progressText.textContent = t('import.filtering');

    const dataRows = rows.slice(1).filter(row => row.length >= 19);
    parsedBacklinks = dataRows.map(row => parseRow(row));

    progressFill.style.width = '70%';
    progressText.textContent = t('import.applying');

    const config = await getFilterConfig();
    filteredBacklinks = filterBacklinks(parsedBacklinks, config);

    progressFill.style.width = '100%';
    progressText.textContent = t('import.done');

    const stats = getFilterStats(parsedBacklinks, filteredBacklinks);
    document.getElementById('stat-total').textContent = stats.totalImported;
    document.getElementById('stat-filtered').textContent = stats.afterFilter;
    document.getElementById('stat-ugc').textContent = stats.ugcCount;
    document.getElementById('stat-blog').textContent = stats.blogUrlCount;
    statsSection.hidden = false;

  } catch (err) {
    progressText.textContent = t('common.error', { message: err.message });
    progressFill.style.width = '0%';
    console.error('Import error:', err);
  }
}

document.getElementById('btn-save-import').addEventListener('click', async () => {
  if (filteredBacklinks.length === 0) return;

  const btn = document.getElementById('btn-save-import');
  btn.disabled = true;
  btn.textContent = t('import.saving');

  try {
    const count = await addRecords(STORES.BACKLINKS, filteredBacklinks);
    btn.textContent = t('import.saved', { count });
    setTimeout(() => {
      btn.textContent = t('import.save');
      btn.disabled = false;
    }, 2000);
  } catch (err) {
    btn.textContent = t('common.error', { message: err.message });
    btn.disabled = false;
  }
});

// -- URL paste import --
document.getElementById('btn-add-urls').addEventListener('click', async () => {
  const input = document.getElementById('url-paste-input');
  const resultDiv = document.getElementById('url-import-result');
  const text = input.value.trim();

  if (!text) return;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const validUrls = [];

  for (const line of lines) {
    try {
      const url = new URL(line);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        validUrls.push(url.href);
      }
    } catch { /* skip invalid URLs */ }
  }

  if (validUrls.length === 0) {
    resultDiv.textContent = t('import.noValidUrls');
    resultDiv.hidden = false;
    return;
  }

  // Check for duplicates against existing backlinks
  const existing = await getAllRecords(STORES.BACKLINKS);
  const existingUrls = new Set(existing.map(b => b.sourceUrl));

  const newRecords = [];
  let skipped = 0;
  for (const url of validUrls) {
    if (existingUrls.has(url)) {
      skipped++;
      continue;
    }
    existingUrls.add(url);
    const domain = new URL(url).hostname;
    newRecords.push({
      ascore: 0,
      sourceTitle: domain, // will be updated when page is analyzed
      sourceUrl: url,
      targetUrl: '',
      anchor: '',
      externalLinks: 0,
      internalLinks: 0,
      nofollow: false,
      sponsored: false,
      ugc: false,
      isText: true,
      isFrame: false,
      isForm: false,
      isImage: false,
      sitewide: false,
      firstSeen: '',
      lastSeen: '',
      newLink: false,
      lostLink: false,
      sourceDomain: domain,
      isBlogUrl: /blog|post|article|\/\d{4}\/\d{2}\/|wordpress|comment/i.test(url),
      isSpam: false,
      status: 'pending',
      importedAt: new Date().toISOString()
    });
  }

  if (newRecords.length > 0) {
    await addRecords(STORES.BACKLINKS, newRecords);
  }

  resultDiv.textContent = t('import.urlsResult', { added: newRecords.length, skipped });
  resultDiv.hidden = false;
  input.value = '';
});

// ========== Backlinks Tab ==========
let currentFilter = 'all';

// Status group mapping: merge similar statuses into 4 groups
const STATUS_GROUPS = {
  pending: ['pending', 'analyzing'],
  commentable: ['commentable'],
  published: ['commented', 'pending_moderation', 'pending_review'],
  failed: ['publish_failed', 'captcha_blocked', 'error', 'not_commentable']
};

function getStatusGroup(status) {
  for (const [group, statuses] of Object.entries(STATUS_GROUPS)) {
    if (statuses.includes(status)) return group;
  }
  return 'failed';
}

async function loadBacklinksList() {
  let allBacklinks = await getAllRecords(STORES.BACKLINKS);
  const list = document.getElementById('backlinks-list');

  // Update status bar counts
  const counts = { all: allBacklinks.length, pending: 0, commentable: 0, published: 0, failed: 0 };
  for (const bl of allBacklinks) {
    counts[getStatusGroup(bl.status)]++;
  }
  document.getElementById('count-all').textContent = counts.all;
  document.getElementById('count-pending').textContent = counts.pending;
  document.getElementById('count-commentable').textContent = counts.commentable;
  document.getElementById('count-published').textContent = counts.published;
  document.getElementById('count-failed').textContent = counts.failed;

  // Apply status filter
  let backlinks = allBacklinks;
  if (currentFilter !== 'all') {
    const statuses = STATUS_GROUPS[currentFilter] || [];
    backlinks = backlinks.filter(b => statuses.includes(b.status));
  }

  // Apply search
  const search = document.getElementById('bl-search').value.trim().toLowerCase();
  if (search) {
    backlinks = backlinks.filter(b =>
      (b.sourceDomain || '').toLowerCase().includes(search) ||
      (b.sourceTitle || '').toLowerCase().includes(search)
    );
  }

  // Apply sort
  const sort = document.getElementById('bl-sort').value;
  backlinks.sort((a, b) => {
    if (sort === 'ascore_desc') return b.ascore - a.ascore;
    if (sort === 'ascore_asc') return a.ascore - b.ascore;
    if (sort === 'date_desc') return (b.importedAt || '').localeCompare(a.importedAt || '');
    if (sort === 'domain') return (a.sourceDomain || '').localeCompare(b.sourceDomain || '');
    return 0;
  });

  if (backlinks.length === 0) {
    list.innerHTML = `<p class="empty-state">${t('backlinks.empty')}</p>`;
    document.getElementById('pagination').hidden = true;
    updateBatchBar();
    return;
  }

  // Pagination
  const totalPages = Math.ceil(backlinks.length / PAGE_SIZE);
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = backlinks.slice(start, start + PAGE_SIZE);

  list.innerHTML = pageItems.map(bl => {
    const group = getStatusGroup(bl.status);
    const dimClass = bl.status === 'not_commentable' ? ' list-item-dim' : '';

    let extraInfo = '';
    if (bl.errorMessage && ['publish_failed', 'error', 'captcha_blocked'].includes(bl.status)) {
      extraInfo = `<div class="list-item-error">${escapeHtml(bl.errorMessage).substring(0, 120)}</div>`;
    }
    if (bl.commentedAt && ['commented', 'pending_moderation'].includes(bl.status)) {
      const sites = bl.commentedWith?.join(', ') || '';
      extraInfo = `<div class="list-item-published">${bl.commentedAt.substring(0, 10)}${sites ? ' · ' + escapeHtml(sites) : ''}</div>`;
    }

    const actions = [];
    if (['commented', 'pending_moderation'].includes(bl.status)) {
      actions.push(`<button class="btn-reverify btn btn-small" data-id="${bl.id}" data-url="${escapeHtml(bl.sourceUrl)}">${t('backlinks.reverify')}</button>`);
    }
    if (['publish_failed', 'error', 'captcha_blocked'].includes(bl.status)) {
      actions.push(`<button class="btn-retry btn btn-small" data-id="${bl.id}">${t('backlinks.retry')}</button>`);
    }
    actions.push(`<button class="btn-delete-bl btn btn-small" data-id="${bl.id}" title="${t('backlinks.delete')}">x</button>`);

    return `
    <div class="list-item${dimClass}" data-id="${bl.id}">
      <div class="list-item-header">
        <input type="checkbox" class="list-item-checkbox bl-checkbox" data-id="${bl.id}">
        <span class="list-item-title" title="${escapeHtml(bl.sourceTitle)}">${escapeHtml(bl.sourceTitle || bl.sourceDomain)}</span>
        <span class="badge badge-${group}">${t('backlinks.grp' + group.charAt(0).toUpperCase() + group.slice(1))}</span>
        <a class="list-item-link" href="${escapeHtml(bl.sourceUrl)}" target="_blank" title="${escapeHtml(bl.sourceUrl)}">&#x1F517;</a>
      </div>
      <div class="list-item-meta">
        <span title="${escapeHtml(bl.sourceUrl)}">${escapeHtml(bl.sourceDomain || '')}</span>
        ${bl.ascore ? `<span>Score:${bl.ascore}</span>` : ''}
        ${bl.ugc ? '<span class="badge badge-ugc">UGC</span>' : ''}
        ${bl.nofollow ? '<span>nofollow</span>' : ''}
        ${bl.firstSeen ? `<span>${bl.firstSeen.substring(0, 10)}</span>` : ''}
        ${actions.join('')}
      </div>
      ${extraInfo}
    </div>`;
  }).join('');

  // Wire up item action buttons
  list.querySelectorAll('.btn-reverify').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const blId = parseInt(btn.dataset.id);
      const url = btn.dataset.url;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const { tabId } = await chrome.runtime.sendMessage({ type: 'analyzeUrl', url });
        const verification = await chrome.runtime.sendMessage({ type: 'verifyComment', tabId, commentText: '', website: '' });
        await chrome.runtime.sendMessage({ type: 'closeTab', tabId });
        const allBl = await getAllRecords(STORES.BACKLINKS);
        const bl = allBl.find(b => b.id === blId);
        if (bl) {
          bl.status = verification.status === 'confirmed' ? 'commented' : verification.status === 'rejected' ? 'publish_failed' : 'pending_moderation';
          bl.lastVerified = new Date().toISOString();
          await updateRecord(STORES.BACKLINKS, bl);
        }
        await loadBacklinksList();
      } catch { btn.textContent = t('backlinks.reverify'); btn.disabled = false; }
    });
  });

  list.querySelectorAll('.btn-retry').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const blId = parseInt(btn.dataset.id);
      const allBl = await getAllRecords(STORES.BACKLINKS);
      const bl = allBl.find(b => b.id === blId);
      if (bl) { bl.status = 'commentable'; delete bl.errorMessage; await updateRecord(STORES.BACKLINKS, bl); await loadBacklinksList(); }
    });
  });

  list.querySelectorAll('.btn-delete-bl').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteRecord(STORES.BACKLINKS, parseInt(btn.dataset.id));
      await loadBacklinksList();
    });
  });

  // Checkbox change → update batch bar
  list.querySelectorAll('.bl-checkbox').forEach(cb => {
    cb.addEventListener('change', updateBatchBar);
  });

  // Pagination
  const pagination = document.getElementById('pagination');
  if (totalPages > 1) {
    pagination.hidden = false;
    document.getElementById('page-info').textContent = t('pagination.page', { current: currentPage, total: totalPages });
    document.getElementById('btn-prev').disabled = currentPage === 1;
    document.getElementById('btn-next').disabled = currentPage === totalPages;
  } else {
    pagination.hidden = true;
  }

  updateBatchBar();
}

// Status bar chip click
document.querySelectorAll('.status-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.status-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.filter;
    currentPage = 1;
    loadBacklinksList();
  });
});

// Search input
document.getElementById('bl-search').addEventListener('input', () => {
  currentPage = 1;
  loadBacklinksList();
});

// Sort change
document.getElementById('bl-sort').addEventListener('change', () => loadBacklinksList());

// Pagination
document.getElementById('btn-prev').addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; loadBacklinksList(); }
});
document.getElementById('btn-next').addEventListener('click', () => {
  currentPage++;
  loadBacklinksList();
});

// Batch action bar
function updateBatchBar() {
  const checked = document.querySelectorAll('.bl-checkbox:checked');
  const bar = document.getElementById('batch-bar');
  if (checked.length > 0) {
    bar.hidden = false;
    document.getElementById('batch-count').textContent = t('backlinks.selectedCount', { count: checked.length });
  } else {
    bar.hidden = true;
  }
}

document.getElementById('bl-select-all').addEventListener('change', (e) => {
  document.querySelectorAll('.bl-checkbox').forEach(cb => { cb.checked = e.target.checked; });
  updateBatchBar();
});

document.getElementById('btn-batch-delete').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('.bl-checkbox:checked')].map(cb => parseInt(cb.dataset.id));
  if (ids.length === 0) return;
  if (!confirm(t('backlinks.deleteConfirm', { count: ids.length }))) return;
  for (const id of ids) { await deleteRecord(STORES.BACKLINKS, id); }
  await loadBacklinksList();
});

document.getElementById('btn-batch-retry').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('.bl-checkbox:checked')].map(cb => parseInt(cb.dataset.id));
  const allBl = await getAllRecords(STORES.BACKLINKS);
  for (const id of ids) {
    const bl = allBl.find(b => b.id === id);
    if (bl && ['publish_failed', 'error', 'captcha_blocked', 'not_commentable'].includes(bl.status)) {
      bl.status = 'commentable';
      delete bl.errorMessage;
      await updateRecord(STORES.BACKLINKS, bl);
    }
  }
  await loadBacklinksList();
});

// Stop analyze button
document.getElementById('btn-stop-analyze').addEventListener('click', () => {
  analyzeRunning = false;
});

// Analyze all pending backlinks - uses LOCAL content script (no API needed)
document.getElementById('btn-analyze-all').addEventListener('click', async () => {
  const backlinks = await getAllRecords(STORES.BACKLINKS);
  const pending = backlinks.filter(b => b.status === 'pending');

  if (pending.length === 0) {
    alert(t('backlinks.noPending'));
    return;
  }

  const btnAnalyze = document.getElementById('btn-analyze-all');
  const btnStop = document.getElementById('btn-stop-analyze');
  btnAnalyze.disabled = true;
  btnStop.hidden = false;
  analyzeRunning = true;

  let stats = { commentable: 0, notCommentable: 0, error: 0 };

  for (let i = 0; i < pending.length; i++) {
    if (!analyzeRunning) {
      btnAnalyze.textContent = t('backlinks.stopped');
      break;
    }

    btnAnalyze.textContent = t('backlinks.analyzing', { current: i + 1, total: pending.length });
    const bl = pending[i];
    let tabId = null;

    try {
      bl.status = 'analyzing';
      await updateRecord(STORES.BACKLINKS, bl);

      // Open tab and WAIT for full page load (not just 3s)
      const result = await chrome.runtime.sendMessage({ type: 'analyzeUrl', url: bl.sourceUrl });
      tabId = result.tabId;

      // Use content script for LOCAL analysis (no API call)
      const analysis = await chrome.runtime.sendMessage({ type: 'analyzePageViaContentScript', tabId });

      if (analysis && !analysis.error) {
        bl.commentFormAnalysis = analysis;
        bl.status = analysis.hasCommentForm && !analysis.requiresLogin ? 'commentable' : 'not_commentable';
        stats[bl.status === 'commentable' ? 'commentable' : 'notCommentable']++;
      } else {
        bl.status = 'error';
        bl.errorMessage = analysis?.error || 'Analysis failed';
        stats.error++;
      }

      // Extract comment links for snowball discovery
      const linksResult = await chrome.runtime.sendMessage({ type: 'extractLinksViaContentScript', tabId });
      if (linksResult?.links?.length > 0) {
        try { await addRecords(STORES.DISCOVERED_SITES, linksResult.links); } catch { /* duplicates ok */ }
      }

    } catch (err) {
      bl.status = 'error';
      bl.errorMessage = err.message;
      stats.error++;
    }

    // Always close the tab
    if (tabId) {
      try { await chrome.runtime.sendMessage({ type: 'closeTab', tabId }); } catch {}
    }

    await updateRecord(STORES.BACKLINKS, bl);
    await loadBacklinksList();
  }

  btnAnalyze.textContent = analyzeRunning
    ? t('backlinks.analyzeComplete', stats)
    : t('backlinks.stopped');
  btnAnalyze.disabled = false;
  btnStop.hidden = true;
  analyzeRunning = false;

  setTimeout(() => {
    btnAnalyze.textContent = t('backlinks.analyzeAll');
  }, 3000);
});

// ========== Publish Tab - Site Profiles ==========
async function getSiteProfiles() {
  return (await getSetting('siteProfiles')) || [];
}

async function saveSiteProfiles(profiles) {
  await setSetting('siteProfiles', profiles);
}

async function loadSiteProfiles() {
  const profiles = await getSiteProfiles();

  // Populate the edit dropdown
  const select = document.getElementById('pub-site-select');
  const deleteBtn = document.getElementById('btn-delete-site');
  select.innerHTML = `<option value="">${t('publish.selectSite')}</option>`;
  profiles.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = p.profileName || p.website;
    select.appendChild(opt);
  });
  document.getElementById('pub-profile-name').value = '';
  document.getElementById('pub-name').value = '';
  document.getElementById('pub-email').value = '';
  document.getElementById('pub-website').value = '';
  deleteBtn.hidden = true;

  // Populate the multi-select checkboxes for publishing
  const checkboxList = document.getElementById('pub-site-checkboxes');
  if (profiles.length === 0) {
    checkboxList.innerHTML = `<div class="empty-hint">${t('publish.noSites')}</div>`;
    return;
  }
  checkboxList.innerHTML = profiles.map((p, i) => `
    <label title="${escapeHtml(p.siteDescription || '')}">
      <input type="checkbox" name="pub-sites" value="${i}">
      <span>${escapeHtml(p.profileName || p.name)}</span>
      <span class="site-url">${escapeHtml(p.website)}</span>
    </label>
  `).join('');
}

// Select a site profile
document.getElementById('pub-site-select').addEventListener('change', async (e) => {
  const profiles = await getSiteProfiles();
  const idx = parseInt(e.target.value);
  const deleteBtn = document.getElementById('btn-delete-site');

  if (isNaN(idx) || !profiles[idx]) {
    document.getElementById('pub-profile-name').value = '';
    document.getElementById('pub-name').value = '';
    document.getElementById('pub-email').value = '';
    document.getElementById('pub-website').value = '';
    document.getElementById('pub-site-desc').value = '';
    deleteBtn.hidden = true;
    return;
  }

  const p = profiles[idx];
  document.getElementById('pub-profile-name').value = p.profileName || '';
  document.getElementById('pub-name').value = p.name || '';
  document.getElementById('pub-email').value = p.email || '';
  document.getElementById('pub-website').value = p.website || '';
  document.getElementById('pub-site-desc').value = p.siteDescription || '';
  deleteBtn.hidden = false;
});

// Add new site (clear form)
document.getElementById('btn-add-site').addEventListener('click', () => {
  document.getElementById('pub-site-select').value = '';
  document.getElementById('pub-profile-name').value = '';
  document.getElementById('pub-name').value = '';
  document.getElementById('pub-email').value = '';
  document.getElementById('pub-website').value = '';
  document.getElementById('pub-site-desc').value = '';
  document.getElementById('btn-delete-site').hidden = true;
});

// Save site profile
document.getElementById('btn-save-site').addEventListener('click', async () => {
  const profileName = document.getElementById('pub-profile-name').value.trim();
  const name = document.getElementById('pub-name').value.trim();
  const email = document.getElementById('pub-email').value.trim();
  const website = document.getElementById('pub-website').value.trim();
  const siteDescription = document.getElementById('pub-site-desc').value.trim();

  if (!name || !email || !website) {
    alert(t('publish.fillRequired'));
    return;
  }

  const profiles = await getSiteProfiles();
  const selectIdx = parseInt(document.getElementById('pub-site-select').value);

  const profile = { profileName: profileName || website, name, email, website, siteDescription };

  if (!isNaN(selectIdx) && profiles[selectIdx]) {
    profiles[selectIdx] = profile; // Update existing
  } else {
    profiles.push(profile); // Add new
  }

  await saveSiteProfiles(profiles);
  await loadSiteProfiles();

  // Re-select the saved profile
  const select = document.getElementById('pub-site-select');
  const newIdx = !isNaN(selectIdx) && selectIdx < profiles.length ? selectIdx : profiles.length - 1;
  select.value = newIdx;
  select.dispatchEvent(new Event('change'));

  const btn = document.getElementById('btn-save-site');
  btn.textContent = t('publish.siteSaved');
  setTimeout(() => btn.textContent = t('publish.saveSite'), 1500);
});

// Delete site profile
document.getElementById('btn-delete-site').addEventListener('click', async () => {
  const selectIdx = parseInt(document.getElementById('pub-site-select').value);
  if (isNaN(selectIdx)) return;

  const profiles = await getSiteProfiles();
  profiles.splice(selectIdx, 1);
  await saveSiteProfiles(profiles);
  await loadSiteProfiles();
});

// Toggle embed link fields
document.getElementById('pub-embed-link').addEventListener('change', (e) => {
  document.getElementById('embed-link-fields').hidden = !e.target.checked;
  updateLinkPreview();
});

// Toggle custom prompt field
document.getElementById('pub-custom-prompt-toggle').addEventListener('change', (e) => {
  document.getElementById('custom-prompt-field').hidden = !e.target.checked;
});

// Update link preview on any change
for (const id of ['pub-link-format', 'pub-link-url', 'pub-link-anchor']) {
  document.getElementById(id).addEventListener('input', updateLinkPreview);
  document.getElementById(id).addEventListener('change', updateLinkPreview);
}

function updateLinkPreview() {
  const format = document.getElementById('pub-link-format').value;
  const url = document.getElementById('pub-link-url').value.trim() || document.getElementById('pub-website').value.trim() || 'https://yoursite.com';
  const anchor = document.getElementById('pub-link-anchor').value.trim() || 'Your Site';
  const preview = document.getElementById('link-preview');
  if (preview) {
    preview.textContent = format === 'auto'
      ? `auto → ${formatLink(url, anchor, 'html')}`
      : formatLink(url, anchor, format);
  }
}

// Stop publish button - explicit stop clears the task state
document.getElementById('btn-stop-publish').addEventListener('click', async () => {
  publishRunning = false;
  setTimeout(async () => { await clearTaskState(); }, 1000);
});

// ========== Resume banner ==========
async function checkResumeTask() {
  const task = await getTaskState();
  const banner = document.getElementById('resume-banner');

  if (!task || !task.backlinkIds || publishRunning) {
    banner.hidden = true;
    return;
  }

  const total = task.backlinkIds.length;
  const done = task.pageIndex;
  const savedAgo = task.savedAt
    ? Math.round((Date.now() - new Date(task.savedAt).getTime()) / 60000)
    : 0;

  document.getElementById('resume-info').textContent = t('publish.resumeInfo', {
    done, total,
    minutes: savedAgo
  });
  banner.hidden = false;
}

document.getElementById('btn-resume-task').addEventListener('click', async () => {
  const task = await getTaskState();
  if (!task) return;

  document.getElementById('resume-banner').hidden = true;

  await runPublishLoop({
    backlinkIds: task.backlinkIds,
    selectedSites: task.selectedSites,
    mode: task.mode,
    delay: task.delay,
    startPageIndex: task.pageIndex,
    startSiteIndex: task.siteIndex,
    initialStats: task.stats || { confirmed: 0, moderation: 0, failed: 0, captcha: 0 }
  });
});

document.getElementById('btn-discard-task').addEventListener('click', async () => {
  if (!confirm(t('publish.discardConfirm'))) return;
  await clearTaskState();
  document.getElementById('resume-banner').hidden = true;
});

// Build comment config from UI
function getCommentConfig(detectedLinkFormat) {
  const embedLink = document.getElementById('pub-embed-link').checked;
  let linkFormat = document.getElementById('pub-link-format').value;
  if (linkFormat === 'auto') linkFormat = detectedLinkFormat || 'html';

  return {
    commentLength: document.getElementById('pub-comment-length').value,
    embedLink,
    linkFormat,
    linkUrl: document.getElementById('pub-link-url').value.trim() || document.getElementById('pub-website').value.trim(),
    linkAnchor: document.getElementById('pub-link-anchor').value.trim(),
    customInstructions: document.getElementById('pub-custom-instructions').value.trim(),
    promptTemplate: document.getElementById('pub-custom-prompt-toggle').checked
      ? document.getElementById('pub-custom-prompt').value.trim()
      : ''
  };
}

// Start publishing
document.getElementById('btn-start-publish').addEventListener('click', async () => {
  const profiles = await getSiteProfiles();
  const checked = [...document.querySelectorAll('input[name="pub-sites"]:checked')];
  const selectedSites = checked.map(cb => profiles[parseInt(cb.value)]).filter(Boolean);

  if (selectedSites.length === 0) {
    alert(t('publish.noSitesSelected'));
    return;
  }

  const mode = document.getElementById('pub-mode').value;
  const delay = Math.max(5, parseInt(document.getElementById('pub-delay').value) || 30);
  const maxPages = parseInt(document.getElementById('pub-max-pages').value) || 0;

  const apiKey = await getSetting('geminiApiKey');
  if (!apiKey) {
    alert(t('settings.noApiKey'));
    return;
  }

  const backlinks = await getAllRecords(STORES.BACKLINKS);
  let commentable = backlinks.filter(b => b.status === 'commentable');
  if (maxPages > 0 && commentable.length > maxPages) {
    commentable = commentable.slice(0, maxPages);
  }

  if (commentable.length === 0) {
    alert(t('publish.noCommentable'));
    return;
  }

  await runPublishLoop({
    backlinkIds: commentable.map(b => b.id),
    selectedSites,
    mode,
    delay,
    startPageIndex: 0,
    startSiteIndex: 0,
    initialStats: { confirmed: 0, moderation: 0, failed: 0, captcha: 0 }
  });
});

// ========== Publish task state (for resume) ==========
async function saveTaskState(state) {
  await setSetting('currentPublishTask', state);
}

async function getTaskState() {
  return await getSetting('currentPublishTask');
}

async function clearTaskState() {
  await setSetting('currentPublishTask', null);
}

// Core publish loop — used for both fresh start and resume
async function runPublishLoop({ backlinkIds, selectedSites, mode, delay, startPageIndex, startSiteIndex, initialStats }) {
  const apiKey = await getSetting('geminiApiKey');

  // Load fresh backlinks from DB (status may have changed)
  const allBacklinks = await getAllRecords(STORES.BACKLINKS);
  const backlinkMap = new Map(allBacklinks.map(b => [b.id, b]));
  const commentable = backlinkIds.map(id => backlinkMap.get(id)).filter(Boolean);

  if (commentable.length === 0) {
    alert(t('publish.noCommentable'));
    await clearTaskState();
    return;
  }

  const logArea = document.getElementById('publish-log');
  const logEntries = document.getElementById('log-entries');
  logArea.hidden = false;

  setRateLimitCallback((seconds) => {
    addLog(logEntries, t('publish.rateLimit', { seconds }), 'info');
  });

  if (startPageIndex === 0 && startSiteIndex === 0) {
    logEntries.innerHTML = '';
    addLog(logEntries, t('publish.startInfo', {
      sites: selectedSites.length,
      pages: commentable.length,
      delay
    }), 'info');
  } else {
    addLog(logEntries, t('publish.resumed', {
      page: startPageIndex + 1,
      total: commentable.length
    }), 'info');
  }

  const btnStart = document.getElementById('btn-start-publish');
  const btnStop = document.getElementById('btn-stop-publish');
  btnStart.hidden = true;
  btnStop.hidden = false;
  publishRunning = true;

  let pubStats = { ...initialStats };

  for (let i = startPageIndex; i < commentable.length; i++) {
    if (!publishRunning) {
      addLog(logEntries, t('backlinks.stopped'), 'error');
      // Save state for potential resume
      await saveTaskState({
        backlinkIds,
        selectedSites,
        mode,
        delay,
        pageIndex: i,
        siteIndex: 0,
        stats: pubStats,
        savedAt: new Date().toISOString()
      });
      btnStart.hidden = false;
      btnStop.hidden = true;
      return;
    }

    const bl = commentable[i];
    const siteStart = i === startPageIndex ? startSiteIndex : 0;

    for (let s = siteStart; s < selectedSites.length; s++) {
      if (!publishRunning) {
        await saveTaskState({
          backlinkIds, selectedSites, mode, delay,
          pageIndex: i, siteIndex: s,
          stats: pubStats,
          savedAt: new Date().toISOString()
        });
        btnStart.hidden = false;
        btnStop.hidden = true;
        return;
      }

      // Save progress before processing each site
      await saveTaskState({
        backlinkIds, selectedSites, mode, delay,
        pageIndex: i, siteIndex: s,
        stats: pubStats,
        savedAt: new Date().toISOString()
      });

      const site = selectedSites[s];
      const { name, email, website } = site;

      addLog(logEntries, `--- [${i + 1}/${commentable.length}] ${site.profileName} ---`, 'info');

      let tabId = null;
      try {
        addLog(logEntries, t('publish.opening', { url: bl.sourceUrl }), 'info');

        const result = await chrome.runtime.sendMessage({ type: 'analyzeUrl', url: bl.sourceUrl });
        tabId = result.tabId;

        let pageInfo;
        try {
          pageInfo = await chrome.tabs.sendMessage(tabId, { type: 'getPageInfo' });
        } catch {
          pageInfo = { title: bl.sourceTitle, url: bl.sourceUrl, contentExcerpt: '', language: 'en', linkFormat: 'html' };
        }

        addLog(logEntries, `[${pageInfo.language}] ${pageInfo.title}`, 'info');

        // Pre-check: has this site already commented on this page?
        const preCheck = await chrome.runtime.sendMessage({
          type: 'verifyComment', tabId, commentText: '', website
        });
        if (preCheck.verified) {
          addLog(logEntries, t('publish.alreadyCommented', { site: site.profileName }), 'info');
          if (!bl._siteResults) bl._siteResults = [];
          bl._siteResults.push('already_exists');
          pubStats.moderation++;
          if (mode === 'auto') {
            await chrome.runtime.sendMessage({ type: 'closeTab', tabId });
            tabId = null;
          }
          continue;
        }

        const commentConfig = getCommentConfig(pageInfo.linkFormat);
        commentConfig.linkUrl = commentConfig.linkUrl || website;

        // First: check if the page actually has a usable comment form BEFORE calling AI
        const freshAnalysis = await chrome.runtime.sendMessage({ type: 'analyzePageViaContentScript', tabId });
        const fieldSelectors = (freshAnalysis && freshAnalysis.fields && Object.keys(freshAnalysis.fields).length > 0)
          ? freshAnalysis.fields
          : (bl.commentFormAnalysis?.fields || {});
        const frameId = freshAnalysis?.frameId;

        if (!fieldSelectors.comment) {
          addLog(logEntries, t('publish.noCommentField'), 'error');
          if (!bl._siteResults) bl._siteResults = [];
          bl._siteResults.push('no_form');
          pubStats.failed++;
          if (tabId) await chrome.runtime.sendMessage({ type: 'closeTab', tabId });
          tabId = null;
          continue; // skip to next site, don't waste API call
        }

        if (frameId != null && frameId !== 0) {
          addLog(logEntries, t('publish.formInFrame', { frameId }), 'info');
        }

        // Now we know the form is usable — call AI to generate comment
        addLog(logEntries, t('publish.generating'), 'info');
        const commentText = await generateComment(apiKey, {
          title: pageInfo.title,
          content: pageInfo.contentExcerpt,
          url: bl.sourceUrl,
          language: pageInfo.language,
          myWebsiteName: site.profileName || name,
          myWebsiteUrl: website,
          siteDescription: site.siteDescription || ''
        }, commentConfig);

        addLog(logEntries, t('publish.comment', { text: commentText.substring(0, 80) }), 'info');

        const formData = { name, email, website, comment: commentText };
        const fillResult = await chrome.runtime.sendMessage({
          type: 'fillCommentForm', tabId, formData, fieldSelectors, frameId
        });

        if (!fillResult.success) {
          const details = Object.entries(fillResult.results || {})
            .map(([k, v]) => `${k}:${v}`).join(', ');
          throw new Error(t('publish.fillFailed', { details }));
        }

        addLog(logEntries, t('publish.filledDetail', {
          filled: fillResult.filledCount,
          total: fillResult.totalCount
        }), 'success');

        let commentStatus = 'unknown';

        if (mode === 'auto') {
          const submitResult = await chrome.runtime.sendMessage({
            type: 'submitCommentForm',
            tabId,
            submitSelector: freshAnalysis?.submitButton || bl.commentFormAnalysis?.submitButton,
            frameId
          });

          if (submitResult.success) {
            addLog(logEntries, t('publish.submitted'), 'success');
            addLog(logEntries, t('publish.verifying'), 'info');
            const verification = await chrome.runtime.sendMessage({
              type: 'verifyComment', tabId,
              commentText: commentText.substring(0, 50),
              website
            });

            commentStatus = verification.status;
            const statusKey = `publish.verify_${commentStatus}`;
            const logType = commentStatus === 'confirmed' ? 'success'
              : (commentStatus === 'rejected' || commentStatus === 'captcha') ? 'error' : 'info';
            addLog(logEntries, `${t(statusKey)}: ${verification.reason}`, logType);

            if (commentStatus === 'confirmed') pubStats.confirmed++;
            else if (commentStatus === 'captcha') pubStats.captcha++;
            else if (commentStatus === 'rejected') pubStats.failed++;
            else pubStats.moderation++;
          } else {
            addLog(logEntries, t('publish.submitFailed', { error: submitResult.error || 'unknown' }), 'error');
            commentStatus = 'submit_failed';
            pubStats.failed++;
          }

          if (tabId) await chrome.runtime.sendMessage({ type: 'closeTab', tabId });
          tabId = null;
        } else {
          commentStatus = 'pending_review';
          addLog(logEntries, t('publish.review'), 'info');
          pubStats.moderation++;
        }

        await addRecords(STORES.COMMENTS, [{
          backlinkId: bl.id,
          sourceUrl: bl.sourceUrl,
          sourceDomain: bl.sourceDomain,
          commentText,
          name, email, website, mode,
          siteProfile: site.profileName,
          status: commentStatus,
          publishedAt: new Date().toISOString()
        }]);

        if (!bl._siteResults) bl._siteResults = [];
        bl._siteResults.push(commentStatus);

      } catch (err) {
        addLog(logEntries, t('common.error', { message: err.message }), 'error');
        pubStats.failed++;
        if (!bl._siteResults) bl._siteResults = [];
        bl._siteResults.push('error');

        // Log detailed failure info for analysis
        await addRecords(STORES.FAILURE_LOGS, [{
          sourceUrl: bl.sourceUrl,
          sourceDomain: bl.sourceDomain,
          sourceTitle: bl.sourceTitle,
          siteProfile: site.profileName,
          failureType: classifyFailure(err.message),
          errorMessage: err.message,
          stage: 'publish',
          formAnalysis: bl.commentFormAnalysis || null,
          loggedAt: new Date().toISOString()
        }]);

        if (tabId) {
          try { await chrome.runtime.sendMessage({ type: 'closeTab', tabId }); } catch {}
        }
      }

      if (s < selectedSites.length - 1 && publishRunning) {
        addLog(logEntries, t('publish.waiting', { seconds: delay }), 'info');
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
      }
    }

    // Update backlink status based on results
    const results = bl._siteResults || [];
    const hasConfirmed = results.includes('confirmed');
    const allFailed = results.every(r => r === 'submit_failed' || r === 'rejected' || r === 'error');
    const hasCaptcha = results.includes('captcha');

    if (hasConfirmed) bl.status = 'commented';
    else if (hasCaptcha) bl.status = 'captcha_blocked';
    else if (allFailed && results.length > 0) bl.status = 'publish_failed';
    else bl.status = 'pending_moderation';

    bl.commentedAt = new Date().toISOString();
    bl.commentedWith = selectedSites.map(s => s.profileName);
    bl.verifyResults = results;
    delete bl._siteResults;
    await updateRecord(STORES.BACKLINKS, bl);

    if (i < commentable.length - 1 && publishRunning) {
      addLog(logEntries, t('publish.waiting', { seconds: delay }), 'info');
      await new Promise(resolve => setTimeout(resolve, delay * 1000));
    }
  }

  // Task completed normally — clear state
  await clearTaskState();
  btnStart.hidden = false;
  btnStop.hidden = true;
  publishRunning = false;
  const actualTotal = pubStats.confirmed + pubStats.moderation + pubStats.failed + pubStats.captcha;
  addLog(logEntries, t('publish.summaryDetail', {
    total: actualTotal,
    confirmed: pubStats.confirmed,
    moderation: pubStats.moderation,
    failed: pubStats.failed,
    captcha: pubStats.captcha
  }), pubStats.failed > 0 ? 'error' : 'success');
}

// Classify failure type for analysis
function classifyFailure(errorMessage) {
  const msg = (errorMessage || '').toLowerCase();
  if (msg.includes('textarea not found') || msg.includes('no_selector')) return 'no_comment_field';
  if (msg.includes('not_found') || msg.includes('form not found')) return 'form_not_found';
  if (msg.includes('set_failed')) return 'react_or_vue_form';
  if (msg.includes('submit') || msg.includes('button')) return 'submit_button_issue';
  if (msg.includes('api error') || msg.includes('gemini')) return 'ai_api_error';
  if (msg.includes('fetch') || msg.includes('network')) return 'network_error';
  if (msg.includes('tab') || msg.includes('timeout')) return 'tab_issue';
  if (msg.includes('captcha')) return 'captcha';
  return 'other';
}

function addLog(container, message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// ========== Settings Tab ==========
async function loadSettings() {
  // API provider
  const provider = await getSetting('apiProvider');
  if (provider) {
    setProvider(provider);
    document.getElementById('setting-api-provider').value = provider;
  } else {
    setProvider('kie');
    document.getElementById('setting-api-provider').value = 'kie';
  }
  updateApiKeyHint();

  const apiKey = await getSetting('geminiApiKey');
  if (apiKey) document.getElementById('setting-api-key').value = apiKey;

  // Language
  const lang = await getSetting('language');
  if (lang) {
    setLanguage(lang);
    document.getElementById('setting-language').value = lang;
  } else {
    setLanguage('zh');
  }

  // Filter settings
  const settingsMap = {
    'setting-min-ascore': { key: 'minAscore', default: 1 },
    'setting-max-ascore': { key: 'maxAscore', default: 100 },
    'setting-max-external': { key: 'maxExternalLinks', default: 5000 },
    'setting-nofollow': { key: 'nofollowFilter', default: 'all' },
    'setting-url-must-contain': { key: 'urlMustContain', default: '' },
    'setting-url-must-not-contain': { key: 'urlMustNotContain', default: '' },
  };
  for (const [id, { key, default: def }] of Object.entries(settingsMap)) {
    const val = await getSetting(key);
    document.getElementById(id).value = val ?? def;
  }

  const checkboxMap = {
    'setting-filter-lost': { key: 'filterLostLinks', default: true },
    'setting-filter-spam': { key: 'filterSpamDomains', default: true },
    'setting-filter-sitewide': { key: 'filterSitewide', default: false },
    'setting-filter-sponsored': { key: 'filterSponsored', default: false },
    'setting-dedup': { key: 'deduplicateByDomain', default: true },
    'setting-prioritize-ugc': { key: 'prioritizeUgc', default: true },
    'setting-prioritize-blog': { key: 'prioritizeBlogUrls', default: true },
  };
  for (const [id, { key, default: def }] of Object.entries(checkboxMap)) {
    const val = await getSetting(key);
    document.getElementById(id).checked = val ?? def;
  }

  // Textarea settings
  const spamKw = await getSetting('customSpamKeywords');
  document.getElementById('setting-spam-keywords').value = Array.isArray(spamKw) ? spamKw.join('\n') : '';
  const blacklist = await getSetting('domainBlacklist');
  document.getElementById('setting-domain-blacklist').value = Array.isArray(blacklist) ? blacklist.join('\n') : '';

  // DB stats
  document.getElementById('db-backlinks').textContent = await getRecordCount(STORES.BACKLINKS);
  document.getElementById('db-comments').textContent = await getRecordCount(STORES.COMMENTS);
  document.getElementById('db-sites').textContent = await getRecordCount(STORES.DISCOVERED_SITES);

  await loadFailureSummary();
}

// Provider change updates hint
document.getElementById('setting-api-provider').addEventListener('change', (e) => {
  updateApiKeyHint();
});

function updateApiKeyHint() {
  const provider = document.getElementById('setting-api-provider').value;
  const hint = document.getElementById('api-key-hint');
  if (provider === 'kie') {
    hint.textContent = t('settings.apiKeyHintKie');
  } else {
    hint.textContent = t('settings.apiKeyHintGoogle');
  }
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const provider = document.getElementById('setting-api-provider').value;
  await setSetting('apiProvider', provider);
  setProvider(provider);

  await setSetting('geminiApiKey', document.getElementById('setting-api-key').value.trim());

  // Number settings
  await setSetting('minAscore', parseInt(document.getElementById('setting-min-ascore').value) || 1);
  await setSetting('maxAscore', parseInt(document.getElementById('setting-max-ascore').value) || 100);
  await setSetting('maxExternalLinks', parseInt(document.getElementById('setting-max-external').value) || 5000);

  // Select settings
  await setSetting('nofollowFilter', document.getElementById('setting-nofollow').value);

  // Checkbox settings
  await setSetting('filterLostLinks', document.getElementById('setting-filter-lost').checked);
  await setSetting('filterSpamDomains', document.getElementById('setting-filter-spam').checked);
  await setSetting('filterSitewide', document.getElementById('setting-filter-sitewide').checked);
  await setSetting('filterSponsored', document.getElementById('setting-filter-sponsored').checked);
  await setSetting('deduplicateByDomain', document.getElementById('setting-dedup').checked);
  await setSetting('prioritizeUgc', document.getElementById('setting-prioritize-ugc').checked);
  await setSetting('prioritizeBlogUrls', document.getElementById('setting-prioritize-blog').checked);

  // Textarea -> array
  const parseLines = (val) => val.split('\n').map(s => s.trim()).filter(Boolean);
  await setSetting('customSpamKeywords', parseLines(document.getElementById('setting-spam-keywords').value));
  await setSetting('domainBlacklist', parseLines(document.getElementById('setting-domain-blacklist').value));

  // Text settings
  await setSetting('urlMustContain', document.getElementById('setting-url-must-contain').value.trim());
  await setSetting('urlMustNotContain', document.getElementById('setting-url-must-not-contain').value.trim());

  const btn = document.getElementById('btn-save-settings');
  btn.textContent = t('settings.saved');
  setTimeout(() => btn.textContent = t('settings.save'), 1500);
});

document.getElementById('btn-export-backlinks').addEventListener('click', async () => {
  const backlinks = await getAllRecords(STORES.BACKLINKS);
  downloadCSV(backlinks, 'backlinks-export.csv',
    ['sourceUrl', 'sourceTitle', 'sourceDomain', 'ascore', 'status', 'ugc', 'nofollow', 'isBlogUrl', 'externalLinks']);
});

document.getElementById('btn-export-discovered').addEventListener('click', async () => {
  const sites = await getAllRecords(STORES.DISCOVERED_SITES);
  downloadCSV(sites, 'discovered-sites.csv',
    ['domain', 'url', 'anchorText', 'discoveredFrom', 'discoveredAt']);
});

// Export site profiles as JSON
document.getElementById('btn-export-sites').addEventListener('click', async () => {
  const profiles = await getSiteProfiles();
  if (profiles.length === 0) {
    alert(t('common.noData'));
    return;
  }
  const json = JSON.stringify(profiles, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linkbuilder-sites-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Import site profiles from JSON
document.getElementById('btn-import-sites').addEventListener('click', () => {
  document.getElementById('import-sites-input').click();
});

document.getElementById('import-sites-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const imported = JSON.parse(text);

    if (!Array.isArray(imported)) {
      alert(t('settings.importInvalid'));
      return;
    }

    // Validate structure
    const valid = imported.filter(p => p && p.name && p.email && p.website);
    if (valid.length === 0) {
      alert(t('settings.importInvalid'));
      return;
    }

    const existing = await getSiteProfiles();
    const existingWebsites = new Set(existing.map(p => p.website));

    // Merge: skip duplicates by website URL
    let added = 0, skipped = 0;
    for (const p of valid) {
      if (existingWebsites.has(p.website)) {
        skipped++;
      } else {
        existing.push(p);
        added++;
      }
    }

    await saveSiteProfiles(existing);
    await loadSiteProfiles();
    alert(t('settings.importSuccess', { added, skipped }));
  } catch (err) {
    alert(t('settings.importError', { message: err.message }));
  } finally {
    e.target.value = ''; // reset for re-upload
  }
});

// Export failure logs
document.getElementById('btn-export-failures').addEventListener('click', async () => {
  const logs = await getAllRecords(STORES.FAILURE_LOGS);
  if (logs.length === 0) {
    alert(t('common.noData'));
    return;
  }
  // Export as JSON for full detail (including formAnalysis)
  const json = JSON.stringify(logs, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linkbuilder-failures-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Clear failure logs
document.getElementById('btn-clear-failures').addEventListener('click', async () => {
  if (!confirm(t('settings.clearFailuresConfirm'))) return;
  await clearStore(STORES.FAILURE_LOGS);
  await loadFailureSummary();
});

// Load and display failure summary (grouped by type)
async function loadFailureSummary() {
  const logs = await getAllRecords(STORES.FAILURE_LOGS);
  const summary = document.getElementById('failure-summary');
  const counts = document.getElementById('failure-counts');

  if (logs.length === 0) {
    summary.hidden = true;
    return;
  }

  const byType = {};
  for (const log of logs) {
    const type = log.failureType || 'other';
    byType[type] = (byType[type] || 0) + 1;
  }

  const sortedTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  counts.innerHTML = sortedTypes.map(([type, count]) => `
    <div class="failure-count-row">
      <span>${t('failure.' + type) || type}</span>
      <span class="count">${count}</span>
    </div>
  `).join('');
  summary.hidden = false;
}

document.getElementById('btn-clear-data').addEventListener('click', async () => {
  if (!confirm(t('settings.clearConfirm'))) return;

  await clearStore(STORES.BACKLINKS);
  await clearStore(STORES.COMMENTS);
  await clearStore(STORES.DISCOVERED_SITES);
  await clearStore(STORES.FAILURE_LOGS);

  await loadSettings();
  alert(t('settings.cleared'));
});

// ========== Utility Functions ==========
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function downloadCSV(data, filename, columns) {
  if (data.length === 0) {
    alert(t('common.noData'));
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
  const keys = [
    'minAscore', 'maxAscore', 'maxExternalLinks',
    'filterLostLinks', 'filterSpamDomains', 'nofollowFilter',
    'filterSitewide', 'filterSponsored',
    'prioritizeUgc', 'prioritizeBlogUrls', 'deduplicateByDomain',
    'customSpamKeywords', 'domainBlacklist',
    'urlMustContain', 'urlMustNotContain'
  ];

  const config = { ...DEFAULT_FILTER_CONFIG };
  for (const key of keys) {
    const val = await getSetting(key);
    if (val != null) config[key] = val;
  }
  return config;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadSiteProfiles();
  checkResumeTask();
});
