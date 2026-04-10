// Gemini 2.5 Flash API integration for comment generation (free tier)
// Free tier rate limit: 5 RPM (requests per minute), 250K TPM

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Rate limiter: track request timestamps to stay within 5 RPM
const requestTimestamps = [];
const MAX_RPM = 5;
const WINDOW_MS = 60 * 1000; // 1 minute
let onRateLimitWait = null; // callback for UI notification

function setRateLimitCallback(cb) {
  onRateLimitWait = cb;
}

async function waitForRateLimit() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= MAX_RPM) {
    const waitMs = WINDOW_MS - (now - requestTimestamps[0]) + 500;
    if (waitMs > 0) {
      if (onRateLimitWait) onRateLimitWait(Math.ceil(waitMs / 1000));
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    const afterWait = Date.now();
    while (requestTimestamps.length > 0 && afterWait - requestTimestamps[0] > WINDOW_MS) {
      requestTimestamps.shift();
    }
  }
  requestTimestamps.push(Date.now());
}

async function callGemini(apiKey, prompt, maxTokens = 500) {
  // Wait for rate limit before making request
  await waitForRateLimit();

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.8
      }
    })
  });

  // Handle 429 (rate limited) with retry
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after')) || 15;
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return callGemini(apiKey, prompt, maxTokens);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Default comment prompt template
const DEFAULT_PROMPT_TEMPLATE = `You are writing a genuine, thoughtful blog comment on the following article.

Rules:
- Be relevant to the article content
- Sound natural and human-written
- Be {commentLength} sentences long
- Add value to the discussion (share a personal insight, ask a question, or agree with a specific point)
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
    myWebsiteUrl = ''
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
    const anchor = linkAnchor || myWebsiteName || linkUrl;
    const linkFormat = commentConfig.linkFormat || 'html';
    const linkExample = formatLink(linkUrl, anchor, linkFormat);
    embedLinkInstruction = `- Naturally embed this link in your comment where relevant: ${linkExample}
- The link must feel natural in context, NOT forced or promotional
- Use EXACTLY this link format, do not change it`;
  }

  // Build custom instructions
  const customPart = customInstructions ? `- Additional instructions: ${customInstructions}` : '';

  // Use custom template or default
  const template = promptTemplate || DEFAULT_PROMPT_TEMPLATE;

  const prompt = template
    .replace('{title}', title)
    .replace('{content}', content?.substring(0, 1500) || 'Not available')
    .replace('{language}', getLanguageName(language))
    .replace('{commentLength}', commentLength)
    .replace('{embedLinkInstruction}', embedLinkInstruction)
    .replace('{customInstructions}', customPart)
    .replace('{url}', url)
    .replace('{myWebsiteName}', myWebsiteName)
    .replace('{myWebsiteUrl}', myWebsiteUrl);

  return callGemini(apiKey, prompt, 500);
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

export { callGemini, generateComment, analyzePageForComments, setRateLimitCallback, formatLink };
