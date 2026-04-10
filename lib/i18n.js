// Internationalization support for Chinese and English

const translations = {
  en: {
    // Header
    'header.subtitle': 'Blog Comment Backlink Tool',

    // Tabs
    'tab.import': 'Import',
    'tab.backlinks': 'Backlinks',
    'tab.publish': 'Publish',
    'tab.settings': 'Settings',

    // Import Tab
    'import.title': 'Import Semrush Backlinks',
    'import.hint': 'Upload .xlsx file exported from Semrush backlink analysis',
    'import.upload': 'Click or drag .xlsx file here',
    'import.processing': 'Processing...',
    'import.reading': 'Reading file...',
    'import.parsing': 'Parsing Excel...',
    'import.filtering': 'Filtering backlinks...',
    'import.applying': 'Applying filters...',
    'import.done': 'Done!',
    'import.results': 'Import Results',
    'import.totalRows': 'Total rows',
    'import.afterFilter': 'After filter',
    'import.ugcLinks': 'UGC links',
    'import.blogUrls': 'Blog URLs',
    'import.save': 'Save to Database',
    'import.saving': 'Saving...',
    'import.saved': 'Saved {count} records!',

    // Backlinks Tab
    'backlinks.title': 'Backlink Resources',
    'backlinks.all': 'All Status',
    'backlinks.pending': 'Pending',
    'backlinks.commentable': 'Commentable',
    'backlinks.notCommentable': 'Not Commentable',
    'backlinks.commented': 'Commented',
    'backlinks.analyzeAll': 'Analyze All',
    'backlinks.empty': 'No backlinks imported yet. Go to Import tab to upload data.',
    'backlinks.analyzing': 'Analyzing {current}/{total}...',
    'backlinks.noPending': 'No pending backlinks to analyze.',

    // Publish Tab
    'publish.title': 'Publish Comments',
    'publish.name': 'Your Name',
    'publish.email': 'Your Email',
    'publish.website': 'Your Website URL',
    'publish.mode': 'Publishing Mode',
    'publish.semiAuto': 'Semi-Auto (Review before submit)',
    'publish.auto': 'Full Auto (Auto submit)',
    'publish.start': 'Start Publishing',
    'publish.publishing': 'Publishing...',
    'publish.log': 'Publishing Log',
    'publish.fillRequired': 'Please fill in your name, email, and website URL.',
    'publish.noCommentable': 'No commentable backlinks found. Analyze backlinks first.',
    'publish.opening': 'Opening: {url}',
    'publish.generating': 'Generating comment...',
    'publish.comment': 'Comment: "{text}..."',
    'publish.filled': 'Form filled!',
    'publish.submitted': 'Comment submitted!',
    'publish.submitFailed': 'Submit failed: {error}',
    'publish.review': 'Review the comment and click submit manually.',
    'publish.done': 'Done! Processed {count} backlinks.',

    // Settings Tab
    'settings.title': 'Settings',
    'settings.apiKey': 'Gemini API Key',
    'settings.apiKeyPlaceholder': 'Enter your Gemini API key',
    'settings.apiKeyHint': 'Get your free key from Google AI Studio (Gemini 2.5 Flash is free)',
    'settings.minAscore': 'Min Page Ascore',
    'settings.maxExternal': 'Max External Links',
    'settings.filterLost': 'Filter lost links',
    'settings.filterSpam': 'Filter SPAM domains',
    'settings.save': 'Save Settings',
    'settings.saved': 'Saved!',
    'settings.language': 'Language',
    'settings.dataManagement': 'Data Management',
    'settings.exportBacklinks': 'Export Backlinks',
    'settings.exportDiscovered': 'Export Discovered Sites',
    'settings.clearData': 'Clear All Data',
    'settings.clearConfirm': 'Are you sure you want to clear ALL data? This cannot be undone.',
    'settings.cleared': 'All data cleared.',
    'settings.backlinks': 'Backlinks',
    'settings.comments': 'Comments',
    'settings.discovered': 'Discovered',
    'settings.noApiKey': 'Please set your Gemini API key in Settings first.',

    // Pagination
    'pagination.prev': '< Prev',
    'pagination.next': 'Next >',
    'pagination.page': 'Page {current} / {total}',

    // Common
    'common.error': 'Error: {message}',
    'common.noData': 'No data to export.'
  },

  zh: {
    // Header
    'header.subtitle': '博客评论外链工具',

    // Tabs
    'tab.import': '导入',
    'tab.backlinks': '外链列表',
    'tab.publish': '发布',
    'tab.settings': '设置',

    // Import Tab
    'import.title': '导入 Semrush 外链数据',
    'import.hint': '上传从 Semrush 外链分析导出的 .xlsx 文件',
    'import.upload': '点击或拖拽 .xlsx 文件到此处',
    'import.processing': '处理中...',
    'import.reading': '读取文件...',
    'import.parsing': '解析 Excel...',
    'import.filtering': '筛选外链...',
    'import.applying': '应用过滤规则...',
    'import.done': '完成!',
    'import.results': '导入结果',
    'import.totalRows': '总行数',
    'import.afterFilter': '筛选后',
    'import.ugcLinks': 'UGC 链接',
    'import.blogUrls': '博客 URL',
    'import.save': '保存到数据库',
    'import.saving': '保存中...',
    'import.saved': '已保存 {count} 条记录!',

    // Backlinks Tab
    'backlinks.title': '外链资源',
    'backlinks.all': '全部状态',
    'backlinks.pending': '待处理',
    'backlinks.commentable': '可评论',
    'backlinks.notCommentable': '不可评论',
    'backlinks.commented': '已评论',
    'backlinks.analyzeAll': '全部分析',
    'backlinks.empty': '暂无外链数据，请到"导入"页面上传数据。',
    'backlinks.analyzing': '分析中 {current}/{total}...',
    'backlinks.noPending': '没有待分析的外链。',

    // Publish Tab
    'publish.title': '发布评论',
    'publish.name': '你的昵称',
    'publish.email': '你的邮箱',
    'publish.website': '你的网站 URL',
    'publish.mode': '发布模式',
    'publish.semiAuto': '半自动（审核后提交）',
    'publish.auto': '全自动（自动提交）',
    'publish.start': '开始发布',
    'publish.publishing': '发布中...',
    'publish.log': '发布日志',
    'publish.fillRequired': '请填写昵称、邮箱和网站 URL。',
    'publish.noCommentable': '没有可评论的外链，请先分析外链。',
    'publish.opening': '打开页面: {url}',
    'publish.generating': '生成评论中...',
    'publish.comment': '评论: "{text}..."',
    'publish.filled': '表单已填写!',
    'publish.submitted': '评论已提交!',
    'publish.submitFailed': '提交失败: {error}',
    'publish.review': '请检查评论内容，手动点击提交按钮。',
    'publish.done': '完成! 共处理 {count} 条外链。',

    // Settings Tab
    'settings.title': '设置',
    'settings.apiKey': 'Gemini API 密钥',
    'settings.apiKeyPlaceholder': '输入你的 Gemini API 密钥',
    'settings.apiKeyHint': '从 Google AI Studio 免费获取密钥（Gemini 2.5 Flash 免费使用）',
    'settings.minAscore': '最低页面评分',
    'settings.maxExternal': '最大外链数量',
    'settings.filterLost': '过滤失效链接',
    'settings.filterSpam': '过滤 SPAM 域名',
    'settings.save': '保存设置',
    'settings.saved': '已保存!',
    'settings.language': '语言',
    'settings.dataManagement': '数据管理',
    'settings.exportBacklinks': '导出外链',
    'settings.exportDiscovered': '导出发现的网站',
    'settings.clearData': '清除所有数据',
    'settings.clearConfirm': '确定要清除所有数据吗？此操作不可撤销。',
    'settings.cleared': '所有数据已清除。',
    'settings.backlinks': '外链',
    'settings.comments': '评论',
    'settings.discovered': '发现',
    'settings.noApiKey': '请先在设置中填写 Gemini API 密钥。',

    // Pagination
    'pagination.prev': '< 上一页',
    'pagination.next': '下一页 >',
    'pagination.page': '第 {current} / {total} 页',

    // Common
    'common.error': '错误: {message}',
    'common.noData': '没有可导出的数据。'
  }
};

let currentLang = 'zh'; // Default to Chinese

function t(key, params = {}) {
  let text = translations[currentLang]?.[key] || translations['en']?.[key] || key;
  for (const [param, value] of Object.entries(params)) {
    text = text.replace(`{${param}}`, value);
  }
  return text;
}

function setLanguage(lang) {
  currentLang = lang;
  // Update all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  // Update all elements with data-i18n-placeholder attribute
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });
  // Update lang toggle button
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.textContent = currentLang === 'zh' ? 'EN' : '中文';
  }
}

function getLanguage() {
  return currentLang;
}

export { t, setLanguage, getLanguage };
