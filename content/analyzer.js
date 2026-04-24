// Content Script: Blog page analyzer
// Injected into tabs the extension opens (not auto-attached to every page).
// The authoritative comment-form analyser and snowball link extractor both
// live in background.js (analyzePageInline / extractCommentLinksInline) and
// are injected via chrome.scripting.executeScript with allFrames:true. This
// file only keeps the getPageInfo helper — popup.js still sends that via
// chrome.tabs.sendMessage to read title / language / content excerpt for the
// Gemini prompt, and that path predates the inline-analyzer refactor.

(function () {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getPageInfo') {
      sendResponse(getPageInfo());
    }
    return true;
  });

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

  function detectLinkFormat() {
    const commentArea = document.querySelector(
      '#comments, .comments-area, .comment-list, .commentlist, ol.comments, ul.comments'
    );
    const commentHtml = commentArea ? commentArea.innerHTML : '';

    if (/<a\s+href=/i.test(commentHtml)) return 'html';
    if (/\[url[=\]]/i.test(commentHtml)) return 'bbcode';
    if (/\[.+?\]\(https?:\/\/.+?\)/.test(commentHtml)) return 'markdown';

    const toolbar = document.querySelector(
      '.comment-form .wp-editor-tools, .comment-form .ql-toolbar, .bbcode-toolbar, .markdown-toolbar'
    );
    if (toolbar) {
      const toolbarHtml = toolbar.innerHTML.toLowerCase();
      if (toolbarHtml.includes('bbcode') || toolbarHtml.includes('[url]')) return 'bbcode';
      if (toolbarHtml.includes('markdown') || toolbarHtml.includes('**')) return 'markdown';
    }

    if (document.querySelector('meta[name="generator"][content*="WordPress"]') ||
        document.querySelector('link[href*="wp-content"]')) {
      return 'html';
    }

    return 'html';
  }

  function detectLanguage() {
    const htmlLang = document.documentElement.lang;
    if (htmlLang) return htmlLang.split('-')[0].toLowerCase();
    const metaLang = document.querySelector('meta[http-equiv="content-language"]');
    if (metaLang) return metaLang.content.split('-')[0].toLowerCase();
    const metaOg = document.querySelector('meta[property="og:locale"]');
    if (metaOg) return metaOg.content.split('_')[0].toLowerCase();
    return 'en';
  }

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
