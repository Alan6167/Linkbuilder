import { STORES, addRecords, getAllRecords, updateRecord, clearStore, getRecordCount, getSetting, setSetting } from '../lib/db.js';
import { parseRow, filterBacklinks, getFilterStats, DEFAULT_FILTER_CONFIG } from '../lib/filter.js';
import { generateComment, setRateLimitCallback, formatLink } from '../lib/gemini.js';
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
    if (tab.dataset.tab === 'publish') loadSiteProfiles();
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

// ========== Backlinks Tab ==========
async function loadBacklinksList() {
  const list = document.getElementById('backlinks-list');
  const filterStatus = document.getElementById('filter-status').value;

  let backlinks = await getAllRecords(STORES.BACKLINKS);

  if (filterStatus !== 'all') {
    backlinks = backlinks.filter(b => b.status === filterStatus);
  }

  if (backlinks.length === 0) {
    list.innerHTML = `<p class="empty-state">${t('backlinks.empty')}</p>`;
    document.getElementById('pagination').hidden = true;
    return;
  }

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

  const pagination = document.getElementById('pagination');
  if (totalPages > 1) {
    pagination.hidden = false;
    document.getElementById('page-info').textContent = t('pagination.page', { current: currentPage, total: totalPages });
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
    <label>
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
    deleteBtn.hidden = true;
    return;
  }

  const p = profiles[idx];
  document.getElementById('pub-profile-name').value = p.profileName || '';
  document.getElementById('pub-name').value = p.name || '';
  document.getElementById('pub-email').value = p.email || '';
  document.getElementById('pub-website').value = p.website || '';
  deleteBtn.hidden = false;
});

// Add new site (clear form)
document.getElementById('btn-add-site').addEventListener('click', () => {
  document.getElementById('pub-site-select').value = '';
  document.getElementById('pub-profile-name').value = '';
  document.getElementById('pub-name').value = '';
  document.getElementById('pub-email').value = '';
  document.getElementById('pub-website').value = '';
  document.getElementById('btn-delete-site').hidden = true;
});

// Save site profile
document.getElementById('btn-save-site').addEventListener('click', async () => {
  const profileName = document.getElementById('pub-profile-name').value.trim();
  const name = document.getElementById('pub-name').value.trim();
  const email = document.getElementById('pub-email').value.trim();
  const website = document.getElementById('pub-website').value.trim();

  if (!name || !email || !website) {
    alert(t('publish.fillRequired'));
    return;
  }

  const profiles = await getSiteProfiles();
  const selectIdx = parseInt(document.getElementById('pub-site-select').value);

  const profile = { profileName: profileName || website, name, email, website };

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

// Stop publish button
document.getElementById('btn-stop-publish').addEventListener('click', () => {
  publishRunning = false;
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
  // Get selected site profiles
  const profiles = await getSiteProfiles();
  const checked = [...document.querySelectorAll('input[name="pub-sites"]:checked')];
  const selectedSites = checked.map(cb => profiles[parseInt(cb.value)]).filter(Boolean);

  if (selectedSites.length === 0) {
    alert(t('publish.noSitesSelected'));
    return;
  }

  const mode = document.getElementById('pub-mode').value;
  const delay = Math.max(5, parseInt(document.getElementById('pub-delay').value) || 30);

  const apiKey = await getSetting('geminiApiKey');
  if (!apiKey) {
    alert(t('settings.noApiKey'));
    return;
  }

  const backlinks = await getAllRecords(STORES.BACKLINKS);
  const commentable = backlinks.filter(b => b.status === 'commentable');

  if (commentable.length === 0) {
    alert(t('publish.noCommentable'));
    return;
  }

  const logArea = document.getElementById('publish-log');
  const logEntries = document.getElementById('log-entries');
  logArea.hidden = false;
  logEntries.innerHTML = '';

  setRateLimitCallback((seconds) => {
    addLog(logEntries, t('publish.rateLimit', { seconds }), 'info');
  });

  addLog(logEntries, t('publish.startInfo', {
    sites: selectedSites.length,
    pages: commentable.length,
    delay
  }), 'info');

  const btnStart = document.getElementById('btn-start-publish');
  const btnStop = document.getElementById('btn-stop-publish');
  btnStart.hidden = true;
  btnStop.hidden = false;
  publishRunning = true;

  let pubStats = { confirmed: 0, moderation: 0, failed: 0, captcha: 0 };

  for (let i = 0; i < commentable.length; i++) {
    if (!publishRunning) {
      addLog(logEntries, t('backlinks.stopped'), 'error');
      break;
    }

    const bl = commentable[i];

    // Each blog page gets comments from all selected sites (rotate)
    for (let s = 0; s < selectedSites.length; s++) {
      if (!publishRunning) break;

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

        const commentConfig = getCommentConfig(pageInfo.linkFormat);
        // Override link URL with current site's website
        commentConfig.linkUrl = commentConfig.linkUrl || website;

        addLog(logEntries, t('publish.generating'), 'info');
        const commentText = await generateComment(apiKey, {
          title: pageInfo.title,
          content: pageInfo.contentExcerpt,
          url: bl.sourceUrl,
          language: pageInfo.language,
          myWebsiteName: name,
          myWebsiteUrl: website
        }, commentConfig);

        addLog(logEntries, t('publish.comment', { text: commentText.substring(0, 80) }), 'info');

        const formData = { name, email, website, comment: commentText };
        const fieldSelectors = bl.commentFormAnalysis?.fields || {};
        await chrome.runtime.sendMessage({ type: 'fillCommentForm', tabId, formData, fieldSelectors });

        addLog(logEntries, t('publish.filled'), 'success');

        let commentStatus = 'unknown';

        if (mode === 'auto') {
          const submitResult = await chrome.runtime.sendMessage({
            type: 'submitCommentForm',
            tabId,
            submitSelector: bl.commentFormAnalysis?.submitButton
          });

          if (submitResult.success) {
            addLog(logEntries, t('publish.submitted'), 'success');

            // Verify: wait for page update and check result
            addLog(logEntries, t('publish.verifying'), 'info');
            const verification = await chrome.runtime.sendMessage({
              type: 'verifyComment',
              tabId,
              commentText: commentText.substring(0, 50),
              website
            });

            commentStatus = verification.status; // confirmed | pending_moderation | rejected | captcha | unknown
            const statusKey = `publish.verify_${commentStatus}`;
            const logType = commentStatus === 'confirmed' ? 'success'
              : (commentStatus === 'rejected' || commentStatus === 'captcha') ? 'error' : 'info';
            addLog(logEntries, `${t(statusKey)}: ${verification.reason}`, logType);

            if (commentStatus === 'confirmed') pubStats.confirmed++;
            else if (commentStatus === 'captcha') pubStats.captcha++;
            else if (commentStatus === 'rejected') pubStats.failed++;
            else pubStats.moderation++; // pending_moderation or unknown
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

        // Save comment record with verification status
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

      } catch (err) {
        addLog(logEntries, t('common.error', { message: err.message }), 'error');
        pubStats.failed++;
        if (tabId) {
          try { await chrome.runtime.sendMessage({ type: 'closeTab', tabId }); } catch {}
        }
      }

      // Delay between sites on the same page
      if (s < selectedSites.length - 1 && publishRunning) {
        addLog(logEntries, t('publish.waiting', { seconds: delay }), 'info');
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
      }
    }

    // Update backlink status after all sites processed for this page
    bl.status = 'commented';
    bl.commentedAt = new Date().toISOString();
    bl.commentedWith = selectedSites.map(s => s.profileName);
    await updateRecord(STORES.BACKLINKS, bl);

    // Delay between different blog pages
    if (i < commentable.length - 1 && publishRunning) {
      addLog(logEntries, t('publish.waiting', { seconds: delay }), 'info');
      await new Promise(resolve => setTimeout(resolve, delay * 1000));
    }
  }

  btnStart.hidden = false;
  btnStop.hidden = true;
  publishRunning = false;
  const total = commentable.length * selectedSites.length;
  addLog(logEntries, t('publish.summaryDetail', {
    total,
    confirmed: pubStats.confirmed,
    moderation: pubStats.moderation,
    failed: pubStats.failed,
    captcha: pubStats.captcha
  }), pubStats.failed > 0 ? 'error' : 'success');
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
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
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

document.getElementById('btn-clear-data').addEventListener('click', async () => {
  if (!confirm(t('settings.clearConfirm'))) return;

  await clearStore(STORES.BACKLINKS);
  await clearStore(STORES.COMMENTS);
  await clearStore(STORES.DISCOVERED_SITES);

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
});
