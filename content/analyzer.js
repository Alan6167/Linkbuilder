// Content Script: Blog page analyzer
// Injected into all pages to analyze comment forms and extract data on demand

(function () {
  // Listen for messages from background/popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'analyzePage') {
      const result = analyzePage();
      sendResponse(result);
    } else if (message.type === 'extractCommentLinks') {
      const links = extractCommentLinks();
      sendResponse({ links });
    } else if (message.type === 'getPageInfo') {
      sendResponse(getPageInfo());
    }
    return true;
  });

  // Analyze the current page for comment form
  function analyzePage() {
    const forms = document.querySelectorAll('form');
    let commentForm = null;
    let formInfo = {
      hasCommentForm: false,
      requiresLogin: false,
      fields: {},
      submitButton: null
    };

    for (const form of forms) {
      // Look for comment-related forms
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

    // Fallback: look for textarea near "comment" text
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
      // Check if login is required
      const loginIndicators = document.querySelectorAll(
        'a[href*="login"], a[href*="register"], a[href*="sign-in"], .login-required, .must-log-in'
      );
      if (loginIndicators.length > 0) {
        formInfo.requiresLogin = true;
      }
      return formInfo;
    }

    formInfo.hasCommentForm = true;

    // Identify form fields
    formInfo.fields = {
      name: findField(commentForm, ['author', 'name', 'commenter', 'your-name']),
      email: findField(commentForm, ['email', 'mail', 'e-mail']),
      website: findField(commentForm, ['url', 'website', 'web', 'site', 'homepage']),
      comment: findTextarea(commentForm)
    };

    // Find submit button
    const submitBtn = commentForm.querySelector('input[type="submit"], button[type="submit"], button.submit, #submit');
    if (submitBtn) {
      formInfo.submitButton = {
        selector: getUniqueSelector(submitBtn),
        text: submitBtn.value || submitBtn.textContent
      };
    }

    return formInfo;
  }

  function findField(form, namePatterns) {
    for (const pattern of namePatterns) {
      // Try by name attribute
      let el = form.querySelector(`input[name*="${pattern}" i]`);
      if (el) return { selector: getUniqueSelector(el), name: el.name, type: el.type };

      // Try by id
      el = form.querySelector(`input[id*="${pattern}" i]`);
      if (el) return { selector: getUniqueSelector(el), name: el.name || el.id, type: el.type };

      // Try by placeholder
      el = form.querySelector(`input[placeholder*="${pattern}" i]`);
      if (el) return { selector: getUniqueSelector(el), name: el.name || el.id, type: el.type };
    }
    return null;
  }

  function findTextarea(form) {
    const ta = form.querySelector('textarea');
    if (ta) {
      return { selector: getUniqueSelector(ta), name: ta.name || ta.id };
    }
    return null;
  }

  // Get a unique CSS selector for an element
  function getUniqueSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.name) return `[name="${el.name}"]`;

    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = `#${current.id}`;
        path.unshift(selector);
        break;
      }
      if (current.className) {
        const classes = current.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (classes) selector += `.${classes}`;
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  // Extract links from existing comments (for snowball discovery)
  function extractCommentLinks() {
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
    const anchors = commentArea.querySelectorAll('a[href]');
    const seenDomains = new Set();

    for (const a of anchors) {
      try {
        const url = new URL(a.href);
        // Skip internal links, social media, and common non-blog domains
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
      } catch { /* ignore invalid URLs */ }
    }

    return links;
  }

  // Get basic page information
  function getPageInfo() {
    return {
      title: document.title,
      url: window.location.href,
      domain: window.location.hostname,
      language: detectLanguage(),
      linkFormat: detectLinkFormat(),
      contentExcerpt: getArticleContent(),
      commentCount: document.querySelectorAll('.comment, .comment-body').length
    };
  }

  // Detect which link format comments support on this page
  function detectLinkFormat() {
    // Check existing comments for link patterns
    const commentArea = document.querySelector(
      '#comments, .comments-area, .comment-list, .commentlist, ol.comments, ul.comments'
    );
    const commentHtml = commentArea ? commentArea.innerHTML : '';

    // Check for HTML links in comments
    if (/<a\s+href=/i.test(commentHtml)) return 'html';
    // Check for BBCode
    if (/\[url[=\]]/i.test(commentHtml)) return 'bbcode';
    // Check for Markdown links
    if (/\[.+?\]\(https?:\/\/.+?\)/.test(commentHtml)) return 'markdown';

    // Check if textarea has a rich text editor or toolbar
    const toolbar = document.querySelector(
      '.comment-form .wp-editor-tools, .comment-form .ql-toolbar, .bbcode-toolbar, .markdown-toolbar'
    );
    if (toolbar) {
      const toolbarHtml = toolbar.innerHTML.toLowerCase();
      if (toolbarHtml.includes('bbcode') || toolbarHtml.includes('[url]')) return 'bbcode';
      if (toolbarHtml.includes('markdown') || toolbarHtml.includes('**')) return 'markdown';
    }

    // WordPress default supports HTML in comments
    if (document.querySelector('meta[name="generator"][content*="WordPress"]') ||
        document.querySelector('link[href*="wp-content"]')) {
      return 'html';
    }

    return 'html'; // default
  }

  // Detect page language
  function detectLanguage() {
    // Check html lang attribute
    const htmlLang = document.documentElement.lang;
    if (htmlLang) return htmlLang.split('-')[0].toLowerCase();
    // Check meta tags
    const metaLang = document.querySelector('meta[http-equiv="content-language"]');
    if (metaLang) return metaLang.content.split('-')[0].toLowerCase();
    const metaOg = document.querySelector('meta[property="og:locale"]');
    if (metaOg) return metaOg.content.split('_')[0].toLowerCase();
    return 'en';
  }

  // Extract main article content
  function getArticleContent() {
    const selectors = ['article', '.post-content', '.entry-content', '.article-content', 'main', '.content'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        return el.textContent.trim().substring(0, 2000);
      }
    }
    return document.body?.textContent?.trim().substring(0, 2000) || '';
  }
})();
