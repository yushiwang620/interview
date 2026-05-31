// Vercel Serverless Function — tiny cross-device relay for the co-pilot.
// Lets the "host" browser (your computer, doing mic + answers) push answered
// Q&A into a shared room, and a "mirror" browser (your iPad) poll and display
// them live. Carries ONLY interview Q&A — no audio, no secrets.
//
//   POST { room, item }            -> append item, returns { ok, cursor }
//   GET  ?room=NAME&since=N        -> { ok, items:[...], cursor }
//
// Backing store = Upstash Redis via its REST API. In Vercel:
//   Storage -> Create Database -> Upstash (Redis) -> connect to this project.
// That injects KV_REST_API_URL / KV_REST_API_TOKEN (or the UPSTASH_* names).
// If neither is set, this returns { ok:false, error:'no_store' } and the
// co-pilot still works fully on a single device (no cross-device mirror).

const STORE_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const STORE_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const TTL = 21600; // rooms auto-expire after 6 hours

function keyFor(room) {
  // sanitize room name -> safe redis key
  const r = (room || '').toString().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'default';
  return 'cp:' + r;
}

// Run a pipeline of redis commands via Upstash REST. Returns array of results.
async function pipe(commands) {
  const r = await fetch(STORE_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + STORE_TOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  return r.json(); // [{result:...}|{error:...}, ...]
}

module.exports = async (req, res) => {
  if (!STORE_URL || !STORE_TOK) {
    res.status(200).json({ ok: false, error: 'no_store' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const room = (req.query && (req.query.room || req.query.r)) || '';
      const since = parseInt((req.query && req.query.since) || '0', 10) || 0;
      const key = keyFor(room);
      const out = await pipe([['LRANGE', key, String(since), '-1']]);
      const rawList = (out && out[0] && out[0].result) || [];
      const items = [];
      for (let i = 0; i < rawList.length; i++) {
        try { items.push(JSON.parse(rawList[i])); } catch (e) {}
      }
      res.status(200).json({ ok: true, items: items, cursor: since + rawList.length });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const room = body.room || '';
      const item = body.item;
      if (!item) { res.status(200).json({ ok: false, error: 'no_item' }); return; }
      const key = keyFor(room);
      const val = JSON.stringify(item).slice(0, 8000); // safety cap
      const out = await pipe([
        ['RPUSH', key, val],
        ['LTRIM', key, '-200', '-1'], // keep the room bounded
        ['EXPIRE', key, String(TTL)]
      ]);
      const len = (out && out[0] && out[0].result) || 0;
      res.status(200).json({ ok: true, cursor: len });
      return;
    }

    res.status(405).json({ ok: false, error: 'method' });
  } catch (e) {
    res.status(200).json({ ok: false, error: 'exception' });
  }
};
