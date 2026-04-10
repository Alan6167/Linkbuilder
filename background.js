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
  // Open a URL in a new tab and inject content script for analysis
  async analyzeUrl({ url }) {
    const tab = await chrome.tabs.create({ url, active: false });
    return { tabId: tab.id };
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
    await chrome.tabs.remove(tabId);
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
  }
};

// Injected function: fill form fields
function fillForm(formData, fieldSelectors) {
  const results = {};

  for (const [field, value] of Object.entries(formData)) {
    const selector = fieldSelectors[field];
    if (!selector) continue;

    // Try CSS selector first, then name attribute
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

  // Fallback: find common submit buttons
  if (!button) {
    const candidates = [
      'input[type="submit"]',
      'button[type="submit"]',
      '#submit',
      '.submit',
      'button:has(> span:contains("Post"))',
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
