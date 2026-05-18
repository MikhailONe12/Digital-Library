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

-- Visit logs (will replace localStorage version in Step 5)
CREATE TABLE IF NOT EXISTS visit_logs (
  id          TEXT        PRIMARY KEY,
  timestamp   TIMESTAMPTZ DEFAULT NOW(),
  username    TEXT,
  ip          TEXT,
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

-- App settings: single row (whitelist, blacklist, custom types, bot config)
CREATE TABLE IF NOT EXISTS app_settings (
  id          INT         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
