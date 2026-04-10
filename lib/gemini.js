// Gemini 2.0 Flash API integration for comment generation

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function callGemini(apiKey, prompt, maxTokens = 500) {
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

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Generate a natural blog comment based on article content
async function generateComment(apiKey, articleInfo) {
  const { title, content, url, myWebsiteName, myWebsiteUrl } = articleInfo;

  const prompt = `You are writing a genuine, thoughtful blog comment on the following article.
The comment should:
- Be relevant to the article content
- Sound natural and human-written
- Be 2-4 sentences long
- Add value to the discussion (share a personal insight, ask a question, or agree with a specific point)
- NOT be generic or spammy
- NOT mention SEO, backlinks, or link building
- Be in English

Article title: ${title}
Article content (excerpt): ${content?.substring(0, 1000) || 'Not available'}
Article URL: ${url}

Write ONLY the comment text, nothing else.`;

  return callGemini(apiKey, prompt, 300);
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
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('Failed to parse Gemini response:', e);
  }

  return { hasCommentForm: false, requiresLogin: true, fields: {}, notes: 'Failed to analyze' };
}

export { callGemini, generateComment, analyzePageForComments };
