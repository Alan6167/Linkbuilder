// Background Service Worker for Linkbuilder

import { getSetting, normalizeUrl } from './lib/db.js';

// Click extension icon to open/close side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Timeouts configurable via Settings. Reads each time to pick up live changes
// without a service-worker restart; falls back to the prior hard-coded defaults
// if unset so old behavior is preserved.
async function pageLoadTimeoutMs() {
  const v = await getSetting('pageLoadTimeoutMs');
  return Number.isFinite(v) && v >= 5000 ? v : 15000;
}
async function submitVerifyTimeoutMs() {
  const v = await getSetting('submitVerifyTimeoutMs');
  return Number.isFinite(v) && v >= 3000 ? v : 12000;
}

// Message handler for communication between popup, content scripts, and background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message.type];
  if (handler) {
    handler(message, sender).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // Keep message channel open for async response
  }
  return false;
});

const messageHandlers = {
  // Open a URL in a new tab and wait for it to finish loading
  async analyzeUrl({ url }) {
    const tab = await chrome.tabs.create({ url, active: false });
    // Wait for the tab to finish loading (timeout configurable via Settings)
    await waitForTabLoad(tab.id, await pageLoadTimeoutMs());
    // Inject analyzer.js on demand instead of via auto-inject content_scripts.
    // This keeps the extension off every page the user visits and only
    // installs the message listeners on tabs we deliberately opened. Errors
    // are swallowed because some pages (chrome://, file:// without permission)
    // are simply not injectable, and the caller already handles missing
    // sendMessage targets.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['content/analyzer.js']
      });
    } catch { /* page not injectable; downstream sendMessage will fail gracefully */ }
    return { tabId: tab.id };
  },

  // Analyze page using the content script (local, no API needed)
  // Searches main frame + all iframes (for Jetpack / embedded comment systems)
  async analyzePageViaContentScript({ tabId }) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: analyzePageInline
      });

      // Collect per-frame results, pick the one that has a comment form
      const found = results.find(r => r.result && r.result.hasCommentForm);
      if (found) {
        return { ...found.result, frameId: found.frameId };
      }

      // No frame has a form — return the main frame's result
      return results[0]?.result || { hasCommentForm: false, error: 'No form found' };
    } catch (err) {
      return { hasCommentForm: false, error: err.message };
    }
  },

  // Extract comment links from the main frame + every iframe (Jetpack
  // embedded comment systems show up in child frames that sendMessage to the
  // top-level handler can't reach). Results are merged and deduped by
  // normalizeUrl so the same outgoing link in parent + child frames counts
  // once.
  async extractLinksViaContentScript({ tabId }) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: extractCommentLinksInline
      });
      const all = results.flatMap(r => r.result || []);
      const seen = new Set();
      const merged = [];
      for (const link of all) {
        const key = normalizeUrl(link.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(link);
      }
      return { links: merged };
    } catch {
      return { links: [] };
    }
  },

  // Close a tab
  async closeTab({ tabId }) {
    try {
      await chrome.tabs.remove(tabId);
    } catch { /* tab may already be closed */ }
    return { success: true };
  },

  // Execute comment form fill - runs in all frames, uses the one that filled successfully
  async fillCommentForm({ tabId, formData, fieldSelectors, frameId, honeypotFields }) {
    const target = frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };

    const results = await chrome.scripting.executeScript({
      target,
      func: fillForm,
      args: [formData, fieldSelectors, honeypotFields]
    });

    // Prefer a frame that actually filled the comment
    const successful = results.find(r => r.result?.success);
    if (successful) return { ...successful.result, frameId: successful.frameId };

    return results[0]?.result || { success: false };
  },

  // Submit comment form - runs in all frames
  async submitCommentForm({ tabId, submitSelector, frameId }) {
    const target = frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };

    const results = await chrome.scripting.executeScript({
      target,
      func: clickSubmit,
      args: [submitSelector]
    });

    const successful = results.find(r => r.result?.success);
    if (successful) return successful.result;

    return results[0]?.result || { success: false };
  },

  // Solve simple math CAPTCHA on page
  async solveCaptcha({ tabId, captchaInfo, frameId }) {
    const target = frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };

    const results = await chrome.scripting.executeScript({
      target,
      func: solveCaptchaOnPage,
      args: [captchaInfo]
    });

    const successful = results.find(r => r.result?.solved);
    if (successful) return successful.result;
    return results[0]?.result || { solved: false, reason: 'script_failed' };
  },

  // Verify if comment was published after submission
  async verifyComment({ tabId, commentText, website }) {
    // Wait for the form submission to trigger navigation
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Now wait for the page to finish loading (reload/redirect after submit)
    // Use a fresh check: listen for loading→complete transition. Timeout is
    // configurable via Settings → submitVerifyTimeoutMs.
    await waitForNavigation(tabId, await submitVerifyTimeoutMs());

    // Extra wait for dynamic content rendering
    await new Promise(resolve => setTimeout(resolve, 2000));

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: verifyCommentOnPage,
      args: [commentText, website]
    });
    return results[0]?.result || { verified: false, reason: 'script_failed' };
  },

  // Fast local check: scan current DOM (all frames) for an existing link to `website`
  // No navigation wait; returns in <100ms. Used as a cheap preCheck before publishing.
  async quickCheckExistingComment({ tabId, website, matchMode }) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: quickCheckInPage,
        args: [website, matchMode || 'url']
      });
      for (const r of results || []) {
        if (r?.result?.found) return r.result;
      }
      return { found: false };
    } catch (err) {
      return { found: false, error: err.message };
    }
  },

  // Optional diagnostic helper. Only invoked when the captureFormSnippet
  // setting is on, and only for failing attempts. Returns up to 500 chars of
  // outerHTML around the comment form so post-mortem investigators can see
  // what the form really looked like at failure time.
  async captureFormSnippet({ tabId, frameId }) {
    try {
      const target = { tabId };
      if (frameId != null && frameId !== 0) target.frameIds = [frameId];
      else target.allFrames = false;
      const results = await chrome.scripting.executeScript({
        target,
        func: () => {
          const form = document.querySelector('#commentform, .comment-form, form[action*="comment"]');
          if (!form) return null;
          const html = form.outerHTML || '';
          return html.slice(0, 500);
        }
      });
      return { snippet: results?.[0]?.result || null };
    } catch (err) {
      return { snippet: null, error: err.message };
    }
  }
};

// Wait for a tab to navigate (loading→complete), with timeout
// Unlike waitForTabLoad, this doesn't short-circuit if the tab is already complete,
// because we expect a form submission to trigger a new page load.
function waitForNavigation(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Resolve even on timeout — page may use AJAX submission
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading') {
        sawLoading = true;
      }
      if (changeInfo.status === 'complete' && sawLoading) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Wait for a tab to finish loading, with timeout
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      // Resolve anyway - page might be partially loaded but usable
      resolve();
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small extra delay for JS to finish rendering
        setTimeout(resolve, 500);
      }
    }

    // Check if already loaded
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        clearTimeout(timeout);
        setTimeout(resolve, 500);
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    }).catch(() => {
      clearTimeout(timeout);
      reject(new Error('Tab not found'));
    });
  });
}

// Injected into every frame of a tab to collect external comment-area links
// for snowball discovery. Must be fully self-contained: no imports, closures,
// or references to background-scope helpers. Returns [] on pages without a
// recognizable comment container. Records are shaped to match what
// popup.js expects for DISCOVERED_SITES.
function extractCommentLinksInline() {
  const commentSelectors = [
    '.comment', '.comment-body', '#comments', '.comments-area',
    '.comment-list', '.commentlist', 'ol.comments', 'ul.comments'
  ];

  let commentArea = null;
  for (const sel of commentSelectors) {
    commentArea = document.querySelector(sel);
    if (commentArea) break;
  }
  if (!commentArea) return [];

  const links = [];
  const seenDomains = new Set();
  for (const a of commentArea.querySelectorAll('a[href]')) {
    try {
      const url = new URL(a.href);
      if (url.hostname === window.location.hostname) continue;
      if (/facebook|twitter|google|youtube|instagram|linkedin/i.test(url.hostname)) continue;
      if (!seenDomains.has(url.hostname)) {
        seenDomains.add(url.hostname);
        links.push({
          url: a.href,
          domain: url.hostname,
          anchorText: a.textContent.trim(),
          discoveredFrom: window.location.href,
          discoveredAt: new Date().toISOString()
        });
      }
    } catch { /* skip invalid URLs */ }
  }
  return links;
}

// Inline page analysis function — detects comment forms across various blog platforms
function analyzePageInline() {
  let formInfo = {
    hasCommentForm: false,
    requiresLogin: false,
    fields: {},
    submitButton: null
  };

  // Analysis-phase field filter: reject disabled/readonly/hidden/password
  // but intentionally ignore visibility. Many comment forms (WordPress default
  // theme, Jetpack) keep name/email/website display:none until the comment
  // box gets focus; dropping them at analyze time loses the selectors.
  function isFillableInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    if (el.disabled || el.readOnly) return false;
    const type = (el.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file',
         'checkbox', 'radio', 'search', 'password'].includes(type)) return false;
    return true;
  }

  function isFillableCommentTarget(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function getSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.name) return `[name="${el.name}"]`;
    // Build a reliable path selector
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) return `${tag}.${cls}`;
    }
    return tag;
  }

  // Strategy 1: Traditional <form> with comment indicators
  let commentForm = null;
  for (const form of document.querySelectorAll('form')) {
    const id = (form.id || '').toLowerCase();
    const cls = (form.className || '').toLowerCase();
    const action = (form.action || '').toLowerCase();

    if (id.includes('comment') || cls.includes('comment') || action.includes('comment') ||
        form.querySelector('textarea[name*="comment" i]') ||
        form.querySelector('textarea[id*="comment" i]') ||
        form.querySelector('#comment')) {
      commentForm = form;
      break;
    }
  }

  // Strategy 2: Any form with a fillable textarea
  if (!commentForm) {
    for (const ta of document.querySelectorAll('textarea')) {
      if (!isFillableCommentTarget(ta)) continue;
      const parent = ta.closest('form');
      if (parent) { commentForm = parent; break; }
    }
  }

  // If we found a traditional form, extract fields
  if (commentForm) {
    formInfo.hasCommentForm = true;

    function findInput(container, patterns) {
      for (const p of patterns) {
        const candidates = [
          ...container.querySelectorAll(`input[name*="${p}" i]`),
          ...container.querySelectorAll(`input[id*="${p}" i]`),
          ...container.querySelectorAll(`input[placeholder*="${p}" i]`)
        ];
        const el = candidates.find(isFillableInput);
        if (el) return { selector: getSelector(el), name: el.name || el.id, type: el.type };
      }
      return null;
    }

    formInfo.fields = {
      name: findInput(commentForm, ['author', 'name', 'commenter', 'your-name', 'nickname']),
      email: findInput(commentForm, ['email', 'mail', 'e-mail']),
      website: findInput(commentForm, ['url', 'website', 'web', 'site', 'homepage']),
      comment: (() => {
        const ta = [...commentForm.querySelectorAll('textarea')].find(isFillableCommentTarget);
        return ta ? { selector: getSelector(ta), name: ta.name || ta.id, type: 'textarea' } : null;
      })()
    };

    const submitBtn = commentForm.querySelector('input[type="submit"], button[type="submit"], button.submit, #submit');
    if (submitBtn) {
      formInfo.submitButton = { selector: getSelector(submitBtn), text: submitBtn.value || submitBtn.textContent?.trim() };
    }

    // Detect CAPTCHA type
    formInfo.captcha = detectCaptcha(commentForm);

    // Site intelligence
    addSiteIntelligence(formInfo, commentForm);

    return formInfo;
  }

  function addSiteIntelligence(info, form) {
    // WordPress detection
    info.isWordPress = !!(
      document.querySelector('meta[name="generator"][content*="WordPress" i]') ||
      document.querySelector('link[href*="wp-content"], link[href*="wp-includes"]') ||
      document.querySelector('#wpadminbar') ||
      typeof window.wp !== 'undefined'
    );

    // Check existing comments for <a> tags (wp_kses allows HTML links)
    const commentArea = document.querySelector('#comments, .comments-area, .comment-list, .commentlist, ol.comments, ul.comments');
    if (commentArea) {
      const commentLinks = commentArea.querySelectorAll('.comment-content a[href], .comment-body a[href]');
      info.wpKsesAllowsLinks = commentLinks.length > 0;

      if (commentLinks.length > 0) {
        const rels = new Set();
        for (const link of commentLinks) {
          const rel = (link.getAttribute('rel') || '').trim().toLowerCase();
          if (rel) rels.add(rel);
        }
        info.commentLinkRels = [...rels];
      }
    } else {
      info.wpKsesAllowsLinks = null;
    }

    // Blockers
    info.blockers = [];
    if (document.querySelector('script[src*="cleantalk" i], #ct_checkjs, input[name="ct_checkjs"], input[name*="cleantalk" i]')) {
      info.blockers.push('cleantalk');
    }
    if (document.querySelector('iframe[src*="jetpack"], iframe[name="jetpack_remote_comment"], .jetpack-comments-iframe')) {
      info.blockers.push('jetpack_iframe');
    }

    // Honeypot detection — hidden inputs/textareas that must stay empty
    info.honeypotFields = [];
    if (form) {
      for (const el of form.querySelectorAll('input, textarea')) {
        const n = (el.name || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        if (['author', 'email', 'url', 'website', 'comment', 'submit', 'comment_post_id', 'comment_parent'].some(k => n.includes(k) || id.includes(k))) continue;
        if (el.type === 'submit' || el.type === 'hidden') continue;

        const style = window.getComputedStyle(el);
        const ps = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
        const isHidden = style.display === 'none' || style.visibility === 'hidden' ||
          style.opacity === '0' || (style.position === 'absolute' && (parseInt(style.left) < -999 || parseInt(style.top) < -999)) ||
          el.offsetWidth === 0 || el.offsetHeight === 0 ||
          (ps && (ps.display === 'none' || ps.visibility === 'hidden' || ps.opacity === '0'));

        const isKnownHoneypot = /^(ak_hp_|alt_s$|wantispam|hpot|hp_|trap|pot_)/i.test(n);

        if (isHidden || isKnownHoneypot) {
          info.honeypotFields.push(getSelector(el));
        }
      }
    }
  }

  function detectCaptcha(form) {
    // Unsolvable: reCAPTCHA, hCaptcha, Cloudflare Turnstile
    const hardCaptcha = form.querySelector(
      '.g-recaptcha, .h-captcha, [data-sitekey], .cf-turnstile, ' +
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'
    );
    if (hardCaptcha) return { type: 'unsolvable', provider: 'recaptcha/hcaptcha/turnstile' };

    // Find CAPTCHA input field
    const captchaInput = findCaptchaInput(form);
    if (!captchaInput) return null;

    // Extract content from CAPTCHA display area
    const result = extractCaptchaContent(captchaInput, form);
    if (result) {
      result.inputSelector = getSelector(captchaInput);
      return result;
    }

    // Has CAPTCHA input — check if it has images (visual CAPTCHA)
    const container = captchaInput.closest('[class*="captcha" i], [class*="cptch" i], [id*="captcha" i]') || captchaInput.parentElement;
    if (container) {
      const imgs = container.querySelectorAll('img, canvas, svg');
      if (imgs.length > 0) {
        return { type: 'image', provider: 'image_captcha' };
      }
    }

    // Has CAPTCHA input but no content and no images
    return { type: 'unsolvable', provider: 'unknown_captcha' };
  }

  function findCaptchaInput(form) {
    const selectors = [
      'input[name*="captcha" i]', 'input[id*="captcha" i]',
      'input[name*="cptch" i]', 'input[id*="cptch" i]',
      'input[name*="arithmetic" i]', 'input[name*="quiz" i]',
      '#si_captcha_code', '.captcha-input input',
      'input[aria-label*="captcha" i]',
      'input[placeholder*="captcha" i]', 'input[placeholder*="验证" i]',
    ];
    for (const sel of selectors) {
      const el = form.querySelector(sel);
      if (el) return el;
    }
    // Check in nearby containers outside the form
    const parent = form.parentElement;
    if (parent) {
      const container = parent.querySelector('[class*="captcha" i], [id*="captcha" i], [class*="cptch" i]');
      if (container) {
        const input = container.querySelector('input[type="text"], input[type="number"], input:not([type])');
        if (input) return input;
      }
    }
    return null;
  }

  function extractCaptchaContent(input, form) {
    const container = input.closest('[class*="captcha" i], [class*="cptch" i], [id*="captcha" i]') || input.parentElement;
    const allText = [];

    // Strategy 1: Read text from styled span/div elements (common in BestWebSoft Captcha etc.)
    if (container) {
      const spans = container.querySelectorAll('span, div, strong, b, em, i, p, td');
      const chars = [];
      for (const span of spans) {
        if (span.contains(input)) continue;
        if (span.querySelector('input, textarea, span, div')) continue; // only leaf elements
        const text = span.textContent.trim();
        if (text && text.length <= 5) chars.push(text);
      }
      if (chars.length >= 2) allText.push(chars.join(' '));

      // Container text with input/buttons removed
      const clone = container.cloneNode(true);
      clone.querySelectorAll('input, button, img, script, style').forEach(el => el.remove());
      const cleanText = clone.textContent.trim();
      if (cleanText) allText.push(cleanText);
    }

    // Strategy 2: Labels
    const label = input.labels?.[0] || document.querySelector(`label[for="${input.id}"]`);
    if (label) allText.push(label.textContent);

    // Strategy 3: Previous siblings
    let el = input.previousElementSibling;
    while (el) {
      if (!el.querySelector('input, textarea')) allText.push(el.textContent);
      el = el.previousElementSibling;
    }

    // Strategy 4: Input attributes
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      const val = input.getAttribute(attr);
      if (val) allText.push(val);
    }

    // Strategy 5: Read alt text from images (some CAPTCHAs use <img> with alt)
    if (container) {
      const imgs = container.querySelectorAll('img:not([src*="reload"]):not([src*="refresh"]):not([alt=""])');
      const altChars = [];
      for (const img of imgs) {
        if (img.alt && img.alt.length <= 10 && !/reload|refresh|captcha/i.test(img.alt)) {
          altChars.push(img.alt.trim());
        }
      }
      if (altChars.length > 0) allText.push(altChars.join(' '));
    }

    // Analyze collected text to determine CAPTCHA type
    for (const text of allText) {
      if (!text || text.trim().length === 0) continue;

      // Check if it looks like a math expression (has arithmetic operators as words or symbols)
      if (/\bplus\b|\bminus\b|\btimes\b|\bdivided\b|加|减|乘|除/i.test(text) ||
          /\d\s*[+\-]\s*\d/.test(text) ||
          /\d\s*[×÷]\s*\d/.test(text)) {
        const expr = extractMathFromText(text);
        if (expr) return { type: 'math', expression: expr };
      }

      // Otherwise: extract digits as "type what you see" answer
      const digits = text.replace(/[^\d]/g, '');
      if (digits.length >= 2) {
        return { type: 'text', answer: digits };
      }
    }

    return null;
  }

  function extractMathFromText(text) {
    if (!text) return null;
    let s = text.toLowerCase();

    // Replace word numbers
    const words = {
      'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,
      'eight':8,'nine':9,'ten':10,'eleven':11,'twelve':12,'thirteen':13,
      'fourteen':14,'fifteen':15,'sixteen':16,'seventeen':17,'eighteen':18,
      'nineteen':19,'twenty':20,
      '零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10
    };
    for (const [w, n] of Object.entries(words)) {
      s = s.replace(new RegExp(`\\b${w}\\b`, 'gi'), String(n));
    }

    // Normalize operators
    s = s.replace(/×|✕|✖/g, '*');
    s = s.replace(/÷|∕/g, '/');
    s = s.replace(/−|–|—/g, '-');
    s = s.replace(/\bplus\b/gi, '+').replace(/\bminus\b/gi, '-');
    s = s.replace(/\btimes\b/gi, '*').replace(/\bmultiplied\s*by\b/gi, '*');
    s = s.replace(/\bdivided\s*by\b/gi, '/');
    s = s.replace(/加/g, '+').replace(/减/g, '-').replace(/乘/g, '*').replace(/除以/g, '/');

    // Remove trailing "= ?"
    s = s.replace(/[=＝]\s*[?？\s]*$/, '').trim();

    const match = s.match(/(\d+\s*[+\-*/]\s*\d+(?:\s*[+\-*/]\s*\d+)*)/);
    return match ? match[1] : null;
  }

  // Strategy 3: Standalone textarea (not inside a form — some themes do this)
  const standaloneTextarea = document.querySelector(
    'textarea[name*="comment" i], textarea[id*="comment" i], textarea[placeholder*="comment" i], textarea[placeholder*="write" i]'
  );
  if (standaloneTextarea) {
    formInfo.hasCommentForm = true;
    formInfo.fields.comment = { selector: getSelector(standaloneTextarea), name: standaloneTextarea.name || standaloneTextarea.id, type: 'textarea' };

    // Look for nearby inputs and submit button in surrounding container
    const container = standaloneTextarea.closest('div, section, article') || document.body;
    formInfo.fields.name = findNearbyInput(container, ['author', 'name', 'commenter']);
    formInfo.fields.email = findNearbyInput(container, ['email', 'mail']);
    formInfo.fields.website = findNearbyInput(container, ['url', 'website', 'site']);
    formInfo.submitButton = findNearbySubmit(container);

    addSiteIntelligence(formInfo, standaloneTextarea.closest('form'));
    return formInfo;
  }

  // Strategy 4: contenteditable div (WordPress.com, Jetpack, Squarespace, Medium-style)
  const editableDivs = document.querySelectorAll(
    '[contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor, .comment-form__field textarea, [data-placeholder*="comment" i], [data-placeholder*="write" i], [placeholder*="comment" i], [placeholder*="write" i]'
  );

  for (const el of editableDivs) {
    // Check if this looks like a comment input (not a search bar or unrelated editor)
    const nearComment = el.closest('[class*="comment" i], [id*="comment" i], [class*="reply" i], [id*="reply" i]')
      || (document.querySelector('h3, h2, h4')?.textContent?.match(/leave.*reply|comment|respond/i));

    if (nearComment || editableDivs.length === 1) {
      formInfo.hasCommentForm = true;
      formInfo.fields.comment = {
        selector: getSelector(el),
        name: el.getAttribute('name') || el.id || null,
        type: el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable'
      };

      // Find nearby inputs
      const container = el.closest('form, div, section') || el.parentElement;
      formInfo.fields.name = findNearbyInput(container, ['author', 'name', 'commenter', 'nickname']);
      formInfo.fields.email = findNearbyInput(container, ['email', 'mail']);
      formInfo.fields.website = findNearbyInput(container, ['url', 'website', 'site']);
      formInfo.submitButton = findNearbySubmit(container);

      addSiteIntelligence(formInfo, el.closest('form'));
      return formInfo;
    }
  }

  // No form found — check for login requirement
  if (document.querySelector('a[href*="login"], a[href*="register"], .login-required, .must-log-in')) {
    formInfo.requiresLogin = true;
  }

  return formInfo;

  // Helpers
  function findNearbyInput(container, patterns) {
    for (const p of patterns) {
      const candidates = [
        ...container.querySelectorAll(`input[name*="${p}" i]`),
        ...container.querySelectorAll(`input[id*="${p}" i]`),
        ...container.querySelectorAll(`input[placeholder*="${p}" i]`)
      ];
      const el = candidates.find(isFillableInput);
      if (el) return { selector: getSelector(el), name: el.name || el.id, type: el.type };
    }
    return null;
  }

  function findNearbySubmit(container) {
    const btn = container.querySelector('input[type="submit"], button[type="submit"]')
      || container.querySelector('button.submit, #submit')
      || [...container.querySelectorAll('button')].find(b =>
        /^(comment|submit|post|reply|send)/i.test(b.textContent?.trim()));
    if (btn) return { selector: getSelector(btn), text: btn.value || btn.textContent?.trim() };
    return null;
  }
}

// Injected function: verify comment appeared on page after submission
// Injected into every frame to find an existing link to `website` in the comment area.
// Returns { found, matched, via } as soon as any frame finds a match.
// matchMode: 'url' (default, strict host+path) or 'domain' (host-only fallback).
function quickCheckInPage(website, matchMode) {
  const normalize = (raw, base) => {
    try {
      const u = base ? new URL(raw, base) : new URL(raw);
      const host = u.host.replace(/^www\./, '').toLowerCase();
      const path = u.pathname.replace(/\/+$/, '') || '/';
      return { full: `${host}${path}`, host };
    } catch {
      return { full: (raw || '').toLowerCase(), host: (raw || '').toLowerCase() };
    }
  };
  const target = normalize(website);
  if (!target.full) return { found: false };

  const containers = document.querySelectorAll(
    '.comment, .comments, .comment-list, #comments, article .comments, .wp-block-comments, ol.commentlist, ul.commentlist'
  );
  const scope = containers.length ? [...containers] : [document.body];

  for (const root of scope) {
    const links = root.querySelectorAll('a[href]');
    for (const a of links) {
      const href = (a.getAttribute('href') || '').trim();
      if (!href) continue;
      const n = normalize(href, location.href);
      if (n.full === target.full || n.full.startsWith(target.full + '/')) {
        return { found: true, matched: href, via: 'url' };
      }
      if (matchMode === 'domain' && n.host === target.host) {
        return { found: true, matched: href, via: 'domain' };
      }
    }
  }
  return { found: false };
}

function verifyCommentOnPage(commentText, website) {
  const pageText = document.body?.innerText || '';
  const pageHtml = document.body?.innerHTML || '';
  const currentUrl = window.location.href;

  // Collect privacy-safe diagnostics once so every return path can carry them
  // without having to repeat the capture in each branch. Only lengths/flags —
  // page text itself is never included.
  const pageTitle = (document.title || '').slice(0, 120);
  const bodyPreviewLen = pageText.length;
  const captchaPresent = !!document.querySelector(
    '.g-recaptcha, .h-captcha, [data-sitekey], .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
  );
  const enrich = (r) => Object.assign({}, r, {
    matched: !!r.verified,
    pageTitle,
    bodyPreviewLen,
    captchaPresent
  });
  const origReturn = (r) => enrich(r);
  const _return = origReturn;

  // URL-based instant detection
  if (currentUrl.includes('unapproved=')) {
    return _return({ verified: false, status: 'pending_moderation', reason: 'Comment awaiting moderation (unapproved in URL)', matchedPattern: 'url:unapproved' });
  }

  // Check for common error/moderation messages
  const moderationPatterns = [
    /awaiting moderation/i,
    /pending approval/i,
    /comment is awaiting/i,
    /will be published after/i,
    /under review/i,
    /held for moderation/i,
    /待审核/,
    /审核后/,
    /your comment has been submitted/i,
    /thank you for your comment/i
  ];

  const errorPatterns = [
    /duplicate comment/i,
    /you've already said that/i,
    /comment too quickly/i,
    /slow down/i,
    /spam/i,
    /blocked/i,
    /not allowed/i,
    /forbidden/i,
    /rejected/i
  ];

  // Check for unsolvable CAPTCHA (reCAPTCHA, hCaptcha, Turnstile)
  // Only flag iframe/widget-based CAPTCHAs, not simple math CAPTCHAs we can solve
  const hardCaptchaElements = document.querySelectorAll(
    '.g-recaptcha, .h-captcha, [data-sitekey], .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
  );
  if (hardCaptchaElements.length > 0) {
    return _return({ verified: false, status: 'captcha', reason: 'CAPTCHA/human verification detected', matchedPattern: 'dom:hardCaptcha' });
  }

  // Check for moderation messages
  for (const pattern of moderationPatterns) {
    if (pattern.test(pageText)) {
      return _return({ verified: false, status: 'pending_moderation', reason: 'Comment awaiting moderation', matchedPattern: pattern.toString() });
    }
  }

  // Check for error messages
  for (const pattern of errorPatterns) {
    // Only match error patterns near forms/alerts, not in article content
    const alerts = document.querySelectorAll('.error, .alert, .notice, .message, #error, .wp-die-message');
    for (const alert of alerts) {
      if (pattern.test(alert.textContent)) {
        return _return({ verified: false, status: 'rejected', reason: alert.textContent.trim().substring(0, 200), matchedPattern: pattern.toString() });
      }
    }
  }

  // Locate the exact <a> the comment posted. We limit the scan to common
  // comment-area containers (not document-wide) and compare host + path
  // instead of raw string inclusion so trailing slashes, www prefix, and
  // http<->https redirects all match. Rel classification runs on this exact
  // anchor (not a header/sidebar link that happens to point at the same
  // domain), producing a stable relCategory alongside the legacy dofollow
  // boolean for backwards compatibility.
  const matchedAnchor = website ? findPostedAnchor(website) : null;

  // Check if comment text snippet appears on page (first 50 chars)
  const snippet = commentText.substring(0, 50).trim();
  if (snippet && pageText.includes(snippet)) {
    const dfResult = classifyAnchor(matchedAnchor);
    return _return({ verified: true, status: 'confirmed', reason: 'Comment text found on page', matchedPattern: 'snippet:body', ...dfResult });
  }

  // Check if website URL appears in a new comment/link via the anchor match
  if (matchedAnchor) {
    const dfResult = classifyAnchor(matchedAnchor);
    return _return({ verified: true, status: 'confirmed', reason: 'Website link found on page', matchedPattern: 'website:anchor', ...dfResult });
  }

  // If form is gone and no errors, likely submitted successfully (moderation or redirect)
  const formStillExists = document.querySelector('#commentform, .comment-form, form[action*="comment"]');
  if (!formStillExists) {
    return _return({ verified: false, status: 'pending_moderation', reason: 'Form gone, likely submitted (may need moderation)', matchedPattern: 'dom:formGone' });
  }

  // Detect login/registration requirement (appears after submit attempt)
  const loginSignals = [
    // Modals and forms
    'form[action*="login"]', 'form[action*="signin"]', 'form[action*="register"]', 'form[action*="signup"]',
    // Substack "Create your profile"
    '[class*="profile-dialog"]', '[class*="create-profile"]',
    // Generic login/register prompts
    '.login-modal', '.signin-modal', '.register-modal', '.auth-modal',
    '[role="dialog"] input[type="password"]',
    '[role="dialog"] a[href*="login"]',
    '[role="dialog"] a[href*="sign"]',
  ];
  const loginPatterns = [
    /create your profile/i,
    /sign in to comment/i,
    /log in to (leave|post|write)/i,
    /login to comment/i,
    /must be logged in/i,
    /please (sign|log) in/i,
    /register to comment/i,
    /create.*account/i,
    /sign up to comment/i,
    /登录.*评论/,
    /请先登录/,
  ];

  for (const sel of loginSignals) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      return _return({ verified: false, status: 'requires_login', reason: 'Login/registration required to comment', matchedPattern: 'login-signal:' + sel });
    }
  }

  // Check visible dialogs/overlays for login text
  const dialogs = document.querySelectorAll('[role="dialog"], .modal, .overlay, [class*="modal"], [class*="dialog"], [class*="popup"]');
  for (const dialog of dialogs) {
    if (dialog.offsetParent === null && !dialog.classList.contains('active') && !dialog.hasAttribute('open')) continue;
    const text = dialog.textContent || '';
    for (const pattern of loginPatterns) {
      if (pattern.test(text)) {
        return _return({ verified: false, status: 'requires_login', reason: 'Login/registration required: ' + text.trim().substring(0, 100), matchedPattern: pattern.toString() });
      }
    }
  }

  // Also check page URL for login redirect
  if (currentUrl.includes('/login') || currentUrl.includes('/signin') || currentUrl.includes('/register') || currentUrl.includes('/signup')) {
    return _return({ verified: false, status: 'requires_login', reason: 'Redirected to login page', matchedPattern: 'url:login-path' });
  }

  // Form still exists - might mean nothing happened or page didn't reload
  return _return({ verified: false, status: 'unknown', reason: 'Could not verify - form still present', matchedPattern: 'fallthrough' });

  // Resolve target URL to a host+path key (lowercase host, drop www, strip
  // trailing slashes). Mirrors lib/db.js normalizeUrl's flexibility but stays
  // inline because injected functions can't import helpers.
  function urlKey(raw, base) {
    try {
      const u = new URL(raw, base);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      const path = u.pathname.replace(/\/+$/, '') || '/';
      return `${host}${path}`;
    } catch {
      return '';
    }
  }

  // Walk the comment-area containers (NOT document-wide, to avoid matching
  // header/sidebar links that happen to share the target's domain) and return
  // the first anchor whose host+path matches the target URL.
  function findPostedAnchor(targetRaw) {
    const target = urlKey(targetRaw);
    if (!target) return null;
    const containers = document.querySelectorAll(
      '.comment, .comments, .comment-list, #comments, article .comments, .wp-block-comments, ol.commentlist, ul.commentlist, .comments-area, [id*=comment]'
    );
    const scope = containers.length ? [...containers] : [document.body];
    for (const root of scope) {
      for (const a of root.querySelectorAll('a[href]')) {
        const href = (a.getAttribute('href') || '').trim();
        if (!href) continue;
        if (urlKey(href, location.href) === target) return a;
      }
    }
    return null;
  }

  // Classify the rel attribute on the posted anchor. Returns the legacy
  // { dofollow, postedRel } plus a fine-grained relCategory so UI/stats can
  // distinguish ugc / sponsored from nofollow instead of collapsing them.
  function classifyAnchor(a) {
    if (!a) return { dofollow: null, relCategory: 'unknown', postedRel: '(none)' };
    const rel = (a.getAttribute('rel') || '').trim().toLowerCase();
    const parts = rel.split(/\s+/).filter(Boolean);
    const hasNofollow = parts.includes('nofollow');
    const hasUgc = parts.includes('ugc');
    const hasSponsored = parts.includes('sponsored');
    let relCategory;
    if (hasSponsored) relCategory = 'sponsored';
    else if (hasUgc) relCategory = 'ugc';
    else if (hasNofollow) relCategory = 'nofollow';
    else relCategory = rel ? 'dofollow' : 'dofollow';  // no rel = dofollow by default
    return {
      dofollow: relCategory === 'dofollow',
      relCategory,
      postedRel: rel || '(none)'
    };
  }
}

// Injected function: solve CAPTCHA (math calculation or text/digit input)
function solveCaptchaOnPage(captchaInfo) {
  if (!captchaInfo || (captchaInfo.type !== 'math' && captchaInfo.type !== 'text')) {
    return { solved: false, reason: 'unsupported_type' };
  }

  // Find the CAPTCHA input
  let input = null;
  if (captchaInfo.inputSelector) {
    input = document.querySelector(captchaInfo.inputSelector);
  }
  if (!input) {
    const selectors = [
      'input[name*="captcha" i]', 'input[id*="captcha" i]',
      'input[name*="cptch" i]', 'input[id*="cptch" i]',
      'input[name*="arithmetic" i]', 'input[name*="quiz" i]',
      '#si_captcha_code'
    ];
    for (const sel of selectors) {
      input = document.querySelector(sel);
      if (input) break;
    }
  }

  if (!input) return { solved: false, reason: 'captcha_input_not_found' };

  // Re-read live content from DOM (CAPTCHA may refresh between analysis and solve)
  const liveContent = readLiveContent(input);
  let answer = null;

  if (captchaInfo.type === 'text') {
    // "Type what you see" — extract all digits from visible characters
    answer = liveContent.digits || captchaInfo.answer;
  } else if (captchaInfo.type === 'math') {
    // Math expression — evaluate
    const expr = liveContent.mathExpr || captchaInfo.expression;
    if (expr) {
      try {
        const sanitized = expr.replace(/\s/g, '');
        if (/^[\d+\-*/().]+$/.test(sanitized)) {
          const result = new Function('return ' + sanitized)();
          if (typeof result === 'number' && isFinite(result)) {
            answer = String(Math.round(result));
          }
        }
      } catch { /* eval failed */ }
    }
  }

  if (!answer) return { solved: false, reason: 'no_answer', type: captchaInfo.type };

  // Fill the input
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, answer);
  else input.value = answer;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  return { solved: true, answer, type: captchaInfo.type };

  function readLiveContent(captchaInput) {
    const container = captchaInput.closest('[class*="captcha" i], [class*="cptch" i], [id*="captcha" i]') || captchaInput.parentElement;
    const result = { digits: null, mathExpr: null };
    if (!container) return result;

    // Collect text from leaf elements (styled character blocks)
    const spans = container.querySelectorAll('span, div, strong, b, em, i, p, td');
    const chars = [];
    for (const span of spans) {
      if (span.contains(captchaInput)) continue;
      if (span.querySelector('input, textarea, span, div')) continue;
      const text = span.textContent.trim();
      if (text && text.length <= 5) chars.push(text);
    }

    // Also check images with alt text
    const imgs = container.querySelectorAll('img');
    for (const img of imgs) {
      if (img.alt && img.alt.length <= 5 && !/reload|refresh|captcha/i.test(img.alt)) {
        chars.push(img.alt.trim());
      }
    }

    if (chars.length >= 2) {
      const combined = chars.join(' ');

      // Check for math operators
      if (/\d\s*[+\-]\s*\d/.test(combined) || /\bplus\b|\bminus\b|\btimes\b/i.test(combined)) {
        result.mathExpr = normalizeMath(combined);
      }

      // Extract all digits
      const digits = combined.replace(/[^\d]/g, '');
      if (digits.length >= 2) result.digits = digits;
    }

    // Fallback: full container text
    if (!result.digits && !result.mathExpr) {
      const clone = container.cloneNode(true);
      clone.querySelectorAll('input, button, img, script, style').forEach(el => el.remove());
      const text = clone.textContent.trim();
      const digits = text.replace(/[^\d]/g, '');
      if (digits.length >= 2) result.digits = digits;

      if (/\d\s*[+\-]\s*\d/.test(text)) {
        result.mathExpr = normalizeMath(text);
      }
    }

    return result;
  }

  function normalizeMath(text) {
    if (!text) return null;
    let s = text.toLowerCase();
    const words = {
      'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,
      'eight':8,'nine':9,'ten':10,'eleven':11,'twelve':12,
      '零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10
    };
    for (const [w, n] of Object.entries(words)) {
      s = s.replace(new RegExp(`\\b${w}\\b`, 'gi'), String(n));
    }
    s = s.replace(/×|✕|✖/g, '*');
    s = s.replace(/÷|∕/g, '/');
    s = s.replace(/−|–|—/g, '-');
    s = s.replace(/\bplus\b/gi, '+').replace(/\bminus\b/gi, '-');
    s = s.replace(/\btimes\b/gi, '*').replace(/\bdivided\s*by\b/gi, '/');
    s = s.replace(/加/g, '+').replace(/减/g, '-').replace(/乘/g, '*').replace(/除以/g, '/');
    s = s.replace(/[=＝]\s*[?？\s]*$/, '').trim();
    const match = s.match(/(\d+\s*[+\-*/]\s*\d+(?:\s*[+\-*/]\s*\d+)*)/);
    return match ? match[1] : null;
  }
}

// Injected function: fill form fields
async function fillForm(formData, fieldSelectors, honeypotFields) {
  const results = {};

  // Mirror analyzePageInline's field predicates. Injected functions don't share
  // scope with background module-level helpers so these are defined locally.
  function isFillableInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    if (el.disabled || el.readOnly) return false;
    const type = (el.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file',
         'checkbox', 'radio', 'search', 'password'].includes(type)) return false;
    return true;
  }
  function isFillableCommentTarget(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  // Clear honeypot fields — these must stay empty to pass anti-spam
  if (honeypotFields?.length > 0) {
    for (const sel of honeypotFields) {
      const el = document.querySelector(sel);
      if (el && el.value) { el.value = ''; }
    }
  }

  // React/Vue-compatible value setter
  function setNativeValue(element, value) {
    const tag = element.tagName;
    const parentSetter = tag === 'TEXTAREA'
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    if (parentSetter) {
      parentSetter.call(element, value);
    } else {
      element.value = value;
    }
  }

  function findElement(selector, fieldKind) {
    if (!selector) return null;
    const predicate = fieldKind === 'comment' ? isFillableCommentTarget : isFillableInput;

    const collect = (raw) => {
      if (!raw) return [];
      try { return [...document.querySelectorAll(raw)]; } catch { return []; }
    };
    const candidates = [];
    if (selector.selector) candidates.push(...collect(selector.selector));
    if (selector.name) candidates.push(...collect(`[name="${selector.name}"]`));

    // Prefer a candidate that passes the field predicate; fall back to the
    // first match if nothing passes (still better than nothing for exotic
    // sites, and downstream code records set_failed when it fails).
    const fillable = candidates.find(predicate);
    return fillable || candidates[0] || null;
  }

  // Step 1: focus/click the comment textarea first to trigger progressive disclosure
  // (Jetpack / Squarespace / modern blogs reveal name/email fields only after interacting with textarea)
  const commentEl = findElement(fieldSelectors.comment, 'comment');
  if (commentEl) {
    commentEl.scrollIntoView({ block: 'center' });
    commentEl.click();
    commentEl.focus();
    // Wait for fields to be revealed by JS
    await new Promise(r => setTimeout(r, 800));
  } else {
    return {
      success: false,
      results: { comment: 'not_found' },
      fieldFillResults: [{ field: 'comment', selector: fieldSelectors.comment?.selector || null, found: false, filledLen: 0, reason: 'not_found' }],
      filledCount: 0,
      totalCount: Object.keys(formData).length
    };
  }

  // fieldFillResults is the privacy-safe diagnostic view: per-field selector,
  // found/not_found, the length of what we wrote (not the value itself), and
  // the outcome reason — consumed by popup.js writeFailureLog.
  const fieldFillResults = [];

  // Step 2: fill each field
  for (const [field, value] of Object.entries(formData)) {
    const selector = fieldSelectors[field];
    if (!selector) {
      results[field] = 'no_selector';
      fieldFillResults.push({ field, selector: null, found: false, filledLen: 0, reason: 'no_selector' });
      continue;
    }

    // Re-query elements (some may have just been rendered by JS)
    const element = findElement(selector, field === 'comment' ? 'comment' : 'input');
    const selStr = selector.selector || selector.name || null;

    if (element) {
      element.focus();

      const isContentEditable = element.isContentEditable || element.getAttribute('contenteditable') === 'true';

      if (isContentEditable) {
        // For contenteditable divs (WordPress.com, Jetpack, Squarespace, etc.)
        element.textContent = '';
        element.focus();
        // Use execCommand for rich text editors that listen for it
        document.execCommand('insertText', false, value);
        // Also set directly as fallback
        if (!element.textContent) {
          element.textContent = value;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));

        if (element.textContent.length > 0) {
          results[field] = 'filled';
          fieldFillResults.push({ field, selector: selStr, found: true, filledLen: element.textContent.length, reason: 'filled' });
        } else {
          results[field] = 'set_failed';
          fieldFillResults.push({ field, selector: selStr, found: true, filledLen: 0, reason: 'set_failed' });
        }
      } else {
        // For regular input/textarea
        setNativeValue(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));

        const elValLen = (element.value || '').length;
        if (element.value === value || elValLen > 0) {
          results[field] = 'filled';
          fieldFillResults.push({ field, selector: selStr, found: true, filledLen: elValLen, reason: 'filled' });
        } else {
          results[field] = 'set_failed';
          fieldFillResults.push({ field, selector: selStr, found: true, filledLen: 0, reason: 'set_failed' });
        }
      }
    } else {
      results[field] = 'not_found';
      fieldFillResults.push({ field, selector: selStr, found: false, filledLen: 0, reason: 'not_found' });
    }
  }

  const commentFilled = results.comment === 'filled';
  const filledCount = Object.values(results).filter(v => v === 'filled').length;

  // Pre-submit required-field check. Only when comment was filled (otherwise
  // fillForm already reports success:false and we don't care about other
  // validation). Scope the scan to the form containing the comment field —
  // we must NOT scan document-wide, which would pick up search boxes and
  // login popups elsewhere on the page. A pure contenteditable target has no
  // enclosing form; skip the check there.
  if (commentFilled) {
    const commentEl = findElement(fieldSelectors.comment, 'comment');
    const form = commentEl && commentEl.closest ? commentEl.closest('form') : null;
    if (form) {
      const missingFields = [];
      for (const field of form.querySelectorAll('input[required], textarea[required]')) {
        if (!isFillableInput(field)) continue;
        if ((field.value || '').trim() === '') {
          missingFields.push(field.name || field.id || field.type || 'unknown');
        }
      }
      if (missingFields.length > 0) {
        return {
          success: false,
          error: 'required_empty',
          results: { ...results, required: 'required_empty' },
          fieldFillResults,
          missingFields,
          filledCount,
          totalCount: Object.keys(formData).length
        };
      }
    }
  }

  return {
    success: commentFilled,
    results,
    fieldFillResults,
    filledCount,
    totalCount: Object.keys(formData).length
  };
}

// Injected function: click submit button
function clickSubmit(submitSelector) {
  let button = null;
  let matchedSelector = null;

  if (submitSelector?.selector) {
    button = document.querySelector(submitSelector.selector);
    if (button) matchedSelector = submitSelector.selector;
  }

  if (!button) {
    const candidates = [
      'input[type="submit"]',
      'button[type="submit"]',
      '#submit',
      '.submit',
      'input[value*="Submit"]',
      'input[value*="Post"]',
      'button[name="submit"]'
    ];
    for (const sel of candidates) {
      try {
        button = document.querySelector(sel);
        if (button) { matchedSelector = sel; break; }
      } catch { /* ignore invalid selectors */ }
    }
  }

  if (button) {
    button.click();
    return { success: true, buttonSelector: matchedSelector, clicked: true, navigationHappened: false };
  }

  // Fallback: use HTMLFormElement.prototype.submit to bypass name="submit" shadow
  const form = document.querySelector('#commentform, .comment-form, form[action*="comment"]');
  if (form) {
    HTMLFormElement.prototype.submit.call(form);
    return { success: true, buttonSelector: 'form.submit()', clicked: false, navigationHappened: false, method: 'form_submit' };
  }

  return { success: false, buttonSelector: null, clicked: false, navigationHappened: false, error: 'Submit button not found' };
}

console.log('Linkbuilder background service worker loaded');
