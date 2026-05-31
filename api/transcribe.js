// Vercel Serverless Function — live audio -> English text (+ Chinese).
// POST { audio: <base64>, mime: "audio/webm" | "audio/mp4" | ... }
//   -> { en, zh }
// The OpenAI key lives ONLY here, as a Vercel Environment Variable
// (Project -> Settings -> Environment Variables -> OPENAI_API_KEY).
//
// We accept the audio as base64 INSIDE a JSON body (not multipart) so the
// Vercel Node body parser handles it cleanly, then rebuild multipart with
// the global FormData/Blob to call OpenAI's audio API. We use the
// /audio/translations endpoint so the top caption is ALWAYS English even if
// some Chinese is spoken; then gpt-4o-mini renders a natural Chinese line.
// (A ~6s clip is ~30-130 KB base64 — far under Vercel's request-body cap —
// so no body-size config is needed.)

const auth = require('../lib/auth');

const EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/oga': 'oga',
  'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav'
};

// Whisper tends to emit these for silence / non-speech — treat as empty.
function isNoise(t) {
  const s = (t || '').trim().toLowerCase().replace(/[.!?。！？\s]/g, '');
  if (!s) return true;
  if (s.length <= 2) return true;
  const junk = ['you', 'thankyou', 'thanksforwatching', 'bye', 'uh', 'um', 'mm', '...', 'thanks'];
  return junk.indexOf(s) >= 0;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ en: '', zh: '' });
    return;
  }
  // Same password gate as /api/answer (fails OPEN until COPILOT_PASS is set).
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
    const b64 = (body.audio || '').toString();
    const mime = (body.mime || 'audio/webm').toString().split(';')[0].trim();
    if (!b64) { res.status(200).json({ en: '', zh: '' }); return; }

    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1200) { res.status(200).json({ en: '', zh: '' }); return; } // basically silence

    const ext = EXT[mime] || 'webm';
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), 'clip.' + ext);
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'json');

    const tr = await fetch('https://api.openai.com/v1/audio/translations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key },
      body: fd
    });
    const tj = await tr.json();
    const en = ((tj && tj.text) || '').trim();

    if (!en || isNoise(en)) { res.status(200).json({ en: '', zh: '' }); return; }

    // Natural Chinese rendering of the same line.
    let zh = '';
    try {
      const cr = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          // Fast/cheap model for live caption translation. Override with the
          // OPENAI_TRANSLATE_MODEL env var if you want (defaults to a mini model
          // to keep captions snappy; the answer engine uses OPENAI_MODEL).
          model: process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Translate the user text to natural, concise Simplified Chinese. Output ONLY the translation, no quotes, no notes.' },
            { role: 'user', content: en }
          ]
        })
      });
      const cj = await cr.json();
      zh = ((cj.choices && cj.choices[0] && cj.choices[0].message && cj.choices[0].message.content) || '').trim();
    } catch (e) { zh = ''; }

    res.status(200).json({ en: en, zh: zh });
  } catch (e) {
    res.status(200).json({ en: '', zh: '', error: 'exception' });
  }
};
