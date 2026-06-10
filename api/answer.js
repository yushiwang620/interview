// Vercel Serverless Function — interview co-pilot answer engine.
// POST { question } -> { en, zh }  (bilingual spoken interview answer)
// The OpenAI key lives ONLY here, as a Vercel Environment Variable
// (Project -> Settings -> Environment Variables -> OPENAI_API_KEY).
// Same-origin with the site (/api/answer) so no CORS is needed.
// Knowledge, persona and truthfulness guardrails come from lib/profile.js
// (server-side only — never shipped to the browser, no sensitive data).

const profile = require('../lib/profile');
const auth = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ en: '', zh: '' });
    return;
  }
  // Once COPILOT_PASS is set in Vercel, only logged-in clients may spend the
  // OpenAI key. Fails OPEN when unconfigured so first-time setup still works.
  if (auth.configured() && !auth.isAuthed(req)) {
    res.status(401).json({ en: '', zh: '', error: 'locked' });
    return;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    res.status(200).json({ en: '', zh: '', error: 'no_key' });
    return;
  }
  try {
    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
    }
    const question = (body.question || body.q || '').toString().trim();
    if (!question) {
      res.status(200).json({ en: '', zh: '' });
      return;
    }
    // Model is set via the OPENAI_MODEL env var in Vercel. Falls back to gpt-4o-mini
    // because the system prompt now carries the full prep doc (~80K tokens) and gpt-4o's
    // tier-1 TPM limit (30K) is too low — gpt-4o-mini's TPM (~200K) fits the big prompt.
    const model = body.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const messages = [
      { role: 'system', content: profile.systemPrompt() },
      { role: 'user', content: 'Interview question just asked:\n"' + question + '"\n\nDraft my spoken answer now as the JSON object {"en":"...","zh":"..."} exactly per the OUTPUT FORMAT — English to read aloud in "en", a paragraph-for-paragraph Chinese translation in "zh" (same number of paragraphs, same order).' }
    ];

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.5,
        response_format: { type: 'json_object' }
      })
    });
    const j = await r.json();
    // Surface the real OpenAI error (e.g. wrong model name or unsupported
    // param) so a dry run shows WHY instead of failing silently.
    if (j && j.error) {
      res.status(200).json({ en: '', zh: '', error: (j.error.message || 'api_error') });
      return;
    }
    const raw =
      (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';

    let en = '', zh = '';
    try {
      const parsed = JSON.parse(raw);
      en = (parsed.en || parsed.EN || '').toString().trim();
      zh = (parsed.zh || parsed.ZH || parsed.cn || '').toString().trim();
    } catch (e) {
      // Model didn't return clean JSON — English is the primary field now, so
      // fall back to using the raw text as EN (the line the UI reads aloud).
      en = raw.trim();
    }
    res.status(200).json({ en: en, zh: zh });
  } catch (e) {
    res.status(200).json({ en: '', zh: '', error: 'exception' });
  }
};
