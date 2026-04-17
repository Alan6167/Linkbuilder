// Background Service Worker for Linkbuilder

// Click extension icon to open/close side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
    // Wait for the tab to finish loading
    await waitForTabLoad(tab.id);
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

  // Extract comment links via content script
  async extractLinksViaContentScript({ tabId }) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'extractCommentLinks' });
      return response;
    } catch {
      return { links: [] };
    }
  },

  // Get page HTML from a tab
  async getPageHtml({ tabId }) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML
    });
    return { html: results[0]?.result || '' };
  },

  // Close a tab
  async closeTab({ tabId }) {
    try {
      await chrome.tabs.remove(tabId);
    } catch { /* tab may already be closed */ }
    return { success: true };
  },

  // Execute comment form fill - runs in all frames, uses the one that filled successfully
  async fillCommentForm({ tabId, formData, fieldSelectors, frameId }) {
    const target = frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };

    const results = await chrome.scripting.executeScript({
      target,
      func: fillForm,
      args: [formData, fieldSelectors]
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

  // Verify if comment was published after submission
  async verifyComment({ tabId, commentText, website }) {
    // Wait for page to potentially reload/redirect after submit
    await waitForTabLoad(tabId, 10000);
    // Small extra wait for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: verifyCommentOnPage,
      args: [commentText, website]
    });
    return results[0]?.result || { verified: false, reason: 'script_failed' };
  }
};

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

// Inline page analysis function — detects comment forms across various blog platforms
function analyzePageInline() {
  let formInfo = {
    hasCommentForm: false,
    requiresLogin: false,
    fields: {},
    submitButton: null
  };

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

  // Strategy 2: Any form with a textarea
  if (!commentForm) {
    for (const ta of document.querySelectorAll('textarea')) {
      const parent = ta.closest('form');
      if (parent) { commentForm = parent; break; }
    }
  }

  // If we found a traditional form, extract fields
  if (commentForm) {
    formInfo.hasCommentForm = true;

    function findInput(container, patterns) {
      for (const p of patterns) {
        let el = container.querySelector(`input[name*="${p}" i]`)
          || container.querySelector(`input[id*="${p}" i]`)
          || container.querySelector(`input[placeholder*="${p}" i]`);
        if (el) return { selector: getSelector(el), name: el.name || el.id, type: el.type };
      }
      return null;
    }

    formInfo.fields = {
      name: findInput(commentForm, ['author', 'name', 'commenter', 'your-name', 'nickname']),
      email: findInput(commentForm, ['email', 'mail', 'e-mail']),
      website: findInput(commentForm, ['url', 'website', 'web', 'site', 'homepage']),
      comment: (() => {
        const ta = commentForm.querySelector('textarea');
        return ta ? { selector: getSelector(ta), name: ta.name || ta.id, type: 'textarea' } : null;
      })()
    };

    const submitBtn = commentForm.querySelector('input[type="submit"], button[type="submit"], button.submit, #submit');
    if (submitBtn) {
      formInfo.submitButton = { selector: getSelector(submitBtn), text: submitBtn.value || submitBtn.textContent?.trim() };
    }

    return formInfo;
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
      let el = container.querySelector(`input[name*="${p}" i]`)
        || container.querySelector(`input[id*="${p}" i]`)
        || container.querySelector(`input[placeholder*="${p}" i]`);
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
function verifyCommentOnPage(commentText, website) {
  const pageText = document.body?.innerText || '';
  const pageHtml = document.body?.innerHTML || '';

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

  const captchaPatterns = [
    /captcha/i,
    /recaptcha/i,
    /hcaptcha/i,
    /verify you.*(human|not.*robot)/i,
    /are you human/i,
    /人机验证/,
    /验证码/,
    /turnstile/i
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

  // Check for CAPTCHA / human verification
  const captchaElements = document.querySelectorAll(
    '.g-recaptcha, .h-captcha, [data-sitekey], .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
  );
  if (captchaElements.length > 0) {
    return { verified: false, status: 'captcha', reason: 'CAPTCHA/human verification detected' };
  }
  for (const pattern of captchaPatterns) {
    if (pattern.test(pageHtml)) {
      return { verified: false, status: 'captcha', reason: 'CAPTCHA/human verification detected' };
    }
  }

  // Check for moderation messages
  for (const pattern of moderationPatterns) {
    if (pattern.test(pageText)) {
      return { verified: false, status: 'pending_moderation', reason: 'Comment awaiting moderation' };
    }
  }

  // Check for error messages
  for (const pattern of errorPatterns) {
    // Only match error patterns near forms/alerts, not in article content
    const alerts = document.querySelectorAll('.error, .alert, .notice, .message, #error, .wp-die-message');
    for (const alert of alerts) {
      if (pattern.test(alert.textContent)) {
        return { verified: false, status: 'rejected', reason: alert.textContent.trim().substring(0, 200) };
      }
    }
  }

  // Check if comment text snippet appears on page (first 50 chars)
  const snippet = commentText.substring(0, 50).trim();
  if (snippet && pageText.includes(snippet)) {
    return { verified: true, status: 'confirmed', reason: 'Comment text found on page' };
  }

  // Check if website URL appears in a new comment/link
  if (website && pageHtml.includes(website)) {
    return { verified: true, status: 'confirmed', reason: 'Website link found on page' };
  }

  // If form is gone and no errors, likely submitted successfully (moderation or redirect)
  const formStillExists = document.querySelector('#commentform, .comment-form, form[action*="comment"]');
  if (!formStillExists) {
    return { verified: false, status: 'pending_moderation', reason: 'Form gone, likely submitted (may need moderation)' };
  }

  // Form still exists - might mean nothing happened or page didn't reload
  return { verified: false, status: 'unknown', reason: 'Could not verify - form still present' };
}

// Injected function: fill form fields
async function fillForm(formData, fieldSelectors) {
  const results = {};

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

  function findElement(selector) {
    if (!selector) return null;
    let el = null;
    if (selector.selector) {
      try { el = document.querySelector(selector.selector); } catch {}
    }
    if (!el && selector.name) {
      el = document.querySelector(`[name="${selector.name}"]`);
    }
    return el;
  }

  // Step 1: focus/click the comment textarea first to trigger progressive disclosure
  // (Jetpack / Squarespace / modern blogs reveal name/email fields only after interacting with textarea)
  const commentEl = findElement(fieldSelectors.comment);
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
      filledCount: 0,
      totalCount: Object.keys(formData).length
    };
  }

  // Step 2: fill each field
  for (const [field, value] of Object.entries(formData)) {
    const selector = fieldSelectors[field];
    if (!selector) {
      results[field] = 'no_selector';
      continue;
    }

    // Re-query elements (some may have just been rendered by JS)
    const element = findElement(selector);

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
        } else {
          results[field] = 'set_failed';
        }
      } else {
        // For regular input/textarea
        setNativeValue(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));

        if (element.value === value || element.value.length > 0) {
          results[field] = 'filled';
        } else {
          results[field] = 'set_failed';
        }
      }
    } else {
      results[field] = 'not_found';
    }
  }

  const commentFilled = results.comment === 'filled';
  const filledCount = Object.values(results).filter(v => v === 'filled').length;

  return {
    success: commentFilled,
    results,
    filledCount,
    totalCount: Object.keys(formData).length
  };
}

// Injected function: click submit button
function clickSubmit(submitSelector) {
  let button = null;

  if (submitSelector?.selector) {
    button = document.querySelector(submitSelector.selector);
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
        if (button) break;
      } catch { /* ignore invalid selectors */ }
    }
  }

  if (button) {
    button.click();
    return { success: true };
  }

  return { success: false, error: 'Submit button not found' };
}

console.log('Linkbuilder background service worker loaded');
