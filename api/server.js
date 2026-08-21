import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dns from 'dns/promises';
import net from 'net';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import pkg from 'pg';

const execFileAsync = promisify(execFile);

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 3001;
const CONTENT_DIR = '/mnt/library/content';

// ── Database ────────────────────────────────────────────────────────────────

const pool = new Pool({
  host: process.env.DB_HOST || 'library-db',
  port: 5432,
  database: process.env.DB_NAME || 'library',
  user: process.env.DB_USER || 'library',
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 5000,
});

const initDb = async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
  await pool.query(sql);

  // Migrate user_reading_progress: expand PK to (user_id, item_id, format_url).
  // Safe to run on every startup (all steps are idempotent).
  await pool.query(`
    -- 1. Fill NULLs so we can set NOT NULL
    UPDATE user_reading_progress SET format_url = '' WHERE format_url IS NULL;
    -- 2. Set column NOT NULL + default (noop if already correct)
    ALTER TABLE user_reading_progress
      ALTER COLUMN format_url SET NOT NULL,
      ALTER COLUMN format_url SET DEFAULT '';
  `).catch(() => {/* already correct */});

  await pool.query(`
    -- 3. Expand PK to (user_id, item_id, format_url) if not already done.
    DO $$
    DECLARE pk_cols TEXT;
    BEGIN
      SELECT string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum))
        INTO pk_cols
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'p' AND c.conrelid = 'user_reading_progress'::regclass;

      IF pk_cols IS DISTINCT FROM 'user_id,item_id,format_url' THEN
        ALTER TABLE user_reading_progress DROP CONSTRAINT user_reading_progress_pkey;
        ALTER TABLE user_reading_progress ADD PRIMARY KEY (user_id, item_id, format_url);
      END IF;
    END $$;
  `).catch(e => console.warn('progress PK migration skipped:', e.message));

  // Everything produced from a source we do not host is flagged, so a later
  // decision to drop external material is one query rather than an audit.
  await pool.query(`
    ALTER TABLE document_text ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE chunks        ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE index_status  ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT false;
  `).catch(e => console.warn('external flag migration skipped:', e.message));

  // document_text gained seconds when video arrived: a subtitle cue is stored
  // exactly like a page, so the text viewer, the manual correction and the
  // re-index protection all work on video without a second code path.
  await pool.query(`
    ALTER TABLE document_text ADD COLUMN IF NOT EXISTS second_start INT;
    ALTER TABLE document_text ADD COLUMN IF NOT EXISTS second_end INT;
  `).catch(e => console.warn('document_text seconds migration skipped:', e.message));

  // visit_logs.ip_hash — added after the table shipped, so existing databases
  // need the column too (CREATE TABLE IF NOT EXISTS won't add it).
  await pool.query(
    'ALTER TABLE visit_logs ADD COLUMN IF NOT EXISTS ip_hash TEXT'
  ).catch(e => console.warn('visit_logs.ip_hash migration skipped:', e.message));

  // One-off: clear visitor pseudonyms left on unattributable rows.
  //
  // Erasure only started clearing ip_hash once the column existed, so a person
  // erased before that still had their visits grouped under one stable value —
  // the linkage erasure is supposed to break. Rows with no username are either
  // exactly those, or visits by someone who never identified themselves at all;
  // for the latter the pseudonym is the only identifier on the row, so dropping
  // it is the conservative reading of "keep no more than you need".
  //
  // Guarded by schema_migrations because it must NOT run again: new anonymous
  // visits are supposed to keep their pseudonym, which is what makes them
  // distinguishable in the access log.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'visit_logs_clear_orphan_ip_hash') THEN
        UPDATE visit_logs SET ip_hash = NULL WHERE username IS NULL AND ip_hash IS NOT NULL;
        INSERT INTO schema_migrations (name) VALUES ('visit_logs_clear_orphan_ip_hash');
      END IF;
    END $$;
  `).catch(e => console.warn('orphan ip_hash cleanup skipped:', e.message));

  // A deploy kills whatever was running. The checkpoint stays, so requeueing is
  // resuming, not restarting — that is the whole reason the queue is a table.
  const requeued = await pool.query(
    `UPDATE jobs SET state = 'queued', locked_by = NULL, locked_at = NULL WHERE state = 'running'`
  ).catch(() => ({ rowCount: 0 }));
  if (requeued.rowCount) console.log(`DB: requeued ${requeued.rowCount} job(s) interrupted by a restart`);

  // Finished work older than a month is history nobody reads; the running and
  // queued rows are never touched.
  await pool.query(
    `DELETE FROM jobs WHERE state IN ('done','failed','cancelled')
       AND COALESCE(finished_at, created_at) < NOW() - INTERVAL '30 days'`
  ).catch(() => {/* housekeeping */});

  // Rows a later success has already replaced. Jobs finished before this ran
  // kept every success for a target, so a re-index left the previous count
  // sitting under the new one as if both were true. New runs clear their own
  // predecessors; this clears the ones that accumulated before they did.
  await pool.query(
    `DELETE FROM jobs a
      WHERE a.state IN ('done','failed','cancelled')
        AND a.format_url IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jobs b
           WHERE b.item_id = a.item_id AND b.format_url = a.format_url
             AND b.state = 'done'
             AND (COALESCE(b.finished_at, b.created_at), b.id)
               > (COALESCE(a.finished_at, a.created_at), a.id)
        )`
  ).catch(() => {/* housekeeping */});

  console.log('DB: schema initialized');
};

// Schema init/migration retries: a single attempt chained off the first
// connect meant that if Postgres wasn't accepting connections yet (compose
// starts both at once) the ALTERs never ran, and the API then served traffic
// against a table missing a column — every visit 500s with nothing retrying.
const initDbWithRetry = async (attempt = 1) => {
  try {
    const client = await pool.connect();
    client.release();
    await initDb();
    startWorker();
  } catch (err) {
    const delay = Math.min(30_000, 2_000 * attempt);
    console.warn(`DB init attempt ${attempt} failed (${err.message}); retrying in ${delay}ms`);
    setTimeout(() => initDbWithRetry(attempt + 1), delay).unref?.();
  }
};
initDbWithRetry();

// ── Middleware ───────────────────────────────────────────────────────────────

const allowedOrigins = (process.env.CORS_ORIGIN || 'https://library.optionsdata.ru').split(',');

// Don't advertise the framework — one less hint for an attacker.
app.disable('x-powered-by');
// Never `true` — with it, ANY client could send X-Forwarded-For: 1.2.3.4 and
// walk past the IP blacklist, the rate limiter and the analytics excludes just
// by rotating headers (#20).
//
// 'loopback' alone was too narrow for how we actually run: the API lives in a
// container and nginx reaches it through a published port, so the peer address
// inside the container is the Docker bridge gateway (172.16/12), never
// 127.0.0.1. The trust test therefore never matched and req.ip fell back to
// that gateway — one shared address for every visitor, which silently defeated
// per-IP rate limiting and IP-based excludes.
//
// Trusting the private ranges is safe *here* because the container port is
// published on host loopback only (docker-compose: 127.0.0.1:3001:3001), so
// nginx is the sole ingress, and it overwrites X-Real-IP with $remote_addr and
// appends the peer to X-Forwarded-For. A forged header therefore arrives as
// "1.2.3.4, <real-ip>"; Express walks the chain from the right and stops at the
// first untrusted hop — the real public IP — so the forgery is ignored.
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json({ limit: '10mb' }));

// ── Security headers (helmet-equivalent, dependency-free) ────────────────────
// These harden every API response. The HTML document's CSP lives in
// index.html (ships with the frontend build) + nginx; here we cover the API
// surface so JSON/file responses can't be sniffed, framed or downgraded.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY'); // API JSON is never meant to be framed
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // HSTS: force HTTPS for a year (nginx already redirects, this tells browsers
  // to never even try http). Harmless behind the TLS-terminating proxy.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ── Rate limiting (in-memory sliding window, per IP, dependency-free) ────────
// A single Node process serves the app, so an in-memory store is sufficient and
// avoids a Redis dependency. Buckets are pruned lazily on access. Keyed by the
// real client IP (nginx forwards it via X-Real-IP / X-Forwarded-For).
const rateBuckets = new Map(); // key -> { count, resetAt }

// req.ip already respects `trust proxy: 'loopback'` — Express only believes
// X-Forwarded-For when the immediate connection came from a loopback address
// (the local nginx). Reading the raw headers ourselves would re-introduce the
// spoofing vector that #20 closed.
const clientIp = (req) => (req.ip || req.socket?.remoteAddress || 'unknown').toString().trim();

// Is this an infrastructure address rather than a visitor's? Used to detect the
// case where proxy trust is misconfigured and req.ip resolves to a gateway or
// loopback address — then every visitor would look identical, so callers that
// have a second (weaker) source can prefer it instead of logging noise.
const isInternalIp = (ip) => {
  if (!ip || ip === 'unknown') return true;
  const s = String(ip).trim().replace(/^::ffff:/i, '');
  if (s === '::1' || s.startsWith('127.')) return true;
  if (s.startsWith('10.') || s.startsWith('192.168.')) return true;
  const m = s.match(/^172\.(\d{1,3})\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (s.startsWith('169.254.')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(s) || /^fe80:/i.test(s)) return true;
  return false;
};

// Returns an Express middleware enforcing `max` requests per `windowMs` for the
// given `name` (name keeps independent routes from sharing a counter).
const rateLimit = (name, max, windowMs) => (req, res, next) => {
  const key = `${name}:${clientIp(req)}`;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count++;
  if (b.count > max) {
    const retry = Math.ceil((b.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retry));
    return res.status(429).json({ error: 'Too many requests, slow down.', retryAfter: retry });
  }
  next();
};

// Periodic sweep so the Map can't grow unbounded from one-off IPs.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(k);
}, 5 * 60 * 1000).unref?.();

// Named limiters reused on the sensitive routes below.
const limitLogin    = rateLimit('login', 5, 15 * 60 * 1000);   // brute-force guard
const limitArticle  = rateLimit('article', 30, 60 * 1000);      // SSRF/proxy-abuse guard
const limitDoi      = rateLimit('doi', 60, 60 * 1000);          // upstream courtesy
const limitBackup   = rateLimit('backup', 3, 60 * 1000);        // heavy pg_dump guard
const limitErrors   = rateLimit('errors', 30, 60 * 1000);       // error-report flood guard
const limitGlobal   = rateLimit('global', 600, 60 * 1000);      // catch-all DoS guard

// Apply the catch-all limiter to every /api route. Specific tighter limiters
// are attached per-route at their definitions.
app.use('/api', limitGlobal);

// API key guard for all write operations
const requireApiKey = (req, res, next) => {
  const key = process.env.API_KEY;
  if (!key) return next(); // dev: no key configured — allow all
  if (req.headers['x-api-key'] !== key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ── Telegram initData validation ─────────────────────────────────────────────

// Validates the Telegram WebApp initData signature with HMAC-SHA256.
// Returns { id, username } on success, null if invalid or BOT_TOKEN not set.
// Rejects initData older than INITDATA_TTL_SECONDS so a leaked initData
// (e.g. via error_log.url or referrer) can't be replayed forever — Telegram
// includes a server-set auth_date and recommends rejecting stale tokens.
const INITDATA_TTL_SECONDS = 24 * 60 * 60; // 24 hours, Telegram's own guidance
const validateTelegramInitData = (initDataRaw, botToken) => {
  if (!botToken || !initDataRaw) return null;
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheck = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(dataCheck).digest('hex');
    if (expected !== hash) return null;
    // Freshness check — auth_date is a Unix timestamp Telegram stamps on the
    // initData when the WebApp is opened. Without this check a token captured
    // hours/days ago is still a valid identity proof.
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || (Date.now() / 1000 - authDate) > INITDATA_TTL_SECONDS) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user
      ? { id: String(user.id), username: (user.username || '').toLowerCase() }
      : null;
  } catch { return null; }
};

// ── Settings cache (avoids a DB round-trip on every auth check) ───────────────

let _settingsCache = null;
let _settingsCacheAt = 0;
const SETTINGS_TTL = 30_000;

const getSettingsCached = async () => {
  if (_settingsCache && Date.now() - _settingsCacheAt < SETTINGS_TTL) return _settingsCache;
  try {
    const r = await pool.query('SELECT data FROM app_settings WHERE id = 1');
    _settingsCache = { ...DEFAULT_SETTINGS, ...(r.rows[0]?.data || {}) };
    _settingsCacheAt = Date.now();
  } catch { _settingsCache = _settingsCache || DEFAULT_SETTINGS; }
  return _settingsCache;
};

const invalidateSettingsCache = () => { _settingsCacheAt = 0; };

// ── User-access middleware (blacklist check + user extraction) ────────────────

// Reads x-telegram-init-data header, validates signature, checks blacklist.
// Attaches req.telegramUser = { id, username } | null.
// Blocks with 403 if user or IP is blacklisted.
const checkUserAccess = async (req, res, next) => {
  const botToken = process.env.BOT_TOKEN;
  const initDataRaw = req.headers['x-telegram-init-data'];
  const ip = clientIp(req);

  let telegramUser = null;
  if (botToken && initDataRaw) telegramUser = validateTelegramInitData(initDataRaw, botToken);

  try {
    const settings = await getSettingsCached();
    const bl = (settings.blacklist || []).map(s => s.toLowerCase().replace(/^@/, ''));
    const blocked =
      (telegramUser && (bl.includes(telegramUser.id) || bl.includes(telegramUser.username))) ||
      (ip && bl.includes(ip));
    if (blocked) return res.status(403).json({ error: 'Access denied' });
    req.telegramUser = telegramUser;
    req.cachedSettings = settings;
    next();
  } catch {
    req.telegramUser = telegramUser;
    req.cachedSettings = DEFAULT_SETTINGS;
    next(); // fail open — prefer availability on DB errors
  }
};

// Block path traversal in itemId
const validateItemId = (req, res, next) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(req.params.itemId)) {
    return res.status(400).json({ error: 'Invalid item ID' });
  }
  next();
};

// Block path traversal / injection in userId
const validateUserId = (req, res, next) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(req.params.userId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  // Hard cap so a hostile client can't pile a 100 KB string into a TEXT column.
  if (req.params.userId.length > 64) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  next();
};

// Guard against IDOR / CSRF on /api/users/:userId/* — previously any client
// could vandalise another user's data just by guessing their numeric Telegram
// ID in the URL. Now:
//   • If x-telegram-init-data is present, it must be valid AND the URL's
//     userId must match tgUser.id.
//   • If absent, only the special 'guest_user' id is allowed — non-Telegram
//     browsers share one bucket, can't impersonate a specific Telegram user.
// READ endpoints (favorites, ratings, bookmarks listing) stay open: those
// only return the requested user's own data, which they could see anyway on
// their own device, and the catalog UI relies on them. WRITE endpoints
// (PUT/POST/DELETE) get this guard.
const GUEST_USER_ID = 'guest_user';
const requireUserMatch = (req, res, next) => {
  const claimedId = req.params.userId;
  const initData = req.headers['x-telegram-init-data'];
  if (initData) {
    const tgUser = validateTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!tgUser) return res.status(401).json({ error: 'Invalid Telegram session' });
    if (tgUser.id !== claimedId) return res.status(403).json({ error: 'User ID mismatch' });
    req.telegramUser = tgUser;
    return next();
  }
  // No Telegram identity → only the shared guest bucket is writeable.
  // This blocks the trivial "POST /api/users/12345/ratings/X with rating 5"
  // attack from anonymous browsers.
  if (claimedId === GUEST_USER_ID) return next();
  return res.status(401).json({ error: 'Authentication required' });
};

// ── Multer: cover ────────────────────────────────────────────────────────────

const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(CONTENT_DIR, req.params.itemId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, 'cover' + ext);
  },
});

const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) =>
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

// ── Multer: content files ────────────────────────────────────────────────────

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/epub+zip',
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/x-m4b',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'application/x-fictionbook+xml',
  'application/x-fictionbook',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.epub', '.mp4', '.webm', '.mkv',
  '.mp3', '.m4a', '.m4b', '.ogg', '.oga', '.opus', '.wav',
  '.fb2', '.djvu', '.djv',
  // Subtitles. Ready-made ones beat anything we could recognise ourselves —
  // free, instant and written by someone who knew the terminology.
  '.srt', '.vtt',
]);

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(CONTENT_DIR, req.params.itemId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const lang = (req.body.lang || 'ru').replace(/[^a-z]/g, '').slice(0, 5);
    // Unique on-disk name so multiple same-language files in one item never
    // collide/overwrite. The human-readable name is applied at download time
    // via Content-Disposition (see GET /api/download), not here.
    cb(null, `${lang}-${randomBytes(3).toString('hex')}${ext}`);
  },
});

const uploadFile = multer({
  storage: fileStorage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB (videos)
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_CONTENT_TYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.has(ext));
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const formatSize = bytes =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;

const baseUrl = () =>
  process.env.BASE_URL || 'https://library.optionsdata.ru';

// Coerce a value to a trimmed string of at most n chars, or null.
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

// Stable pseudonym for a visitor, stored next to the anonymised address.
//
// The anonymised IP alone can't tell two people apart — everyone on a /24 looks
// identical — so the access log couldn't answer "is this the same visitor?".
// An HMAC of the full address answers that without keeping the address: equal
// inputs give equal output, and the digest can't be turned back into an IP
// without the key, which never leaves the server and is never sent to a client.
//
// Threat model, stated plainly: the IPv4 space is small enough to enumerate, so
// anyone holding BOTH the database and the server key could brute-force the
// original addresses. The key is separate from the data precisely so a database
// leak on its own doesn't expose them. Rotating the key (or API_KEY, when no
// dedicated one is set) invalidates existing pseudonyms — old rows stop
// correlating with new ones, which is a deliberate, cheap kill switch.
const IP_HASH_KEY = process.env.IP_HASH_SECRET
  || (process.env.API_KEY
        ? createHmac('sha256', process.env.API_KEY).update('visit-ip-pseudonym').digest('hex')
        : null);

const visitorHash = (raw) => {
  if (!IP_HASH_KEY) return null;              // no stable key ⇒ no fake correlation
  const ip = (raw || '').trim();
  if (!ip || ip === 'unknown') return null;
  // 16 hex chars = 64 bits: collision-free at any traffic this app will see,
  // and short enough to read off the screen.
  return createHmac('sha256', IP_HASH_KEY).update(ip).digest('hex').slice(0, 16);
};

// #37 — IP anonymisation for long-lived rows. Zero the last octet of IPv4 and
// truncate IPv6 to the first 48 bits — matches the standard used by Plausible
// and GA. Real-time blacklist / rate-limit checks still see the full IP via
// clientIp(); only what gets persisted into visit_logs goes through here.
// The address both write paths agree on. Prefer the connection; fall back to
// the client's own claim only when the connection yields nothing but
// infrastructure (misconfigured proxy trust), so the log stays informative
// instead of collapsing onto one gateway address. Shared by /api/visits and
// /api/items/:itemId/track so a pseudonym means the same thing on both.
const resolveVisitorIp = (req) => {
  const real = clientIp(req);
  if (!isInternalIp(real)) return real;
  return clip(req.body?.ip, 64) || real;
};

const anonymizeIp = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  const ip = raw.trim();
  if (!ip || ip === 'unknown') return ip;
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.0`;
  if (ip.includes(':')) {
    const sides = ip.split('::');
    let hextets;
    if (sides.length === 2) {
      const left = sides[0] ? sides[0].split(':') : [];
      const right = sides[1] ? sides[1].split(':') : [];
      const missing = 8 - (left.length + right.length);
      hextets = [...left, ...new Array(Math.max(0, missing)).fill('0'), ...right];
    } else {
      hextets = ip.split(':');
    }
    if (hextets.length >= 3) return `${hextets[0]}:${hextets[1]}:${hextets[2]}::`;
  }
  return ip;
};

// ── Error logging (built-in monitoring) ──────────────────────────────────────

// Persist one error row. Best-effort: never throws (we don't want logging to
// take down the request that's already failing). Fields are length-capped.
const recordError = async ({ source, kind, message, stack, url, userId, username, userAgent }) => {
  try {
    await pool.query(
      `INSERT INTO error_log (source, kind, message, stack, url, user_id, username, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        source === 'server' ? 'server' : 'client',
        clip(kind, 64),
        clip(message, 2000) || '(no message)',
        clip(stack, 8000),
        clip(url, 512),
        clip(userId, 64),
        clip(username, 64),
        clip(userAgent, 512),
      ],
    );
  } catch (e) {
    console.warn('recordError failed:', e.message);
  }
};

// ── Download token helpers ───────────────────────────────────────────────────

// Stable TOKEN_SECRET in env is recommended for production (tokens survive
// restarts). A random ephemeral secret still works fine since tokens are
// short-lived (TOKEN_TTL) and the user re-clicks to get a fresh one.
const TOKEN_SECRET = process.env.TOKEN_SECRET || randomBytes(32).toString('hex');
const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

const signDownloadToken = (itemId, filename) => {
  const payload = Buffer.from(
    JSON.stringify({ itemId, filename, exp: Date.now() + TOKEN_TTL }),
  ).toString('base64url');
  const sig = createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};

const verifyDownloadToken = (token, itemId, filename) => {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64     = token.slice(dot + 1);
  try {
    const expected = createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
    if (expected !== sigB64) return false;
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return data.itemId === itemId && data.filename === filename && Date.now() <= data.exp;
  } catch { return false; }
};

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch {/* ignore */}
  res.json({ status: 'ok', db: dbStatus, version: '1.0.0' });
});

// Admin login: verify ADMIN_PASSWORD, return API_KEY
app.post('/api/admin/login', limitLogin, (req, res) => {
  const { password } = req.body || {};
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || typeof password !== 'string') {
    return res.status(401).json({ error: 'Invalid password' });
  }
  // Constant-time compare so a botnet spread across many IPs can't extract
  // the password one character at a time from response-time deltas. The
  // length check up front is itself constant — buffers of different lengths
  // can't be passed to timingSafeEqual, so we short-circuit with a fake
  // compare of equal length to keep timing uniform across cases.
  const a = Buffer.from(password);
  const b = Buffer.from(adminPassword);
  const lenMatch = a.length === b.length;
  // Always run the compare to avoid leaking length via timing.
  const padded = lenMatch ? a : Buffer.alloc(b.length);
  const equal = timingSafeEqual(padded, b);
  if (!lenMatch || !equal) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'API key not configured on server' });
  }
  res.json({ apiKey });
});

// ── Error monitoring endpoints ───────────────────────────────────────────────

// Public: the frontend posts client-side errors here (rate-limited so it can't
// be abused as a write-amplification vector). Verified Telegram identity is
// attached when present.
app.post('/api/errors', limitErrors, async (req, res) => {
  const b = req.body || {};
  // Strip query strings from the reported URL — they often contain short-lived
  // download tokens (?t=...), session traces and admin gate flags (?admin=true)
  // that have no place in a long-lived log row exposed to anyone with admin
  // access. Hash and fragment are dropped too.
  let cleanUrl = null;
  if (typeof b.url === 'string') {
    try {
      const u = new URL(b.url, 'https://x.invalid');
      cleanUrl = u.origin + u.pathname;
    } catch { cleanUrl = b.url.split('?')[0].split('#')[0]; }
  }
  // NEVER trust body-supplied identity. Only the HMAC-verified Telegram user
  // can be associated with the report — otherwise an unauthenticated client
  // can frame any @username for any error.
  const tgUser = validateTelegramInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN);
  await recordError({
    source: 'client',
    kind: b.kind,
    message: b.message,
    stack: b.stack,
    url: cleanUrl,
    userId: tgUser?.id || null,
    username: tgUser?.username || null,
    userAgent: req.headers['user-agent'],
  });
  res.json({ ok: true });
});

// Admin: most recent errors (newest first).
// The caller's own address, as the server sees it. Exists so the admin panel's
// "exclude me" button doesn't have to ask a third-party lookup service what the
// operator's IP is — we already know it from the connection, and routing it
// through an outside company was a needless transfer of personal data.
app.get('/api/admin/whoami', requireApiKey, (req, res) => {
  res.json({ ip: clientIp(req) });
});

app.get('/api/admin/errors', requireApiKey, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ts, source, kind, message, stack, url, user_id, username, user_agent
         FROM error_log ORDER BY ts DESC LIMIT 200`,
    );
    res.json({ errors: rows });
  } catch (e) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

// Admin: wipe the error log.
app.post('/api/admin/errors/clear', requireApiKey, async (req, res) => {
  try {
    await pool.query('DELETE FROM error_log');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Deploy control ───────────────────────────────────────────────────────────
// The web process never runs git/docker itself. It only exchanges files with the
// host deploy-agent through a shared directory (see deploy-agent/README.md):
// reads status.json, writes a request-*.json to trigger a deploy, writes mode.json
// to toggle auto/manual.
const DEPLOY_CONTROL_DIR = process.env.DEPLOY_CONTROL_DIR || '/deploy-control';

// Shared HMAC secret with the deploy-agent so it can prove a mailbox file
// came from the API (and not from any other local process that managed to
// write into the shared directory). Falls back to BOT_TOKEN — the agent
// applies the same fallback so out-of-the-box installs keep working.
const DEPLOY_AGENT_SECRET = process.env.DEPLOY_AGENT_SECRET || process.env.BOT_TOKEN || '';

// Serialise + sign a mailbox payload. The agent rejects any *.json in the
// control dir whose top-level "sig" field doesn't HMAC-match the rest.
const writeSignedMailbox = (filePath, payload) => {
  const body = { ...payload, ts: Date.now() };
  const canonical = JSON.stringify(body);
  const sig = DEPLOY_AGENT_SECRET
    ? createHmac('sha256', DEPLOY_AGENT_SECRET).update(canonical).digest('hex')
    : '';
  fs.writeFileSync(filePath, JSON.stringify({ ...body, sig }), { mode: 0o600 });
};

// Current deploy status as reported by the host agent.
app.get('/api/admin/deploy/status', requireApiKey, (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(DEPLOY_CONTROL_DIR, 'status.json'), 'utf8');
    res.json({ agent: 'online', ...JSON.parse(raw) });
  } catch {
    // No status file → agent not installed/running yet.
    res.json({ agent: 'offline' });
  }
});

// Queue a manual deploy: drop a request file for the agent to consume.
app.post('/api/admin/deploy', requireApiKey, (req, res) => {
  try {
    fs.mkdirSync(DEPLOY_CONTROL_DIR, { recursive: true });
    const file = path.join(DEPLOY_CONTROL_DIR, `request-${Date.now()}.json`);
    writeSignedMailbox(file, { requestedAt: new Date().toISOString() });
    res.json({ queued: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not queue deploy: ' + (e?.message || String(e)) });
  }
});

// Toggle automatic/manual deployment.
app.post('/api/admin/deploy/mode', requireApiKey, (req, res) => {
  const mode = req.body?.mode;
  if (mode !== 'auto' && mode !== 'manual') {
    return res.status(400).json({ error: 'mode must be "auto" or "manual"' });
  }
  try {
    fs.mkdirSync(DEPLOY_CONTROL_DIR, { recursive: true });
    writeSignedMailbox(path.join(DEPLOY_CONTROL_DIR, 'mode.json'), { mode });
    res.json({ mode });
  } catch (e) {
    res.status(500).json({ error: 'Could not set mode: ' + (e?.message || String(e)) });
  }
});

// ── Backup control ───────────────────────────────────────────────────────────
// Same mailbox pattern as deploy: the API only reads/writes files in the shared
// control directory. The host agent runs pg_dump / pg_restore / scp / aws s3.

const BACKUP_CONFIG_FILE = path.join(DEPLOY_CONTROL_DIR, 'backup-config.json');
const BACKUP_STATUS_FILE = path.join(DEPLOY_CONTROL_DIR, 'backup-status.json');

// Mirrors DEFAULT_BACKUP_CONFIG in deploy-agent/agent.mjs. Returned by GET
// /api/admin/backup/status when the agent has never written a config file
// yet, so the admin can pre-configure the targets even before the agent is
// running on the host. Saving will create the file; the agent will pick it
// up on its next tick.
const DEFAULT_BACKUP_CONFIG = {
  schedule: { enabled: true, intervalHours: 6 },
  retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
  targets: {
    local:  { enabled: true,  path: '' },
    remote: { enabled: false, host: '', user: '', path: '', port: 22, sshKeyPath: '' },
    s3:     { enabled: false, endpoint: '', region: '', bucket: '', prefix: '', accessKey: '', secretKey: '' },
  },
};

// Strip credential-shaped fields before returning config to the admin UI.
// Replaced with "***" if set, empty string if not set — that way the UI can
// show "configured" vs "blank" without ever revealing the actual secret.
const maskBackupConfig = (cfg) => {
  if (!cfg) return cfg;
  const c = JSON.parse(JSON.stringify(cfg));
  const mask = (v) => (v ? '***' : '');
  if (c.targets?.remote) {
    c.targets.remote.sshKeyPath = c.targets.remote.sshKeyPath || '';
    // sshKeyPath is a path, not a secret, so we leave it visible
  }
  if (c.targets?.s3) {
    c.targets.s3.accessKey = mask(c.targets.s3.accessKey);
    c.targets.s3.secretKey = mask(c.targets.s3.secretKey);
  }
  return c;
};

// Merge an incoming partial config over the existing one, preserving any
// "***" placeholders (admin didn't change that secret in this submission).
const mergeBackupConfig = (existing, incoming) => {
  const out = JSON.parse(JSON.stringify(existing || {}));
  if (!incoming || typeof incoming !== 'object') return out;
  if (incoming.schedule) out.schedule = { ...(out.schedule || {}), ...incoming.schedule };
  if (incoming.retention) out.retention = { ...(out.retention || {}), ...incoming.retention };
  if (incoming.targets) {
    out.targets = out.targets || {};
    for (const k of ['local', 'remote', 's3']) {
      if (!incoming.targets[k]) continue;
      const merged = { ...(out.targets[k] || {}), ...incoming.targets[k] };
      // Preserve real secrets the UI sent back as "***"
      if (k === 's3') {
        if (incoming.targets.s3.accessKey === '***') merged.accessKey = out.targets.s3?.accessKey || '';
        if (incoming.targets.s3.secretKey === '***') merged.secretKey = out.targets.s3?.secretKey || '';
      }
      out.targets[k] = merged;
    }
  }
  return out;
};

const readBackupConfigSafe = () => {
  try { return JSON.parse(fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8')); } catch { return null; }
};

// GET backup status + masked config
app.get('/api/admin/backup/status', requireApiKey, (req, res) => {
  let status = null;
  try { status = JSON.parse(fs.readFileSync(BACKUP_STATUS_FILE, 'utf8')); } catch { /* not yet */ }
  // Always hand the UI a usable config — defaults when nothing has been
  // saved yet — so the admin can pre-configure targets before the agent
  // ever runs. Saving creates the file; the agent reads it on next tick.
  const cfg = readBackupConfigSafe() || DEFAULT_BACKUP_CONFIG;
  res.json({
    agent: status ? 'online' : 'offline',
    status,
    config: maskBackupConfig(cfg),
  });
});

// Trigger an immediate backup
app.post('/api/admin/backup/run', limitBackup, requireApiKey, (req, res) => {
  try {
    fs.mkdirSync(DEPLOY_CONTROL_DIR, { recursive: true });
    const file = path.join(DEPLOY_CONTROL_DIR, `backup-request-${Date.now()}.json`);
    writeSignedMailbox(file, { requestedAt: new Date().toISOString() });
    res.json({ queued: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not queue backup: ' + (e?.message || String(e)) });
  }
});

// Trigger a restore from a previous local backup. Destructive — the admin UI
// requires typing a confirmation phrase before calling this.
app.post('/api/admin/backup/restore', requireApiKey, (req, res) => {
  const filename = req.body?.filename;
  if (typeof filename !== 'string' || !/^[a-zA-Z0-9._-]+\.dump$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    fs.mkdirSync(DEPLOY_CONTROL_DIR, { recursive: true });
    const file = path.join(DEPLOY_CONTROL_DIR, `backup-restore-${Date.now()}.json`);
    writeSignedMailbox(file, { filename, requestedAt: new Date().toISOString() });
    res.json({ queued: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not queue restore: ' + (e?.message || String(e)) });
  }
});

// Update backup config (schedule + targets). Secrets sent as "***" are kept.
app.put('/api/admin/backup/config', requireApiKey, (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid config' });
  }
  try {
    fs.mkdirSync(DEPLOY_CONTROL_DIR, { recursive: true });
    const existing = readBackupConfigSafe() || {};
    const next = mergeBackupConfig(existing, req.body);
    writeSignedMailbox(BACKUP_CONFIG_FILE, next);
    res.json({ config: maskBackupConfig(next) });
  } catch (e) {
    res.status(500).json({ error: 'Could not save config: ' + (e?.message || String(e)) });
  }
});

// ── Content scan ─────────────────────────────────────────────────────────────
//
// Answers one question per catalogued file: is there a text layer we can read?
//
// This is step zero of the search plan, and it exists because the two decisions
// that follow — whether OCR is needed at all, and how big the indexing job is —
// currently rest on nobody's guess. A book whose pages are pictures cannot be
// searched, and finding that out for three files is a different project from
// finding it out for a third of the library.
//
// It runs as a background job: extracting text from a few hundred books takes
// minutes, and an HTTP request held open that long is a request that dies.

const SCAN_MEDIA_EXT = new Set([
  '.mp4', '.webm', '.mkv', '.mp3', '.m4a', '.m4b', '.ogg', '.oga', '.opus', '.wav',
]);

// A typeset page carries a couple of thousand characters. A scanned page with
// only a stamped folio carries a handful. The band between is a book that is
// part text, part image — usually formula-heavy pages set as pictures — and it
// is worth a human look rather than being rounded to either verdict.
const SCAN_TEXT_PER_PAGE = 200;
const SCAN_PARTIAL_PER_PAGE = 20;

// Single job: one library, one operator, and two concurrent passes would only
// fight over the same CPU and rows.
const scanJob = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  current: '',
  error: null,
  stopRequested: false,
};

const scanJobView = () => ({
  running: scanJob.running,
  startedAt: scanJob.startedAt,
  finishedAt: scanJob.finishedAt,
  total: scanJob.total,
  done: scanJob.done,
  current: scanJob.current,
  error: scanJob.error,
  stopRequested: scanJob.stopRequested,
});

// Our own files are stored as <base>/content/<itemId>/<filename>. Anything that
// doesn't match that shape is somebody else's URL, which is a fact worth
// reporting rather than a path worth guessing at.
const scanFilenameFromUrl = (itemId, url) => {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/content\/([^/]+)\/([^/?#]+)(?:[?#].*)?$/);
  if (!m) return null;
  let dir, filename;
  try {
    dir = decodeURIComponent(m[1]);
    filename = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (dir !== itemId) return null;
  // Same charset the upload and download paths enforce — a name outside it
  // never came from us, so it must not be turned into a filesystem path.
  return /^[a-zA-Z0-9._-]+$/.test(filename) ? filename : null;
};

// Whitespace excluded: line breaks and indentation differ wildly between
// extractors and would make two copies of the same book look different.
const scanCountChars = text => text.replace(/\s+/g, '').length;

const scanPdf = async filePath => {
  let pages = null;
  try {
    const { stdout } = await execFileAsync('pdfinfo', [filePath], { timeout: 30_000 });
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    if (m) pages = parseInt(m[1], 10);
  } catch {
    // Damaged or encrypted header. pdftotext often still manages, and a
    // missing page count only costs us the per-page test.
  }
  const { stdout } = await execFileAsync(
    'pdftotext', ['-q', '-enc', 'UTF-8', filePath, '-'],
    { timeout: 300_000, maxBuffer: 128 * 1024 * 1024 },
  );
  return { pages, chars: scanCountChars(stdout) };
};

const scanEbook = async filePath => {
  const out = path.join(os.tmpdir(), `scan-${randomBytes(6).toString('hex')}.txt`);
  try {
    await execFileAsync('ebook-convert', [filePath, out], { timeout: 300_000 });
    return { pages: null, chars: scanCountChars(fs.readFileSync(out, 'utf8')) };
  } finally {
    try { fs.unlinkSync(out); } catch { /* never created */ }
  }
};

const scanClassify = (pages, chars) => {
  if (!pages) {
    // No page count (EPUB, or a PDF with an unreadable header): fall back to a
    // flat floor, so a good book isn't called a scan for want of a header.
    return chars > 2000 ? 'text' : chars > 200 ? 'partial' : 'scan';
  }
  const perPage = chars / pages;
  if (perPage >= SCAN_TEXT_PER_PAGE) return 'text';
  if (perPage >= SCAN_PARTIAL_PER_PAGE) return 'partial';
  return 'scan';
};

const scanOneFile = async (itemId, format) => {
  const url = format.url.trim();

  // Flagged external: we deliberately never fetch it. Reporting it as a
  // separate state keeps "we chose not to" apart from "we failed to".
  if (format.external) return { state: 'external' };

  const filename = scanFilenameFromUrl(itemId, url);
  if (!filename) {
    return {
      state: 'error',
      detail: 'Ссылка ведёт не на наш сервер, но файл не отмечен как внешний',
    };
  }

  const filePath = path.join(CONTENT_DIR, itemId, filename);
  let size = null;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { state: 'missing', filename };
  }

  const ext = path.extname(filename).toLowerCase();
  const kind = ext.replace('.', '') || null;
  if (SCAN_MEDIA_EXT.has(ext)) return { state: 'media', filename, size, kind };

  try {
    if (ext === '.pdf') {
      const { pages, chars } = await scanPdf(filePath);
      return { state: scanClassify(pages, chars), filename, size, kind, pages, chars };
    }
    if (ext === '.epub' || ext === '.fb2') {
      const { chars } = await scanEbook(filePath);
      return { state: scanClassify(null, chars), filename, size, kind, chars };
    }
    return { state: 'unsupported', filename, size, kind };
  } catch (e) {
    return { state: 'error', filename, size, kind, detail: clip(e?.message || String(e), 300) };
  }
};

// Video and article links live outside `formats`, so the first version of this
// scan said nothing about them — and an admin reading "0 external" would have
// concluded there was no external material, when really nobody had looked.
//
// Links are classified without being fetched. Requesting arbitrary URLs from
// the server is a different and much larger thing than reading our own disk:
// it is an SSRF surface, it is slow, and for the platforms it would mean
// scraping. What can be established without a request is exactly what the
// subtitles step needs to know — which platform, and whether we already have a
// transcript.
const SCAN_VIDEO_PLATFORMS = [
  // `seek` records whether jumping to a given second is a solved problem for us
  // yet, not whether the platform supports it at all. Reporting "not checked"
  // turns a vague task into a concrete list.
  { re: /(?:youtube\.com|youtu\.be)/i,           kind: 'youtube', seek: true },
  { re: /rutube\.ru/i,                           kind: 'rutube',  seek: false },
  { re: /(?:vk\.com|vkvideo\.ru|vkontakte\.ru)/i, kind: 'vk',     seek: false },
  { re: /twitch\.tv/i,                           kind: 'twitch',  seek: false },
];

const scanVideoLink = link => {
  const url = link.url.trim();
  const platform = SCAN_VIDEO_PLATFORMS.find(p => p.re.test(url));
  if (!platform) {
    return {
      state: 'media', kind: 'video',
      detail: 'Ссылка на видео, площадка не опознана. Расшифровки нет; переход на секунду проверять отдельно.',
    };
  }
  return {
    state: 'media', kind: platform.kind,
    detail: platform.seek
      ? 'Ссылка на видео. Расшифровки нет — ждёт шага с субтитрами.'
      : 'Ссылка на видео. Расшифровки нет; переход на нужную секунду по этой площадке ещё не проверен.',
  };
};

const scanArticleLink = () => {
  return {
    state: 'external', kind: 'article',
    detail: 'Внешняя статья. Ждёт шага «Внешние источники».',
  };
};

const runContentScan = async () => {
  const startedAt = new Date();
  Object.assign(scanJob, {
    running: true,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    total: 0,
    done: 0,
    current: '',
    error: null,
    stopRequested: false,
  });

  try {
    const { rows } = await pool.query('SELECT id, data FROM items ORDER BY seq');
    const targets = [];
    for (const row of rows) {
      const item = row.data || {};
      const title = item.title?.ru || item.title?.en || item.title?.es || row.id;
      // (item, url) is the primary key, so the same URL listed twice in one
      // item would otherwise be probed twice and overwrite its own row.
      const seen = new Set();
      // An entry with no URL is skipped rather than reported: the row is keyed
      // by URL, so there is nowhere to record it, and several such entries in
      // one item would collide with each other.
      const add = (entry, label, probe) => {
        const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
        if (!url || seen.has(url)) return;
        seen.add(url);
        targets.push({ itemId: row.id, title, url, label, probe });
      };
      for (const f of Array.isArray(item.formats) ? item.formats : []) {
        add(f, f?.name, () => scanOneFile(row.id, f));
      }
      for (const v of Array.isArray(item.videos) ? item.videos : []) {
        add(v, v?.source || 'видео', () => scanVideoLink(v));
      }
      for (const a of Array.isArray(item.articles) ? item.articles : []) {
        add(a, a?.title || a?.source || 'статья', scanArticleLink);
      }

      // A material catalogued as a bare pointer — no file, no video, no
      // article, only `source.url` — produced no rows at all, which made it
      // invisible in a tab whose entire job is answering "what is in the
      // library, and can it be indexed". It was counted among the materials and
      // then silently absent from every verdict.
      //
      // The source link is only read when nothing else stands in for the
      // material: on a hosted PDF it is attribution, not a thing to index, and
      // listing it there would double every row.
      if (seen.size === 0) {
        const sourceUrl = typeof item.source?.url === 'string' ? item.source.url.trim() : '';
        if (sourceUrl) {
          add({ url: sourceUrl }, item.source?.name || 'источник', () => ({
            state: 'external', kind: 'source',
            detail: 'Только ссылка на источник, файла у нас нет. Ждёт шага «Внешние источники».',
          }));
        } else {
          // Keyed by the empty string: one such row per material, and the
          // primary key keeps it that way.
          targets.push({
            itemId: row.id, title, url: '', label: '',
            probe: () => ({
              state: 'nothing',
              detail: 'В материале нет ни файла, ни ссылки — искать нечего.',
            }),
          });
        }
      }
    }
    scanJob.total = targets.length;

    for (const { itemId, title, url, label, probe } of targets) {
      if (scanJob.stopRequested) break;
      scanJob.current = `${title} · ${label || ''}`.trim();
      const r = await probe();
      await pool.query(
        `INSERT INTO content_scan
           (item_id, format_url, filename, kind, state, pages, chars, size_bytes, detail, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (item_id, format_url) DO UPDATE SET
           filename = $3, kind = $4, state = $5, pages = $6, chars = $7,
           size_bytes = $8, detail = $9, scanned_at = NOW()`,
        [
          itemId, url, r.filename || null, r.kind || null, r.state,
          r.pages ?? null, r.chars ?? null, r.size ?? null, r.detail || null,
        ],
      );
      scanJob.done += 1;
    }

    // Files dropped from the catalogue since the last pass. Only after a run
    // that went all the way through — a stopped run has simply not reached them.
    if (!scanJob.stopRequested) {
      await pool.query('DELETE FROM content_scan WHERE scanned_at < $1', [startedAt]);
    }
  } catch (e) {
    scanJob.error = clip(e?.message || String(e), 300);
    console.error('content scan failed:', e);
  } finally {
    scanJob.running = false;
    scanJob.finishedAt = new Date().toISOString();
    scanJob.current = '';
  }
};

// Start a pass. Deliberately not awaited: the caller gets an immediate answer
// and follows progress through GET /api/admin/scan.
app.post('/api/admin/scan', requireApiKey, (req, res) => {
  if (scanJob.running) return res.status(409).json({ error: 'Scan already running' });
  runContentScan();
  res.json({ started: true });
});

app.post('/api/admin/scan/stop', requireApiKey, (req, res) => {
  if (scanJob.running) scanJob.stopRequested = true;
  res.json({ ok: true });
});

app.get('/api/admin/scan', requireApiKey, async (req, res) => {
  try {
    const rows = (await pool.query(`
      SELECT s.item_id, s.format_url, s.filename, s.kind, s.state, s.pages,
             s.chars, s.size_bytes, s.detail, s.scanned_at,
             i.data->'title' AS title
        FROM content_scan s
        LEFT JOIN items i ON i.id = s.item_id
       ORDER BY CASE s.state
                  WHEN 'scan' THEN 1 WHEN 'partial' THEN 2 WHEN 'error' THEN 3
                  WHEN 'missing' THEN 4 WHEN 'nothing' THEN 5 WHEN 'unsupported' THEN 6
                  WHEN 'media' THEN 7 WHEN 'external' THEN 8 ELSE 9
                END,
                s.item_id, s.filename
       LIMIT 3000
    `)).rows;

    const summary = (await pool.query(`
      SELECT state,
             COUNT(*)::int                  AS files,
             COALESCE(SUM(pages), 0)::int   AS pages,
             COALESCE(SUM(chars), 0)::bigint AS chars
        FROM content_scan
       GROUP BY state
    `)).rows;

    // What the catalogue holds, next to what the last pass actually walked.
    //
    // Without this the tab could only show what it found, and "no article rows"
    // is ambiguous: it means either "there are no articles" or "the pass that
    // ran predates article support". Those need different actions — nothing,
    // versus press the button again — so the screen has to tell them apart
    // rather than leave it to be guessed at.
    const catalog = (await pool.query(`
      SELECT COUNT(*)::int AS items,
             ${['formats', 'videos', 'articles'].map(k => `
               COALESCE(SUM(CASE WHEN jsonb_typeof(data->'${k}') = 'array'
                                 THEN jsonb_array_length(data->'${k}') ELSE 0 END), 0)::int AS ${k}`).join(',')}
        FROM items
    `)).rows[0];

    const scanned = (await pool.query(`
      SELECT COUNT(DISTINCT item_id)::int AS items,
             COUNT(*) FILTER (WHERE kind = 'article')::int AS articles,
             COUNT(*) FILTER (WHERE kind IN ('youtube','rutube','vk','twitch','video'))::int AS videos,
             COUNT(*) FILTER (WHERE state <> 'nothing'
                                AND (kind IS NULL
                                 OR kind NOT IN ('article','source','youtube','rutube','vk','twitch','video')))::int AS formats
        FROM content_scan
    `)).rows[0];

    // When the last pass finished is a fact about the rows, not about this
    // process: job state lives in memory and an API restart wipes it, which had
    // the tab announcing "not run yet" over a full set of results.
    const lastScanAt = (await pool.query(
      'SELECT MAX(scanned_at) AS at FROM content_scan'
    )).rows[0]?.at || null;

    res.json({
      job: scanJobView(),
      lastScanAt,
      // BIGINT arrives as a string from pg; the UI wants to do arithmetic.
      rows: rows.map(r => ({ ...r, chars: r.chars === null ? null : Number(r.chars) })),
      summary: summary.map(s => ({ ...s, chars: Number(s.chars) })),
      catalog,
      scanned,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Indexing ─────────────────────────────────────────────────────────────────
//
// Turns the files the scan found into something searchable: text per page,
// chunks per paragraph, and a per-file report the admin can read.
//
// Lives in this file rather than its own module on purpose — the deploy
// bind-mounts exactly server.js and init.sql, so a third file would turn every
// code change back into an image rebuild.

const CHUNK_TARGET  = 700;   // characters — where a chunk is happily closed
const CHUNK_MAX     = 1100;  // …and where it must be
const CHUNK_OVERLAP = 120;   // carried into the next chunk, so a thought split
                             // across a boundary is still findable from either side

// Front matter is normally numbered in roman, the body in arabic, and the two
// runs are what make "page 214 of the file" and "p. 214 of the book" disagree.
const ROMAN_RE = /^[ivxlcdm]{1,7}$/i;

// A printed folio sits at the very top or the very bottom of the page, alone on
// its line. Anything else on the page is text, and guessing from it is worse
// than admitting we don't know.
const pageFolio = pageText => {
  const lines = pageText.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  for (const line of [...lines.slice(0, 2), ...lines.slice(-2)]) {
    const arabic = line.match(/^(\d{1,4})$/);
    if (arabic) return { arabic: parseInt(arabic[1], 10) };
    if (ROMAN_RE.test(line)) return { roman: line.toLowerCase() };
  }
  return null;
};

/**
 * Printed page labels for a whole document, or nulls when the file doesn't
 * carry enough evidence.
 *
 * The offset between printed and physical numbering is constant through the
 * body, so the most common (printed − physical) difference is the answer. It is
 * only accepted when a clear majority of the pages that carry a number agree —
 * a handful of stray figures in a table must not be allowed to renumber a book.
 */
const derivePageLabels = pages => {
  const offsets = new Map();
  const romans = new Map();
  pages.forEach((text, i) => {
    const folio = pageFolio(text);
    if (!folio) return;
    if (folio.roman) { romans.set(i, folio.roman); return; }
    const offset = folio.arabic - (i + 1);
    offsets.set(offset, (offsets.get(offset) || 0) + 1);
  });

  let best = 0, bestVotes = 0, votes = 0;
  for (const [offset, n] of offsets) {
    votes += n;
    if (n > bestVotes) { bestVotes = n; best = offset; }
  }
  const confident = bestVotes >= 3 && bestVotes / votes >= 0.5;

  return {
    labels: pages.map((_, i) => {
      if (romans.has(i)) return romans.get(i);
      if (!confident) return null;
      const label = i + 1 + best;
      return label > 0 ? String(label) : null;
    }),
    confident,
    offset: confident ? best : null,
  };
};

/** Share of letters among non-space characters. Low means formulas or bad OCR. */
const textQuality = text => {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return 0;
  return (compact.match(/\p{L}/gu) || []).length / compact.length;
};

const splitParagraphs = text =>
  text.split(/\n\s*\n+/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);

// Only used on a paragraph that is already over the hard limit — a wall of text
// with no blank lines, which happens in badly converted files.
const splitLongParagraph = para => {
  const sentences = para.match(/[^.!?…]+[.!?…]+["»)\]]*\s*|.+$/g) || [para];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && buf.length + s.length > CHUNK_MAX) { out.push(buf.trim()); buf = ''; }
    buf += s;
    if (buf.length >= CHUNK_TARGET) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
};

/**
 * Cut text into search units along paragraph boundaries.
 *
 * Not every N characters: in this literature a definition, its formula and the
 * conditions it holds under live in three consecutive paragraphs, and a counter
 * that fires mid-sentence turns one idea into three useless fragments.
 */
const chunkText = text => {
  const chunks = [];
  let buf = '';
  const flush = () => {
    const done = buf.trim();
    if (done) chunks.push(done);
    buf = done.length > CHUNK_OVERLAP ? done.slice(-CHUNK_OVERLAP) : '';
  };
  for (const para of splitParagraphs(text)) {
    for (const piece of (para.length > CHUNK_MAX ? splitLongParagraph(para) : [para])) {
      if (buf && buf.length + piece.length + 1 > CHUNK_MAX) flush();
      buf = buf ? `${buf} ${piece}` : piece;
      if (buf.length >= CHUNK_TARGET) flush();
    }
  }
  const tail = buf.trim();
  // The overlap tail alone is not a chunk — it is already inside the previous one.
  if (tail && !(chunks.length && chunks[chunks.length - 1].endsWith(tail))) chunks.push(tail);
  return chunks;
};

// pdftotext separates pages with a form feed, which is the only reason we can
// keep page numbers at all without parsing the PDF ourselves.
const extractPdfPages = async filePath => {
  const { stdout } = await execFileAsync(
    'pdftotext', ['-q', '-enc', 'UTF-8', filePath, '-'],
    { timeout: 600_000, maxBuffer: 256 * 1024 * 1024 },
  );
  const pages = stdout.split('\f');
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  return pages;
};

// EPUB has no pages — position is a CFI — so this yields one "page 0" holding
// the whole book. Search and citation work; the reader opens the book rather
// than the exact spot. Wiring CFI ranges through is a separate piece of work,
// and doing it badly would be worse than admitting the limit here.
const extractEpubText = async filePath => {
  const out = path.join(os.tmpdir(), `idx-${randomBytes(6).toString('hex')}.txt`);
  try {
    await execFileAsync('ebook-convert', [filePath, out], { timeout: 600_000 });
    return [fs.readFileSync(out, 'utf8')];
  } finally {
    try { fs.unlinkSync(out); } catch { /* never created */ }
  }
};

// The file is fetched only to be read. It is deleted the moment the text is
// out, so the risk of holding somebody else's document does not accumulate on
// our disk — the text stays, the copy does not.
const EXTERNAL_MAX_BYTES = 80 * 1024 * 1024;
const EXTERNAL_TIMEOUT_MS = 120_000;

const fetchExternalDocument = async url => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
  try {
    const { response, error } = await fetchWithSsrfGuard(url, controller.signal, {
      'User-Agent': 'OptionsData-Library/1.0 (indexing)',
      Accept: 'application/pdf,application/epub+zip,*/*',
    });
    if (error) throw new Error(`Не удалось загрузить: ${error}`);
    if (!response.ok) throw new Error(`Источник ответил ${response.status}`);

    const declared = parseInt(response.headers.get('content-length') || '0', 10);
    if (declared > EXTERNAL_MAX_BYTES) throw new Error('Файл слишком большой');

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > EXTERNAL_MAX_BYTES) throw new Error('Файл слишком большой');
    if (!buf.length) throw new Error('Источник вернул пустой файл');

    // Trust the bytes, not the URL: a link ending in .pdf that answers with an
    // HTML "please log in" page must not be indexed as if it were the paper.
    const head = buf.subarray(0, 5).toString('latin1');
    const type = head === '%PDF-' ? '.pdf'
      : buf.subarray(0, 2).toString('latin1') === 'PK' ? '.epub'
      : null;
    if (!type) throw new Error('По ссылке не PDF и не EPUB — возможно, страница входа');

    const file = path.join(os.tmpdir(), `ext-${randomBytes(8).toString('hex')}${type}`);
    fs.writeFileSync(file, buf);
    return { file, type, bytes: buf.length };
  } finally {
    clearTimeout(timer);
  }
};

const indexJob = {
  running: false, startedAt: null, finishedAt: null,
  total: 0, done: 0, current: '', error: null, stopRequested: false,
};

const indexJobView = () => ({ ...indexJob });

// Chunks go in batched: a 300-page book yields ~1000 of them, and a thousand
// round trips is the difference between a second and a minute.
const insertChunks = async (client, itemId, formatUrl, rows, external = false) => {
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    slice.forEach((r, n) => {
      const b = n * 7;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
      params.push(itemId, formatUrl, r.page, r.pageLabel, r.heading, r.text, external);
    });
    await client.query(
      `INSERT INTO chunks (item_id, format_url, page, page_label, heading, text, external)
       VALUES ${values.join(',')}`,
      params,
    );
  }
};

/**
 * Index one file: extract, store per page, re-cut chunks, record the report.
 *
 * Pages a human corrected are never overwritten — that is what makes fixing a
 * mangled formula worth the effort, since the next re-index would otherwise
 * throw the correction away.
 */
const indexOneFile = async (itemId, format) => {
  const url = format.url.trim();
  const ourFilename = scanFilenameFromUrl(itemId, url);
  // Anything not on our disk is fetched, read and thrown away. That covers both
  // a file flagged external and a material catalogued as a bare source link.
  const isExternal = format.external === true || !ourFilename;

  let filePath, filename, ext, temporary = false;
  if (isExternal) {
    let got;
    try {
      got = await fetchExternalDocument(url);
    } catch (e) {
      return { state: 'failed', external: true, detail: clip(e?.message || String(e), 300) };
    }
    filePath = got.file; ext = got.type; temporary = true;
    filename = decodeURIComponent((url.split('/').pop() || '').split(/[?#]/)[0]).slice(0, 120) || `external${ext}`;
  } else {
    filename = ourFilename;
    filePath = path.join(CONTENT_DIR, itemId, filename);
    if (!fs.existsSync(filePath)) return { state: 'failed', filename, detail: 'Файла нет на диске' };
    ext = path.extname(filename).toLowerCase();
    if (SCAN_MEDIA_EXT.has(ext)) return { state: 'skipped', filename, detail: 'Аудио и видео — шаг с субтитрами' };
  }

  let pages, method, labels = { labels: [], confident: false, offset: null };
  try {
    if (ext === '.pdf') {
      pages = await extractPdfPages(filePath);
      labels = derivePageLabels(pages);
      method = 'pdftotext';
    } else if (ext === '.epub' || ext === '.fb2') {
      pages = await extractEpubText(filePath);
      method = 'epub';
    } else {
      return { state: 'skipped', filename, detail: `Формат ${ext} не извлекаем` };
    }
  } catch (e) {
    return { state: 'failed', external: isExternal, filename, detail: clip(e?.message || String(e), 300) };
  } finally {
    // The copy has served its only purpose the moment the text is out.
    if (temporary) { try { fs.unlinkSync(filePath); } catch { /* already gone */ } }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Which pages a human owns. Everything else is rebuilt from the file.
    const manual = new Set((await client.query(
      `SELECT page FROM document_text
        WHERE item_id = $1 AND format_url = $2 AND source = 'manual'`,
      [itemId, url],
    )).rows.map(r => r.page));

    await client.query(
      `DELETE FROM document_text WHERE item_id = $1 AND format_url = $2 AND source <> 'manual'`,
      [itemId, url],
    );
    await client.query('DELETE FROM chunks WHERE item_id = $1 AND format_url = $2', [itemId, url]);

    const isPaged = method === 'pdftotext';
    for (let i = 0; i < pages.length; i++) {
      const page = isPaged ? i + 1 : 0;
      if (manual.has(page)) continue;
      const text = pages[i];
      if (!text.trim()) continue;
      await client.query(
        `INSERT INTO document_text (item_id, format_url, page, page_label, source, text, chars, external)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (item_id, format_url, page) DO UPDATE
           SET page_label = $4, source = $5, text = $6, chars = $7, external = $8, updated_at = NOW()`,
        [itemId, url, page, labels.labels[i] || null, method, text, scanCountChars(text), isExternal],
      );
    }

    // Chunks are always cut from what is stored, not from what was extracted —
    // that is how a corrected page reaches the index instead of the raw one.
    const stored = (await client.query(
      `SELECT page, page_label, text FROM document_text
        WHERE item_id = $1 AND format_url = $2 ORDER BY page`,
      [itemId, url],
    )).rows;

    const chunkRows = [];
    let chars = 0;
    for (const row of stored) {
      chars += scanCountChars(row.text);
      for (const text of chunkText(row.text)) {
        chunkRows.push({ page: row.page, pageLabel: row.page_label, heading: null, text });
      }
    }
    await insertChunks(client, itemId, url, chunkRows, isExternal);

    const quality = stored.length
      ? stored.reduce((sum, r) => sum + textQuality(r.text), 0) / stored.length
      : 0;

    const externalNote = isExternal
      ? 'Внешний источник: файл скачан для индексации и удалён, кнопка ведёт к источнику. '
      : '';
    const detail = method === 'pdftotext' && !labels.confident
      ? 'Напечатанные номера страниц не определились — показывается номер страницы файла'
      : method === 'epub'
        ? 'EPUB: позиция внутри книги пока не сохраняется, читалка откроет книгу с начала'
        : null;

    await client.query(
      `INSERT INTO index_status
         (item_id, format_url, filename, state, method, pages, chars, chunk_count, quality, manual_pages, detail, external, indexed_at)
       VALUES ($1,$2,$3,'indexed',$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (item_id, format_url) DO UPDATE SET
         filename = $3, state = 'indexed', method = $4, pages = $5, chars = $6,
         chunk_count = $7, quality = $8, manual_pages = $9, detail = $10,
         external = $11, indexed_at = NOW()`,
      [itemId, url, filename, method, stored.length, chars, chunkRows.length,
       quality, manual.size, (externalNote + (detail || '')).trim() || null, isExternal],
    );

    await client.query('COMMIT');
    return { state: 'indexed', filename, pages: stored.length, chunks: chunkRows.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { state: 'failed', filename, detail: clip(e?.message || String(e), 300) };
  } finally {
    client.release();
  }
};

const runIndex = async (onlyItemId = null) => {
  Object.assign(indexJob, {
    running: true, startedAt: new Date().toISOString(), finishedAt: null,
    total: 0, done: 0, current: '', error: null, stopRequested: false,
  });
  try {
    const { rows } = onlyItemId
      ? await pool.query('SELECT id, data FROM items WHERE id = $1', [onlyItemId])
      : await pool.query('SELECT id, data FROM items ORDER BY seq');

    const targets = [];
    for (const row of rows) {
      const item = row.data || {};
      const title = item.title?.ru || item.title?.en || item.title?.es || row.id;
      const formats = (Array.isArray(item.formats) ? item.formats : [])
        .filter(f => typeof f?.url === 'string' && f.url.trim());
      for (const format of formats) targets.push({ itemId: row.id, title, format });
      // Only when nothing else stands in for the material — on a hosted PDF the
      // source link is attribution, not a second thing to index.
      const sourceUrl = typeof item.source?.url === 'string' ? item.source.url.trim() : '';
      if (!formats.length && sourceUrl) {
        targets.push({
          itemId: row.id, title,
          format: { url: sourceUrl, name: item.source?.name || 'источник', external: true },
        });
      }
    }
    indexJob.total = targets.length;

    for (const { itemId, title, format } of targets) {
      if (indexJob.stopRequested) break;
      indexJob.current = `${title} · ${format.name || ''}`.trim();
      const r = await indexOneFile(itemId, format);
      if (r.state !== 'indexed') {
        await pool.query(
          `INSERT INTO index_status (item_id, format_url, filename, state, detail, indexed_at)
           VALUES ($1,$2,$3,$4,$5, NOW())
           ON CONFLICT (item_id, format_url) DO UPDATE SET
             filename = $3, state = $4, detail = $5, indexed_at = NOW()`,
          [itemId, format.url.trim(), r.filename || null, r.state, r.detail || null],
        );
      }
      indexJob.done += 1;
    }

    // Rows about targets that no longer exist. A file whose URL was edited, or
    // a material that was deleted, leaves its old index_status row behind, and
    // that row keeps being counted — as an indexed file nobody can open, or as
    // a failure nobody can fix. Only a complete, uninterrupted run knows the
    // full set of targets, so only it may clean up.
    if (!onlyItemId && !indexJob.stopRequested) {
      await pool.query(
        `DELETE FROM index_status s
          WHERE NOT EXISTS (
                  SELECT 1 FROM items i WHERE i.id = s.item_id
                )
             OR (s.item_id || ' ' || s.format_url) <> ALL($1::text[])`,
        [[
          ...targets.map(t => `${t.itemId} ${t.format.url.trim()}`),
          // Transcripts are written by the queue, not by this run; their targets
          // are still real and must not be swept away with the dead ones.
          ...(await pool.query('SELECT id, data FROM items')).rows.flatMap(row =>
            spokenTargets({ ...(row.data || {}), id: row.id })
              .map(t => `${row.id} ${t.url}`)),
        ]],
      ).catch(e => console.error('index cleanup failed:', e?.message || e));
    }
  } catch (e) {
    indexJob.error = clip(e?.message || String(e), 300);
    console.error('indexing failed:', e);
  } finally {
    indexJob.running = false;
    indexJob.finishedAt = new Date().toISOString();
    indexJob.current = '';
  }
};

app.post('/api/admin/index', requireApiKey, (req, res) => {
  if (indexJob.running) return res.status(409).json({ error: 'Indexing already running' });
  const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : null;
  if (itemId && !/^[a-zA-Z0-9_-]{1,64}$/.test(itemId)) {
    return res.status(400).json({ error: 'Invalid itemId' });
  }
  runIndex(itemId);
  res.json({ started: true });
});

app.post('/api/admin/index/stop', requireApiKey, (req, res) => {
  if (indexJob.running) indexJob.stopRequested = true;
  res.json({ ok: true });
});

app.get('/api/admin/index', requireApiKey, async (req, res) => {
  try {
    const rows = (await pool.query(`
      SELECT s.item_id, s.format_url, s.filename, s.state, s.method, s.pages,
             s.chars, s.chunk_count, s.quality, s.manual_pages, s.detail,
             s.external, s.indexed_at,
             i.data->'title' AS title
        FROM index_status s
        LEFT JOIN items i ON i.id = s.item_id
       ORDER BY CASE s.state WHEN 'failed' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END,
                s.quality NULLS FIRST, s.item_id
       LIMIT 2000
    `)).rows;

    const totals = (await pool.query(`
      SELECT COUNT(*) FILTER (WHERE state = 'indexed')::int AS indexed,
             COUNT(*) FILTER (WHERE state = 'failed')::int  AS failed,
             COUNT(*) FILTER (WHERE state = 'skipped')::int AS skipped,
             COALESCE(SUM(pages) FILTER (WHERE state = 'indexed'), 0)::int   AS pages,
             COALESCE(SUM(chars) FILTER (WHERE state = 'indexed'), 0)::bigint AS chars,
             COALESCE(SUM(chunk_count) FILTER (WHERE state = 'indexed'), 0)::int AS chunks,
             COALESCE(SUM(manual_pages), 0)::int AS manual_pages
        FROM index_status
    `)).rows[0];

    // How much there is to index at all, so "24 of 23" cannot happen. It did:
    // the denominator counted files and source links while the numerator also
    // counted transcripts, so indexing a video pushed the count past its own
    // total. A video link is a source like any other — it belongs in both.
    const fileCounts = (await pool.query(`
      WITH files AS (
        SELECT i.id, f->>'url' AS url
          FROM items i, jsonb_array_elements(
                 CASE WHEN jsonb_typeof(i.data->'formats') = 'array'
                      THEN i.data->'formats' ELSE '[]'::jsonb END) f
         WHERE COALESCE(f->>'url', '') <> ''
      ), sources AS (
        -- A material whose only pointer is a source link is indexed too: the
        -- file is fetched, read and thrown away.
        SELECT i.id
          FROM items i
         WHERE COALESCE(i.data->'source'->>'url', '') <> ''
           AND NOT EXISTS (SELECT 1 FROM files WHERE files.id = i.id)
      )
      SELECT (SELECT COUNT(*) FROM files
               WHERE url NOT LIKE '%.srt' AND url NOT LIKE '%.vtt')::int AS files,
             (SELECT COUNT(*) FROM sources)::int AS sources
    `)).rows[0];

    // Spoken targets come from the same function the transcribe queue uses, so
    // the count can never describe work the server would not actually attempt.
    const spoken = [];
    for (const row of (await pool.query('SELECT id, data FROM items')).rows) {
      for (const target of spokenTargets({ ...(row.data || {}), id: row.id })) {
        spoken.push({ itemId: row.id, url: target.url, platform: target.platform });
      }
    }
    const doneTargets = new Set((await pool.query(
      `SELECT item_id, format_url FROM index_status WHERE state = 'indexed'`,
    )).rows.map(r => `${r.item_id} ${r.format_url}`));
    const spokenPending = spoken.filter(t => !doneTargets.has(`${t.itemId} ${t.url}`)).length;

    // A media file already counts among the files; a platform link does not
    // count anywhere else, so only it is added.
    const indexable = fileCounts.files + fileCounts.sources
      + spoken.filter(t => t.platform).length;

    res.json({
      job: indexJobView(),
      rows: rows.map(r => ({ ...r, chars: r.chars === null ? null : Number(r.chars) })),
      totals: {
        ...totals, chars: Number(totals.chars), indexable,
        spoken: spoken.length, spoken_pending: spokenPending,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Drop everything produced from sources we do not host. The point of flagging
// them at index time: reversing that decision is one query, not an audit.
app.post('/api/admin/index/purge-external', requireApiKey, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chunks = await client.query('DELETE FROM chunks WHERE external');
    await client.query('DELETE FROM document_text WHERE external');
    const files = await client.query('DELETE FROM index_status WHERE external');
    await client.query('COMMIT');
    res.json({ files: files.rowCount, chunks: chunks.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Take one material out of the index without touching the catalogue.
//
// The counterpart of the index button: an admin who can put a material in has
// to be able to take it out, or "try it and see" is a one-way door. This is
// also the narrow first half of the removal step — same cascade, one material.
app.delete('/api/admin/index/:itemId', requireApiKey, validateItemId, async (req, res) => {
  const { itemId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chunks = await client.query('DELETE FROM chunks WHERE item_id = $1', [itemId]);
    await client.query('DELETE FROM document_text WHERE item_id = $1', [itemId]);
    const files = await client.query('DELETE FROM index_status WHERE item_id = $1', [itemId]);
    await client.query('COMMIT');
    res.json({ files: files.rowCount, chunks: chunks.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Per-page report for one file: what was extracted, how good it looks, and
// whether a human has already been here.
app.get('/api/admin/index/pages', requireApiKey, async (req, res) => {
  const { item, format } = req.query;
  if (typeof item !== 'string' || typeof format !== 'string') {
    return res.status(400).json({ error: 'item and format are required' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const rows = (await pool.query(
      `SELECT page, page_label, source, chars, text, updated_at
         FROM document_text
        WHERE item_id = $1 AND format_url = $2
        ORDER BY page LIMIT $3 OFFSET $4`,
      [item, format, limit, offset],
    )).rows;
    const total = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM document_text WHERE item_id = $1 AND format_url = $2',
      [item, format],
    )).rows[0].n;
    res.json({
      total,
      pages: rows.map(r => ({ ...r, quality: textQuality(r.text) })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Correct one page by hand. Marked 'manual', which makes it survive every later
// re-index — without that guarantee, fixing a formula would be wasted effort.
app.put('/api/admin/index/page', requireApiKey, async (req, res) => {
  const { itemId, formatUrl, page, text } = req.body || {};
  if (typeof itemId !== 'string' || typeof formatUrl !== 'string'
      || !Number.isInteger(page) || typeof text !== 'string') {
    return res.status(400).json({ error: 'itemId, formatUrl, page and text are required' });
  }
  if (text.length > 2_000_000) return res.status(400).json({ error: 'Text too large' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT page_label FROM document_text WHERE item_id = $1 AND format_url = $2 AND page = $3',
      [itemId, formatUrl, page],
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Page not found' });
    }
    await client.query(
      `UPDATE document_text
          SET text = $4, chars = $5, source = 'manual', updated_at = NOW()
        WHERE item_id = $1 AND format_url = $2 AND page = $3`,
      [itemId, formatUrl, page, text, scanCountChars(text)],
    );
    // Only this page's chunks are rebuilt; the rest of the book is untouched.
    await client.query(
      'DELETE FROM chunks WHERE item_id = $1 AND format_url = $2 AND page = $3',
      [itemId, formatUrl, page],
    );
    const label = existing.rows[0].page_label;
    await insertChunks(client, itemId, formatUrl,
      chunkText(text).map(t => ({ page, pageLabel: label, heading: null, text: t })));
    await client.query(
      `UPDATE index_status
          SET manual_pages = (SELECT COUNT(*) FROM document_text
                               WHERE item_id = $1 AND format_url = $2 AND source = 'manual'),
              chunk_count = (SELECT COUNT(*) FROM chunks
                              WHERE item_id = $1 AND format_url = $2)
        WHERE item_id = $1 AND format_url = $2`,
      [itemId, formatUrl],
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Withdrawal ───────────────────────────────────────────────────────────────
//
// The library indexes material it does not own, on the owner's decision. The
// engineering half of that decision is making the way back cheap: a question
// about somebody's rights must be answerable in minutes, and answering it must
// not cost a re-run of recognition and embedding.
//
// So "убрать" has two strengths, and they are deliberately not one control:
//
//   Заморозка — the material stops answering questions and keeps its text. One
//               row appears in index_holds; deleting it brings the material
//               back instantly, with nothing recognised or embedded again.
//   Вычистить — the text goes: pages, chunks, vectors, extraction status. Back
//               only by indexing from scratch.
//
// Every decision is written down, including the irreversible ones, and the log
// outlives the material: the most valuable row in it is the one about a book
// that is no longer here.

const WITHDRAW_ACTIONS = new Set(['freeze', 'unfreeze', 'purge', 'delete']);

const logWithdrawal = async (client, { itemId, title, action, reason, byWhom, detail }) => {
  await client.query(
    `INSERT INTO withdrawals (item_id, title, action, reason, by_whom, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [itemId, clip(title || null, 300), action, clip(reason || null, 500),
     clip(byWhom || null, 120), clip(detail || null, 300)],
  );
};

const itemTitleOf = row => {
  const d = row?.data || {};
  return d.title?.ru || d.title?.en || d.title?.es || row?.id || null;
};

app.post('/api/admin/withdraw', requireApiKey, async (req, res) => {
  const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : '';
  const action = typeof req.body?.action === 'string' ? req.body.action : '';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
  const byWhom = typeof req.body?.byWhom === 'string' ? req.body.byWhom : 'admin';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(itemId)) return res.status(400).json({ error: 'Invalid itemId' });
  if (!WITHDRAW_ACTIONS.has(action)) return res.status(400).json({ error: 'Unknown action' });

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT id, data FROM items WHERE id = $1', [itemId]);
    const title = itemTitleOf(rows[0]);
    // A material can be withdrawn after it has already been deleted from the
    // catalogue — the index rows outlive the item when something went wrong —
    // so a missing item is not an error for anything except freezing.
    if (!rows.length && action === 'freeze') return res.status(404).json({ error: 'Материала нет в каталоге' });

    await client.query('BEGIN');
    let detail = '';

    if (action === 'freeze') {
      await client.query(
        `INSERT INTO index_holds (item_id, reason, by_whom) VALUES ($1,$2,$3)
         ON CONFLICT (item_id) DO UPDATE SET reason = $2, by_whom = $3, since = NOW()`,
        [itemId, clip(reason, 500), clip(byWhom, 120)],
      );
      detail = 'текст сохранён';
    } else if (action === 'unfreeze') {
      const r = await client.query('DELETE FROM index_holds WHERE item_id = $1', [itemId]);
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Этот материал не заморожен' });
      }
      detail = 'вернулся в поиск сразу, без переиндексации';
    } else if (action === 'purge') {
      const chunks = await client.query('DELETE FROM chunks WHERE item_id = $1', [itemId]);
      await client.query('DELETE FROM document_text WHERE item_id = $1', [itemId]);
      const files = await client.query('DELETE FROM index_status WHERE item_id = $1', [itemId]);
      // Vectors go with the chunks by cascade; the hold becomes meaningless
      // once there is nothing left to hold back.
      await client.query('DELETE FROM index_holds WHERE item_id = $1', [itemId]);
      detail = `${chunks.rowCount} кусков, ${files.rowCount} файлов`;
    } else if (action === 'delete') {
      // The catalogue entry and everything derived from it. Same sweep the
      // ordinary delete does, kept here so the log records the reason.
      for (const sql of [
        'DELETE FROM chunks WHERE item_id = $1',
        'DELETE FROM document_text WHERE item_id = $1',
        'DELETE FROM index_status WHERE item_id = $1',
        'DELETE FROM content_scan WHERE item_id = $1',
        'DELETE FROM index_holds WHERE item_id = $1',
        'DELETE FROM items WHERE id = $1',
      ]) await client.query(sql, [itemId]);
      try { fs.rmSync(path.join(CONTENT_DIR, itemId), { recursive: true, force: true }); } catch { /* nothing on disk */ }
      detail = 'материал и файлы удалены';
    }

    await logWithdrawal(client, { itemId, title, action, reason, byWhom, detail });
    await client.query('COMMIT');
    // Frozen or purged, the in-memory vector index is now describing passages
    // that must not answer: rebuild it on the next search rather than in fifteen
    // seconds' time.
    vectorIndex.checkedAt = 0;
    res.json({ ok: true, action, detail });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Which materials are out of the search, and the record of every decision.
app.get('/api/admin/withdrawals', requireApiKey, async (req, res) => {
  try {
    const holds = (await pool.query(
      `SELECT h.item_id, h.reason, h.by_whom, h.since,
              i.data->'title' AS title,
              (SELECT COUNT(*)::int FROM chunks c WHERE c.item_id = h.item_id) AS chunks
         FROM index_holds h
         LEFT JOIN items i ON i.id = h.item_id
        ORDER BY h.since DESC`)).rows;
    const log = (await pool.query(
      `SELECT id, item_id, title, action, reason, by_whom, detail, at
         FROM withdrawals ORDER BY at DESC LIMIT 100`)).rows;
    // The count that decides where a rights question starts: material in the
    // index whose basis for being here nobody has written down.
    const { rows: [{ n: unknownBasis }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM items i
        WHERE COALESCE(i.data->>'rightsBasis', 'unknown') = 'unknown'
          AND EXISTS (SELECT 1 FROM chunks c WHERE c.item_id = i.id)`);
    res.json({ holds, log, unknownBasis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Vectors ──────────────────────────────────────────────────────────────────
//
// Full-text search finds the words that were typed. It cannot find the passage
// that says the same thing in other words — "vol crush" for падение
// волатильности, "theta decay" for временной распад — and the reader who asks
// in their own words gets silence from a library that holds the answer.
//
// A vector is a passage expressed as a point, so passages about one subject sit
// near each other whatever words they used. Everything below runs on the
// processor and nothing leaves the server: the model is local, the arithmetic
// is a dot product, and the only network call is the one an operator configures
// on purpose.
//
// Vectors never replace the word search. They are a second opinion, fused with
// it — see the search query for how, and why "no vectors" reproduces today's
// ranking exactly rather than approximately.

const EMBED_MODEL = process.env.EMBED_MODEL || 'Xenova/multilingual-e5-small';
const EMBED_DIM = parseInt(process.env.EMBED_DIM, 10) || 384;
const EMBED_BATCH = parseInt(process.env.EMBED_BATCH, 10) || 16;
// Where the model files live. Same volume as the whisper models, so an operator
// can drop the files in by hand on a server with no access to a model hub.
const EMBED_HOME = process.env.EMBED_HOME || '/mnt/library/models/embed';
// An OpenAI-shaped /embeddings service, when one is already running beside us.
// Meant for a local address — a remote one would send the library's text to
// somebody else, which is the one thing this design is built to avoid.
const EMBED_ENDPOINT = process.env.EMBED_ENDPOINT || '';
// How close to the best match a passage must be to count as a match at all.
//
// Relative, not absolute, because the scale is the model's business: e5 packs
// everything between 0.7 and 0.9, another model spreads the same distances over
// 0.1 to 1.0, and a fixed threshold would mean "everything" for one and
// "nothing" for the other. Nine tenths of the best score is a strong statement
// in either scale — without it the meaning search hands sixty loosely related
// passages to every query, and they crowd out the literal answers.
const EMBED_REL_FLOOR = Number.isFinite(Number(process.env.EMBED_REL_FLOOR))
  ? Number(process.env.EMBED_REL_FLOOR) : 0.9;

// e5 models were trained with these prefixes and lose accuracy without them.
const EMBED_QUERY_PREFIX = process.env.EMBED_QUERY_PREFIX ?? 'query: ';
const EMBED_PASSAGE_PREFIX = process.env.EMBED_PASSAGE_PREFIX ?? 'passage: ';

// Why a vector search can't run right now, in the operator's words. Held so the
// admin panel can say it instead of showing an empty coverage bar.
let embedFault = null;

// A broken embedder must cost one attempt every few minutes, not one per
// reader. Without this, a missing model file turns every single search into a
// failed model load — the search still answers, but slowly, and the log fills
// with the same line forever. The queue job ignores the cooldown: it is the one
// caller that must hear the real error immediately.
const EMBED_RETRY_MS = 5 * 60 * 1000;
let embedColdUntil = 0;

let embedderPromise = null;
const localEmbedder = () => {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      // Imported at first use, never at boot: a missing or broken install must
      // cost the library its vector search, not its ability to serve pages.
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = EMBED_HOME;
      env.localModelPath = EMBED_HOME;
      return pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
    })().catch(e => { embedderPromise = null; throw e; });
  }
  return embedderPromise;
};

const l2normalize = v => {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
};

/**
 * Turn texts into unit vectors. Returns null — never throws — when no embedder
 * is available, because every caller's correct response to that is to carry on
 * without vectors.
 */
const embedTexts = async (texts, kind = 'passage', force = false) => {
  if (!texts.length) return [];
  if (!force && Date.now() < embedColdUntil) return null;
  const prefix = kind === 'query' ? EMBED_QUERY_PREFIX : EMBED_PASSAGE_PREFIX;
  const input = texts.map(t => prefix + clip(String(t || '').replace(/\s+/g, ' ').trim(), 4000));
  try {
    if (EMBED_ENDPOINT) {
      const res = await fetch(EMBED_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`служба векторов ответила ${res.status}`);
      const body = await res.json();
      const out = (body?.data || []).map(d => l2normalize(Float32Array.from(d.embedding || [])));
      if (out.length !== input.length) throw new Error('служба векторов вернула не столько векторов');
      embedColdUntil = 0;
      embedFault = null;
      return out;
    }
    const pipe = await localEmbedder();
    const out = await pipe(input, { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const flat = out.data;
    const vectors = [];
    for (let i = 0; i < input.length; i++) {
      vectors.push(l2normalize(Float32Array.from(flat.slice(i * dim, (i + 1) * dim))));
    }
    embedColdUntil = 0;
    embedFault = null;
    return vectors;
  } catch (e) {
    embedFault = explainEmbed(e);
    embedColdUntil = Date.now() + EMBED_RETRY_MS;
    console.error('embedding failed:', e?.message || e);
    return null;
  }
};

// The three ways this fails on a real server, said plainly.
const explainEmbed = e => {
  const text = String(e?.message || e || '');
  if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(text)) {
    return 'Модель не установлена в образе: нет пакета @xenova/transformers. Пересоберите образ API.';
  }
  if (/Forbidden|ENOTFOUND|EAI_AGAIN|fetch failed|ECONNREFUSED|403|404/i.test(text)) {
    // Two very different faults hide behind one network error, and pointing an
    // operator at the model files when the configured service is simply down
    // sends them to the wrong place entirely.
    return EMBED_ENDPOINT
      ? `Служба векторов не отвечает: ${EMBED_ENDPOINT}. (${clip(text, 120)})`
      : `Файлы модели недоступны. Положите их в ${EMBED_HOME} или откройте серверу доступ к хабу моделей. (${clip(text, 120)})`;
  }
  return clip(text, 300);
};

// One query is asked by many readers within a minute, and embedding it costs
// more than the search itself. Bounded so a flood of distinct queries cannot
// grow it without limit.
const queryVectors = new Map();
const embedQuery = async q => {
  const key = q.toLowerCase();
  if (queryVectors.has(key)) return queryVectors.get(key);
  const [vec] = (await embedTexts([q], 'query')) || [];
  if (!vec) return null;
  if (queryVectors.size > 500) queryVectors.clear();
  queryVectors.set(key, vec);
  return vec;
};

// ── The index in memory ──────────────────────────────────────────────────────
//
// Loaded whole and scanned in full. At twelve thousand chunks that is 18 MB and
// about five milliseconds per query — an approximate-neighbour structure would
// add a moving part and save nothing until this library is twenty times larger.

const vectorIndex = { ids: [], cyr: null, mat: null, dim: 0, model: '', stamp: '', checkedAt: 0 };

const vectorStamp = async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(MAX(chunk_id), 0)::text AS max FROM chunk_vectors WHERE model = $1`,
    [EMBED_MODEL],
  );
  return `${rows[0].n}:${rows[0].max}`;
};

const loadVectorIndex = async () => {
  const now = Date.now();
  // Rebuilding is cheap but not free; a query storm should not re-read the
  // table for every reader.
  if (vectorIndex.mat && now - vectorIndex.checkedAt < 15_000) return vectorIndex;
  const stamp = await vectorStamp();
  vectorIndex.checkedAt = now;
  if (vectorIndex.mat && stamp === vectorIndex.stamp) return vectorIndex;

  // The script each passage is written in comes along for the ride: it is what
  // makes "show me what the English books say about this" answerable.
  const { rows } = await pool.query(
    `SELECT v.chunk_id, v.dim, v.vec, (c.text ~ '[А-Яа-яЁё]') AS cyr
       FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id
      WHERE v.model = $1
        AND length(regexp_replace(c.text, '[^[:alpha:]]', '', 'g')) >= $2
      ORDER BY v.chunk_id`, [EMBED_MODEL, EMBED_MIN_LETTERS],
  );
  const dim = rows.length ? rows[0].dim : EMBED_DIM;
  const mat = new Float32Array(rows.length * dim);
  const ids = new Array(rows.length);
  const cyr = new Uint8Array(rows.length);
  let n = 0;
  for (const r of rows) {
    if (r.dim !== dim) continue;   // a leftover from another model: skip, don't guess
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, dim);
    mat.set(v, n * dim);
    ids[n] = String(r.chunk_id);
    cyr[n] = r.cyr ? 1 : 0;
    n += 1;
  }
  vectorIndex.ids = ids.slice(0, n);
  vectorIndex.cyr = cyr.subarray(0, n);
  vectorIndex.mat = mat.subarray(0, n * dim);
  vectorIndex.dim = dim;
  vectorIndex.model = EMBED_MODEL;
  vectorIndex.stamp = stamp;
  return vectorIndex;
};

/** Chunk ids nearest the query vector, closest first. Vectors are unit length, so cosine is a dot product. */
const nearestChunks = (qvec, k, only = null) => {
  const { ids, mat, dim, cyr } = vectorIndex;
  if (!ids.length || qvec.length !== dim) return [];
  const best = [];   // small k, so an insertion sort beats sorting everything
  for (let i = 0; i < ids.length; i++) {
    if (only !== null && cyr && cyr[i] !== only) continue;
    let dot = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) dot += mat[off + d] * qvec[d];
    if (best.length < k) {
      best.push({ id: ids[i], dot });
      if (best.length === k) best.sort((a, b) => b.dot - a.dot);
    } else if (dot > best[k - 1].dot) {
      best[k - 1] = { id: ids[i], dot };
      let j = k - 1;
      while (j > 0 && best[j].dot > best[j - 1].dot) { const t = best[j]; best[j] = best[j - 1]; best[j - 1] = t; j--; }
    }
  }
  if (best.length < k) best.sort((a, b) => b.dot - a.dot);
  return best;
};

// A pass reserved for the other language.
//
// Asked in Russian about a subject the library discusses in both languages, the
// nearest sixty passages are all Russian — the model puts a literal match above
// a translated one, and there are enough Russian pages to fill the list. The
// English shelf is then never offered, which is the one thing a bilingual
// library exists to do.
//
// So the other script gets its own short list, ranked among itself. It is
// appended after the main one, which is what it deserves: a same-language match
// is usually the better answer, and this is the "and here is what the other
// half of the library says" tail.
// Read so that zero means zero. `parseInt(...) || 12` would quietly ignore an
// operator who switches the reserve off, which is exactly the setting someone
// reaches for first when they suspect it of causing trouble.
const envNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};
const EMBED_CROSS_K = envNum('EMBED_CROSS_K', 12);

// A passage has to say something before it can be about something. "---- End of
// Script ---- 31" is page furniture: its vector is dominated by punctuation and
// it lands near everything, which is how a line of dashes turns up as an answer
// about volatility.
//
// The measure is letters, not length. A short sentence is a real answer and
// must stay; a long row of dashes and page numbers is not, however long it is.
// Word search may still find such a chunk — there the reader typed the word and
// it is genuinely there — but meaning may not offer it.
const EMBED_MIN_LETTERS = envNum('EMBED_MIN_LETTERS', 40);

const keepClose = hits => {
  if (!hits.length) return [];
  const floor = hits[0].dot * EMBED_REL_FLOOR;
  return hits.filter(h => h.dot >= floor);
};

/** Candidate chunk ids for a query, or an empty list when vectors are not available. */
const vectorCandidates = async (q, k) => {
  try {
    const index = await loadVectorIndex();
    if (!index.ids.length) return [];
    const qvec = await embedQuery(q);
    if (!qvec) return [];
    const main = keepClose(nearestChunks(qvec, k));
    if (!main.length) return [];

    // Which half of the library the question itself is written in.
    const asked = /[А-Яа-яЁё]/.test(q) ? 1 : 0;
    const cross = EMBED_CROSS_K ? keepClose(nearestChunks(qvec, EMBED_CROSS_K, asked ? 0 : 1)) : [];
    const seen = new Set(main.map(h => h.id));
    return [...main.map(h => h.id), ...cross.filter(h => !seen.has(h.id)).map(h => h.id)];
  } catch (e) {
    embedFault = explainEmbed(e);
    console.error('vector search unavailable:', e?.message || e);
    return [];
  }
};

// The one search query in the application, named so the answer layer can ask
// the same question the reader asked and get the same passages back. Two
// callers, one ranking: an answer assembled from a different shortlist than
// the one on screen would quote pages the reader cannot see.
const SEARCH_SQL = `WITH q AS (
         SELECT websearch_to_tsquery('russian'::regconfig, $1) ||
                websearch_to_tsquery('english'::regconfig, $1) AS tsq
       ),
       matched AS (
         SELECT c.id, c.item_id, ts_rank(c.tsv, q.tsq) AS fts, v.ord AS vord
           FROM chunks c
           CROSS JOIN q
           LEFT JOIN items i ON i.id = c.item_id
           -- The passages the meaning search brought, in its order. Empty when
           -- vectors are off, which is how this whole branch disappears.
           LEFT JOIN unnest($6::bigint[]) WITH ORDINALITY AS v(vid, ord) ON v.vid = c.id
          WHERE (c.tsv @@ q.tsq OR v.vid IS NOT NULL)
            -- Frozen material is in the catalogue and out of the search. One
            -- row in index_holds is the whole mechanism, which is what makes
            -- coming back free.
            AND NOT EXISTS (SELECT 1 FROM index_holds hh WHERE hh.item_id = c.item_id)
            -- Compared as text on purpose. A cast would throw on any item whose
            -- isPrivate is not a clean boolean — one bad row in the catalogue
            -- would then empty every search result for everyone.
            AND ($4::boolean OR COALESCE(i.data->>'isPrivate', 'false') NOT IN ('true', '1'))
            AND ($5::text IS NULL OR c.item_id = $5)
       ),
       scored AS (
         -- Rank inside each of the two lists. Partitioning on "did the words
         -- match at all" keeps the word ranking free of the vector-only rows.
         SELECT id, item_id, fts, vord,
                RANK() OVER (PARTITION BY (fts > 0) ORDER BY fts DESC) AS fts_rank
           FROM matched
       ),
       fused AS (
         -- Whether the words matched travels with the row: a passage the meaning
         -- search alone found has nothing highlighted, and the reader is owed
         -- the reason.
         -- Reciprocal rank fusion: each list contributes 1/(60 + place in it).
         -- Positions, not scores, because a ts_rank and a cosine are not on the
         -- same scale and pretending otherwise is how one silently wins.
         --
         -- With no vectors every row scores 1/(60 + word rank), which is the
         -- old ordering exactly — not merely close to it. That is the property
         -- worth having: switching vectors off restores today's search.
         SELECT id, item_id, (fts > 0) AS by_words,
                (CASE WHEN fts > 0 THEN 1.0 / (60 + fts_rank) ELSE 0 END)
              + (CASE WHEN vord IS NOT NULL THEN 1.0 / (60 + vord) ELSE 0 END) AS rank
           FROM scored
       ),
       ranked AS (
         SELECT id, item_id, rank, by_words,
                ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY rank DESC, id) AS rn,
                -- How much this material has to say beyond what is shown. It is
                -- the difference between "the video mentions it once" and "the
                -- video mentions it eleven times and you are seeing one".
                COUNT(*)     OVER (PARTITION BY item_id) AS item_total
           FROM fused
       ),
       hits AS (
         -- Three places from any one material, however much room is left. Seven
         -- rows of the same book saying the same sentence is not seven answers,
         -- and the reader who wants the eighth can ask for it.
         --
         -- Fetched with room to spare: neighbouring chunks share their edges, so
         -- some of these rows are the same passage twice and get dropped below.
         SELECT id, rank, rn, by_words, item_total FROM ranked
          WHERE $5::text IS NOT NULL OR rn <= 3
          ORDER BY rn, rank DESC, id LIMIT $2
       )
       SELECT c.id AS chunk_id, c.item_id, c.format_url, c.page, c.page_label,
              c.second_start, c.second_end, h.rank, h.rn, h.by_words, h.item_total,
              -- Computed only for the rows that survived, never for every match.
              ts_headline($3::regconfig, c.text, q.tsq,
                          'MaxFragments=1,MaxWords=40,MinWords=15') AS snippet,
              i.data->'title' AS title, i.data->>'author' AS author
         FROM hits h
         JOIN chunks c ON c.id = h.id
         CROSS JOIN q
         LEFT JOIN items i ON i.id = c.item_id
        -- The material with the strongest single hit leads; every other hit of
        -- that same material follows it immediately, in order of position.
        ORDER BY MAX(h.rank) OVER (PARTITION BY c.item_id) DESC,
                 c.item_id,
                 c.second_start ASC NULLS LAST,
                 c.page ASC NULLS LAST,
                 h.rank DESC`;

const searchRows = async ({ q, fetchLimit, headlineConfig, maySeePrivate, onlyItem, near }) =>
  (await pool.query(SEARCH_SQL, [q, fetchLimit, headlineConfig, maySeePrivate, onlyItem, near])).rows;

// Full-text search over the chunks.
//
// Admin-only for now, deliberately. Opening it to readers needs the private-item
// check the download path already does, and shipping a public endpoint that
// leaks the contents of a restricted book would be a poor way to find that out.
// Neighbouring chunks deliberately share their edges — 120 characters carried
// forward, so a thought split across a boundary is findable from either side.
// That is right for the index and wrong for the screen: a match that lands in
// the shared part belongs to both chunks, and the reader gets the same sentence
// twice, on the same page, one card under the other.
//
// The index keeps its overlap; the answer drops the repeat. Two hits are the
// same place when the words immediately around the match are the same — that is
// what a reader compares, and it survives the snippets starting at different
// points, which is exactly how the duplicate presents itself.
// Only the words *before* the match count. When the overlap falls at the end of
// a chunk, the first copy has nothing after the match while the second runs on
// for a line — so what follows differs although the passage is the same.
const passageKey = snippet => {
  const words = String(snippet || '').split(/\s+/).filter(Boolean);
  const at = Math.max(0, words.findIndex(w => /<b>/i.test(w)));
  return words.slice(Math.max(0, at - 5), at + 1)
    .map(w => w.replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean)
    .join(' ');
};

const dropRepeatedPassages = rows => {
  const seen = new Map();
  return rows.filter(r => {
    // Same material, same words leading into the match, and no further than the
    // neighbouring page. A book may well repeat a phrase on page 10 and again
    // on page 200 — those are two places worth going to — but the same words at
    // the same edge of two consecutive pages are one place seen twice: either
    // the chunk overlap, or a running header the extractor reads on every page.
    const key = passageKey(r.snippet);
    const at = r.page ?? r.second_start ?? 0;
    const near = seen.get(`${r.item_id} ${key}`);
    if (near !== undefined && Math.abs(near - at) <= 1) return false;
    seen.set(`${r.item_id} ${key}`, at);
    return true;
  });
};

app.get('/api/search', checkUserAccess, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  // Full-text search is the interactive path: it must not wait for model
  // inference while a reader types. Meaning search is explicitly requested by
  // the UI after literal results are already visible.
  const semantic = req.query.semantic === '1';
  const shouldLog = req.query.log !== '0';
  // Asking for one material's places rather than the library's: the reader has
  // already chosen where to look, so everything that material says is fair game.
  const onlyItem = typeof req.query.item === 'string' && req.query.item ? req.query.item : null;
  // Under three characters every keystroke would be a query; and a two-letter
  // stem matches half the corpus anyway.
  if (q.length < 3) return res.json({ results: [] });
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  // Private material is searchable only by someone who could already open it —
  // the same rule the download path enforces. Without this, search would happily
  // quote the contents of a book the reader cannot see.
  const settings = req.cachedSettings || {};
  const user = req.telegramUser;
  const allowed = settings.allowedUsers || [];
  const maySeePrivate = !!settings.globalAccess
    || !!(user && (allowed.includes(user.id) || (user.username && allowed.includes(user.username))));

  try {
    // Headline in the language the question was asked in — stemming a Russian
    // query with the English dictionary highlights the wrong words.
    const headlineConfig = /\p{Script=Cyrillic}/u.test(q) ? 'russian' : 'english';

    // Model inference is optional and deliberately outside the normal typing
    // path. It is useful for paraphrases and cross-language questions, but a
    // slow embedder must never turn an indexed word search into a minute-long
    // wait.
    const tStart = Date.now();
    const near = semantic ? await vectorCandidates(q, 60) : [];
    const tVector = Date.now() - tStart;
    const tSql = Date.now();
    const rows = await searchRows({
      q,
      // Over-fetch, because the duplicates are dropped after the query and the
      // reader should still get a full list. Room for what will be dropped and
      // no more: every extra row is a ts_headline over a page of text.
      fetchLimit: Math.min(limit + 8, 60),
      headlineConfig, maySeePrivate, onlyItem, near,
    });

    // Trimming has to keep the breadth rule, and the rows arrive in *reading*
    // order — grouped by material. Cutting that list at twelve keeps the first
    // four materials with three places each and throws the other four away
    // entirely, which is precisely what it did. So the cut is made on the
    // breadth order (every material's best place first) and the survivors are
    // then shown in reading order again.
    const sqlMs = Date.now() - tSql;
    const deduped = dropRepeatedPassages(rows);
    const keep = new Set([...deduped]
      .sort((a, b) => a.rn - b.rn || b.rank - a.rank)
      .slice(0, limit));
    const results = deduped.filter(r => keep.has(r)).map(({ rn, ...row }) => row);

    // One row per question, filled in later if a result is opened. A query that
    // found nothing is the most valuable row here: it is the list of what the
    // library cannot answer yet.
    //
    // Opening one material's remaining places is the same question asked again,
    // not a new one — logging it would inflate every count in the metric panel.
    let logId = null;
    if (!onlyItem && shouldLog) {
      try {
        const ins = await pool.query(
          'INSERT INTO search_log (query, lang, results, visitor) VALUES ($1,$2,$3,$4) RETURNING id',
          [clip(q, 300), clip(req.query.lang, 8), results.length, visitorHash(resolveVisitorIp(req))],
        );
        logId = ins.rows[0].id;
      } catch { /* logging must never break search */ }
    }

    // Where the time went, and whether the meaning search took part at all.
    // Both questions get asked of a live server sooner or later, and answering
    // them from the outside means guessing.
    const took = { total: Date.now() - tStart, vector: tVector, sql: sqlMs, candidates: near.length, semantic };
    if (took.total > 700) console.warn('search slow:', JSON.stringify({ q: clip(q, 60), ...took }));
    res.json({ results, logId, took });
  } catch (e) {
    // Loud on the server, and honest to the client: a failed search must not
    // arrive looking like a search that found nothing.
    console.error('search failed:', e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

// ── The answer layer ─────────────────────────────────────────────────────────
//
// Two voices, and they must never be confused: the explanation is the model's,
// the quotation is the library's. A model that paraphrases a copyrighted book
// into its own words is redistributing that book; a model that invents a quote
// is worse than useless, because a fabricated citation with a page number is
// believed.
//
// So nothing the model writes is trusted about the sources. Every quotation it
// offers is checked against the passage it claims to come from, character by
// character, by string comparison and not by another model. What does not check
// out does not reach the reader.
//
// The layer is optional and off until configured: with no model the library is
// exactly the search it is today.

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || '';       // OpenAI-shaped /chat/completions
const LLM_MODEL = process.env.LLM_MODEL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
// Three minutes, because the intended deployment is a model on this server's
// own processor: a couple of thousand tokens of context is a minute of prefill
// before a word is generated. A cloud model answers in seconds and never gets
// near this; a local one would have been cut off at sixty.
const LLM_TIMEOUT_MS = envNum('LLM_TIMEOUT_MS', 180_000);
// How many passages the model is allowed to see. More context is not a better
// answer: it is more chances to quote the wrong book.
// Four, not eight. Every extra passage is prompt to be processed before the
// first word appears, and on a processor that is seconds each. A definition
// needs three sentences from one book; a comparison of two authors needs more,
// and that is what the setting is for.
const ANSWER_PASSAGES = envNum('ANSWER_PASSAGES', 4);
// A quotation longer than this is republishing rather than citing. The limit is
// per licence — see quoteLimitFor.
const QUOTE_MAX_CHARS = envNum('QUOTE_MAX_CHARS', 400);
const QUOTE_MAX_CHARS_STRICT = envNum('QUOTE_MAX_CHARS_STRICT', 200);
// A run of this many identical words outside a quotation is a paraphrase of the
// source rather than an explanation of it.
const PARAPHRASE_RUN = envNum('PARAPHRASE_RUN', 12);

let llmFault = null;

const llmAvailable = () => !!(LLM_ENDPOINT && LLM_MODEL);

/** One call to the model. Returns its text, or null with llmFault set. */
const llmGenerate = async ({ system, user, maxTokens = 900 }) => {
  if (!llmAvailable()) {
    llmFault = 'Модель не настроена: задайте LLM_ENDPOINT и LLM_MODEL.';
    return null;
  }
  try {
    const res = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`модель ответила ${res.status}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content
      ?? body?.content?.[0]?.text         // Anthropic-shaped, if pointed at one
      ?? '';
    if (!text) throw new Error('модель вернула пустой ответ');
    llmFault = null;
    return String(text);
  } catch (e) {
    llmFault = clip(e?.message || String(e), 300);
    console.error('llm failed:', e?.message || e);
    return null;
  }
};

// ── Verification, all of it string work ──────────────────────────────────────

const normalizeForMatch = t => String(t || '')
  .replace(/[«»"“”„‟]/g, '"')
  .replace(/[–—‒]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** True when the quotation really is in that passage, word for word. */
const quoteIsVerbatim = (quote, passage) => {
  const q = normalizeForMatch(quote);
  return q.length >= 12 && normalizeForMatch(passage).includes(q);
};

// No-derivatives licences forbid altering the text, which includes translating
// it. We never translate a quotation anyway; this makes the rule enforced rather
// than merely intended, by refusing a quote written in a different script from
// the passage it claims to come from.
const scriptOf = t => (/[А-Яа-яЁё]/.test(t) ? 'cyr' : 'lat');
const licenseIsNoDerivatives = code => /(^|-)ND(-|$)/i.test(String(code || ''));
const licenseIsPermissive = code => /^(CC-BY(-SA)?-|CC0|PD|PUBLIC)/i.test(String(code || ''));

/**
 * How much of a passage may be quoted.
 *
 * A licence that permits redistribution permits a paragraph. Everything else —
 * including "not stated", which is all rights reserved until somebody checks —
 * gets the short quotation that citation law contemplates, not a page.
 */
const quoteLimitFor = license =>
  (licenseIsPermissive(license?.code) ? QUOTE_MAX_CHARS : QUOTE_MAX_CHARS_STRICT);

const wordsOf = t => normalizeForMatch(t).split(' ').filter(Boolean);

/**
 * Does the explanation reproduce the source instead of explaining it?
 *
 * Returns the longest run of consecutive words the two share. Twelve is where a
 * sentence stops being a summary: the model is copying, and copying outside a
 * quotation is exactly what a licence forbids and what a reader cannot tell
 * apart from the model's own words.
 */
const longestSharedRun = (text, passage) => {
  const a = wordsOf(text);
  const b = wordsOf(passage);
  if (!a.length || !b.length) return 0;
  const index = new Map();
  b.forEach((w, i) => {
    if (!index.has(w)) index.set(w, []);
    index.get(w).push(i);
  });
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (const j of index.get(a[i]) || []) {
      let n = 0;
      while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
      if (n > best) best = n;
    }
  }
  return best;
};

const splitSentences = t => String(t || '').split(/(?<=[.!?…])\s+/).filter(s => s.trim());

/**
 * Assemble an answer from the library, and let nothing through unchecked.
 *
 * The shape of the result is deliberate: `answer` is the model's explanation,
 * `quotes` are the library's words with the place to open, and `dropped` says
 * what was refused and why. A reader gets the first two; an operator needs the
 * third to know whether the model is behaving.
 */
const buildAnswer = async ({ q, maySeePrivate, lang }) => {
  const near = await vectorCandidates(q, 60);
  const rows = await searchRows({
    q,
    fetchLimit: Math.min(ANSWER_PASSAGES * 3, 60),
    headlineConfig: /\p{Script=Cyrillic}/u.test(q) ? 'russian' : 'english',
    maySeePrivate,
    onlyItem: null,
    near,
  });
  const passages = dropRepeatedPassages(rows).slice(0, ANSWER_PASSAGES);
  if (!passages.length) return { enough: false, reason: 'nothing-found', quotes: [], passages: [] };

  // The text the model is shown, and the licence each passage carries with it.
  const items = new Map();
  for (const r of (await pool.query(
    'SELECT id, data FROM items WHERE id = ANY($1::text[])',
    [[...new Set(passages.map(p => p.item_id))]],
  )).rows) items.set(r.id, r.data || {});

  const full = new Map();
  for (const r of (await pool.query(
    `SELECT id, text FROM chunks WHERE id = ANY($1::bigint[])`,
    [passages.map(p => String(p.chunk_id ?? p.id ?? 0)).filter(x => x !== '0')],
  )).rows.filter(Boolean)) full.set(String(r.id), r.text);

  // Sentences, numbered. This is what makes a fabricated quotation impossible
  // rather than merely detectable: the model chooses evidence by number and the
  // library inserts its own text, so there is nothing left for a model to get
  // wrong about a quotation. Twelve per passage is the cap — beyond that the tail
  // joins the last sentence rather than growing the prompt.
  const SENTENCES_PER_PASSAGE = envNum('ANSWER_SENTENCES', 12);
  const sentencesOf = text => {
    const parts = splitSentences(text).map(x => x.trim()).filter(Boolean);
    if (parts.length <= SENTENCES_PER_PASSAGE) return parts;
    const head = parts.slice(0, SENTENCES_PER_PASSAGE - 1);
    return [...head, parts.slice(SENTENCES_PER_PASSAGE - 1).join(' ')];
  };

  const numbered = passages.map((p, i) => {
    const item = items.get(p.item_id) || {};
    const where = p.second_start !== null
      ? formatSeconds(p.second_start)
      : (p.page_label || p.page || '—');
    return {
      n: i + 1,
      itemId: p.item_id,
      formatUrl: p.format_url,
      page: p.page,
      second: p.second_start,
      where,
      title: item.title?.ru || item.title?.en || item.title?.es || p.item_id,
      author: item.author || '',
      license: item.license || null,
      // The passage as stored — the only text a quotation may come from.
      text: full.get(String(p.chunk_id ?? '')) || String(p.snippet || '').replace(/<[^>]+>/g, ''),
    };
  });
  for (const p of numbered) p.sentences = sentencesOf(p.text);

  // The model is not asked to write a quotation, and is not told where the
  // passages come from. It cannot invent a page number it never saw, nor
  // misspell a quotation it never typed.
  const system = [
    'Ты помогаешь читателю библиотеки. Отвечай ТОЛЬКО по приведённым предложениям.',
    'Если они не отвечают на вопрос — так и скажи, не додумывай.',
    'Цитаты не пиши: вместо цитат перечисли номера предложений, которые подтверждают ответ.',
    'Своими словами — объясняй, а не переписывай источник.',
    'Ответ верни строго в JSON: {"enough":true|false,"answer":"…","evidence":["1.2","3.1"]}',
  ].join(' ');

  const user = [
    `Вопрос: ${q}`,
    '',
    'Предложения:',
    ...numbered.flatMap(p => p.sentences.map((sent, k) => `[${p.n}.${k + 1}] ${sent}`)),
  ].join('\n');

  const raw = await llmGenerate({ system, user });
  if (raw === null) return { enough: false, reason: 'llm-unavailable', error: llmFault, quotes: [], passages: numbered };

  let parsed = null;
  try {
    const jsonText = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(jsonText);
  } catch {
    return { enough: false, reason: 'llm-unparsable', error: clip(raw, 200), quotes: [], passages: numbered };
  }

  const dropped = [];
  const quotes = [];

  // The new path: the model names sentences, the library quotes itself. Nothing
  // here can fail verification, because there is nothing for the model to have
  // written. An unknown number is the only possible error, and it is refused.
  for (const id of (Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 8) : [])) {
    const m = String(id).match(/^(\d+)\s*[.:\-]\s*(\d+)$/);
    const p = m && numbered.find(x => x.n === Number(m[1]));
    const sentence = p?.sentences?.[Number(m?.[2]) - 1];
    if (!sentence) { dropped.push({ text: clip(String(id), 40), why: 'no-sentence' }); continue; }
    if (quotes.some(qq => qq.n === p.n && qq.text.startsWith(sentence.slice(0, 40)))) continue;
    const limit = quoteLimitFor(p.license);
    quotes.push({
      n: p.n,
      itemId: p.itemId,
      formatUrl: p.formatUrl,
      page: p.page,
      second: p.second,
      where: p.where,
      title: p.title,
      author: p.author,
      text: sentence.length > limit
        ? `${sentence.slice(0, sentence.lastIndexOf(' ', limit) || limit).trim()}…`
        : sentence,
      trimmed: sentence.length > limit,
    });
  }

  // The old path, kept because a model may ignore the format and write a
  // quotation anyway. Then it is checked exactly as before, and refused if it
  // does not hold up.
  for (const cand of Array.isArray(parsed.quotes) ? parsed.quotes.slice(0, 8) : []) {
    const p = numbered.find(x => x.n === Number(cand?.n));
    const text = String(cand?.text || '').trim();
    if (!p || !text) { dropped.push({ text: clip(text, 120), why: 'no-passage' }); continue; }
    // Verbatim, or not at all. This is the check that makes a page number mean
    // something.
    if (!quoteIsVerbatim(text, p.text)) { dropped.push({ text: clip(text, 120), why: 'not-verbatim' }); continue; }
    // A no-derivatives source may be quoted, never translated.
    if (licenseIsNoDerivatives(p.license?.code) && scriptOf(text) !== scriptOf(p.text)) {
      dropped.push({ text: clip(text, 120), why: 'nd-translation' });
      continue;
    }
    const limit = quoteLimitFor(p.license);
    quotes.push({
      n: p.n,
      itemId: p.itemId,
      formatUrl: p.formatUrl,
      page: p.page,
      second: p.second,
      where: p.where,
      title: p.title,
      author: p.author,
      // Trimmed to what the licence allows, at a word boundary.
      text: text.length > limit ? `${text.slice(0, text.lastIndexOf(' ', limit) || limit).trim()}…` : text,
      trimmed: text.length > limit,
    });
  }

  // The explanation, sentence by sentence: any sentence that copies a long run
  // from a source is not an explanation and is removed.
  let answer = String(parsed.answer || '').trim();
  const paraphrased = [];
  if (answer) {
    const kept = [];
    for (const sentence of splitSentences(answer)) {
      const worst = Math.max(0, ...numbered.map(p => longestSharedRun(sentence, p.text)));
      if (worst >= PARAPHRASE_RUN) paraphrased.push({ text: clip(sentence, 160), run: worst });
      else kept.push(sentence);
    }
    answer = kept.join(' ').trim();
  }

  // An answer with no verified quotation is an opinion about a library, not an
  // answer from one. The reader gets the places instead — the search result they
  // would have had anyway.
  const enough = !!(parsed.enough !== false && answer && quotes.length);
  return {
    enough,
    reason: enough ? null : (quotes.length ? 'no-answer-text' : 'nothing-verified'),
    answer,
    quotes,
    dropped,
    paraphrased,
    passages: numbered.map(p => ({
      n: p.n, itemId: p.itemId, formatUrl: p.formatUrl, page: p.page, second: p.second,
      where: p.where, title: p.title, author: p.author,
    })),
  };
};

app.get('/api/answer', checkUserAccess, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 3) return res.json({ enough: false, reason: 'too-short', quotes: [] });
  if (!llmAvailable()) return res.json({ available: false, enough: false, reason: 'llm-unavailable', quotes: [] });

  const settings = req.cachedSettings || {};
  const user = req.telegramUser;
  const allowed = settings.allowedUsers || [];
  const maySeePrivate = !!settings.globalAccess
    || !!(user && (allowed.includes(user.id) || (user.username && allowed.includes(user.username))));

  try {
    const t0 = Date.now();
    const out = await buildAnswer({ q, maySeePrivate, lang: req.query.lang });
    res.json({ available: true, ...out, tookMs: Date.now() - t0 });
  } catch (e) {
    console.error('answer failed:', e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

// Is the layer configured, and what does it do to real questions?
app.get('/api/admin/answers', requireApiKey, async (req, res) => {
  try {
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM eval_questions');
    res.json({
      available: llmAvailable(),
      model: LLM_MODEL,
      endpoint: LLM_ENDPOINT ? LLM_ENDPOINT.replace(/^(https?:\/\/[^/]+).*/, '$1') : '',
      questions: n,
      error: llmFault,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The reference set: real questions from the log plus a starter list, so a model
// change can be judged instead of guessed at. Runs them all and reports what the
// verification did — the number that matters is not "how many answers" but "how
// many answers the library could stand behind".
app.post('/api/admin/answers/eval', requireApiKey, async (req, res) => {
  if (!llmAvailable()) return res.status(409).json({ error: llmFault || 'Модель не настроена' });
  try {
    // Top up the set from questions people actually asked.
    await pool.query(
      `INSERT INTO eval_questions (question, source)
       SELECT DISTINCT query, 'log' FROM search_log
        WHERE COALESCE(query, '') <> ''
          AND NOT EXISTS (SELECT 1 FROM eval_questions e WHERE e.question = search_log.query)
        LIMIT 60`);
    const { rows } = await pool.query(
      'SELECT id, question, source, kind FROM eval_questions ORDER BY id LIMIT 100');

    const results = [];
    for (const row of rows) {
      const out = await buildAnswer({ q: row.question, maySeePrivate: false, lang: 'ru' });
      results.push({
        id: row.id,
        question: row.question,
        source: row.source,
        kind: row.kind || 'basic',
        enough: !!out.enough,
        quotes: (out.quotes || []).length,
        dropped: (out.dropped || []).length,
        paraphrased: (out.paraphrased || []).length,
        reason: out.reason,
      });
    }
    // Per class, because the totals hide the only interesting failures. A model
    // that answers every definition and also answers every question the library
    // cannot answer is worse than one that answers fewer and refuses the rest.
    const kinds = {};
    for (const r of results) {
      const k = kinds[r.kind] || (kinds[r.kind] = { kind: r.kind, total: 0, answered: 0, unverified: 0, paraphrase: 0 });
      k.total += 1;
      if (r.enough) k.answered += 1;
      if (r.dropped) k.unverified += 1;
      if (r.paraphrased) k.paraphrase += 1;
    }
    res.json({
      model: LLM_MODEL,
      total: results.length,
      answered: results.filter(r => r.enough).length,
      refused: results.filter(r => !r.enough && r.reason === 'nothing-found').length,
      unverified: results.filter(r => r.dropped > 0).length,
      paraphrase: results.filter(r => r.paraphrased > 0).length,
      // For 'no-answer', 'off-topic' and the bait classes, a low `answered` is
      // the good result — the panel says so next to the number.
      kinds: Object.values(kinds),
      results,
    });
  } catch (e) {
    console.error('eval failed:', e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

// ── Subtitles ────────────────────────────────────────────────────────────────
//
// A ready-made subtitle file beats anything we could recognise ourselves: it is
// free, instant, and written by someone who knew the terminology. So it is the
// first of the three ways to get a transcript, ahead of downloading the audio
// and far ahead of capturing playback.
//
// A cue is stored exactly like a page of a book — same table, same manual
// correction, same protection from re-indexing. Only the position differs:
// seconds instead of a page number.

const srtTime = t => {
  // 00:12:34,560 and 00:12:34.560 both appear in the wild; so does 12:34.560.
  const m = t.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2], 10) * 60)
       + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
};

/**
 * Parse SRT or WebVTT into cues. One parser for both: they differ in a header,
 * an optional cue id and the decimal separator, none of which is worth a second
 * implementation.
 */
const cueLine = l => l
  .replace(/<[^>]+>/g, '')                                    // <i>, <c.colorE5E5E5>
  .replace(/\{\\[^}]*\}/g, '')                                // ASS-style overrides
  .replace(/\s+/g, ' ')
  .trim();

// The same words twice at a cue boundary are the rolling effect, not speech.
//
// An auto-generated track scrolls: every cue reprints what the previous one
// already said and adds a few words at the end. Read straight through, the
// transcript comes out as "…changed the approach to risk. Do globally changed
// the approach to risk. Do globally changed…" — which is what the reader sees
// in a search result, and what the ranking counts as a dozen separate matches.
//
// Two overlaps are removed. A repeated whole line is the usual shape and is
// unambiguous. A repeated run of words without a line break needs a threshold:
// four words, because a speaker really can end one cue and start the next on
// the same two or three ("the", "you know", "in the end"), and deleting genuine
// speech is the worse mistake of the two.
const OVERLAP_MIN_WORDS = 4;

const dropRepeatedLines = (prevLines, lines) => {
  const seen = new Set(prevLines.map(l => l.toLowerCase()));
  let i = 0;
  while (i < lines.length && seen.has(lines[i].toLowerCase())) i++;
  return lines.slice(i);
};

const dropRepeatedTail = (prevText, text) => {
  const prev = prevText.split(' ').filter(Boolean);
  const cur = text.split(' ').filter(Boolean);
  const max = Math.min(prev.length, cur.length);
  for (let k = max; k >= OVERLAP_MIN_WORDS; k--) {
    if (prev.slice(prev.length - k).join(' ').toLowerCase() === cur.slice(0, k).join(' ').toLowerCase()) {
      return cur.slice(k).join(' ');
    }
  }
  return text;
};

const parseSubtitles = raw => {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  let prevLines = [];      // as written, before any trimming — that is what repeats
  let prevText = '';       // as kept, which is what the reader would read twice
  for (const blockText of text.split(/\n{2,}/)) {
    const lines = blockText.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;                  // file header
    let i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;                                      // NOTE / STYLE block
    const [from, to] = lines[i].split('-->');
    const start = srtTime(from);
    // A cue can carry positioning after the end time: "…  --> 00:00:04.000 line:90%"
    const end = srtTime((to || '').trim().split(/\s+/)[0] || '');
    if (start === null || end === null) continue;
    const own = lines.slice(i + 1).map(cueLine).filter(Boolean);
    if (!own.length) continue;

    const fresh = dropRepeatedLines(prevLines, own);
    prevLines = own;
    // Same rule across the cue boundary and inside the cue: a two-line cue can
    // reprint its own first line just as readily as the previous one's.
    let body = '';
    for (const line of fresh) {
      const add = dropRepeatedTail(body || prevText, line).trim();
      if (add) body = body ? `${body} ${add}` : add;
    }
    // Nothing new was said in this cue — it only redrew the previous one.
    if (!body) continue;
    prevText = body;
    cues.push({ start, end, text: body });
  }
  return cues;
};

// A chunk must cover one continuous stretch of speech, not merely a convenient
// number of characters. Four short remarks spread across an hour would otherwise
// become a single chunk stamped "from 0:04", and the search would send the
// listener an hour away from what it found — while looking entirely correct.
const CUE_GAP_SECONDS = 30;      // silence this long is a different moment
const CHUNK_MAX_SECONDS = 90;    // and no chunk spans more than a minute and a half

// Speech is measured in minutes, not in characters, and a page number forgives
// what a timecode does not: landing on page 143 you see the word, landing at
// 12:34 you wait. A book's 700-character chunk is a paragraph or two; the same
// 700 characters of speech is most of a minute, which is both a long wait and
// enough room for two separate mentions to collapse into one result.
//
// This mattered less while auto-captions padded every cue with the previous
// one's words: the padding made chunks cover half as much time, and stripping
// it made the granularity honest — and coarse. So speech gets its own, smaller
// size, and the timecode stays close to the words.
const CUE_CHUNK_TARGET = 380;
const CUE_CHUNK_MAX    = 600;

/** Group cues into search-sized chunks, keeping the span each one covers. */
const chunkCues = cues => {
  const chunks = [];
  let buf = [], len = 0;
  const flush = () => {
    if (!buf.length) return;
    chunks.push({
      text: buf.map(c => c.text).join(' '),
      second_start: Math.floor(buf[0].start),
      second_end: Math.ceil(buf[buf.length - 1].end),
    });
    buf = []; len = 0;
  };
  for (const cue of cues) {
    const gap = buf.length ? cue.start - buf[buf.length - 1].end : 0;
    const span = buf.length ? cue.end - buf[0].start : 0;
    if (buf.length && (len + cue.text.length + 1 > CUE_CHUNK_MAX
                       || gap > CUE_GAP_SECONDS
                       || span > CHUNK_MAX_SECONDS)) flush();
    buf.push(cue); len += cue.text.length + 1;
    if (len >= CUE_CHUNK_TARGET) flush();
  }
  flush();
  return chunks;
};

/**
 * Store a transcript against a media target: cues as document_text rows,
 * grouped chunks as search units.
 *
 * `target` is what the search result should open — the video link for a
 * platform video, or the media file for one of ours.
 */
const storeTranscript = async (itemId, targetUrl, cues, source, sourceName) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const manual = new Set((await client.query(
      `SELECT page FROM document_text WHERE item_id = $1 AND format_url = $2 AND source = 'manual'`,
      [itemId, targetUrl],
    )).rows.map(r => r.page));

    await client.query(
      `DELETE FROM document_text WHERE item_id = $1 AND format_url = $2 AND source <> 'manual'`,
      [itemId, targetUrl],
    );
    await client.query('DELETE FROM chunks WHERE item_id = $1 AND format_url = $2', [itemId, targetUrl]);

    for (let i = 0; i < cues.length; i++) {
      const page = i + 1;                       // cue ordinal — the "page" of a video
      if (manual.has(page)) continue;
      const c = cues[i];
      await client.query(
        `INSERT INTO document_text
           (item_id, format_url, page, page_label, source, text, chars, second_start, second_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (item_id, format_url, page) DO UPDATE
           SET page_label = $4, source = $5, text = $6, chars = $7,
               second_start = $8, second_end = $9, updated_at = NOW()`,
        [itemId, targetUrl, page, formatSeconds(c.start), source, c.text,
         scanCountChars(c.text), Math.floor(c.start), Math.ceil(c.end)],
      );
    }

    // Chunks come from what is stored, so a corrected cue reaches the index.
    const stored = (await client.query(
      `SELECT text, second_start, second_end FROM document_text
        WHERE item_id = $1 AND format_url = $2 ORDER BY page`,
      [itemId, targetUrl],
    )).rows;
    const grouped = chunkCues(stored.map(r => ({
      text: r.text, start: r.second_start ?? 0, end: r.second_end ?? 0,
    })));

    for (const g of grouped) {
      await client.query(
        `INSERT INTO chunks (item_id, format_url, text, second_start, second_end)
         VALUES ($1,$2,$3,$4,$5)`,
        [itemId, targetUrl, g.text, g.second_start, g.second_end],
      );
    }

    const chars = stored.reduce((n, r) => n + scanCountChars(r.text), 0);
    await client.query(
      `INSERT INTO index_status
         (item_id, format_url, filename, state, method, pages, chars, chunk_count, quality, manual_pages, detail, indexed_at)
       VALUES ($1,$2,$3,'indexed',$4,$5,$6,$7,$8,$9,$10, NOW())
       ON CONFLICT (item_id, format_url) DO UPDATE SET
         filename = $3, state = 'indexed', method = $4, pages = $5, chars = $6,
         chunk_count = $7, quality = $8, manual_pages = $9, detail = $10, indexed_at = NOW()`,
      [itemId, targetUrl, sourceName, source, stored.length, chars, grouped.length,
       stored.length ? stored.reduce((sum, r) => sum + textQuality(r.text), 0) / stored.length : 0,
       manual.size,
       stored.length
         ? `Расшифровка: ${stored.length} реплик, до ${formatSeconds(stored[stored.length - 1].second_end || 0)}`
         : 'Расшифровка пуста'],
    );
    await client.query('COMMIT');
    return { cues: stored.length, chunks: grouped.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

const formatSeconds = total => {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

// ── Job queue ────────────────────────────────────────────────────────────────

const WORKER_ID = `api-${process.pid}`;
const JOB_POLL_MS = 2000;
const JOB_HANDLERS = {};
let jobBusy = false;

const jobProgress = (id) => async (progress, checkpoint) => {
  await pool.query(
    'UPDATE jobs SET progress = $2, checkpoint = COALESCE($3::jsonb, checkpoint) WHERE id = $1',
    [id, Math.max(0, Math.min(1, progress)), checkpoint ? JSON.stringify(checkpoint) : null],
  ).catch(() => {/* progress is advisory; never fail a job over it */});
};

/** Cancellation is cooperative: long handlers check between segments. */
const jobCancelled = async id => {
  const { rows } = await pool.query('SELECT state FROM jobs WHERE id = $1', [id]);
  return rows[0]?.state === 'cancelled';
};

const claimJob = async () => {
  const { rows } = await pool.query(`
    UPDATE jobs
       SET state = 'running', attempts = attempts + 1, locked_by = $1,
           locked_at = NOW(), started_at = COALESCE(started_at, NOW()), detail = NULL
     WHERE id = (SELECT id FROM jobs
                  WHERE state = 'queued'
                  ORDER BY priority, id
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1)
     RETURNING *`, [WORKER_ID]);
  return rows[0] || null;
};

const workerTick = async () => {
  if (jobBusy) return;
  let job;
  try { job = await claimJob(); } catch { return; }
  if (!job) return;
  jobBusy = true;
  try {
    const handler = JOB_HANDLERS[job.kind];
    if (!handler) throw new Error(`Неизвестный тип задачи: ${job.kind}`);
    const detail = await handler(job, {
      report: jobProgress(job.id),
      cancelled: () => jobCancelled(job.id),
    });
    await pool.query(
      `UPDATE jobs SET state = 'done', progress = 1, detail = $2, finished_at = NOW(),
                       locked_by = NULL, locked_at = NULL
        WHERE id = $1 AND state <> 'cancelled'`,
      [job.id, clip(detail || null, 500)],
    );
    // A target has one index, so its history has one current row. Everything
    // finished before this run described what the index held a moment ago —
    // including an earlier success: re-indexing replaced its text, so "1322
    // реплик" sitting under "679 реплик" is not history, it is two answers to
    // one question with nothing saying which is true. Whatever is still queued
    // or running is left alone; only finished rows are superseded.
    if (job.format_url) {
      await pool.query(
        `DELETE FROM jobs
          WHERE id <> $1 AND item_id = $2 AND format_url = $3
            AND state IN ('done', 'failed', 'cancelled')`,
        [job.id, job.item_id, job.format_url],
      ).catch(() => {/* tidying, never fatal */});
    }
  } catch (e) {
    const message = clip(e?.message || String(e), 500);
    // Retry is the default because most failures here are transient — a busy
    // CPU, a platform hiccup. A job that has burned its attempts stops and says
    // why, rather than looping.
    await pool.query(
      `UPDATE jobs
          SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
              detail = $2, locked_by = NULL, locked_at = NULL,
              finished_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END
        WHERE id = $1 AND state <> 'cancelled'`,
      [job.id, message],
    ).catch(() => {});
    console.error(`job ${job.id} (${job.kind}) failed:`, message);
  } finally {
    jobBusy = false;
  }
};

const startWorker = () => {
  setInterval(() => { workerTick(); }, JOB_POLL_MS).unref?.();
};

// ── Job: import a subtitle file ──────────────────────────────────────────────

// ── Transcripts from the platform, or from listening ─────────────────────────
//
// Two ways to get the same thing, and the order matters: a platform's own
// subtitle track costs seconds and arrives with timecodes already in it, while
// recognising the audio costs an hour of CPU per lecture. So the cheap one is
// the default and the expensive one is what you press when the first came back
// empty.
//
// Both converge on parseSubtitles + storeTranscript, which are already tested:
// yt-dlp writes VTT, whisper.cpp writes SRT, and one parser reads both. Nothing
// downstream — timecodes, manual correction, re-index protection — needs to
// know which path produced the cues.

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/mnt/library/models/ggml-medium.bin';
const YTDLP_TIMEOUT_MS = 300_000;
const ASR_TIMEOUT_MS = 6 * 60 * 60 * 1000;   // a long lecture on a CPU

const tmpWorkDir = () => {
  const dir = path.join(os.tmpdir(), `media-${randomBytes(8).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const cleanupDir = dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };

/** Ask the platform for its own subtitle track. Nothing else is downloaded. */
// yt-dlp's own wording is written for a terminal, not for whoever runs the
// library. These two are the failures that actually happen.
const explainYtDlp = raw => {
  const text = String(raw || '');
  if (/Requested format is not available/i.test(text)) {
    return 'Площадка не отдала ни субтитров, ни пригодного потока. Чаще всего помогает обновление yt-dlp — см. ARG YTDLP_VERSION в api/Dockerfile.';
  }
  if (/Sign in to confirm|bot|429|rate/i.test(text)) {
    return 'Площадка потребовала подтверждения или ограничила частоту запросов. Попробуйте позже или реже.';
  }
  if (/Video unavailable|Private video|removed/i.test(text)) {
    return 'Ролик недоступен: удалён, приватный или ограничен по региону.';
  }
  return clip(text, 400);
};

/**
 * Give every indexed passage a vector.
 *
 * Batched through the same queue as recognition, for the same reasons: it takes
 * minutes to hours on a processor, it must survive a deploy, and the admin
 * should watch it where every other long job is watched. Progress is measured
 * against what is left to do, and the checkpoint is simply "vectors already
 * written" — a re-run picks up whatever is missing, so an interrupted pass
 * costs nothing but the batch it was in.
 */
JOB_HANDLERS.embed = async (job, ctx) => {
  const onlyItem = job.payload?.itemId || null;
  const todo = async () => Number((await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM chunks c
       LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = $1
      WHERE v.chunk_id IS NULL AND ($2::text IS NULL OR c.item_id = $2)`,
    [EMBED_MODEL, onlyItem],
  )).rows[0].n);

  const total = await todo();
  if (!total) return 'Все куски уже с векторами';
  let done = 0;

  for (;;) {
    if (await ctx.cancelled()) return `Отменено: посчитано ${done} из ${total}`;
    const { rows } = await pool.query(
      `SELECT c.id, c.text
         FROM chunks c
         LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = $1
        WHERE v.chunk_id IS NULL AND ($2::text IS NULL OR c.item_id = $2)
        ORDER BY c.id
        LIMIT $3`,
      [EMBED_MODEL, onlyItem, EMBED_BATCH],
    );
    if (!rows.length) break;

    const vectors = await embedTexts(rows.map(r => r.text), 'passage', true);
    // Not an empty result — a broken embedder. Failing loudly is right: a job
    // that "finished" having written nothing is the worst of both worlds.
    if (!vectors) throw new Error(embedFault || 'Модель векторов недоступна');

    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      await pool.query(
        `INSERT INTO chunk_vectors (chunk_id, model, dim, vec)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chunk_id) DO UPDATE SET model = $2, dim = $3, vec = $4, created_at = NOW()`,
        [rows[i].id, EMBED_MODEL, v.length, Buffer.from(v.buffer, v.byteOffset, v.length * 4)],
      );
    }
    done += rows.length;
    await ctx.report(Math.min(0.99, done / total), { done });
    // The reader should not wait out the staleness window to benefit from work
    // that has already finished: the writer knows the index changed, so it says
    // so instead of letting the next search find out fifteen seconds later.
    vectorIndex.checkedAt = 0;
  }
  return `Вектора: ${done} кусков, модель ${EMBED_MODEL}`;
};

// What the vector search has to work with, and why it might have nothing.
app.get('/api/admin/vectors', requireApiKey, async (req, res) => {
  try {
    // Nothing computed and nothing said about why: find out, at most once every
    // few minutes, so the panel answers the operator's actual question.
    if (!embedFault && Date.now() >= embedColdUntil) {
      const { rows: [{ n }] } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM chunk_vectors WHERE model = $1', [EMBED_MODEL]);
      if (!n) await embedTexts(['проверка связи'], 'query', true);
    }
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM chunks) AS chunks,
              (SELECT COUNT(*)::int FROM chunk_vectors WHERE model = $1) AS vectors,
              (SELECT COUNT(*)::int FROM jobs WHERE kind = 'embed' AND state IN ('queued','running')) AS pending`,
      [EMBED_MODEL],
    );
    res.json({
      model: EMBED_MODEL,
      dim: EMBED_DIM,
      home: EMBED_HOME,
      endpoint: EMBED_ENDPOINT ? EMBED_ENDPOINT.replace(/^(https?:\/\/[^/]+).*/, '$1') : '',
      chunks: rows[0].chunks,
      vectors: rows[0].vectors,
      pending: rows[0].pending,
      error: embedFault,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/vectors', requireApiKey, async (req, res) => {
  const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : null;
  try {
    const running = await pool.query(
      `SELECT id FROM jobs WHERE kind = 'embed' AND state IN ('queued','running') LIMIT 1`);
    if (running.rowCount) return res.json({ queued: 0, already: true });

    const batch = (await pool.query(
      `INSERT INTO job_batches (kind, title) VALUES ('embed', $1) RETURNING id`,
      [itemId ? `Вектора · ${itemId}` : 'Вектора · вся библиотека'],
    )).rows[0];
    await pool.query(
      `INSERT INTO jobs (batch_id, kind, item_id, label, payload)
       VALUES ($1, 'embed', $2, $3, $4)`,
      [batch.id, itemId, itemId ? `Вектора · ${itemId}` : 'Вектора · вся библиотека',
       JSON.stringify({ itemId })],
    );
    res.json({ queued: 1, batchId: batch.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// How long a real search takes on this server, and how much of it is the
// meaning search. Asked from the admin panel, because "поиск стал медленнее" is
// otherwise impossible to answer without a developer console.
app.get('/api/admin/vectors/probe', requireApiKey, async (req, res) => {
  try {
    const asked = typeof req.query.q === 'string' && req.query.q.trim()
      ? req.query.q.trim()
      : (await pool.query(
          `SELECT query FROM search_log WHERE COALESCE(query,'') <> '' ORDER BY ts DESC LIMIT 1`)
        ).rows[0]?.query || 'падение волатильности';

    const t0 = Date.now();
    const near = await vectorCandidates(asked, 60);
    const vectorMs = Date.now() - t0;
    const t1 = Date.now();
    const { rows } = await pool.query(
      `WITH q AS (SELECT websearch_to_tsquery('russian'::regconfig, $1) ||
                         websearch_to_tsquery('english'::regconfig, $1) AS tsq)
       SELECT c.id FROM chunks c CROSS JOIN q
        LEFT JOIN unnest($2::bigint[]) WITH ORDINALITY AS v(vid, ord) ON v.vid = c.id
        WHERE (c.tsv @@ q.tsq OR v.vid IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM index_holds hh WHERE hh.item_id = c.item_id)
        LIMIT 200`, [asked, near]);
    res.json({
      query: asked,
      vectorMs,
      sqlMs: Date.now() - t1,
      totalMs: Date.now() - t0,
      candidates: near.length,
      matches: rows.length,
      error: embedFault,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Did the second opinion help? Replays real questions from the log through both
// rankings and reports the difference, because "feels better" is not a reason
// to keep a moving part.
app.get('/api/admin/vectors/compare', requireApiKey, async (req, res) => {
  try {
    const { rows: asked } = await pool.query(
      `SELECT query, MAX(ts) AS last, COUNT(*)::int AS times
         FROM search_log
        WHERE COALESCE(query, '') <> ''
        GROUP BY query
        ORDER BY MAX(ts) DESC
        LIMIT 40`);
    if (!asked.length) return res.json({ queries: [], ready: false });

    const rank = async (q, near) => (await pool.query(
      `WITH qq AS (
         SELECT websearch_to_tsquery('russian'::regconfig, $1) ||
                websearch_to_tsquery('english'::regconfig, $1) AS tsq
       ),
       m AS (
         SELECT c.id, c.item_id, ts_rank(c.tsv, qq.tsq) AS fts, v.ord AS vord
           FROM chunks c CROSS JOIN qq
           LEFT JOIN unnest($2::bigint[]) WITH ORDINALITY AS v(vid, ord) ON v.vid = c.id
          WHERE (c.tsv @@ qq.tsq OR v.vid IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM index_holds hh WHERE hh.item_id = c.item_id)
       ),
       s AS (SELECT *, RANK() OVER (PARTITION BY (fts > 0) ORDER BY fts DESC) AS fr FROM m)
       SELECT item_id,
              (CASE WHEN fts > 0 THEN 1.0/(60 + fr) ELSE 0 END)
            + (CASE WHEN vord IS NOT NULL THEN 1.0/(60 + vord) ELSE 0 END) AS score
         FROM s ORDER BY score DESC LIMIT 5`,
      [q, near],
    )).rows;

    const queries = [];
    for (const a of asked) {
      const near = await vectorCandidates(a.query, 60);
      const before = await rank(a.query, []);
      const after = await rank(a.query, near);
      queries.push({
        query: a.query,
        times: a.times,
        before: before.length,
        after: after.length,
        rescued: before.length === 0 && after.length > 0,
        changedTop: !!(before[0]?.item_id && after[0]?.item_id && before[0].item_id !== after[0].item_id),
        newSources: after.filter(r => !before.some(b => b.item_id === r.item_id)).length,
      });
    }
    res.json({
      ready: true,
      model: EMBED_MODEL,
      queries,
      rescued: queries.filter(x => x.rescued).length,
      changedTop: queries.filter(x => x.changedTop).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

JOB_HANDLERS['platform-subs'] = async (job, ctx) => {
  const { itemId, targetUrl, langs } = job.payload || {};
  if (!itemId || !targetUrl) throw new Error('Задача без параметров');
  const dir = tmpWorkDir();
  try {
    await ctx.report(0.15);
    await execFileAsync('yt-dlp', [
      '--skip-download',            // the video itself is never fetched
      // Without this, yt-dlp still runs format selection and aborts with
      // "Requested format is not available" — on a request that wants no format
      // at all. It is the documented flag for subtitle-only extraction.
      '--ignore-no-formats-error',
      '--write-subs', '--write-auto-subs',
      '--sub-format', 'vtt',
      '--sub-langs', typeof langs === 'string' && langs ? langs : 'ru,en,ru-orig,en-orig',
      '--no-playlist', '--no-warnings',
      '-o', path.join(dir, 'sub'),
      targetUrl,
    ], { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
      .catch(e => { throw new Error(explainYtDlp(e?.stderr || e?.message)); });

    const files = fs.readdirSync(dir).filter(f => /\.vtt$/i.test(f));
    if (!files.length) throw new Error('У этого ролика площадка субтитров не отдаёт — попробуйте распознавание речи');
    // Prefer a human-made track over an auto one: same shape, better wording.
    files.sort((a, b) => Number(/auto/i.test(a)) - Number(/auto/i.test(b)));

    await ctx.report(0.6);
    const cues = parseSubtitles(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    if (!cues.length) throw new Error('Дорожка субтитров пуста');
    if (await ctx.cancelled()) return 'Отменено';

    const { cues: stored, chunks } = await storeTranscript(itemId, targetUrl, cues, 'subtitles', files[0]);
    return `Субтитры площадки: ${stored} реплик, ${chunks} поисковых кусков`;
  } finally {
    cleanupDir(dir);
  }
};

/**
 * Listen and write it down. The audio track is fetched, recognised and deleted;
 * what stays is the transcript.
 */
JOB_HANDLERS.asr = async (job, ctx) => {
  const { itemId, targetUrl, filename } = job.payload || {};
  if (!itemId || !targetUrl) throw new Error('Задача без параметров');
  const dir = tmpWorkDir();
  const wav = path.join(dir, 'audio.wav');
  try {
    if (filename) {
      // Our own media file: no download, straight to a shape whisper.cpp reads.
      const src = path.join(CONTENT_DIR, itemId, filename);
      if (!fs.existsSync(src)) throw new Error('Файла нет на диске');
      await ctx.report(0.1);
      await execFileAsync('ffmpeg', ['-y', '-i', src, '-ar', '16000', '-ac', '1', wav],
        { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    } else {
      await ctx.report(0.1);
      // Audio only — the picture is not needed to hear what was said.
      await execFileAsync('yt-dlp', [
        '-f', 'bestaudio', '-x', '--audio-format', 'wav',
        '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
        '--no-playlist', '--no-warnings',
        '-o', path.join(dir, 'audio.%(ext)s'),
        targetUrl,
      ], { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
        .catch(e => { throw new Error(explainYtDlp(e?.stderr || e?.message)); });
      if (!fs.existsSync(wav)) throw new Error('Не удалось получить звуковую дорожку');
    }
    if (await ctx.cancelled()) return 'Отменено';

    await ctx.report(0.3, { stage: 'asr' });
    if (!fs.existsSync(WHISPER_MODEL)) {
      throw new Error(`Модель распознавания не найдена: ${WHISPER_MODEL}`);
    }
    // SRT out, so the same parser reads it as a platform's VTT.
    await execFileAsync(WHISPER_BIN, [
      '-m', WHISPER_MODEL, '-f', wav, '-osrt', '-of', path.join(dir, 'out'),
      '-l', 'auto', '-t', String(process.env.WHISPER_THREADS || 4),
    ], { timeout: ASR_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });

    const srt = path.join(dir, 'out.srt');
    if (!fs.existsSync(srt)) throw new Error('Распознавание не дало результата');
    const cues = parseSubtitles(fs.readFileSync(srt, 'utf8'));
    if (!cues.length) throw new Error('В расшифровке нет ни одной реплики');

    await ctx.report(0.9);
    const { cues: stored, chunks } = await storeTranscript(itemId, targetUrl, cues, 'asr', 'whisper');
    return `Распознавание: ${stored} реплик, ${chunks} поисковых кусков`;
  } finally {
    cleanupDir(dir);
  }
};

/** Every spoken target of a material, with what can be done to each. */
const spokenTargets = item => {
  const out = [];
  for (const v of Array.isArray(item.videos) ? item.videos : []) {
    const url = typeof v?.url === 'string' ? v.url.trim() : '';
    if (url) out.push({ url, label: v.source || 'видео', platform: true });
  }
  for (const f of Array.isArray(item.formats) ? item.formats : []) {
    const url = typeof f?.url === 'string' ? f.url.trim() : '';
    if (!url || f.external) continue;
    const ext = path.extname(url.split(/[?#]/)[0]).toLowerCase();
    if (SCAN_MEDIA_EXT.has(ext)) {
      out.push({ url, label: f.name || 'файл', platform: false, filename: scanFilenameFromUrl(item.id, url) });
    }
  }
  return out;
};

// Queue one method for one material, or for everything that has spoken content.
app.post('/api/admin/jobs/transcribe', requireApiKey, async (req, res) => {
  const method = req.body?.method === 'asr' ? 'asr' : 'platform-subs';
  const onlyItem = typeof req.body?.itemId === 'string' ? req.body.itemId : null;
  const onlyUrl = typeof req.body?.targetUrl === 'string' ? req.body.targetUrl.trim() : null;
  try {
    const { rows } = onlyItem
      ? await pool.query('SELECT id, data FROM items WHERE id = $1', [onlyItem])
      : await pool.query('SELECT id, data FROM items ORDER BY seq');

    const planned = [];
    for (const row of rows) {
      const item = { ...(row.data || {}), id: row.id };
      const title = item.title?.ru || item.title?.en || item.title?.es || row.id;
      for (const target of spokenTargets(item)) {
        if (onlyUrl && target.url !== onlyUrl) continue;
        // A local file has no platform to ask; recognising it is the only route.
        if (method === 'platform-subs' && !target.platform) continue;
        planned.push({
          itemId: row.id,
          targetUrl: target.url,
          label: `${title} · ${target.label}`,
          payload: { itemId: row.id, targetUrl: target.url, filename: target.filename || null },
        });
      }
    }
    if (!planned.length) return res.json({ queued: 0 });

    const batch = (await pool.query(
      `INSERT INTO job_batches (kind, title) VALUES ($1, $2) RETURNING id`,
      [method, `${method === 'asr' ? 'Распознавание' : 'Субтитры площадки'} · ${planned.length}`],
    )).rows[0];

    for (const p of planned) {
      await pool.query(
        `INSERT INTO jobs (batch_id, kind, item_id, format_url, label, payload, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        // Recognition takes hours; letting a cheap subtitle fetch overtake it
        // keeps the queue useful while a long job is running.
        [batch.id, method, p.itemId, p.targetUrl, p.label, JSON.stringify(p.payload),
         method === 'asr' ? 200 : 50],
      );
    }
    res.json({ queued: planned.length, batchId: batch.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

JOB_HANDLERS.subtitles = async (job, ctx) => {
  const { itemId, targetUrl, filename } = job.payload || {};
  if (!itemId || !targetUrl || !filename) throw new Error('Задача без параметров');
  const filePath = path.join(CONTENT_DIR, itemId, filename);
  if (!fs.existsSync(filePath)) throw new Error('Файл субтитров не найден');

  await ctx.report(0.1);
  const cues = parseSubtitles(fs.readFileSync(filePath, 'utf8'));
  if (!cues.length) throw new Error('В файле субтитров нет ни одной реплики');
  if (await ctx.cancelled()) return 'Отменено';

  await ctx.report(0.5);
  const { cues: stored, chunks } = await storeTranscript(itemId, targetUrl, cues, 'subtitles', filename);
  return `${stored} реплик, ${chunks} поисковых кусков`;
};

/**
 * Which media a subtitle file belongs to.
 *
 * Guessing is worse than asking: a file named ru-a1b2c3.srt says nothing about
 * which of three lectures it transcribes. So the rule is deliberately narrow —
 * one obvious candidate or none — and an ambiguous item is reported rather than
 * silently attached to the wrong video.
 */
const subtitleTarget = item => {
  const videos = (Array.isArray(item.videos) ? item.videos : [])
    .filter(v => typeof v?.url === 'string' && v.url.trim());
  const media = (Array.isArray(item.formats) ? item.formats : []).filter(f => {
    const url = typeof f?.url === 'string' ? f.url.trim() : '';
    return url && !f.external && SCAN_MEDIA_EXT.has(path.extname(url.split(/[?#]/)[0]).toLowerCase());
  });
  const candidates = [...videos.map(v => v.url.trim()), ...media.map(f => f.url.trim())];
  if (candidates.length === 1) return { url: candidates[0] };
  return { error: candidates.length ? 'У материала несколько видео — непонятно, к какому субтитры' : 'В материале нет видео или аудио' };
};

// Queue subtitle imports for every uploaded .srt/.vtt that has an obvious target.
app.post('/api/admin/jobs/subtitles', requireApiKey, async (req, res) => {
  const onlyItem = typeof req.body?.itemId === 'string' ? req.body.itemId : null;
  try {
    const { rows } = onlyItem
      ? await pool.query('SELECT id, data FROM items WHERE id = $1', [onlyItem])
      : await pool.query('SELECT id, data FROM items ORDER BY seq');

    const planned = [];
    const skipped = [];
    for (const row of rows) {
      const item = row.data || {};
      const subs = (Array.isArray(item.formats) ? item.formats : []).filter(f => {
        const url = typeof f?.url === 'string' ? f.url.trim() : '';
        return url && !f.external && /\.(srt|vtt)$/i.test(url.split(/[?#]/)[0]);
      });
      if (!subs.length) continue;
      const target = subtitleTarget(item);
      const title = item.title?.ru || item.title?.en || item.title?.es || row.id;
      if (target.error) { skipped.push(`${title}: ${target.error}`); continue; }
      for (const sub of subs) {
        const filename = scanFilenameFromUrl(row.id, sub.url.trim());
        if (!filename) { skipped.push(`${title}: файл субтитров не на нашем сервере`); continue; }
        planned.push({ itemId: row.id, targetUrl: target.url, filename, label: `${title} · ${sub.name || filename}` });
      }
    }

    if (!planned.length) return res.json({ queued: 0, skipped });

    const batch = (await pool.query(
      `INSERT INTO job_batches (kind, title) VALUES ('subtitles', $1) RETURNING id`,
      [`Субтитры · ${planned.length}`],
    )).rows[0];

    for (const p of planned) {
      await pool.query(
        `INSERT INTO jobs (batch_id, kind, item_id, format_url, label, payload)
         VALUES ($1, 'subtitles', $2, $3, $4, $5)`,
        [batch.id, p.itemId, p.targetUrl, p.label,
         JSON.stringify({ itemId: p.itemId, targetUrl: p.targetUrl, filename: p.filename })],
      );
    }
    res.json({ queued: planned.length, batchId: batch.id, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/jobs', requireApiKey, async (req, res) => {
  try {
    const jobs = (await pool.query(`
      SELECT id, batch_id, kind, item_id, label, state, progress, attempts, max_attempts,
             detail, created_at, started_at, finished_at
        FROM jobs
       ORDER BY CASE state WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
                id DESC
       LIMIT 200
    `)).rows;
    const totals = (await pool.query(`
      SELECT COUNT(*) FILTER (WHERE state = 'queued')::int    AS queued,
             COUNT(*) FILTER (WHERE state = 'running')::int   AS running,
             COUNT(*) FILTER (WHERE state = 'done')::int      AS done,
             COUNT(*) FILTER (WHERE state = 'failed')::int    AS failed,
             COUNT(*) FILTER (WHERE state = 'cancelled')::int AS cancelled
        FROM jobs
    `)).rows[0];
    res.json({ jobs, totals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/jobs/:id/:action', requireApiKey, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action } = req.params;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid job id' });
  try {
    if (action === 'cancel') {
      await pool.query(
        `UPDATE jobs SET state = 'cancelled', finished_at = NOW() WHERE id = $1 AND state IN ('queued','running')`,
        [id],
      );
    } else if (action === 'retry') {
      await pool.query(
        `UPDATE jobs SET state = 'queued', attempts = 0, detail = NULL, finished_at = NULL
          WHERE id = $1 AND state IN ('failed','cancelled')`,
        [id],
      );
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stop a whole batch at once — the point of batches being a thing.
// Clear finished history — everything, or one material's. Running and queued
// work is never touched: this is a tidy-up, not a stop button.
app.delete('/api/admin/jobs/history', requireApiKey, async (req, res) => {
  const itemId = typeof req.query.item === 'string' ? req.query.item : null;
  try {
    const { rowCount } = itemId
      ? await pool.query(
          `DELETE FROM jobs WHERE item_id = $1 AND state IN ('done','failed','cancelled')`, [itemId])
      : await pool.query(
          `DELETE FROM jobs WHERE state IN ('done','failed','cancelled')`);
    res.json({ deleted: rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/jobs/batch/:id/cancel', requireApiKey, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid batch id' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE jobs SET state = 'cancelled', finished_at = NOW()
        WHERE batch_id = $1 AND state IN ('queued','running')`,
      [id],
    );
    res.json({ cancelled: rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A result was opened. Completes the row started by the search, so one record
// says: asked this, found that many, opened this book at that position.
app.post('/api/search/opened', checkUserAccess, async (req, res) => {
  const { logId, itemId, position } = req.body || {};
  if (!Number.isInteger(logId)) return res.status(400).json({ error: 'logId required' });
  try {
    await pool.query(
      `UPDATE search_log SET opened_item = $2, opened_pos = $3
        WHERE id = $1 AND opened_item IS NULL`,
      [logId, clip(itemId, 64), clip(position, 32)],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search → Source Open Rate: the only number that answers whether search gets
// the library read. Queries alone would not — one that found nothing, or found
// something nobody opened, is a miss.
app.get('/api/admin/search-log', requireApiKey, async (req, res) => {
  try {
    const totals = (await pool.query(`
      SELECT COUNT(*)::int                                   AS queries,
             COUNT(*) FILTER (WHERE results > 0)::int        AS with_results,
             COUNT(*) FILTER (WHERE opened_item IS NOT NULL)::int AS opened
        FROM search_log WHERE ts > NOW() - INTERVAL '30 days'
    `)).rows[0];
    const misses = (await pool.query(`
      SELECT query, COUNT(*)::int AS n, MAX(ts) AS last_at
        FROM search_log
       WHERE results = 0 AND ts > NOW() - INTERVAL '30 days'
       GROUP BY query ORDER BY n DESC, last_at DESC LIMIT 50
    `)).rows;
    const recent = (await pool.query(`
      SELECT query, results, opened_item, opened_pos, ts
        FROM search_log ORDER BY id DESC LIMIT 50
    `)).rows;
    res.json({ totals, misses, recent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload cover image
// POST /api/upload/:itemId/cover  (field: file)
app.post('/api/upload/:itemId/cover',
  requireApiKey, validateItemId,
  uploadCover.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No valid image (jpeg/png/webp, max 20 MB)' });

    const url = `${baseUrl()}/content/${req.params.itemId}/${req.file.filename}`;

    try {
      await pool.query(
        `INSERT INTO uploaded_files (item_id, file_type, filename, url, size_bytes)
         VALUES ($1, 'cover', $2, $3, $4)
         ON CONFLICT (item_id, filename) DO UPDATE SET url = $3, size_bytes = $4, uploaded_at = NOW()`,
        [req.params.itemId, req.file.filename, url, req.file.size],
      );
    } catch (e) {
      console.warn('DB write (cover):', e.message);
    }

    res.json({ url, filename: req.file.filename, size: formatSize(req.file.size) });
  },
);

// Upload content file (PDF, EPUB, video, audio)
// POST /api/upload/:itemId/file  (fields: file, lang?)
app.post('/api/upload/:itemId/file',
  requireApiKey, validateItemId,
  uploadFile.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'File type not allowed or missing' });

    const lang = (req.body.lang || 'ru').replace(/[^a-z]/g, '').slice(0, 5);
    let filename = req.file.filename;
    let ext = path.extname(filename).slice(1).toLowerCase();
    let size = req.file.size;

    // Convert FB2 → EPUB automatically
    if (ext === 'fb2') {
      const dir = path.join(CONTENT_DIR, req.params.itemId);
      const fb2Path = path.join(dir, filename);
      const epubFilename = filename.replace(/\.fb2$/i, '.epub');
      const epubPath = path.join(dir, epubFilename);
      try {
        await execFileAsync('ebook-convert', [fb2Path, epubPath], {
          env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
          timeout: 120000,
        });
        fs.unlinkSync(fb2Path);
        filename = epubFilename;
        ext = 'epub';
        size = fs.statSync(epubPath).size;
        console.log(`FB2→EPUB: ${fb2Path} → ${epubPath}`);
      } catch (e) {
        console.error('FB2→EPUB conversion failed:', e.message);
      }
    }

    // Convert DJVU → PDF automatically
    if (ext === 'djvu' || ext === 'djv') {
      const dir = path.join(CONTENT_DIR, req.params.itemId);
      const djvuPath = path.join(dir, filename);
      const pdfFilename = filename.replace(/\.djvu?$/i, '.pdf');
      const pdfPath = path.join(dir, pdfFilename);
      try {
        await execFileAsync('ddjvu', ['-format=pdf', djvuPath, pdfPath], {
          timeout: 180000,
        });
        fs.unlinkSync(djvuPath);
        filename = pdfFilename;
        ext = 'pdf';
        size = fs.statSync(pdfPath).size;
        console.log(`DJVU→PDF: ${djvuPath} → ${pdfPath}`);
      } catch (e) {
        console.error('DJVU→PDF conversion failed:', e.message);
      }
    }

    const url = `${baseUrl()}/content/${req.params.itemId}/${filename}`;

    try {
      await pool.query(
        `INSERT INTO uploaded_files (item_id, file_type, filename, url, size_bytes, language)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (item_id, filename) DO UPDATE SET url = $4, size_bytes = $5, uploaded_at = NOW()`,
        [req.params.itemId, ext, filename, url, size, lang],
      );
    } catch (e) {
      console.warn('DB write (file):', e.message);
    }

    res.json({ url, filename, size: formatSize(size), lang });
  },
);

// List all uploaded files for an item
// GET /api/upload/:itemId
app.get('/api/upload/:itemId', validateItemId, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM uploaded_files WHERE item_id = $1 ORDER BY uploaded_at',
      [req.params.itemId],
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
});

// Delete one file for an item
// DELETE /api/upload/:itemId/:filename
app.delete('/api/upload/:itemId/:filename',
  requireApiKey, validateItemId,
  async (req, res) => {
    const { filename } = req.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(filename))
      return res.status(400).json({ error: 'Invalid filename' });

    const filePath = path.join(CONTENT_DIR, req.params.itemId, filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await pool.query(
        'DELETE FROM uploaded_files WHERE item_id = $1 AND filename = $2',
        [req.params.itemId, filename],
      );
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    res.json({ ok: true });
  },
);

// Delete ALL files for an item (called when item is deleted from admin)
// DELETE /api/upload/:itemId
app.delete('/api/upload/:itemId',
  requireApiKey, validateItemId,
  async (req, res) => {
    const dir = path.join(CONTENT_DIR, req.params.itemId);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      await pool.query('DELETE FROM uploaded_files WHERE item_id = $1', [req.params.itemId]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    res.json({ ok: true });
  },
);

// ── App state: catalog items + settings ─────────────────────────────────────

const DEFAULT_SETTINGS = {
  allowedUsers: [],
  blacklist: [],
  customTypes: ['BOOK', 'ARTICLE', 'JOURNAL', 'VIDEO', 'AUDIO', 'COURSE'],
  defaultLanguage: 'ru',
  globalAccess: false,
  // Identifiers whose visits / item events should NOT be counted in
  // analytics. Applied both at write-time (POST /api/visits and
  // POST /api/items/:itemId/track skip the insert) and at read-time
  // (GET /api/analytics filters out any pre-existing rows that match).
  analyticsExcludes: { usernames: [], ips: [], userIds: [], browsers: [], visitors: [] },
};

// True when the visitor matches any entry on the admin's "don't count me"
// list. Cheap — settings are cached for 30 s. Username comparison is
// case-insensitive and tolerates a leading @. browserToken is the value of
// the `x-skip-analytics` request header; userId is the Telegram numeric ID.
const isAnalyticsExcluded = (username, ip, userId, browserToken, settings) => {
  const ex = settings?.analyticsExcludes || {};
  const u = (username || '').toLowerCase().replace(/^@/, '');
  const ipClean = (ip || '').trim();
  const uid = userId != null ? String(userId) : '';

  const exU   = (ex.usernames || []).map(x => String(x).toLowerCase().replace(/^@/, ''));
  const exI   = (ex.ips || []).map(x => String(x).trim());
  const exUid = (ex.userIds || []).map(x => String(x).trim());
  const exTok = (ex.browsers || []).map(b => b?.token).filter(Boolean);

  if (u && u !== 'guest' && exU.includes(u)) return true;
  // Exact match only. Matching an anonymised entry (85.140.3.0) would silently
  // widen the exclusion to the visitor's whole /24 and stop counting unrelated
  // people who happen to share it — an exclude must target one visitor.
  if (ipClean && ipClean !== 'unknown' && exI.includes(ipClean)) return true;
  if (uid && exUid.includes(uid)) return true;
  if (browserToken && exTok.includes(browserToken)) return true;
  // Pseudonym match: identifies exactly one address, unlike the truncated IP.
  const exVis = (ex.visitors || []).map(x => String(x).trim());
  if (exVis.length) {
    const h = visitorHash(ipClean);
    if (h && exVis.includes(h)) return true;
  }
  return false;
};

// Full app state (catalog + settings + average ratings)
// checkUserAccess: blocks blacklisted users; extracts trusted user identity.
// Private items are stripped server-side for non-whitelisted users.
app.get('/api/state', checkUserAccess, async (req, res) => {
  try {
    const itemsRes = await pool.query('SELECT data FROM items ORDER BY seq');
    const setRes   = await pool.query('SELECT data FROM app_settings WHERE id = 1');
    const rateRes  = await pool.query(
      `SELECT item_id, round(avg(rating)::numeric, 1)::float AS avg
         FROM user_ratings GROUP BY item_id`,
    );
    const settings = setRes.rows[0]?.data || DEFAULT_SETTINGS;
    const ratings  = {};
    for (const r of rateRes.rows) ratings[r.item_id] = r.avg;

    // Server-side whitelist gate: hide private items from non-whitelisted users
    const { telegramUser } = req;
    const allowed = settings.allowedUsers || [];
    const canSeePrivate = settings.globalAccess ||
      (telegramUser && (
        allowed.includes(telegramUser.id) ||
        (telegramUser.username && allowed.includes(telegramUser.username))
      ));
    let items = itemsRes.rows.map(r => r.data);
    if (!canSeePrivate) items = items.filter(item => !item.isPrivate);

    res.json({ ...DEFAULT_SETTINGS, ...settings, items, ratings });
  } catch (e) {
    console.warn('GET /api/state:', e.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

// ── Article reader: fetch external URL and run Mozilla Readability ─────────
// Returns a cleaned-up { title, byline, content (sanitised HTML), excerpt,
// siteName, length, lang } object the in-app reader can render directly.
// Aggressive caching keeps repeat opens fast — articles change rarely.

const articleCache = new Map(); // url → { at, data }
const ARTICLE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const ARTICLE_CACHE_MAX = 200;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const ARTICLE_MAX_BYTES = 4 * 1024 * 1024; // 4 MB raw HTML

// #24 — DOMPurify instead of regex. The previous regex sanitiser missed
// unquoted attributes (`<img src=x onerror=alert(1)>`), SVG event handlers
// (`<svg onload=...>` and `<animate onbegin=...>`), data: URIs hosting HTML,
// and any nested-element variant that didn't match the exact pattern. CSP
// blocks the resulting <script> at the browser level, but defence-in-depth
// says don't ship known-broken sanitisation.
// We run DOMPurify against a JSDOM window — it does the same node-walk
// approach that browser-side DOMPurify uses, so the policy matches whatever
// the React client would have enforced if it had run there itself.
const purifyWindow = new JSDOM('').window;
const DOMPurify = createDOMPurify(purifyWindow);
// Conservative profile for article content: prose tags only, no inline
// styles, no forms, http(s)/mailto/data:image links only.
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code',
    'a', 'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup', 'mark',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption',
    'img', 'figure', 'figcaption',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'lang'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,)/i,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'noscript'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover'],
  ALLOW_DATA_ATTR: false,
};
// Pin rel="noopener noreferrer" + target=_blank on outbound links so a
// sanitised article opens externally without exposing window.opener.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
const sanitiseHtml = (html) => (html ? DOMPurify.sanitize(html, PURIFY_CONFIG) : '');

// ── SSRF defence for /api/article-extract ────────────────────────────────────
// Any unauthenticated visitor can pass a URL — without these guards an
// attacker would probe internal services (library-db, deploy-control mailbox,
// cloud metadata at 169.254.169.254) by fetching them through the server's
// network position. Rules:
//   1. Hostname must resolve only to public unicast IPs (no RFC1918, loopback,
//      link-local, multicast, broadcast, unspecified, CGNAT, IPv6 ULA).
//   2. Port restricted to 80/443 — blocks targeting Redis (6379), Postgres
//      (5432), SSH (22), random Docker-internal services.
//   3. Redirects are handled manually — every hop is re-validated against the
//      same rules, so an attacker can't bounce through a public 302 to a
//      private 200.

const isPrivateOrReservedIp = (ip) => {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0) return true;            // 0.0.0.0/8 unspecified
    if (o[0] === 10) return true;           // 10.0.0.0/8 private
    if (o[0] === 127) return true;          // 127.0.0.0/8 loopback
    if (o[0] === 169 && o[1] === 254) return true;       // 169.254/16 link-local incl. AWS metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12 private
    if (o[0] === 192 && o[1] === 168) return true;       // 192.168/16 private
    if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;  // 192.0.0/24 reserved
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // 100.64/10 CGNAT
    if (o[0] >= 224) return true;           // 224+ multicast / reserved / broadcast
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 ULA
    if (v.startsWith('fe80:') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // fe80::/10 link-local
    if (v.startsWith('ff')) return true;    // ff00::/8 multicast
    if (v.startsWith('::ffff:')) {          // IPv4-mapped
      const v4 = v.slice(7);
      return isPrivateOrReservedIp(v4);
    }
    return false;
  }
  return true; // unknown family → reject
};

// Validates a URL against SSRF policy. Returns { ok: true } or { ok: false, error }.
// Resolves DNS and checks every returned address.
const validateExternalUrl = async (raw) => {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'Invalid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http/https' };
  // Restrict to standard web ports — nothing legitimate needs to fetch articles from :22 or :6379.
  const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) return { ok: false, error: 'Port not allowed' };
  // Block raw IP hostnames that are themselves private (skip DNS).
  const host = u.hostname;
  if (net.isIP(host) && isPrivateOrReservedIp(host)) return { ok: false, error: 'Private IP' };
  // Resolve and reject if any answer is private — protects against DNS rebinding
  // at the moment of the check (we don't re-resolve on the actual fetch though,
  // so a TOCTOU window remains; documented limitation).
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0) return { ok: false, error: 'DNS lookup failed' };
    for (const a of addrs) {
      if (isPrivateOrReservedIp(a.address)) return { ok: false, error: 'Resolves to private IP' };
    }
  } catch { return { ok: false, error: 'DNS lookup failed' }; }
  return { ok: true, url: u.toString() };
};

// Fetch with manual redirect handling so every Location hop is re-validated.
const fetchWithSsrfGuard = async (initialUrl, signal, headers, maxHops = 5) => {
  let current = initialUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    const check = await validateExternalUrl(current);
    if (!check.ok) return { error: check.error, status: 400 };
    const r = await fetch(check.url, { signal, redirect: 'manual', headers });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return { response: r };
      current = new URL(loc, check.url).toString();
      continue;
    }
    return { response: r };
  }
  return { error: 'Too many redirects', status: 508 };
};

// ── DOI (scholarly metadata + citations) ─────────────────────────────────────
//
// Unlike /api/article-extract there is no SSRF surface here: the host is fixed
// and only the DOI travels, so the guard is input shape rather than network
// policy. The DOI is validated against the registered form before it is ever
// put in a path, and percent-encoded on the way out.
//
// DOI_RESOLVER_BASE exists because some institutions front doi.org with their
// own resolver; it also lets the tests point at a stub.
const DOI_BASE = (process.env.DOI_RESOLVER_BASE || 'https://doi.org').replace(/\/+$/, '');
const DOI_RE = /^10\.\d{4,9}\/\S+$/;
const DOI_TIMEOUT_MS = 8000;
const DOI_MAX_BYTES = 256 * 1024;

const cleanDoi = (raw) => {
  let d = String(raw || '').trim();
  d = d.replace(/^doi:\s*/i, '')
       .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
  if (/^\(.*\)$/.test(d) || /^\[.*\]$/.test(d)) d = d.slice(1, -1);
  d = d.replace(/[.,;]+$/, '').trim();
  if (d.length > 256 || !DOI_RE.test(d)) return null;
  return d;
};

// Encode each path segment but keep the '/' that separates registrant from
// suffix — that slash is part of the DOI, not a path boundary we invented.
const doiPath = (doi) => doi.split('/').map(encodeURIComponent).join('/');

const fetchDoi = async (doi, accept) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOI_TIMEOUT_MS);
  try {
    const r = await fetch(`${DOI_BASE}/${doiPath(doi)}`, {
      headers: {
        Accept: accept,
        // Crossref asks callers to identify themselves; it buys better service.
        'User-Agent': `OptionsData-Library/1.0 (${process.env.BASE_URL || 'https://library.optionsdata.ru'})`,
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (r.status === 404) return { error: 'DOI not found', status: 404 };
    if (!r.ok) return { error: 'Resolver error', status: 502 };
    const text = (await r.text()).slice(0, DOI_MAX_BYTES);
    return { text };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'Resolver timed out' : 'Resolver unreachable', status: 504 };
  } finally {
    clearTimeout(timer);
  }
};

// Admin autofill. Returns only the fields the editor fills in, so a change in
// the registry's payload can't quietly become part of our stored shape.
app.get('/api/doi/lookup', requireApiKey, limitDoi, async (req, res) => {
  const doi = cleanDoi(req.query.doi);
  if (!doi) return res.status(400).json({ error: 'Invalid DOI' });

  const got = await fetchDoi(doi, 'application/vnd.citationstyles.csl+json');
  if (got.error) return res.status(got.status).json({ error: got.error });

  let csl;
  try { csl = JSON.parse(got.text); }
  catch { return res.status(502).json({ error: 'Resolver returned malformed metadata' }); }

  const firstOf = (v) => (Array.isArray(v) ? v[0] : v) || '';
  const authors = Array.isArray(csl.author)
    ? csl.author
        .map(a => (a.literal || [a.given, a.family].filter(Boolean).join(' ')).trim())
        .filter(Boolean)
    : [];
  // CSL dates are [[year, month, day]]; the year alone is what we store, and it
  // goes into the item's existing publishedDate rather than a second field.
  const year = (csl.issued?.['date-parts']?.[0]?.[0])
    ?? (csl['published-print']?.['date-parts']?.[0]?.[0])
    ?? (csl['published-online']?.['date-parts']?.[0]?.[0])
    ?? null;

  res.json({
    doi,
    title: String(firstOf(csl.title)).trim(),
    authors,
    journal: String(firstOf(csl['container-title'])).trim(),
    publisher: String(csl.publisher || '').trim(),
    // Registry's own machine value, verbatim — the UI derives the label.
    type: String(csl.type || '').trim(),
    year: Number.isInteger(year) ? String(year) : '',
  });
});

// Formatted citation. Public because the item page offers it to readers, and
// rate-limited because it is a proxied upstream call. We ask the resolver to
// do the formatting: hand-rolling APA/MLA means owning every edge case
// (eight authors, no journal, non-Latin names) and getting them wrong.
app.get('/api/doi/citation', limitDoi, async (req, res) => {
  const doi = cleanDoi(req.query.doi);
  if (!doi) return res.status(400).json({ error: 'Invalid DOI' });

  const style = String(req.query.style || 'apa');
  const ALLOWED = ['apa', 'modern-language-association', 'bibtex'];
  if (!ALLOWED.includes(style)) return res.status(400).json({ error: 'Unsupported style' });

  const accept = style === 'bibtex'
    ? 'application/x-bibtex'
    : `text/x-bibliography; style=${style}; locale=en-US`;

  const got = await fetchDoi(doi, accept);
  if (got.error) return res.status(got.status).json({ error: got.error });

  res.json({ doi, style, citation: got.text.trim() });
});

app.get('/api/article-extract', limitArticle, async (req, res) => {
  const url = req.query.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2000) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Cache check
  const hit = articleCache.get(url);
  if (hit && Date.now() - hit.at < ARTICLE_CACHE_TTL) {
    return res.json({ ...hit.data, cached: true });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARTICLE_FETCH_TIMEOUT);
  try {
    const fetched = await fetchWithSsrfGuard(url, controller.signal, {
      'User-Agent': 'Mozilla/5.0 (compatible; OptionsDataLibrary/1.0; +https://library.optionsdata.ru)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru,en;q=0.8,es;q=0.5',
    });
    clearTimeout(timer);
    if (fetched.error) return res.status(fetched.status || 400).json({ error: fetched.error });
    const upstream = fetched.response;

    if (!upstream.ok) return res.status(502).json({ error: `Upstream ${upstream.status}` });
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('html') && !ct.includes('xml')) {
      return res.status(415).json({ error: 'Not an HTML page' });
    }

    // Length-bound the body so a hostile/huge page can't OOM the server.
    const reader = upstream.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > ARTICLE_MAX_BYTES) {
        try { reader.cancel(); } catch { /* noop */ }
        return res.status(413).json({ error: 'Article too large' });
      }
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString('utf8');

    const dom = new JSDOM(html, { url });
    const reader2 = new Readability(dom.window.document);
    const parsed = reader2.parse();
    if (!parsed) return res.status(422).json({ error: 'Could not extract article' });

    const data = {
      url,
      title:    (parsed.title    || '').slice(0, 500),
      byline:   (parsed.byline   || '').slice(0, 200),
      excerpt:  (parsed.excerpt  || '').slice(0, 800),
      siteName: (parsed.siteName || '').slice(0, 200),
      lang:     (parsed.lang     || '').slice(0, 8),
      length:    parsed.length || 0,
      content:  sanitiseHtml(parsed.content || ''),
    };

    // Cap cache size (drop oldest)
    if (articleCache.size >= ARTICLE_CACHE_MAX) {
      const oldest = articleCache.keys().next().value;
      if (oldest) articleCache.delete(oldest);
    }
    articleCache.set(url, { at: Date.now(), data });

    res.json(data);
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === 'AbortError' ? 'Timed out' : (e?.message || 'Fetch failed');
    res.status(500).json({ error: msg });
  }
});

// Lightweight auth check for Nginx auth_request on /content/ (IP blacklist only)
app.get('/api/check-access', async (req, res) => {
  const ip = clientIp(req);
  try {
    const settings = await getSettingsCached();
    const bl = (settings.blacklist || []).map(s => s.toLowerCase().replace(/^@/, ''));
    if (ip && bl.includes(ip)) return res.status(403).end();
    res.status(200).end();
  } catch { res.status(200).end(); } // fail open
});

// Returns true if the request may access this item's files. Public items are
// always allowed; private items require the caller to be not-blacklisted and
// (globalAccess OR whitelisted). Mirrors the front-end access gate.
const canAccessItemFiles = async (item, req) => {
  if (!item?.isPrivate) return true;
  const botToken = process.env.BOT_TOKEN;
  const initDataRaw = req.headers['x-telegram-init-data'];
  const ip = clientIp(req);
  let telegramUser = null;
  if (botToken && initDataRaw) telegramUser = validateTelegramInitData(initDataRaw, botToken);

  const settings = await getSettingsCached();
  const bl = (settings.blacklist || []).map(s => s.toLowerCase().replace(/^@/, ''));
  const blocked =
    (telegramUser && (bl.includes(telegramUser.id) || bl.includes(telegramUser.username))) ||
    (ip && bl.includes(ip));
  if (blocked) return false;

  if (!settings.globalAccess) {
    const allowed = settings.allowedUsers || [];
    const ok = telegramUser && (
      allowed.includes(telegramUser.id) ||
      (telegramUser.username && allowed.includes(telegramUser.username))
    );
    if (!ok) return false;
  }
  return true;
};

// Builds the human-readable download filename: "Title - Author (lang[, N]).ext".
// N is added only when several files share the same language AND extension.
const buildDownloadName = (item, fileRow, allRows) => {
  const filename = fileRow.filename;
  const ext  = path.extname(filename);                 // includes leading dot
  const lang = (fileRow.language || filename.split('-')[0] || '').toLowerCase();
  const type = fileRow.file_type || ext.slice(1).toLowerCase();

  const t = item?.title;
  const title = ((typeof t === 'string' ? t : (t?.[lang] || t?.en || t?.ru || t?.es)) || 'file').trim();
  const author = (item?.author || '').trim();

  // 1-based index within the same (language, type) group, only if there's >1
  const peers = (allRows || []).filter(r =>
    (r.language || '').toLowerCase() === lang &&
    (r.file_type || path.extname(r.filename).slice(1)).toLowerCase() === type,
  );
  let suffix = lang;
  if (peers.length > 1) {
    const idx = peers.findIndex(r => r.filename === filename);
    suffix = `${lang}, ${idx >= 0 ? idx + 1 : peers.length}`;
  }

  const raw = `${title}${author ? ' - ' + author : ''} (${suffix})${ext}`;
  // Strip characters illegal in filenames on common OSes; keep Unicode/Cyrillic.
  return raw.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
};

// Protected file endpoint for private items (used by the in-app readers).
// Validates access, then serves the file via Nginx X-Accel-Redirect.
app.get('/api/file/:itemId/:filename', validateItemId, async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename))
    return res.status(400).json({ error: 'Invalid filename' });

  try {
    const itemRes = await pool.query('SELECT data FROM items WHERE id = $1', [req.params.itemId]);
    const item = itemRes.rows[0]?.data;
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!(await canAccessItemFiles(item, req))) return res.status(403).json({ error: 'Access denied' });

    // Delegate actual file transfer to Nginx (efficient, zero-copy)
    res.setHeader('X-Accel-Redirect', `/internal-content/${req.params.itemId}/${filename}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Issue a short-lived signed download token.
// checkUserAccess: blocks blacklisted users + attaches req.telegramUser / req.cachedSettings.
// Private items additionally require whitelist membership (same gate as /api/file).
// Public items require only the blacklist check (already enforced by checkUserAccess).
app.post('/api/download-token', checkUserAccess, async (req, res) => {
  const { itemId, filename } = req.body || {};
  if (!itemId || !filename ||
      !/^[a-zA-Z0-9_-]+$/.test(itemId) ||
      !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  try {
    const itemRes = await pool.query('SELECT data FROM items WHERE id = $1', [itemId]);
    const item = itemRes.rows[0]?.data;
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Private items: additionally enforce whitelist
    if (item.isPrivate) {
      const settings = req.cachedSettings;
      if (!settings.globalAccess) {
        const allowed = settings.allowedUsers || [];
        const user = req.telegramUser;
        const ok = user && (
          allowed.includes(user.id) ||
          (user.username && allowed.includes(user.username))
        );
        if (!ok) return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Verify the requested file actually exists on disk
    const filePath = path.join(CONTENT_DIR, itemId, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const token = signDownloadToken(itemId, filename);
    res.json({ token, url: `/api/download/${itemId}/${filename}?t=${token}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve the file for download. Requires a valid presigned token (?t=...) issued
// by POST /api/download-token — this is the only auth gate, so the token must
// have already verified blacklist + whitelist membership at issue time.
app.get('/api/download/:itemId/:filename', validateItemId, async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename))
    return res.status(400).json({ error: 'Invalid filename' });

  if (!verifyDownloadToken(req.query.t, req.params.itemId, filename)) {
    return res.status(403).json({ error: 'Invalid or expired download token' });
  }

  try {
    const itemRes = await pool.query('SELECT data FROM items WHERE id = $1', [req.params.itemId]);
    const item = itemRes.rows[0]?.data;
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const filesRes = await pool.query(
      'SELECT filename, file_type, language, uploaded_at FROM uploaded_files WHERE item_id = $1 ORDER BY uploaded_at ASC',
      [req.params.itemId],
    );
    const rows = filesRes.rows;
    const me = rows.find(r => r.filename === filename) || { filename };
    const niceName = buildDownloadName(item, me, rows);

    const asciiName = niceName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(niceName)}`,
    );
    res.setHeader('X-Accel-Redirect', `/internal-content/${req.params.itemId}/${filename}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create or update one catalog item
app.put('/api/items/:itemId', requireApiKey, validateItemId, async (req, res) => {
  const item = req.body;
  if (!item || typeof item !== 'object' || item.id !== req.params.itemId) {
    return res.status(400).json({ error: 'Item id mismatch' });
  }
  try {
    await pool.query(
      `INSERT INTO items (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [item.id, JSON.stringify(item)],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset view/download counters on every item + wipe the event log
app.post('/api/items/reset-stats', requireApiKey, async (req, res) => {
  try {
    await pool.query(
      `UPDATE items SET data = jsonb_set(jsonb_set(data, '{views}', '0'), '{downloads}', '0')`,
    );
    await pool.query('DELETE FROM item_events');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete one catalog item. Cascades to all per-user tables so no orphan rows
// linger after content is removed — the schema has no FK ON DELETE CASCADE
// between items and user_*, so we clean up explicitly here.
app.delete('/api/items/:itemId', requireApiKey, validateItemId, async (req, res) => {
  const { itemId } = req.params;
  try {
    // 1. Files on disk
    const itemDir = path.join(CONTENT_DIR, itemId);
    try { fs.rmSync(itemDir, { recursive: true, force: true }); } catch { /* noop */ }

    // 2. Catalog + uploaded files registry + every per-user trace of this item.
    //    Run sequentially (not in a transaction) so a single failing query
    //    doesn't block the rest — leftover rows are harmless without the parent.
    const sweep = async (sql) => { try { await pool.query(sql, [itemId]); } catch (e) { console.warn('cascade-delete', sql.split(' ')[2], e.message); } };
    await sweep('DELETE FROM uploaded_files        WHERE item_id = $1');
    await sweep('DELETE FROM user_reading_progress WHERE item_id = $1');
    await sweep('DELETE FROM user_bookmarks        WHERE item_id = $1');
    await sweep('DELETE FROM user_annotations      WHERE item_id = $1');
    await sweep('DELETE FROM user_favorites        WHERE item_id = $1');
    await sweep('DELETE FROM user_ratings          WHERE item_id = $1');
    await sweep('DELETE FROM item_events           WHERE item_id = $1');
    // 3. And everything the search knows about it. Without this a deleted book
    //    keeps answering questions — its text is still in the index, quoted to
    //    readers, pointing at a material that no longer exists.
    await sweep('DELETE FROM chunks                WHERE item_id = $1');
    await sweep('DELETE FROM document_text         WHERE item_id = $1');
    await sweep('DELETE FROM index_status          WHERE item_id = $1');
    await sweep('DELETE FROM content_scan          WHERE item_id = $1');
    await sweep(`DELETE FROM jobs WHERE item_id = $1 AND state IN ('done','failed','cancelled')`);
    await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Increment a view/download counter + record the event (public — visitor action)
app.post('/api/items/:itemId/track', validateItemId, async (req, res) => {
  const type = req.body?.type;
  if (type !== 'view' && type !== 'download') {
    return res.status(400).json({ error: 'Invalid type' });
  }
  const field = type === 'view' ? 'views' : 'downloads';
  const username = clip(req.body?.username, 64);
  const ip = resolveVisitorIp(req);
  const tgUser  = validateTelegramInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN);
  const userId  = tgUser?.id || null;
  const browserToken = clip(req.headers['x-skip-analytics'], 80);
  try {
    const settings = await getSettingsCached();
    if (isAnalyticsExcluded(username, ip, userId, browserToken, settings)) {
      // Don't pollute the visible counters or the events feed
      return res.json({ ok: true, skipped: 'excluded' });
    }
    await pool.query(
      `UPDATE items
          SET data = jsonb_set(data, '{${field}}',
                to_jsonb(COALESCE((data ->> '${field}')::int, 0) + 1))
        WHERE id = $1`,
      [req.params.itemId],
    );
    // Pick the most informative identifier we can. Without this the leader-
    // board's `WHERE username IS NOT NULL` silently drops every Telegram user
    // who hasn't set a @handle (typical for new accounts), so the table looked
    // empty even with active traffic.
    //   1. body-supplied @username (lowercased on the client)
    //   2. verified Telegram numeric ID, prefixed `id_` so it can't collide
    //      with a real handle and the admin UI can format it as "ID 12345"
    //   3. NULL — anonymous web visitor with no Telegram identity at all
    const trackedUser = username || (userId ? `id_${userId}` : null);
    await pool.query(
      `INSERT INTO item_events (item_id, username, event_type) VALUES ($1, $2, $3)`,
      [req.params.itemId, trackedUser, type],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save settings (whitelist, blacklist, custom types, bot config…)
// Strict settings sanitiser. Without this, an admin (or anyone post-API-key
// theft) could PUT { __proto__: ... } for prototype pollution, drop a huge
// `blacklist: [...100k items]` for cache DoS, or sneak in unknown keys that
// downstream code happens to read. Returns a clean settings object built
// only from the known-shape keys. Throws ValidationError on hard violations.
class ValidationError extends Error {}
const MAX_LIST = 10000;
const STR = (v, max = 256) => {
  if (typeof v !== 'string') throw new ValidationError('Expected string');
  if (v.length > max) throw new ValidationError(`String exceeds ${max} chars`);
  return v;
};
const arrOfStr = (v, maxItems = MAX_LIST, maxLen = 256) => {
  if (!Array.isArray(v)) throw new ValidationError('Expected array');
  if (v.length > maxItems) throw new ValidationError(`Array exceeds ${maxItems} items`);
  return v.map(x => STR(x, maxLen));
};
const sanitiseSettings = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Settings must be an object');
  const out = {};
  if ('allowedUsers' in raw)   out.allowedUsers   = arrOfStr(raw.allowedUsers, 10000, 64);
  if ('blacklist'    in raw)   out.blacklist      = arrOfStr(raw.blacklist,    10000, 64);
  if ('customTypes'  in raw) {
    if (!Array.isArray(raw.customTypes)) throw new ValidationError('customTypes must be array');
    if (raw.customTypes.length > 100) throw new ValidationError('Too many customTypes');
    out.customTypes = raw.customTypes.map(ct => {
      if (typeof ct === 'string') return STR(ct, 64);
      if (!ct || typeof ct !== 'object') throw new ValidationError('customType entry must be object');
      return { id: STR(ct.id, 64), en: STR(ct.en, 128), ru: STR(ct.ru, 128), es: STR(ct.es, 128) };
    });
  }
  if ('defaultLanguage' in raw) {
    const lang = STR(raw.defaultLanguage, 8);
    if (!['en', 'ru', 'es'].includes(lang)) throw new ValidationError('defaultLanguage must be en/ru/es');
    out.defaultLanguage = lang;
  }
  if ('globalAccess' in raw) {
    if (typeof raw.globalAccess !== 'boolean') throw new ValidationError('globalAccess must be boolean');
    out.globalAccess = raw.globalAccess;
  }
  if ('analyticsExcludes' in raw) {
    const a = raw.analyticsExcludes;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ValidationError('analyticsExcludes must be object');
    out.analyticsExcludes = {
      usernames: 'usernames' in a ? arrOfStr(a.usernames, 1000, 64) : [],
      ips:       'ips'       in a ? arrOfStr(a.ips,       1000, 64) : [],
      userIds:   'userIds'   in a ? arrOfStr(a.userIds,   1000, 64) : [],
      // Pseudonyms from the access log (visitorHash output) — lets an admin
      // exclude one visitor exactly, including an anonymous one who has no
      // @handle or Telegram id to key on.
      visitors:  'visitors'  in a ? arrOfStr(a.visitors,  1000, 64) : [],
      browsers:  Array.isArray(a.browsers)
        ? (a.browsers.length > 1000 ? (() => { throw new ValidationError('Too many browsers'); })() : a.browsers.map(b => {
            if (!b || typeof b !== 'object') throw new ValidationError('browser entry must be object');
            return { token: STR(b.token, 80), label: STR(b.label || '', 128), addedAt: STR(b.addedAt || '', 64) };
          }))
        : [],
    };
  }
  return out;
};

app.put('/api/settings', requireApiKey, async (req, res) => {
  let clean;
  try { clean = sanitiseSettings(req.body); }
  catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    return res.status(400).json({ error: 'Invalid settings' });
  }
  try {
    await pool.query(
      `INSERT INTO app_settings (id, data) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(clean)],
    );
    invalidateSettingsCache(); // blacklist/whitelist changed — clear cache immediately
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Step 5: traffic logging & analytics ─────────────────────────────────────

// Record a page visit (public — visitor action)
app.post('/api/visits', async (req, res) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const username = clip(req.body?.username, 64);
  // Trust the connection, not the payload. The client used to report its own
  // address (fetched from a third-party lookup), which made IP excludes both
  // spoofable and unreliable — a failed lookup sent 'unknown' and silently
  // disabled IP-based exclusion for that visit. clientIp() is the same source
  // /api/items/:itemId/track already uses, so the two paths now agree.
  //
  // If the connection only yields an infrastructure address (proxy trust
  // misconfigured, or a topology this build didn't anticipate), every row would
  // otherwise collapse onto one gateway IP. In that case fall back to what the
  // client reported: weaker, but it keeps the log informative instead of
  // uniformly useless.
  const ip       = resolveVisitorIp(req);
  // Use the verified Telegram user (initData HMAC) — body fields would be
  // trivially spoofable. browserToken arrives via custom header.
  const tgUser  = validateTelegramInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN);
  const userId  = tgUser?.id || req.body?.userId || null;
  const browserToken = clip(req.headers['x-skip-analytics'], 80);
  try {
    const settings = await getSettingsCached();
    if (isAnalyticsExcluded(username, ip, userId, browserToken, settings)) {
      return res.json({ ok: true, skipped: 'excluded' });
    }
    // Same identifier resolution as item_events: a real @handle wins, then
    // verified Telegram numeric ID (`id_NN`), then whatever the body said
    // ("guest" by default from the client). Keeps the access log distinct
    // per anonymous Telegram visitor instead of one giant "guest" pile.
    const loggedUser = (username && username !== 'guest')
      ? username
      : (userId ? `id_${userId}` : username);
    await pool.query(
      `INSERT INTO visit_logs (id, username, ip, ip_hash, platform, device)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id, loggedUser, anonymizeIp(ip), visitorHash(ip),
        clip(req.body?.platform, 32),
        clip(req.body?.device, 256),
      ],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset just the traffic log (visit_logs) — separate from the per-item event
// reset so the admin can wipe noisy traffic numbers without losing view/
// download history on books.
app.post('/api/visits/reset', requireApiKey, async (req, res) => {
  try {
    await pool.query('DELETE FROM visit_logs');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Purge access-log rows belonging to anyone currently on the exclude list.
// The write-time filter only stops *new* rows, so entries recorded before an
// exclude was added linger in the log; this applies the list retroactively.
//
// Deliberately matches on identity (username / Telegram id) only:
//   • IP excludes can't be applied backwards. Rows store the anonymised
//     address (#37), so the only way to match an excluded IP would be to
//     compare its truncated form — which would delete every row in that /24,
//     including unrelated visitors. Over-deleting other people's rows is worse
//     than leaving a few stale ones, so we don't.
//   • Browser-token excludes can't be matched either: the token is a request
//     header and never lands on the row.
// Both counts come back in the response so the UI can say what was skipped
// instead of implying the purge covered everything.
app.post('/api/visits/purge-excluded', requireApiKey, async (req, res) => {
  try {
    const settings = await getSettingsCached();
    const ex = settings.analyticsExcludes || {};
    const usernames = (ex.usernames || [])
      .map(x => String(x).toLowerCase().replace(/^@/, '').trim()).filter(Boolean);
    const userIds = (ex.userIds || []).map(x => String(x).trim()).filter(Boolean);
    // userIds are logged as `id_NN` when the visitor has no @handle.
    const names = [...usernames, ...userIds.map(id => `id_${id}`)];
    // Pseudonyms are stored on the row and identify one address exactly, so
    // unlike raw IPs they can be applied backwards without over-deleting.
    const visitors = (ex.visitors || []).map(x => String(x).trim()).filter(Boolean);
    const skipped = {
      ipsSkipped: (ex.ips || []).length,
      browserTokensSkipped: (ex.browsers || []).length,
    };

    if (names.length === 0 && visitors.length === 0) {
      return res.json({ ok: true, deleted: 0, ...skipped });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM visit_logs
        WHERE ($1::text[] <> '{}' AND LOWER(username) = ANY($1))
           OR ($2::text[] <> '{}' AND ip_hash = ANY($2))`,
      [names, visitors],
    );
    res.json({ ok: true, deleted: rowCount || 0, ...skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aggregated analytics for the admin dashboard (protected — sensitive data)
app.get('/api/analytics', requireApiKey, async (req, res) => {
  try {
    // Read-time filter — drops any pre-existing rows belonging to excluded
    // usernames/IPs (events recorded BEFORE the exclude list was set). The
    // write-time filter on /api/visits + /api/items/:itemId/track stops new
    // ones from being recorded going forward.
    const settings = await getSettingsCached();
    const exU = ((settings.analyticsExcludes?.usernames) || [])
      .map(x => String(x).toLowerCase().replace(/^@/, '')).filter(Boolean);
    const exI = ((settings.analyticsExcludes?.ips) || [])
      .map(x => String(x).trim()).filter(Boolean);
    const exV = ((settings.analyticsExcludes?.visitors) || [])
      .map(x => String(x).trim()).filter(Boolean);
    // Build a parameterised WHERE for SQL injection safety.
    // `username IS NULL OR lower(...) NOT IN (...)` — without the IS NULL
    // branch, NULL-username rows (historical events from handle-less Telegram
    // visitors recorded before the id_<N> fallback) would evaluate to NULL
    // instead of TRUE and be silently dropped from BOTH the timeline and
    // the leaderboard the moment any exclude is configured.
    const userNotIn = exU.length > 0
      ? `AND (username IS NULL OR lower(username) NOT IN (${exU.map((_, i) => `$${i + 1}`).join(',')}))`
      : '';
    const visitNotIn = (exU.length + exI.length + exV.length) > 0
      ? `WHERE 1=1
           ${exU.length > 0 ? `AND (username IS NULL OR lower(username) NOT IN (${exU.map((_, i) => `$${i + 1}`).join(',')}))` : ''}
           ${exI.length > 0 ? `AND (ip IS NULL OR ip NOT IN (${exI.map((_, i) => `$${exU.length + i + 1}`).join(',')}))` : ''}
           ${exV.length > 0 ? `AND (ip_hash IS NULL OR ip_hash NOT IN (${exV.map((_, i) => `$${exU.length + exI.length + i + 1}`).join(',')}))` : ''}`
      : '';

    // Left-join the events against a generated 30-day calendar so the chart
    // always shows a continuous timeline even when activity is sparse —
    // without this, a single active day rendered as one isolated dot in
    // the middle of the chart, indistinguishable from a broken chart. The
    // userNotIn filter has to sit inside the LEFT JOIN's ON clause (not in
    // a WHERE) so excluded users can't cause whole days to be dropped from
    // the calendar.
    const statsRes = await pool.query(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - INTERVAL '29 days')::date,
           CURRENT_DATE::date,
           '1 day'::interval
         )::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              COALESCE(SUM(CASE WHEN e.event_type = 'view' THEN 1 ELSE 0 END), 0)::int     AS views,
              COALESCE(SUM(CASE WHEN e.event_type = 'download' THEN 1 ELSE 0 END), 0)::int AS downloads
         FROM days d
         LEFT JOIN item_events e
           ON e.timestamp::date = d.day
              ${userNotIn}
        GROUP BY d.day
        ORDER BY d.day`,
      exU,
    );

    const eventsRes = await pool.query(
      // NULL usernames are coerced into the synthetic 'anonymous' bucket so
      // legacy events (recorded before the id_<N> fallback landed) still
      // surface in the leaderboard as one aggregated row instead of being
      // silently dropped.
      `SELECT COALESCE(username, 'anonymous') AS username,
              item_id, event_type,
              count(*)::int AS cnt,
              to_char(max(timestamp), 'YYYY-MM-DD') AS last_active
         FROM item_events
        WHERE 1=1 ${userNotIn}
        GROUP BY COALESCE(username, 'anonymous'), item_id, event_type`,
      exU,
    );

    const users = {};
    for (const row of eventsRes.rows) {
      let u = users[row.username];
      if (!u) {
        u = users[row.username] = {
          username: row.username,
          views: 0, downloads: 0,
          lastActive: row.last_active,
          itemViews: {}, itemDownloads: {},
        };
      }
      if (row.last_active > u.lastActive) u.lastActive = row.last_active;
      if (row.event_type === 'view') {
        u.views += row.cnt;
        u.itemViews[row.item_id] = row.cnt;
      } else {
        u.downloads += row.cnt;
        u.itemDownloads[row.item_id] = row.cnt;
      }
    }

    const logsRes = await pool.query(
      `SELECT id, timestamp, username, ip, ip_hash, platform, device
         FROM visit_logs
        ${visitNotIn}
        ORDER BY timestamp DESC
        LIMIT 2000`,
      [...exU, ...exI, ...exV],
    );

    res.json({
      stats: statsRes.rows,
      userAnalytics: Object.values(users),
      visitLogs: logsRes.rows,
    });
  } catch (e) {
    console.warn('GET /api/analytics:', e.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

// ── Step 5: per-user favorites (public — visitor action) ────────────────────

app.get('/api/users/:userId/favorites', validateUserId, requireUserMatch, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT item_id FROM user_favorites WHERE user_id = $1',
      [req.params.userId],
    );
    res.json({ favorites: rows.map(r => r.item_id) });
  } catch {
    res.json({ favorites: [] });
  }
});

app.put('/api/users/:userId/favorites/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    try {
      await pool.query(
        `INSERT INTO user_favorites (user_id, item_id) VALUES ($1, $2)
         ON CONFLICT (user_id, item_id) DO NOTHING`,
        [req.params.userId, req.params.itemId],
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.delete('/api/users/:userId/favorites/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM user_favorites WHERE user_id = $1 AND item_id = $2',
        [req.params.userId, req.params.itemId],
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ── #36 Right to erasure ────────────────────────────────────────────────────
// DELETE /api/users/:userId wipes every per-user row across the schema —
// implements GDPR Art. 17 and the analogous 152-ФЗ right. Authorised via the
// admin API key (operator-erase on user request) OR a verified Telegram session
// matching the URL's userId (self-erase). Best-effort per-statement so a single
// failing sweep doesn't block the rest.
app.delete('/api/users/:userId', validateUserId, async (req, res) => {
  const { userId } = req.params;
  const adminOk = process.env.API_KEY && req.headers['x-api-key'] === process.env.API_KEY;
  if (!adminOk) {
    const tgUser = validateTelegramInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN);
    if (!tgUser || tgUser.id !== userId) {
      return res.status(403).json({ error: 'Authentication required to erase user data' });
    }
  }
  const wipes = [
    'DELETE FROM user_favorites        WHERE user_id = $1',
    'DELETE FROM user_ratings          WHERE user_id = $1',
    'DELETE FROM user_bookmarks        WHERE user_id = $1',
    'DELETE FROM user_reading_progress WHERE user_id = $1',
    'DELETE FROM user_annotations      WHERE user_id = $1',
  ];
  const tgUser = validateTelegramInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN);
  const username = tgUser?.username || null;
  const idMarker = `id_${userId}`;
  const sweep = async (sql, params) => {
    try { await pool.query(sql, params); }
    catch (e) { console.warn('erasure', sql.split(' ')[2], e.message); }
  };
  for (const sql of wipes) await sweep(sql, [userId]);
  // Un-attribute analytics rows — UPDATE-to-NULL keeps aggregate counters
  // intact while individual visits can no longer be tied to the deleted user.
  await sweep('UPDATE item_events SET username = NULL WHERE username = $1 OR username = $2', [idMarker, username]);
  // Clear the pseudonym too: leaving it would keep an erased person's visits
  // grouped under one stable value, which is exactly the linkage erasure is
  // meant to break (152-ФЗ ст. 21 / GDPR Art. 17).
  await sweep('UPDATE visit_logs  SET username = NULL, ip_hash = NULL WHERE username = $1 OR username = $2', [idMarker, username]);
  // Crash reports carry the reporter's identity (set from verified initData in
  // POST /api/errors). The stack itself is ours to keep for debugging, but the
  // attribution is the user's data and has to go with everything else.
  await sweep('UPDATE error_log SET user_id = NULL, username = NULL WHERE user_id = $1 OR username = $2', [userId, username]);
  res.json({ ok: true });
});

// Everything we hold about one person, in one response (152-ФЗ ст. 14 — the
// subject's right to know what is processed about them; GDPR Art. 15).
//
// Coverage is deliberately the mirror image of DELETE /api/users/:userId: the
// same tables, keyed the same two ways (user_id for per-user rows, @handle or
// the id_<N> marker for analytics rows). If the two ever drift, one of the
// rights is broken — either we hand back less than we hold, or we delete less
// than we admit to holding.
app.get('/api/users/:userId/export', validateUserId, requireUserMatch, async (req, res) => {
  const { userId } = req.params;
  const tgUser = validateTelegramInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN);
  const username = tgUser?.username || null;
  const idMarker = `id_${userId}`;

  // A failed section must not look like an empty one: silently returning []
  // would under-report what we hold, which is the one thing a subject access
  // response must never do.
  const failed = [];
  const q = async (label, sql, params) => {
    try { const r = await pool.query(sql, params); return r.rows; }
    catch (e) { console.warn('export', label, e.message); failed.push(label); return null; }
  };

  try {
    const [favorites, ratings, bookmarks, progress, annotations, visits, events, errors] = await Promise.all([
      q('favorites', 'SELECT item_id, created_at FROM user_favorites WHERE user_id = $1 ORDER BY created_at', [userId]),
      q('ratings', 'SELECT item_id, rating, created_at FROM user_ratings WHERE user_id = $1 ORDER BY created_at', [userId]),
      q('bookmarks', 'SELECT item_id, position, label, created_at FROM user_bookmarks WHERE user_id = $1 ORDER BY created_at', [userId]),
      q('readingProgress', 'SELECT item_id, position, position_total, format_url FROM user_reading_progress WHERE user_id = $1', [userId]),
      q('annotations', 'SELECT item_id, format_url, cfi_range, page, selected_text, note, color, created_at FROM user_annotations WHERE user_id = $1 ORDER BY created_at', [userId]),
      q('visits', 'SELECT timestamp, ip, platform, device FROM visit_logs WHERE username = $1 OR username = $2 ORDER BY timestamp', [idMarker, username]),
      q('itemEvents', 'SELECT item_id, event_type, timestamp FROM item_events WHERE username = $1 OR username = $2 ORDER BY timestamp', [idMarker, username]),
      q('errorReports', 'SELECT ts, kind, message, url FROM error_log WHERE user_id = $1 OR username = $2 ORDER BY ts', [userId, username]),
    ]);

    if (failed.length) {
      return res.status(500).json({ error: 'Export incomplete', sections: failed });
    }
    res.setHeader('Content-Disposition', `attachment; filename="my-data-${userId}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      about: {
        userId,
        telegramUsername: username,
        note: 'IP addresses in visits are stored anonymised (last IPv4 octet zeroed / IPv6 truncated to /48).',
      },
      favorites,
      ratings,
      bookmarks,
      readingProgress: progress,
      annotations,
      visits,
      itemEvents: events,
      errorReports: errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Step 5: per-user ratings (public — visitor action) ──────────────────────

app.get('/api/users/:userId/ratings', validateUserId, requireUserMatch, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT item_id, rating FROM user_ratings WHERE user_id = $1',
      [req.params.userId],
    );
    const ratings = {};
    for (const r of rows) ratings[r.item_id] = r.rating;
    res.json({ ratings });
  } catch {
    res.json({ ratings: {} });
  }
});

app.put('/api/users/:userId/ratings/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    const rating = parseInt(req.body?.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1–5' });
    }
    try {
      await pool.query(
        `INSERT INTO user_ratings (user_id, item_id, rating) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, item_id) DO UPDATE SET rating = $3, created_at = NOW()`,
        [req.params.userId, req.params.itemId, rating],
      );
      const { rows } = await pool.query(
        `SELECT round(avg(rating)::numeric, 1)::float AS average
           FROM user_ratings WHERE item_id = $1`,
        [req.params.itemId],
      );
      res.json({ ok: true, average: rows[0]?.average ?? rating });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ── Bookmarks ────────────────────────────────────────────────────────────────

app.get('/api/users/:userId/bookmarks/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, item_id, position, label, created_at
           FROM user_bookmarks
          WHERE user_id = $1 AND item_id = $2
          ORDER BY created_at DESC`,
        [req.params.userId, req.params.itemId],
      );
      res.json({ bookmarks: rows });
    } catch {
      res.json({ bookmarks: [] });
    }
  },
);

app.post('/api/users/:userId/bookmarks/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    const position = clip(req.body?.position, 512);
    const label    = clip(req.body?.label, 100) || 'Закладка';
    if (!position) return res.status(400).json({ error: 'position required' });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      await pool.query(
        `INSERT INTO user_bookmarks (id, user_id, item_id, position, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, req.params.userId, req.params.itemId, position, label],
      );
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.delete('/api/users/:userId/bookmarks/:bookmarkId',
  validateUserId, requireUserMatch,
  async (req, res) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(req.params.bookmarkId))
      return res.status(400).json({ error: 'Invalid bookmark ID' });
    try {
      await pool.query(
        'DELETE FROM user_bookmarks WHERE id = $1 AND user_id = $2',
        [req.params.bookmarkId, req.params.userId],
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ── User annotations (highlights + notes) ────────────────────────────────────

app.get('/api/users/:userId/annotations/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, item_id, format_url, cfi_range, page, selected_text, note, color, created_at
           FROM user_annotations
          WHERE user_id = $1 AND item_id = $2
          ORDER BY created_at DESC`,
        [req.params.userId, req.params.itemId],
      );
      res.json({ annotations: rows });
    } catch {
      res.json({ annotations: [] });
    }
  },
);

app.post('/api/users/:userId/annotations/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    const formatUrl    = clip(req.body?.formatUrl, 512) || '';
    const cfiRange     = clip(req.body?.cfiRange, 1024);
    const page         = Number.isInteger(parseInt(req.body?.page)) ? parseInt(req.body.page) : null;
    const selectedText = clip(req.body?.selectedText, 2000) || '';
    const note         = clip(req.body?.note, 2000);
    const color        = ['yellow', 'green', 'blue', 'pink'].includes(req.body?.color)
      ? req.body.color : 'yellow';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      await pool.query(
        `INSERT INTO user_annotations
           (id, user_id, item_id, format_url, cfi_range, page, selected_text, note, color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, req.params.userId, req.params.itemId, formatUrl, cfiRange, page, selectedText, note, color],
      );
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.delete('/api/users/:userId/annotations/:annotationId',
  validateUserId, requireUserMatch,
  async (req, res) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(req.params.annotationId))
      return res.status(400).json({ error: 'Invalid annotation ID' });
    try {
      await pool.query(
        'DELETE FROM user_annotations WHERE id = $1 AND user_id = $2',
        [req.params.annotationId, req.params.userId],
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ── Reading progress ─────────────────────────────────────────────────────────

// GET all progress for a user (used on app start to prefetch for progress bars)
app.get('/api/users/:userId/progress', validateUserId, requireUserMatch, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT item_id, position, position_total, format_url FROM user_reading_progress WHERE user_id = $1',
      [req.params.userId],
    );
    res.json({ progress: rows });
  } catch {
    res.json({ progress: [] });
  }
});

// GET single-item progress — returns all format rows for this item
app.get('/api/users/:userId/progress/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT position, position_total, format_url FROM user_reading_progress WHERE user_id = $1 AND item_id = $2',
        [req.params.userId, req.params.itemId],
      );
      res.json(rows);
    } catch {
      res.json([]);
    }
  },
);

// Wipe all reading progress for an item (used by the "Reset progress" button
// in Item Details). Removes both per-file rows and the synthetic "finished"
// marker, so the book becomes fresh again on the next open.
app.delete('/api/users/:userId/progress/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM user_reading_progress WHERE user_id = $1 AND item_id = $2',
        [req.params.userId, req.params.itemId],
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// PUT (upsert) single-item+format progress
app.put('/api/users/:userId/progress/:itemId',
  validateUserId, validateItemId, requireUserMatch,
  async (req, res) => {
    const position = clip(req.body?.position, 512);
    const positionTotal = parseInt(req.body?.positionTotal ?? 0, 10) || 0;
    const formatUrl = clip(req.body?.formatUrl, 512) || '';
    if (!position) return res.status(400).json({ error: 'position required' });
    try {
      await pool.query(
        `INSERT INTO user_reading_progress (user_id, item_id, position, position_total, format_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, item_id, format_url) DO UPDATE
           SET position = $3, position_total = $4, updated_at = NOW()`,
        [req.params.userId, req.params.itemId, position, positionTotal, formatUrl],
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ── Error handlers ───────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
    return res.status(400).json({ error: err.message });
  }

  // Malformed request bodies are the caller's fault, not a server fault.
  // express.json() rejects unparseable JSON with a 4xx-tagged SyntaxError; that
  // used to fall through to the branch below, so a scanner POSTing `{"invalid":}`
  // got a misleading 500 back and left a stack trace in the admin error log.
  // Answer with the status body-parser already decided and don't record it —
  // otherwise anyone can fill the log by sending junk.
  const status = err.status || err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    const reason = err.type === 'entity.parse.failed' ? 'Malformed JSON body'
      : err.type === 'entity.too.large' ? 'Payload too large'
      : 'Bad request';
    return res.status(status).json({ error: reason });
  }

  console.error('Unhandled error:', err.message);
  // Persist to the built-in monitor so server crashes are visible in the admin
  // panel, not just the container logs.
  recordError({
    source: 'server',
    kind: `${req.method} ${req.path}`,
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    userAgent: req.headers['user-agent'],
  });
  res.status(500).json({ error: 'Internal server error' });
});

// Last-resort process guards — log uncaught failures instead of dying silently.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  recordError({ source: 'server', kind: 'unhandledRejection', message: String(reason?.message || reason), stack: reason?.stack });
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  recordError({ source: 'server', kind: 'uncaughtException', message: err.message, stack: err.stack });
});

// ── Start ────────────────────────────────────────────────────────────────────

fs.mkdirSync(CONTENT_DIR, { recursive: true });

// #23 — Retention sweep. Without this every error_log row from a hostile
// client, every item_events INSERT and every visit_logs row lives forever:
// disk usage grows unbounded and a single buggy month inflates the timeline
// chart for years. Each table has a sensible retention window (default 90
// days, tunable via env). Runs on boot + every 24h while the process is up
// — cron-equivalent without an external scheduler.
const RETENTION_DAYS = {
  error_log:   parseInt(process.env.RETENTION_ERROR_LOG  || '90', 10),
  item_events: parseInt(process.env.RETENTION_ITEM_EVENTS || '365', 10),
  visit_logs:  parseInt(process.env.RETENTION_VISIT_LOGS  || '90',  10),
};
const RETENTION_COLUMN = { error_log: 'ts', item_events: 'timestamp', visit_logs: 'timestamp' };
const runRetention = async () => {
  for (const [table, days] of Object.entries(RETENTION_DAYS)) {
    if (!Number.isInteger(days) || days <= 0) continue; // 0 / NaN disables the sweep
    const col = RETENTION_COLUMN[table];
    try {
      const r = await pool.query(
        `DELETE FROM ${table} WHERE ${col} < NOW() - ($1::int * INTERVAL '1 day')`,
        [days],
      );
      if (r.rowCount > 0) console.log(`retention: ${table} pruned ${r.rowCount} rows older than ${days}d`);
    } catch (e) {
      // Table may not exist on a fresh install; logged once, swallowed.
      console.warn(`retention: ${table}:`, e.message);
    }
  }
};
// Delay first sweep a few seconds so the DB pool is warm.
setTimeout(() => { runRetention().catch(() => {}); }, 10_000);
setInterval(() => { runRetention().catch(() => {}); }, 24 * 60 * 60 * 1000).unref?.();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Library API :${PORT}  content=${CONTENT_DIR}  retention=${JSON.stringify(RETENTION_DAYS)}`);
});
