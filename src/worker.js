// AHKE Stock — Cloudflare Worker.
//
// Serves the app from ./public and an append-only event log from D1, all
// behind one password. Only the login page and the files needed to install
// the app (manifest, icons, service worker) are reachable without a session;
// none of them contain stock data.
//
// Secrets (set with `wrangler secret put`, or .dev.vars locally):
//   APP_PASSWORD    the password
//   SESSION_SECRET  random string used to sign session cookies; changing it
//                   signs every device out

const COOKIE = 'ahke_session';
const SESSION_DAYS = 180;
const MAX_FAILS = 10;                 // failed logins per IP ...
const FAIL_WINDOW_MS = 15 * 60e3;     // ... per 15 minutes
const MAX_BODY = 1_000_000;
const MAX_EVENT = 32_000;
const PAGE = 1000;

const PUBLIC = new Set(['/login', '/login.html', '/manifest.webmanifest', '/sw.js',
  '/icon.svg', '/icon-192.png', '/icon-512.png', '/favicon.ico']);

const EVENT_TYPES = new Set(['COUNT', 'RECEIPT', 'RECEIPT_VOID', 'ORDER_CREATED', 'ORDER_CONFIRMED',
  'ORDER_CANCELLED', 'ORDER_DELETED', 'ITEM_ADDED', 'ITEM_UPDATED']);

export default {
  async fetch(request, env) {
    try {
      return secure(await route(request, env));
    } catch (err) {
      console.error(err);
      return secure(json({ error: 'server error' }, 500));
    }
  }
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: 'server not configured: APP_PASSWORD and SESSION_SECRET must be set' }, 500);
  }

  if (path === '/api/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }
  if (PUBLIC.has(path)) return env.ASSETS.fetch(request);

  // Everything below needs a valid session.
  if (!(await validSession(request, env))) {
    if (path.startsWith('/api/')) return json({ error: 'unauthorised' }, 401);
    return new Response(null, { status: 302, headers: { Location: '/login' } });
  }

  if (path === '/api/sync' && request.method === 'POST') return sync(request, env);
  if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);

  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'private, no-cache');   // never cache gated pages in shared caches
  return out;
}

/* ------------------------------ login ------------------------------ */

async function login(request, env) {
  if (!sameOrigin(request)) return json({ error: 'bad origin' }, 403);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();

  await env.DB.prepare('DELETE FROM login_attempts WHERE ts < ?').bind(now - 24 * 3600e3).run();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts > ?')
    .bind(ip, now - FAIL_WINDOW_MS).first();
  if (n >= MAX_FAILS) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);

  let password = '';
  try { password = String((await request.json()).password || ''); } catch { /* empty body */ }

  if (!(await equalSecret(password, env.APP_PASSWORD))) {
    await env.DB.prepare('INSERT INTO login_attempts (ip, ts) VALUES (?, ?)').bind(ip, now).run();
    return json({ error: 'Wrong password.' }, 401);
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  const token = `${exp}.${await sign(env.SESSION_SECRET, `v1.${exp}`)}`;
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`
  });
}

async function validSession(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [expStr, sig] = m[1].split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000 || !sig) return false;
  return equalBytes(new TextEncoder().encode(sig),
                    new TextEncoder().encode(await sign(env.SESSION_SECRET, `v1.${exp}`)));
}

async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compare digests, so timing reveals nothing about length or content.
async function equalSecret(a, b) {
  const [da, db] = await Promise.all([a, b].map(s =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  return equalBytes(new Uint8Array(da), new Uint8Array(db));
}
function equalBytes(a, b) {
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/* ------------------------------- sync ------------------------------- */
// Client sends events the server may not have plus the last server cursor it
// saw; server stores new ones (idempotent by id) and returns everything after
// the cursor. Events are immutable, so merging is a set union.

async function sync(request, env) {
  if (!sameOrigin(request)) return json({ error: 'bad origin' }, 403);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({ error: 'request too large' }, 413);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const since = Number.isInteger(body.since) && body.since >= 0 ? body.since : 0;
  const incoming = Array.isArray(body.events) ? body.events : [];
  if (incoming.length > 500) return json({ error: 'too many events in one request' }, 413);

  const now = new Date().toISOString();
  const stmts = [];
  for (const ev of incoming) {
    const problem = checkEvent(ev);
    if (problem) return json({ error: `rejected event ${String(ev && ev.id).slice(0, 80)}: ${problem}` }, 400);
    stmts.push(env.DB.prepare(
      'INSERT OR IGNORE INTO events (id, type, occurred_at, body, received_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(ev.id, ev.type, ev.occurred_at, JSON.stringify(ev), now));
  }
  if (stmts.length) await env.DB.batch(stmts);   // one atomic batch

  // A cursor beyond anything stored means the server lost data (wiped or restored from an
  // older backup). Tell the device to start over and re-send its whole history.
  const [{ top }, meta] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM events').first(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'epoch'").first()
  ]);
  const epoch = meta ? meta.value : '';
  if (since > top || (body.epoch && epoch && body.epoch !== epoch)) {
    return json({ events: [], cursor: 0, more: false, reset: true, epoch });
  }

  const { results } = await env.DB.prepare(
    'SELECT seq, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?'
  ).bind(since, PAGE).all();
  return json({
    events: results.map(r => JSON.parse(r.body)),
    cursor: results.length ? results[results.length - 1].seq : since,
    more: results.length === PAGE,
    epoch
  });
}

function checkEvent(ev) {
  if (!ev || typeof ev !== 'object') return 'not an object';
  if (typeof ev.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(ev.id)) return 'bad id';
  if (!EVENT_TYPES.has(ev.type)) return 'unknown type';
  if (typeof ev.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(ev.occurred_at)) return 'bad occurred_at';
  if (JSON.stringify(ev).length > MAX_EVENT) return 'too large';
  return null;
}

/* ------------------------------ helpers ------------------------------ */

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}

function secure(res) {
  const out = new Response(res.body, res);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'same-origin');
  out.headers.set('X-Frame-Options', 'DENY');
  return out;
}
