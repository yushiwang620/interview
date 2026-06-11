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
    // Model is set via the OPENAI_MODEL env var in Vercel (env WINS over this default).
    // The prompt is now lean (~few-K tokens), so TPM is no longer a constraint — any
    // model fits. Default gpt-4.1-mini (fast). To try a "5" model set OPENAI_MODEL=gpt-5
    // (or gpt-5-mini for speed); gpt-4o / gpt-4.1 also work now.
    const model = body.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    // GPT-5 and o-series are REASONING models: they reject a custom temperature and
    // take a reasoning_effort instead, so detect them or a "5" model 400s.
    const isReasoning = /^(gpt-5|o\d)/i.test(model);

    const messages = [
      { role: 'system', content: profile.systemPrompt() },
      { role: 'user', content: 'Interview question just asked:\n"' + question + '"\n\nDraft my spoken answer now as the JSON object {"zh":"...","en":"..."} exactly per the OUTPUT FORMAT — the PRIMARY spoken answer in natural Mandarin in "zh" (this is what I read aloud), and a faithful, paragraph-for-paragraph English translation in "en" (same number of paragraphs, same order).' }
    ];

    const payload = {
      model: model,
      messages: messages,
      response_format: { type: 'json_object' }
    };
    if (isReasoning) {
      // keep latency sane; override via OPENAI_REASONING_EFFORT (minimal|low|medium|high)
      payload.reasoning_effort = process.env.OPENAI_REASONING_EFFORT || 'low';
    } else {
      payload.temperature = 0.5;
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(payload)
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
