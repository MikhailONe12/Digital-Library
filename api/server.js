import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { createHmac, randomBytes } from 'crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
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

  console.log('DB: schema initialized');
};

pool.connect()
  .then(client => { client.release(); return initDb(); })
  .catch(err => console.warn('DB not ready:', err.message));

// ── Middleware ───────────────────────────────────────────────────────────────

const allowedOrigins = (process.env.CORS_ORIGIN || 'https://library.optionsdata.ru').split(',');

// Don't advertise the framework — one less hint for an attacker.
app.disable('x-powered-by');
app.set('trust proxy', true); // nginx sets X-Forwarded-For / X-Real-IP

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

const clientIp = (req) =>
  (req.headers['x-real-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0]
    || req.ip
    || 'unknown').toString().trim();

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
  const ip = (req.headers['x-real-ip'] || req.ip || '').split(',')[0].trim();

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
  next();
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
  'application/x-fictionbook+xml',
  'application/x-fictionbook',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.epub', '.mp4', '.webm', '.mkv', '.mp3', '.fb2', '.djvu', '.djv',
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
  if (!adminPassword || password !== adminPassword) {
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
  const tgUser = validateTelegramInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN);
  await recordError({
    source: 'client',
    kind: b.kind,
    message: b.message,
    stack: b.stack,
    url: b.url,
    userId: tgUser?.id || b.userId,
    username: tgUser?.username || b.username,
    userAgent: req.headers['user-agent'],
  });
  res.json({ ok: true });
});

// Admin: most recent errors (newest first).
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
    fs.writeFileSync(file, JSON.stringify({ requestedAt: new Date().toISOString() }));
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
    fs.writeFileSync(path.join(DEPLOY_CONTROL_DIR, 'mode.json'), JSON.stringify({ mode }));
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
    fs.writeFileSync(file, JSON.stringify({ requestedAt: new Date().toISOString() }));
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
    fs.writeFileSync(file, JSON.stringify({ filename, requestedAt: new Date().toISOString() }));
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
    fs.writeFileSync(BACKUP_CONFIG_FILE, JSON.stringify(next, null, 2));
    try { fs.chmodSync(BACKUP_CONFIG_FILE, 0o600); } catch { /* host fs */ }
    res.json({ config: maskBackupConfig(next) });
  } catch (e) {
    res.status(500).json({ error: 'Could not save config: ' + (e?.message || String(e)) });
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
  customTypes: ['BOOK', 'ARTICLE', 'JOURNAL', 'VIDEO', 'COURSE'],
  defaultLanguage: 'ru',
  globalAccess: false,
  // Identifiers whose visits / item events should NOT be counted in
  // analytics. Applied both at write-time (POST /api/visits and
  // POST /api/items/:itemId/track skip the insert) and at read-time
  // (GET /api/analytics filters out any pre-existing rows that match).
  analyticsExcludes: { usernames: [], ips: [], userIds: [], browsers: [] },
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
  if (ipClean && ipClean !== 'unknown' && exI.includes(ipClean)) return true;
  if (uid && exUid.includes(uid)) return true;
  if (browserToken && exTok.includes(browserToken)) return true;
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

// Strip <script>/<style>/<iframe>/event handlers + javascript: hrefs.
// Readability already removes most of this, but be paranoid since the HTML is
// injected directly into the page.
const sanitiseHtml = (html) => {
  if (!html) return '';
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/href\s*=\s*"\s*javascript:[^"]*"/gi, 'href="#"')
    .replace(/href\s*=\s*'\s*javascript:[^']*'/gi, "href='#'");
};

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
    const upstream = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OptionsDataLibrary/1.0; +https://library.optionsdata.ru)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8,es;q=0.5',
      },
    });
    clearTimeout(timer);

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
  const ip = (req.headers['x-real-ip'] || req.ip || '').split(',')[0].trim();
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
  const ip = (req.headers['x-real-ip'] || req.ip || '').split(',')[0].trim();
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
  const ip = (req.headers['x-real-ip'] || req.ip || '').toString().split(',')[0].trim();
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
    await pool.query(
      `INSERT INTO item_events (item_id, username, event_type) VALUES ($1, $2, $3)`,
      [req.params.itemId, username, type],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save settings (whitelist, blacklist, custom types, bot config…)
app.put('/api/settings', requireApiKey, async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid settings' });
  }
  try {
    await pool.query(
      `INSERT INTO app_settings (id, data) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(req.body)],
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
  const ip       = clip(req.body?.ip, 64);
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
    await pool.query(
      `INSERT INTO visit_logs (id, username, ip, platform, device)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id, username, ip,
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
    // Build a parameterised WHERE for SQL injection safety
    const userNotIn = exU.length > 0
      ? `AND lower(username) NOT IN (${exU.map((_, i) => `$${i + 1}`).join(',')})`
      : '';
    const visitNotIn = (exU.length + exI.length) > 0
      ? `WHERE 1=1
           ${exU.length > 0 ? `AND (username IS NULL OR lower(username) NOT IN (${exU.map((_, i) => `$${i + 1}`).join(',')}))` : ''}
           ${exI.length > 0 ? `AND (ip IS NULL OR ip NOT IN (${exI.map((_, i) => `$${exU.length + i + 1}`).join(',')}))` : ''}`
      : '';

    const statsRes = await pool.query(
      `SELECT to_char(timestamp, 'YYYY-MM-DD') AS date,
              count(*) FILTER (WHERE event_type = 'view')::int     AS views,
              count(*) FILTER (WHERE event_type = 'download')::int AS downloads
         FROM item_events
        WHERE 1=1 ${userNotIn}
        GROUP BY 1
        ORDER BY 1`,
      exU,
    );

    const eventsRes = await pool.query(
      `SELECT username, item_id, event_type,
              count(*)::int AS cnt,
              to_char(max(timestamp), 'YYYY-MM-DD') AS last_active
         FROM item_events
        WHERE username IS NOT NULL ${userNotIn}
        GROUP BY username, item_id, event_type`,
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
      `SELECT id, timestamp, username, ip, platform, device
         FROM visit_logs
        ${visitNotIn}
        ORDER BY timestamp DESC
        LIMIT 2000`,
      [...exU, ...exI],
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

app.get('/api/users/:userId/favorites', validateUserId, async (req, res) => {
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
  validateUserId, validateItemId,
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
  validateUserId, validateItemId,
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

// ── Step 5: per-user ratings (public — visitor action) ──────────────────────

app.get('/api/users/:userId/ratings', validateUserId, async (req, res) => {
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
  validateUserId, validateItemId,
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
  validateUserId, validateItemId,
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
  validateUserId, validateItemId,
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
  validateUserId,
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
  validateUserId, validateItemId,
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
  validateUserId, validateItemId,
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
  validateUserId,
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
app.get('/api/users/:userId/progress', validateUserId, async (req, res) => {
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
  validateUserId, validateItemId,
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
  validateUserId, validateItemId,
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
  validateUserId, validateItemId,
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Library API :${PORT}  content=${CONTENT_DIR}`);
});
