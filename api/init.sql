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

-- ── Search index ────────────────────────────────────────────────────────────
--
-- Extracted text, one row per page. The page number is the point of the whole
-- exercise: a search result has to be able to open the reader where the answer
-- is, and that needs two different numbers.
--
--   page        the physical page of the file — what the reader opens
--   page_label  what is printed on that page — what a citation quotes
--
-- They differ by however long the front matter is, which is why a PDF page 214
-- is routinely not "p. 214" of the book.
--
-- `source` records how the text got here. It matters because 'manual' is
-- protected: re-indexing rebuilds everything except pages a human corrected.
CREATE TABLE IF NOT EXISTS document_text (
  item_id     TEXT        NOT NULL,
  format_url  TEXT        NOT NULL,
  page        INT         NOT NULL,   -- 1-based; 0 when the format has no pages
  page_label  TEXT,
  source      TEXT        NOT NULL,   -- 'pdftotext' | 'epub' | 'ocr' | 'manual'
  text        TEXT        NOT NULL,
  chars       INT         NOT NULL,   -- whitespace excluded
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (item_id, format_url, page)
);

CREATE INDEX IF NOT EXISTS idx_doctext_item ON document_text(item_id, format_url);

-- Search units, cut from document_text along paragraph boundaries.
--
-- The generated tsvector indexes each chunk under both configurations at once:
-- the corpus is bilingual, and a Russian question about "гамма" and an English
-- one about "gamma" have to reach the same books.
CREATE TABLE IF NOT EXISTS chunks (
  id           BIGSERIAL   PRIMARY KEY,
  item_id      TEXT        NOT NULL,
  format_url   TEXT        NOT NULL,
  page         INT,
  page_label   TEXT,
  heading      TEXT,
  char_start   INT,
  char_end     INT,
  spine_item   TEXT,                  -- EPUB
  cfi_start    TEXT,
  cfi_end      TEXT,
  second_start INT,                   -- audio / video
  second_end   INT,
  text         TEXT        NOT NULL,
  tsv          TSVECTOR    GENERATED ALWAYS AS (
                 to_tsvector('russian'::regconfig, text) ||
                 to_tsvector('english'::regconfig, text)
               ) STORED,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_tsv  ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_item ON chunks(item_id, format_url);

-- One row per indexed file: what came out, how, when, and how trustworthy it
-- looks. This is what the admin's Index panel reads.
CREATE TABLE IF NOT EXISTS index_status (
  item_id     TEXT        NOT NULL,
  format_url  TEXT        NOT NULL,
  filename    TEXT,
  state       TEXT        NOT NULL,   -- 'indexed' | 'failed' | 'skipped'
  method      TEXT,                   -- 'pdftotext' | 'epub' | …
  pages       INT,
  chars       BIGINT,
  chunk_count INT,
  -- Share of letters among non-space characters, 0..1. Clean type sits near
  -- 0.85; formula-heavy pages and bad OCR fall far below it, which is how a
  -- book worth looking at surfaces without anyone proofreading 300 pages.
  quality     REAL,
  manual_pages INT NOT NULL DEFAULT 0,
  detail      TEXT,
  indexed_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (item_id, format_url)
);

CREATE INDEX IF NOT EXISTS idx_index_status_state ON index_status(state);

-- ── Background jobs ─────────────────────────────────────────────────────────
--
-- Recognising a lecture takes hours on a CPU, and capturing one that cannot be
-- downloaded takes as long as the lecture itself. Two things follow, and both
-- are why this is a table and not a variable in the API process:
--
--   a deploy restarts the container, and in-memory state dies with it;
--   a job that dies at minute 70 of 90 must not start again from zero.
--
-- Postgres is the queue — claimed with FOR UPDATE SKIP LOCKED. No Redis, no
-- broker; at this size they would be a third moving part for nothing.
CREATE TABLE IF NOT EXISTS job_batches (
  id         BIGSERIAL   PRIMARY KEY,
  kind       TEXT        NOT NULL,
  title      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL   PRIMARY KEY,
  batch_id     BIGINT      REFERENCES job_batches(id) ON DELETE CASCADE,
  kind         TEXT        NOT NULL,   -- 'subtitles' | 'asr' | 'capture' | 'ocr'
  item_id      TEXT,
  format_url   TEXT,
  label        TEXT,                   -- what to show a human
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  state        TEXT        NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|cancelled
  priority     INT         NOT NULL DEFAULT 100,
  attempts     INT         NOT NULL DEFAULT 0,
  max_attempts INT         NOT NULL DEFAULT 3,
  progress     REAL        NOT NULL DEFAULT 0,         -- 0..1
  -- Where the job got to. A capture stores the second it reached, so the next
  -- attempt seeks the player there instead of listening to the first hour again.
  checkpoint   JSONB,
  detail       TEXT,
  locked_by    TEXT,
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(state, priority, id);
CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id);
