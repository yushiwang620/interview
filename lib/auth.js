// Shared password-gate helpers for the interview co-pilot + prep doc.
//
// The gate password lives ONLY as a Vercel Environment Variable, COPILOT_PASS
// (Project -> Settings -> Environment Variables). It is NEVER stored in this
// repo. A correct password makes /api/gate set an HttpOnly cookie whose value
// is a one-way hash derived from the password, so every later request can be
// re-verified statelessly — and the login survives refreshes / restarts.
//
// This file is safe to be public: it contains the ALGORITHM, never the secret.
// Without the COPILOT_PASS env value, the cookie token cannot be forged.

const crypto = require('crypto');

const COOKIE = 'cp_auth';
const VERSION = 'v1';

function pass() { return process.env.COPILOT_PASS || ''; }
function configured() { return !!pass(); }

// Deterministic, non-reversible token derived from the secret password.
function expectedToken() {
  return crypto.createHash('sha256').update(VERSION + ':' + pass()).digest('hex');
}

function parseCookies(req) {
  const out = {};
  const raw = (req && req.headers && req.headers.cookie) || '';
  raw.split(';').forEach(function (p) {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

// Is this request carrying a valid auth cookie?
function isAuthed(req) {
  if (!configured()) return false;
  const tok = parseCookies(req)[COOKIE];
  if (!tok) return false;
  return safeEqual(tok, expectedToken());
}

// Does a submitted password match COPILOT_PASS?
function passwordOk(submitted) {
  if (!configured()) return false;
  return safeEqual(String(submitted == null ? '' : submitted), pass());
}

// Persist for 1 year: HttpOnly + Secure + SameSite=Lax so it rides along with
// same-site iframe loads and fetches, and never has to be re-entered on refresh.
function setAuthCookie(res) {
  const maxAge = 60 * 60 * 24 * 365;
  res.setHeader('Set-Cookie',
    COOKIE + '=' + expectedToken() +
    '; Path=/; Max-Age=' + maxAge + '; HttpOnly; Secure; SameSite=Lax');
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie',
    COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
}

module.exports = { configured, isAuthed, passwordOk, setAuthCookie, clearAuthCookie };
