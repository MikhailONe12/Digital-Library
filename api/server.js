import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
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
  console.log('DB: schema initialized');
};

pool.connect()
  .then(client => { client.release(); return initDb(); })
  .catch(err => console.warn('DB not ready:', err.message));

// ── Middleware ───────────────────────────────────────────────────────────────

const allowedOrigins = (process.env.CORS_ORIGIN || 'https://library.optionsdata.ru').split(',');

app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json({ limit: '10mb' }));

// API key guard for all write operations
const requireApiKey = (req, res, next) => {
  const key = process.env.API_KEY;
  if (!key) return next(); // dev: no key configured — allow all
  if (req.headers['x-api-key'] !== key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
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
    cb(null, lang + ext);
  },
});

const uploadFile = multer({
  storage: fileStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
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
app.post('/api/admin/login', (req, res) => {
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
};

// Full app state (catalog + settings + average ratings) — public read
app.get('/api/state', async (req, res) => {
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
    res.json({
      ...DEFAULT_SETTINGS,
      ...settings,
      items: itemsRes.rows.map(r => r.data),
      ratings,
    });
  } catch (e) {
    console.warn('GET /api/state:', e.message);
    res.status(503).json({ error: 'Database unavailable' });
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

// Delete one catalog item
app.delete('/api/items/:itemId', requireApiKey, validateItemId, async (req, res) => {
  try {
    await pool.query('DELETE FROM items WHERE id = $1', [req.params.itemId]);
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
  try {
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Step 5: traffic logging & analytics ─────────────────────────────────────

// Record a page visit (public — visitor action)
app.post('/api/visits', async (req, res) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  try {
    await pool.query(
      `INSERT INTO visit_logs (id, username, ip, platform, device)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        clip(req.body?.username, 64),
        clip(req.body?.ip, 64),
        clip(req.body?.platform, 32),
        clip(req.body?.device, 256),
      ],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aggregated analytics for the admin dashboard (protected — sensitive data)
app.get('/api/analytics', requireApiKey, async (req, res) => {
  try {
    const statsRes = await pool.query(
      `SELECT to_char(timestamp, 'YYYY-MM-DD') AS date,
              count(*) FILTER (WHERE event_type = 'view')::int     AS views,
              count(*) FILTER (WHERE event_type = 'download')::int AS downloads
         FROM item_events
        GROUP BY 1
        ORDER BY 1`,
    );

    const eventsRes = await pool.query(
      `SELECT username, item_id, event_type,
              count(*)::int AS cnt,
              to_char(max(timestamp), 'YYYY-MM-DD') AS last_active
         FROM item_events
        WHERE username IS NOT NULL
        GROUP BY username, item_id, event_type`,
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
        ORDER BY timestamp DESC
        LIMIT 2000`,
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

// GET single-item progress
app.get('/api/users/:userId/progress/:itemId',
  validateUserId, validateItemId,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT position, position_total, format_url FROM user_reading_progress WHERE user_id = $1 AND item_id = $2',
        [req.params.userId, req.params.itemId],
      );
      res.json(rows[0] || null);
    } catch {
      res.json(null);
    }
  },
);

// PUT (upsert) single-item progress
app.put('/api/users/:userId/progress/:itemId',
  validateUserId, validateItemId,
  async (req, res) => {
    const position = clip(req.body?.position, 512);
    const positionTotal = parseInt(req.body?.positionTotal ?? 0, 10) || 0;
    const formatUrl = clip(req.body?.formatUrl, 512);
    if (!position) return res.status(400).json({ error: 'position required' });
    try {
      await pool.query(
        `INSERT INTO user_reading_progress (user_id, item_id, position, position_total, format_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, item_id) DO UPDATE
           SET position = $3, position_total = $4, format_url = $5, updated_at = NOW()`,
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
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────────────────────

fs.mkdirSync(CONTENT_DIR, { recursive: true });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Library API :${PORT}  content=${CONTENT_DIR}`);
});
