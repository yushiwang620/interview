// Vercel Serverless Function — live audio -> verbatim transcript (+ a gloss).
// POST { audio: <base64>, mime: "audio/webm" | "audio/mp4" | ... }
//   -> { en, zh }
//
// NOTE: the field names {en, zh} are HISTORICAL — they're just the two display
// slots in copilot.html (primary line + small secondary line). What they carry
// now is language-agnostic:
//   en = PRIMARY line: the transcript EXACTLY as spoken — pure Chinese,
//        English, or code-switched 中/英. We call /audio/transcriptions (NOT
//        /translations), which keeps the original language and auto-detects it,
//        so the interviewer's real words show up. (We no longer force English.)
//   zh = SECONDARY line: a translation of that text into the OTHER language
//        (English when the transcript is Chinese/mixed; Simplified Chinese when
//        it's English-only) — a quick reading aid; may be "".
//
// The OpenAI key lives ONLY here, as a Vercel Environment Variable
// (Project -> Settings -> Environment Variables -> OPENAI_API_KEY).
// Transcription model = OPENAI_TRANSCRIBE_MODEL (default "whisper-1");
// the gloss uses OPENAI_TRANSLATE_MODEL (default "gpt-4o-mini").
//
// We accept the audio as base64 INSIDE a JSON body (not multipart) so the
// Vercel Node body parser handles it cleanly, then rebuild multipart with the
// global FormData/Blob to call OpenAI's audio API. (A ~6s clip is ~30-130 KB
// base64 — far under Vercel's request-body cap — so no body-size config.)

const auth = require('../lib/auth');

const EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/oga': 'oga',
  'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav'
};

// A short domain hint helps Whisper with proper nouns and 中/英 code-switching
// (it keeps English product/tech terms intact inside Chinese speech, and vice
// versa). It biases recognition only — it is not added to the output.
const PROMPT = 'Job interview about architecture, UX design, software and BIM/Revit. ' +
  '面试对话，内容涉及建筑、用户体验设计、软件开发与 BIM/Revit，中英文混合。';

function hasCJK(s) {
  s = s || '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x3400 && c <= 0x9fff) return true; // CJK Ext-A + Unified Ideographs
  }
  return false;
}

// Whisper "fills" near-silent / low-content audio with stock outro lines.
// This only matters for Latin-only text; ANY CJK content is treated as real
// speech so short Chinese questions are never dropped as "noise".
function isNoise(t) {
  const raw = (t || '').trim();
  if (!raw) return true;
  if (hasCJK(raw)) return false;
  const s = raw.toLowerCase().replace(/[.!?。！？\s]/g, '');
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
    fd.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
    fd.append('response_format', 'json');
    fd.append('prompt', PROMPT);
    // No `language` is set ON PURPOSE: auto-detect handles BOTH pure-Chinese and
    // code-switched 中/英 speech. (Forcing language=zh would garble English
    // stretches; forcing en is exactly the old English-only behavior.)

    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key },
      body: fd
    });
    const tj = await tr.json();
    const text = ((tj && tj.text) || '').trim();

    if (!text || isNoise(text)) { res.status(200).json({ en: '', zh: '' }); return; }

    // Secondary line: render the SAME utterance in the OTHER language as a quick
    // reading aid. Chinese/mixed -> English; English-only -> Simplified Chinese.
    const target = hasCJK(text) ? 'English' : 'Simplified Chinese';
    let gloss = '';
    try {
      const cr = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          // Fast/cheap model for the live caption gloss. Override with
          // OPENAI_TRANSLATE_MODEL (the answer engine uses OPENAI_MODEL).
          model: process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Translate the user text to natural, concise ' + target + '. Keep technical terms and product names (e.g. Revit, BIM, Figma, Unity) as-is. Output ONLY the translation, no quotes, no notes.' },
            { role: 'user', content: text }
          ]
        })
      });
      const cj = await cr.json();
      gloss = ((cj.choices && cj.choices[0] && cj.choices[0].message && cj.choices[0].message.content) || '').trim();
    } catch (e) { gloss = ''; }

    // en = verbatim transcript (primary, top); zh = other-language gloss (below).
    res.status(200).json({ en: text, zh: gloss });
  } catch (e) {
    res.status(200).json({ en: '', zh: '', error: 'exception' });
  }
};
