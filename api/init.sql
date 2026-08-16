-- Uploaded files registry
CREATE TABLE IF NOT EXISTS uploaded_files (
  id          SERIAL PRIMARY KEY,
  item_id     TEXT        NOT NULL,
  file_type   TEXT        NOT NULL,  -- 'cover' | 'pdf' | 'epub' | 'mp4' | …
  filename    TEXT        NOT NULL,
  url         TEXT        NOT NULL,
  size_bytes  BIGINT,
  language    TEXT,                  -- 'ru' | 'en' | 'es' | NULL for covers
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uf_item_id ON uploaded_files(item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_uf_item_filename ON uploaded_files(item_id, filename);

-- Visit logs (will replace localStorage version in Step 5)
CREATE TABLE IF NOT EXISTS visit_logs (
  id          TEXT        PRIMARY KEY,
  timestamp   TIMESTAMPTZ DEFAULT NOW(),
  username    TEXT,
  -- Anonymised: last IPv4 octet zeroed / IPv6 truncated to /48 (#37).
  ip          TEXT,
  -- Keyed digest of the FULL address. Lets the admin tell two visitors apart
  -- without the address being recoverable from this table. See visitorHash().
  ip_hash     TEXT,
  platform    TEXT,
  device      TEXT
);

CREATE INDEX IF NOT EXISTS idx_vl_timestamp ON visit_logs(timestamp DESC);

-- Item events: view / download per user (replaces localStorage in Step 5)
CREATE TABLE IF NOT EXISTS item_events (
  id          SERIAL      PRIMARY KEY,
  item_id     TEXT        NOT NULL,
  username    TEXT,
  event_type  TEXT        NOT NULL,  -- 'view' | 'download'
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ie_item_id  ON item_events(item_id);
CREATE INDEX IF NOT EXISTS idx_ie_username ON item_events(username);
CREATE INDEX IF NOT EXISTS idx_ie_ts       ON item_events(timestamp DESC);

-- Catalog items (replaces localStorage in Step 4)
CREATE TABLE IF NOT EXISTS items (
  id          TEXT        PRIMARY KEY,
  data        JSONB       NOT NULL,
  seq         BIGSERIAL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_seq ON items(seq);

-- App settings: single row (whitelist, blacklist, custom types)
-- Bookkeeping for one-off data migrations. Schema changes are idempotent DDL
-- and can just re-run, but a data backfill usually must not: this table is how
-- such a step records that it already happened.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  id          INT         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Per-user favorites (Step 5) — shared across all devices
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id    TEXT        NOT NULL,
  item_id    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_favs_user ON user_favorites(user_id);

-- Per-user ratings, 1–5 (Step 5) — shared across all devices
CREATE TABLE IF NOT EXISTS user_ratings (
  user_id    TEXT        NOT NULL,
  item_id    TEXT        NOT NULL,
  rating     INT         NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_item ON user_ratings(item_id);

-- Reader bookmarks — multiple per user per item, shared across devices
CREATE TABLE IF NOT EXISTS user_bookmarks (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL,
  item_id    TEXT        NOT NULL,
  position   TEXT        NOT NULL,  -- page number (PDF) or CFI string (EPUB)
  label      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bm_user_item ON user_bookmarks(user_id, item_id);

-- User annotations: highlights + notes for EPUB/PDF readers
CREATE TABLE IF NOT EXISTS user_annotations (
  id            TEXT        PRIMARY KEY,
  user_id       TEXT        NOT NULL,
  item_id       TEXT        NOT NULL,
  format_url    TEXT        NOT NULL DEFAULT '',
  cfi_range     TEXT,
  page          INT,
  selected_text TEXT        NOT NULL DEFAULT '',
  note          TEXT,
  color         TEXT        NOT NULL DEFAULT 'yellow',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ann_user_item ON user_annotations(user_id, item_id);

-- Reading progress: one row per user per file (upsert on update)
CREATE TABLE IF NOT EXISTS user_reading_progress (
  user_id        TEXT        NOT NULL,
  item_id        TEXT        NOT NULL,
  position       TEXT        NOT NULL,   -- page number (PDF) or CFI string (EPUB)
  position_total INT         NOT NULL DEFAULT 0,  -- total pages (PDF); 0–100 for EPUB
  format_url     TEXT        NOT NULL DEFAULT '', -- identifies which file
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, item_id, format_url)
);

-- Error log (built-in lightweight monitoring; replaces an external Sentry).
-- Both client-side (window.onerror / unhandledrejection / React boundary) and
-- server-side (Express error handler) failures land here.
CREATE TABLE IF NOT EXISTS error_log (
  id          BIGSERIAL   PRIMARY KEY,
  ts          TIMESTAMPTZ DEFAULT NOW(),
  source      TEXT        NOT NULL DEFAULT 'client', -- 'client' | 'server'
  kind        TEXT,        -- 'error' | 'unhandledrejection' | 'react' | route path…
  message     TEXT        NOT NULL,
  stack       TEXT,
  url         TEXT,        -- page URL (client) or request path (server)
  user_id     TEXT,
  username    TEXT,
  user_agent  TEXT,
  count       INT         NOT NULL DEFAULT 1  -- reserved for future dedup
);

CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log(ts DESC);

-- Text-extraction audit: one row per catalogued file, written by the
-- "Recognition" tab in admin (POST /api/admin/scan).
--
-- Step zero of the search plan. Before anything is spent on OCR or on
-- embeddings, this answers the only question that decides the budget: how much
-- of the library has a text layer we can already read, and how much is
-- pictures of pages. Planning without these numbers is guessing.
--
-- Cheap to rebuild — it is derived entirely from the files on disk — so it is
-- never migrated, only re-scanned.
CREATE TABLE IF NOT EXISTS content_scan (
  item_id     TEXT        NOT NULL,
  format_url  TEXT        NOT NULL,
  filename    TEXT,
  kind        TEXT,                  -- 'pdf' | 'epub' | 'fb2' | file extension
  -- text        readable text layer, ready to index as-is
  -- partial     some text, far too little for the page count — mixed scan
  -- scan        pictures of pages; needs OCR before it can be searched
  -- media       audio/video; belongs to the subtitles step, not this one
  -- external    hosted by someone else, deliberately not fetched
  -- missing     catalogued but absent from disk
  -- unsupported extension we do not extract from
  -- error       extraction failed; `detail` says why
  state       TEXT        NOT NULL,
  pages       INT,
  chars       BIGINT,                -- whitespace excluded
  size_bytes  BIGINT,
  detail      TEXT,
  scanned_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (item_id, format_url)
);

CREATE INDEX IF NOT EXISTS idx_content_scan_state ON content_scan(state);
