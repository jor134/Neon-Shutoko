/* api/room.js — NEON SHUTOKO multiplayer relay.
 *
 * This exists for one reason: the Upstash token must never reach the
 * browser. Everything else about the game runs client-side.
 *
 * Required environment variables on the Vercel project:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * CommonJS on purpose. Vercel's Node runtime treats a bare .js file as
 * CommonJS unless package.json declares "type": "module", and mixing the
 * two is the classic way to get a 500 that only shows up in production.
 */

const TTL = 900;            // rooms evaporate 15 minutes after last write
const STALE_MS = 90000;     // players unheard from for 90s drop off the list
const MAX_PLAYERS = 8;

function env() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

async function pipeline(cfg, cmds) {
  const r = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + cfg.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('upstash ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  return out.map(x => (x && x.error ? null : x && x.result));
}

function keyP(code) { return 'sh:' + code + ':p'; }
function keyM(code) { return 'sh:' + code + ':m'; }

function parseHash(flat) {
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) { /* skip corrupt */ }
  }
  return out;
}

function clean(players, now) {
  const out = {};
  for (const id of Object.keys(players)) {
    const p = players[id];
    if (!p || typeof p !== 'object') continue;
    if (now - (p.t || 0) > STALE_MS) continue;
    out[id] = p;
  }
  return out;
}

function sanitize(body, now) {
  const num = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    id: String(body.id || '').slice(0, 24),
    name: String(body.name || 'RACER').replace(/[^\w \-]/g, '').slice(0, 10) || 'RACER',
    color: num(body.color, 0, 0xffffff, 0x22e7ff) | 0,
    d: num(body.d, -1e3, 1e7, 0),
    x: num(body.x, -60, 60, 0),
    v: num(body.v, 0, 200, 0),
    hp: num(body.hp, 0, 9, 3) | 0,
    sc: num(body.sc, 0, 1e9, 0) | 0,
    cb: num(body.cb, 0, 999, 0) | 0,
    alive: body.alive ? 1 : 0,
    done: body.done ? 1 : 0,
    t: now
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const cfg = env();
  if (!cfg) {
    res.status(501).json({
      error: 'relay-unconfigured',
      hint: 'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on this Vercel project.'
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const code = String(body.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { res.status(400).json({ error: 'bad-code' }); return; }

  const now = Date.now();
  const kp = keyP(code), km = keyM(code);
  const action = String(body.action || 'state');

  try {
    if (action === 'start') {
      const at = Number(body.startAt);
      if (!Number.isFinite(at)) { res.status(400).json({ error: 'bad-start' }); return; }
      const meta = { startAt: Math.min(now + 60000, Math.max(now, at)), by: String(body.id || '') };
      const r = await pipeline(cfg, [
        ['SET', km, JSON.stringify(meta), 'EX', String(TTL)],
        ['EXPIRE', kp, String(TTL)],
        ['HGETALL', kp]
      ]);
      res.status(200).json({ now: Date.now(), startAt: meta.startAt, players: clean(parseHash(r[2]), now) });
      return;
    }

    if (action === 'leave') {
      await pipeline(cfg, [['HDEL', kp, String(body.id || '')]]);
      res.status(200).json({ now: Date.now(), ok: true });
      return;
    }

    /* join / state / lobby all write this player then read the room back */
    const me = sanitize(body, now);
    if (!me.id) { res.status(400).json({ error: 'bad-id' }); return; }

    if (action === 'join') {
      const pre = await pipeline(cfg, [['HGETALL', kp]]);
      const cur = clean(parseHash(pre[0]), now);
      if (!cur[me.id] && Object.keys(cur).length >= MAX_PLAYERS) {
        res.status(409).json({ error: 'room-full', max: MAX_PLAYERS });
        return;
      }
    }

    const r = await pipeline(cfg, [
      ['HSET', kp, me.id, JSON.stringify(me)],
      ['EXPIRE', kp, String(TTL)],
      ['HGETALL', kp],
      ['GET', km]
    ]);

    const players = clean(parseHash(r[2]), now);
    let meta = {};
    try { meta = r[3] ? JSON.parse(r[3]) : {}; } catch (e) { meta = {}; }

    /* the first id in the room owns the start button */
    const ids = Object.keys(players).sort();
    const host = ids.length ? ids[0] === me.id : true;

    res.status(200).json({
      now: Date.now(),
      players,
      startAt: meta.startAt || 0,
      host,
      count: ids.length
    });
  } catch (e) {
    res.status(502).json({ error: 'relay-failed', detail: String(e.message || e).slice(0, 200) });
  }
};
