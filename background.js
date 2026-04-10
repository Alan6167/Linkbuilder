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
  async analyzePageViaContentScript({ tabId }) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'analyzePage' });
      return response;
    } catch {
      // Content script not ready, try injecting and running inline
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: analyzePageInline
      });
      return results[0]?.result || { hasCommentForm: false, error: 'Script injection failed' };
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

  // Execute comment form fill in a tab
  async fillCommentForm({ tabId, formData, fieldSelectors }) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillForm,
      args: [formData, fieldSelectors]
    });
    return results[0]?.result || { success: false };
  },

  // Submit comment form in a tab
  async submitCommentForm({ tabId, submitSelector }) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickSubmit,
      args: [submitSelector]
    });
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

// Inline page analysis function (fallback when content script isn't available)
function analyzePageInline() {
  const forms = document.querySelectorAll('form');
  let commentForm = null;
  let formInfo = {
    hasCommentForm: false,
    requiresLogin: false,
    fields: {},
    submitButton: null
  };

  for (const form of forms) {
    const formId = (form.id || '').toLowerCase();
    const formClass = (form.className || '').toLowerCase();
    const formAction = (form.action || '').toLowerCase();

    const isCommentForm =
      formId.includes('comment') ||
      formClass.includes('comment') ||
      formAction.includes('comment') ||
      form.querySelector('textarea[name*="comment"]') ||
      form.querySelector('textarea[id*="comment"]') ||
      form.querySelector('#comment');

    if (isCommentForm) {
      commentForm = form;
      break;
    }
  }

  if (!commentForm) {
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      const parent = ta.closest('form');
      if (parent) {
        commentForm = parent;
        break;
      }
    }
  }

  if (!commentForm) {
    const loginIndicators = document.querySelectorAll(
      'a[href*="login"], a[href*="register"], a[href*="sign-in"], .login-required, .must-log-in'
    );
    if (loginIndicators.length > 0) {
      formInfo.requiresLogin = true;
    }
    return formInfo;
  }

  formInfo.hasCommentForm = true;

  function getSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.name) return `[name="${el.name}"]`;
    return null;
  }

  function findInput(patterns) {
    for (const p of patterns) {
      let el = commentForm.querySelector(`input[name*="${p}" i]`)
        || commentForm.querySelector(`input[id*="${p}" i]`)
        || commentForm.querySelector(`input[placeholder*="${p}" i]`);
      if (el) return { selector: getSelector(el), name: el.name || el.id, type: el.type };
    }
    return null;
  }

  formInfo.fields = {
    name: findInput(['author', 'name', 'commenter', 'your-name']),
    email: findInput(['email', 'mail', 'e-mail']),
    website: findInput(['url', 'website', 'web', 'site', 'homepage']),
    comment: (() => {
      const ta = commentForm.querySelector('textarea');
      return ta ? { selector: getSelector(ta), name: ta.name || ta.id } : null;
    })()
  };

  const submitBtn = commentForm.querySelector('input[type="submit"], button[type="submit"], button.submit, #submit');
  if (submitBtn) {
    formInfo.submitButton = {
      selector: getSelector(submitBtn),
      text: submitBtn.value || submitBtn.textContent
    };
  }

  return formInfo;
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
function fillForm(formData, fieldSelectors) {
  const results = {};

  for (const [field, value] of Object.entries(formData)) {
    const selector = fieldSelectors[field];
    if (!selector) continue;

    let element = null;
    if (selector.selector) {
      element = document.querySelector(selector.selector);
    }
    if (!element && selector.name) {
      element = document.querySelector(`[name="${selector.name}"]`);
    }

    if (element) {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      results[field] = true;
    } else {
      results[field] = false;
    }
  }

  return { success: true, results };
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
