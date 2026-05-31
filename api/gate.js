// Password gate for the combined prep doc + co-pilot.
//
//   GET                      -> { ok, configured, authed }
//                               (the shell uses this to decide login vs. app,
//                                and to stay logged-in across refreshes)
//   POST { password }        -> sets the auth cookie if correct; { ok }
//   DELETE                   -> clears the cookie (log out)
//
// The password is checked against the COPILOT_PASS Vercel env var (see
// lib/auth). No password env -> login always fails (fail closed).

const auth = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      res.status(200).json({ ok: true, configured: auth.configured(), authed: auth.isAuthed(req) });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      if (!auth.configured()) { res.status(200).json({ ok: false, error: 'not_configured' }); return; }
      if (auth.passwordOk(body && body.password)) {
        auth.setAuthCookie(res);
        res.status(200).json({ ok: true });
      } else {
        res.status(200).json({ ok: false, error: 'bad_password' });
      }
      return;
    }

    if (req.method === 'DELETE') {
      auth.clearAuthCookie(res);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'method' });
  } catch (e) {
    res.status(200).json({ ok: false, error: 'exception' });
  }
};
