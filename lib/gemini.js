// Gemini API integration - supports Google and KIE providers

const PROVIDERS = {
  google: {
    name: 'Google',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    authType: 'query', // ?key=
    rpmLimit: 5
  },
  kie: {
    name: 'KIE',
    url: 'https://api.kie.ai/gemini-2.5-flash/v1/chat/completions',
    authType: 'bearer', // Authorization: Bearer
    rpmLimit: 120 // KIE has higher limits
  }
};

let currentProvider = 'google';

function setProvider(provider) {
  currentProvider = provider;
  // Reset rate limiter when switching
  requestTimestamps.length = 0;
}

function getProvider() {
  return currentProvider;
}

// Rate limiter
const requestTimestamps = [];
let onRateLimitWait = null;

function setRateLimitCallback(cb) {
  onRateLimitWait = cb;
}

async function waitForRateLimit() {
  const rpmLimit = PROVIDERS[currentProvider]?.rpmLimit || 5;
  const windowMs = 60 * 1000;
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > windowMs) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= rpmLimit) {
    const waitMs = windowMs - (now - requestTimestamps[0]) + 500;
    if (waitMs > 0) {
      if (onRateLimitWait) onRateLimitWait(Math.ceil(waitMs / 1000));
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    const afterWait = Date.now();
    while (requestTimestamps.length > 0 && afterWait - requestTimestamps[0] > windowMs) {
      requestTimestamps.shift();
    }
  }
  requestTimestamps.push(Date.now());
}

async function callGemini(apiKey, prompt, maxTokens = 500, _retryCount = 0) {
  await waitForRateLimit();

  const provider = PROVIDERS[currentProvider] || PROVIDERS.google;
  let response;

  if (provider.authType === 'bearer') {
    // KIE: OpenAI-compatible format
    response = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        stream: false,
        include_thoughts: false,
        reasoning_effort: 'low'
      })
    });
  } else {
    // Google: native format
    response = await fetch(`${provider.url}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.8 }
      })
    });
  }

  // Retry on 429 / 503
  if (response.status === 429 || response.status === 503) {
    if (_retryCount >= 3) {
      throw new Error(`API error: ${response.status} - max retries reached`);
    }
    const baseDelay = response.status === 429
      ? (parseInt(response.headers.get('retry-after')) || 15)
      : 10;
    const delay = baseDelay * Math.pow(2, _retryCount);
    if (onRateLimitWait) onRateLimitWait(delay);
    await new Promise(resolve => setTimeout(resolve, delay * 1000));
    return callGemini(apiKey, prompt, maxTokens, _retryCount + 1);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const data = await response.json();

  // Parse response based on provider format
  if (provider.authType === 'bearer') {
    return data.choices?.[0]?.message?.content || '';
  } else {
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
}

// Default comment prompt template
const DEFAULT_PROMPT_TEMPLATE = `You are writing a genuine, thoughtful blog comment on the following article.
You are a real person who runs a website: {myWebsiteName} ({myWebsiteUrl}).
{siteContext}

Rules:
- Be relevant to the article content
- Sound natural and human-written, like a real reader leaving a comment
- Be {commentLength} sentences long
- Add value to the discussion (share a personal insight, ask a question, or agree with a specific point)
- If your website is related to the article topic, you may briefly mention your experience with it, but keep it natural
- NOT be generic or spammy
- NOT mention SEO, backlinks, or link building
- Write in the SAME language as the article ({language})
{embedLinkInstruction}
{customInstructions}

Article title: {title}
Article content (excerpt):
{content}

Write ONLY the comment text, nothing else.`;

// Generate a natural blog comment based on article content
// commentConfig: { promptTemplate, commentLength, embedLink, linkUrl, linkAnchor, customInstructions }
async function generateComment(apiKey, articleInfo, commentConfig = {}) {
  const {
    title = '',
    content = '',
    url = '',
    language = 'en',
    myWebsiteName = '',
    myWebsiteUrl = '',
    siteDescription = ''
  } = articleInfo;

  const {
    promptTemplate = '',
    commentLength = '2-4',
    embedLink = false,
    linkUrl = '',
    linkAnchor = '',
    customInstructions = ''
  } = commentConfig;

  // Build embed link instruction based on format
  let embedLinkInstruction = '';
  if (embedLink && linkUrl) {
    const linkFormat = commentConfig.linkFormat || 'html';
    if (linkAnchor) {
      // User specified anchor text
      const linkExample = formatLink(linkUrl, linkAnchor, linkFormat);
      embedLinkInstruction = `- Naturally embed this link in your comment where relevant: ${linkExample}
- The link must feel natural in context, NOT forced or promotional
- Use EXACTLY this link format, do not change it`;
    } else {
      // Auto-generate anchor text based on article context
      embedLinkInstruction = `- Naturally embed a link to ${linkUrl} in your comment
- Generate a short, contextually relevant anchor text for the link (2-5 words, related to the article topic)
- Use this link format: ${getLinkFormatExample(linkFormat)}
- The link must feel natural in context, NOT forced or promotional`;
    }
  }

  // Build custom instructions
  const customPart = customInstructions ? `- Additional instructions: ${customInstructions}` : '';

  // Build site context from description
  const siteContext = siteDescription
    ? `Your website description: ${siteDescription}\nUse this context to write a comment that naturally connects the article topic to your website's domain, and to generate relevant anchor text for any embedded links.`
    : '';

  // Use custom template or default
  const template = promptTemplate || DEFAULT_PROMPT_TEMPLATE;

  const prompt = template
    .replace('{title}', title)
    .replace('{content}', content?.substring(0, 1500) || 'Not available')
    .replace('{language}', getLanguageName(language))
    .replace('{commentLength}', commentLength)
    .replace('{embedLinkInstruction}', embedLinkInstruction)
    .replace('{customInstructions}', customPart)
    .replace('{siteContext}', siteContext)
    .replace('{url}', url)
    .replace('{myWebsiteName}', myWebsiteName)
    .replace('{myWebsiteUrl}', myWebsiteUrl)
    .replace('{siteDescription}', siteDescription);

  return callGemini(apiKey, prompt, 500);
}

// Get a format description for AI prompt (when anchor is auto-generated)
function getLinkFormatExample(format) {
  switch (format) {
    case 'html': return '<a href="URL">anchor text</a>';
    case 'markdown': return '[anchor text](URL)';
    case 'bbcode': return '[url=URL]anchor text[/url]';
    case 'plain': return 'just the plain URL';
    default: return '<a href="URL">anchor text</a>';
  }
}

// Format a link based on the selected format type
function formatLink(url, anchor, format) {
  switch (format) {
    case 'html':
      return `<a href="${url}">${anchor}</a>`;
    case 'markdown':
      return `[${anchor}](${url})`;
    case 'bbcode':
      return `[url=${url}]${anchor}[/url]`;
    case 'plain':
      return url;
    default:
      return `<a href="${url}">${anchor}</a>`;
  }
}

// Map language code to readable name
function getLanguageName(code) {
  const names = {
    en: 'English', zh: 'Chinese', es: 'Spanish', fr: 'French',
    de: 'German', ja: 'Japanese', ko: 'Korean', pt: 'Portuguese',
    ru: 'Russian', it: 'Italian', nl: 'Dutch', pl: 'Polish',
    sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish',
    tr: 'Turkish', ar: 'Arabic', th: 'Thai', vi: 'Vietnamese',
    id: 'Indonesian', ms: 'Malay', hi: 'Hindi'
  };
  return names[code] || code;
}

// Analyze a page to determine if it has a comment form and identify form fields
async function analyzePageForComments(apiKey, pageHtml, pageUrl) {
  const prompt = `Analyze this HTML page and determine:
1. Does it have a comment form that doesn't require login/registration?
2. If yes, identify the form fields (name, email, website/url, comment/message textarea)
3. What are the CSS selectors or name attributes for each field?

Page URL: ${pageUrl}
HTML (excerpt): ${pageHtml.substring(0, 3000)}

Respond in this exact JSON format:
{
  "hasCommentForm": true/false,
  "requiresLogin": true/false,
  "fields": {
    "name": {"selector": "CSS selector or null", "name": "name attribute or null"},
    "email": {"selector": "CSS selector or null", "name": "name attribute or null"},
    "website": {"selector": "CSS selector or null", "name": "name attribute or null"},
    "comment": {"selector": "CSS selector or null", "name": "name attribute or null"}
  },
  "submitButton": {"selector": "CSS selector or null"},
  "notes": "any relevant notes"
}

Respond with ONLY the JSON, no other text.`;

  const result = await callGemini(apiKey, prompt, 500);

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('Failed to parse Gemini response:', e);
  }

  return { hasCommentForm: false, requiresLogin: true, fields: {}, notes: 'Failed to analyze' };
}

export { callGemini, generateComment, analyzePageForComments, setRateLimitCallback, formatLink, setProvider, getProvider, PROVIDERS };
