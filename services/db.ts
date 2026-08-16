import { AppState, MediaItem, Bookmark, ReadingProgress, Annotation, HighlightColor, CustomType, MultilingualText } from '../types';
import { toast } from './toast';

// ── Storage keys ─────────────────────────────────────────────────────────────

const SERVER_API_KEY_STORAGE = 'library_server_api_key';

// ── Server API key (sessionStorage: cleared on tab close) ────────────────────

export const getServerApiKey = (): string =>
  sessionStorage.getItem(SERVER_API_KEY_STORAGE) || '';

export const setServerApiKey = (key: string) =>
  sessionStorage.setItem(SERVER_API_KEY_STORAGE, key);

// ── Default (empty) state ────────────────────────────────────────────────────

const emptyState = (): AppState => ({
  items: [],
  allowedUsers: [],
  blacklist: [],
  visitLogs: [],
  stats: [],
  userAnalytics: [],
  userFavorites: {},
  userRatings: {},
  customTypes: [
    { id: 'BOOK',    en: 'Book',    ru: 'Книга',   es: 'Libro' },
    { id: 'ARTICLE', en: 'Article', ru: 'Статья',  es: 'Artículo' },
    { id: 'JOURNAL', en: 'Journal', ru: 'Журнал',  es: 'Журнал' },
    { id: 'VIDEO',   en: 'Video',   ru: 'Видео',   es: 'Vídeo' },
    { id: 'AUDIO',   en: 'Audio',   ru: 'Аудио',   es: 'Audio' },
    { id: 'COURSE',  en: 'Course',  ru: 'Курс',    es: 'Curso' },
  ],
  defaultLanguage: 'ru',
  globalAccess: false,
  analyticsExcludes: { usernames: [], ips: [], userIds: [], browsers: [], visitors: [] },
});

// In-memory cache — source of truth for the UI between renders.
let cache: AppState = emptyState();

// Admin "preview" mode. When on, all stat-writing calls (view/download counts,
// reading & watch progress) become no-ops — it lets an admin open content from
// the dashboard to inspect what's inside without inflating analytics or saving
// a position. Toggled by ItemDetails while it renders in preview.
let previewMode = false;
export const setPreviewMode = (on: boolean): void => { previewMode = on; };

// Server-computed average ratings, keyed by item id.
let avgRatings: Record<string, number> = {};

// Reading progress cache, keyed by itemId → formatUrl → progress.
let progressCache: Record<string, Record<string, ReadingProgress>> = {};

// ── Item normalization (backward compatibility) ──────────────────────────────

// Keep `author` (string) and `authors` (string[]) consistent. Old items
// only carry `author`; new ones can store either. We treat `authors` as the
// canonical full list and `author === authors[0]` as a derived display
// field — every site that reads `item.author` (search, deep-link, badges)
// keeps working unchanged.
const reconcileAuthors = (item: any): { author: string; authors: string[] } => {
  const fromArray = Array.isArray(item.authors)
    ? item.authors.map((s: any) => String(s || '').trim()).filter(Boolean)
    : null;
  if (fromArray && fromArray.length > 0) {
    return { author: fromArray[0], authors: fromArray };
  }
  const single = String(item.author || '').trim();
  if (single) return { author: single, authors: [single] };
  return { author: '', authors: [] };
};

const normalizeItem = (item: any): MediaItem => ({
  ...item,
  contentLanguages: item.contentLanguages || ['en'],
  allowDownload: item.allowDownload !== undefined ? item.allowDownload : true,
  allowReading: item.allowReading !== undefined ? item.allowReading : true,
  addedDate: item.addedDate || (item.publishedDate ? new Date(item.publishedDate).toISOString() : new Date().toISOString()),
  views: item.views || 0,
  downloads: item.downloads || 0,
  rating: item.rating || 0,
  ...reconcileAuthors(item),
  formats: (item.formats || []).map((f: any) => ({
    ...f,
    allowDownload: f.allowDownload !== undefined ? f.allowDownload : true,
    allowReading: f.allowReading !== undefined ? f.allowReading : true,
    // Legacy rows have no flag — absent means "hosted by us", the safe default
    // (an unflagged file is one we uploaded, so rendering it in-app is fine).
    external: f.external === true,
  })),
});

// ── Server requests ──────────────────────────────────────────────────────────

// Telegram initData header — sent on every write to /api/users/:userId/* so
// the server can prove the caller is who they claim to be (server-side check
// in requireUserMatch middleware). Without this header, the server rejects
// writes targeting any userId other than the shared 'guest_user' bucket.
const tgInitDataHeader = (): Record<string, string> => {
  const initData = (window as any).Telegram?.WebApp?.initData || '';
  return initData ? { 'x-telegram-init-data': initData } : {};
};

const authHeaders = (): Record<string, string> => {
  const key = getServerApiKey();
  return key ? { 'x-api-key': key } : {};
};

const warnIfFailed = (label: string) => (res: Response) => {
  if (!res.ok) console.warn(`${label}: HTTP ${res.status}`);
};

// Reliable write: performs the request, surfaces a toast and throws on any
// failure so callers can roll back. No more silently-lost saves.
const writeRequest = async (label: string, url: string, init: RequestInit): Promise<Response> => {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    toast.error(`${label}: нет связи с сервером`);
    throw new Error(`${label}: network error`);
  }
  if (!res.ok) {
    const reason = res.status === 401
      ? 'нет доступа — проверьте Server API Key во вкладке «Данные»'
      : `ошибка сервера (${res.status})`;
    toast.error(`${label}: ${reason}`);
    throw new Error(`${label}: HTTP ${res.status}`);
  }
  return res;
};

const putItem = (item: MediaItem): Promise<Response> =>
  writeRequest('Сохранение элемента', `/api/items/${item.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(item),
  });

const removeItem = (id: string): Promise<Response> =>
  writeRequest('Удаление элемента', `/api/items/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });

const putSettings = (): Promise<Response> => {
  const settings = {
    allowedUsers: cache.allowedUsers,
    blacklist: cache.blacklist,
    customTypes: cache.customTypes,
    defaultLanguage: cache.defaultLanguage,
    globalAccess: cache.globalAccess,
    analyticsExcludes: cache.analyticsExcludes,
  };
  return writeRequest('Сохранение настроек', '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(settings),
  });
};

// ── Current user's favorites & ratings (server-backed, shared across devices) ─

const loadUserData = async (userId: string) => {
  try {
    const [favRes, ratRes, progRes] = await Promise.all([
      fetch(`/api/users/${userId}/favorites`, { headers: tgInitDataHeader() }),
      fetch(`/api/users/${userId}/ratings`, { headers: tgInitDataHeader() }),
      fetch(`/api/users/${userId}/progress`, { headers: tgInitDataHeader() }),
    ]);
    if (favRes.ok) {
      const d = await favRes.json();
      cache.userFavorites = { [userId]: d.favorites || [] };
    }
    if (ratRes.ok) {
      const d = await ratRes.json();
      cache.userRatings = { [userId]: d.ratings || {} };
    }
    if (progRes.ok) {
      const d = await progRes.json();
      progressCache = {};
      for (const p of (d.progress || [])) {
        if (!progressCache[p.item_id]) progressCache[p.item_id] = {};
        progressCache[p.item_id][p.format_url || ''] = {
          position: p.position,
          position_total: p.position_total,
          format_url: p.format_url,
        };
      }
    }
  } catch (e) {
    console.warn('loadUserData failed:', e);
  }
};

// ── Load / get ───────────────────────────────────────────────────────────────

// Loads catalog + settings. Throws on a hard failure (no connection or non-OK
// response) so the caller can show a retry screen instead of a misleading
// "empty catalog". User-specific data (favorites/ratings) is best-effort.
export const loadDb = async (userId?: string): Promise<AppState> => {
  const tg = (window as any).Telegram?.WebApp;
  const initData = tg?.initData || '';
  const stateHeaders: Record<string, string> = initData
    ? { 'x-telegram-init-data': initData }
    : {};

  let res: Response;
  try {
    res = await fetch('/api/state', { headers: stateHeaders });
  } catch (e) {
    console.warn('loadDb: network error', e);
    throw new Error('loadDb: network error');
  }
  if (!res.ok) {
    console.warn('loadDb: HTTP', res.status);
    // 403 is the blacklist verdict, decided server-side from the real
    // connection. Distinguished from a transport failure so the UI can show
    // "access denied" rather than "connection failed".
    throw new Error(res.status === 403 ? 'loadDb: blocked' : `loadDb: HTTP ${res.status}`);
  }

  const remote = await res.json();
  cache = {
    ...emptyState(),
    items: (remote.items || []).map(normalizeItem),
    allowedUsers: remote.allowedUsers || [],
    blacklist: remote.blacklist || [],
    customTypes: (() => {
      const raw = remote.customTypes;
      if (!raw || !raw.length) return emptyState().customTypes;
      // Migrate old string[] format to CustomType[]
      if (typeof raw[0] === 'string')
        return (raw as string[]).map((s: string) => ({ id: s, en: s, ru: s, es: s }));
      return raw as CustomType[];
    })(),
    defaultLanguage: remote.defaultLanguage || 'ru',
    globalAccess: !!remote.globalAccess,
    analyticsExcludes: {
      usernames: remote.analyticsExcludes?.usernames || [],
      ips:       remote.analyticsExcludes?.ips || [],
      userIds:   remote.analyticsExcludes?.userIds || [],
      browsers:  remote.analyticsExcludes?.browsers || [],
      visitors:  remote.analyticsExcludes?.visitors || [],
    },
  };
  avgRatings = remote.ratings || {};

  if (userId) await loadUserData(userId);
  return getDb();
};

// Load admin-only analytics (stats, leaderboard, access logs) from the server.
export const loadAnalytics = async (): Promise<AppState> => {
  try {
    const res = await fetch('/api/analytics', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      cache.stats = data.stats || [];
      cache.userAnalytics = data.userAnalytics || [];
      cache.visitLogs = data.visitLogs || [];
    } else {
      console.warn('loadAnalytics: HTTP', res.status);
    }
  } catch (e) {
    console.warn('loadAnalytics failed:', e);
  }
  return getDb();
};

export const getDb = (): AppState => ({ ...cache });

// Used by the admin JSON import — overwrites catalog + settings.
export const saveDb = async (data: AppState): Promise<void> => {
  const prev = cache;
  cache = {
    ...emptyState(),
    ...data,
    items: (data.items || []).map(normalizeItem),
  };
  try {
    await Promise.all(cache.items.map(putItem));
    await putSettings();
  } catch (e) {
    cache = prev; // roll back the in-memory state on any failure
    throw e;
  }
};

// ── Items ────────────────────────────────────────────────────────────────────

export const updateItem = async (item: MediaItem): Promise<void> => {
  const prev = cache.items;
  const exists = cache.items.some(i => i.id === item.id);
  cache.items = exists
    ? cache.items.map(i => (i.id === item.id ? item : i))
    : [...cache.items, item];
  try {
    await putItem(item);
  } catch (e) {
    cache.items = prev; // roll back so the UI reflects reality
    throw e;
  }
};

export const deleteItem = async (id: string): Promise<void> => {
  const prev = cache.items;
  cache.items = cache.items.filter(i => i.id !== id);
  try {
    await removeItem(id);
  } catch (e) {
    cache.items = prev;
    throw e;
  }
};

// ── Favorites (server-backed) ────────────────────────────────────────────────

export const toggleFavorite = (userId: string, itemId: string) => {
  const current = cache.userFavorites[userId] || [];
  const has = current.includes(itemId);
  const updated = has
    ? current.filter(i => i !== itemId)
    : [...current, itemId];
  cache.userFavorites = { ...cache.userFavorites, [userId]: updated };

  fetch(`/api/users/${userId}/favorites/${itemId}`, {
    method: has ? 'DELETE' : 'PUT',
    headers: tgInitDataHeader(),
  }).then(warnIfFailed('favorite')).catch(e => console.warn('favorite failed:', e));
};

export const isFavorited = (userId: string, itemId: string): boolean =>
  cache.userFavorites[userId]?.includes(itemId) || false;

// ── #36 Right-to-erasure ────────────────────────────────────────────────────
// Wipes every server-side trace of a single user — favourites,
// ratings, bookmarks, annotations, reading progress — and un-attributes the
// user's analytics rows. Used to honour GDPR Art. 17 / 152-ФЗ deletion
// requests. The server gate accepts either a verified Telegram session
// matching userId (self-erase) or the admin API key (operator-erase); we
// always send the API key from the admin panel and rely on server-side
// authorisation to make the final decision.
export const eraseUserData = async (userId: string): Promise<void> => {
  // Optimistically clear local caches so the UI flips immediately.
  cache.userFavorites = { ...cache.userFavorites, [userId]: [] };
  cache.userRatings   = { ...cache.userRatings,   [userId]: {} };
  await writeRequest('Удаление данных пользователя', `/api/users/${userId}`, {
    method: 'DELETE',
    headers: { ...authHeaders(), ...tgInitDataHeader() },
  });
};

// ── Ratings (server-backed) ──────────────────────────────────────────────────

export const setUserRating = async (
  userId: string, itemId: string, rating: number,
): Promise<number> => {
  const userRecord = { ...(cache.userRatings[userId] || {}), [itemId]: rating };
  cache.userRatings = { ...cache.userRatings, [userId]: userRecord };

  try {
    const res = await fetch(`/api/users/${userId}/ratings/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...tgInitDataHeader() },
      body: JSON.stringify({ rating }),
    });
    if (res.ok) {
      const d = await res.json();
      if (typeof d.average === 'number') avgRatings[itemId] = d.average;
    } else {
      console.warn('rating: HTTP', res.status);
    }
  } catch (e) {
    console.warn('rating failed:', e);
  }
  return getAverageRating(itemId);
};

export const getUserRating = (userId: string, itemId: string): number =>
  cache.userRatings[userId]?.[itemId] || 0;

// Server-computed community average, falling back to the editorial rating.
export const getAverageRating = (itemId: string): number => {
  if (avgRatings[itemId] !== undefined) return avgRatings[itemId];
  const item = cache.items.find(i => i.id === itemId);
  return item ? item.rating : 0;
};

// ── Whitelist ────────────────────────────────────────────────────────────────

// Persists current settings; rolls the in-memory state back to `prev` on failure.
const commitSettings = async (prev: AppState): Promise<void> => {
  try {
    await putSettings();
  } catch (e) {
    cache = prev;
    throw e;
  }
};

export const addUserToWhitelist = async (username: string): Promise<void> => {
  const clean = username.replace('@', '').trim().toLowerCase();
  if (!clean || cache.allowedUsers.includes(clean)) return;
  const prev = { ...cache };
  cache.allowedUsers = [...cache.allowedUsers, clean];
  await commitSettings(prev);
};

export const removeUserFromWhitelist = async (username: string): Promise<void> => {
  const prev = { ...cache };
  cache.allowedUsers = cache.allowedUsers.filter(u => u !== username);
  await commitSettings(prev);
};

// ── Blacklist ────────────────────────────────────────────────────────────────

export const addToBlacklist = async (entry: string): Promise<void> => {
  const clean = entry.replace('@', '').trim().toLowerCase();
  if (!clean || cache.blacklist.includes(clean)) return;
  const prev = { ...cache };
  cache.blacklist = [...cache.blacklist, clean];
  await commitSettings(prev);
};

export const removeFromBlacklist = async (entry: string): Promise<void> => {
  const prev = { ...cache };
  cache.blacklist = cache.blacklist.filter(e => e !== entry);
  await commitSettings(prev);
};

// ── Custom types ─────────────────────────────────────────────────────────────

export const addCustomType = async (type: CustomType): Promise<void> => {
  if (cache.customTypes.find(t => t.id === type.id)) return;
  const prev = { ...cache };
  cache.customTypes = [...cache.customTypes, type];
  await commitSettings(prev);
};

export const deleteCustomType = async (id: string): Promise<void> => {
  const prev = { ...cache };
  cache.customTypes = cache.customTypes.filter(t => t.id !== id);
  await commitSettings(prev);
};

export const updateCustomType = async (id: string, labels: { en: string; ru: string; es: string }): Promise<void> => {
  const prev = { ...cache };
  cache.customTypes = cache.customTypes.map(t => t.id === id ? { ...t, ...labels } : t);
  await commitSettings(prev);
};

// ── Misc settings ────────────────────────────────────────────────────────────

export const toggleGlobalAccess = async (enabled: boolean): Promise<void> => {
  const prev = { ...cache };
  cache.globalAccess = enabled;
  await commitSettings(prev);
};

// ── Visit logs (server-backed) ───────────────────────────────────────────────

// The IP argument is gone: the server takes the address from the connection
// (resolveVisitorIp), which is both unspoofable and one fewer third party
// holding our visitors' addresses.
export const logVisit = (username: string, platform: string) => {
  const tg = (window as any).Telegram?.WebApp;
  fetch('/api/visits', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...skipAnalyticsHeader(),
      ...(tg?.initData ? { 'x-telegram-init-data': tg.initData } : {}),
    },
    body: JSON.stringify({
      username: username || 'guest',
      platform: platform || 'web',
      device: navigator.userAgent,
    }),
  }).catch(() => {/* best effort */});
};

// ── Stats (server-backed) ────────────────────────────────────────────────────

export const resetStats = async (): Promise<void> => {
  cache.stats = [];
  cache.userAnalytics = [];
  cache.items = cache.items.map(item => ({ ...item, views: 0, downloads: 0 }));
  await writeRequest('Сброс статистики', '/api/items/reset-stats', {
    method: 'POST',
    headers: authHeaders(),
  });
};

// Wipe visit_logs only — leaves item view/download counters untouched.
export const resetTrafficStats = async (): Promise<void> => {
  cache.visitLogs = [];
  await writeRequest('Сброс аналитики трафика', '/api/visits/reset', {
    method: 'POST',
    headers: authHeaders(),
  });
};

/**
 * Apply the analytics-exclude list retroactively: delete access-log rows that
 * were recorded before the exclusion existed. Matches on identity (@handle /
 * Telegram id) only. Returns how many rows went, plus the excludes that can't
 * be applied backwards — IPs (rows store only the anonymised address, so
 * matching one would delete the whole subnet) and browser tokens (never stored
 * on a row at all).
 */
export const purgeExcludedVisits = async (): Promise<{
  deleted: number; ipsSkipped: number; browserTokensSkipped: number;
}> => {
  const res = await fetch('/api/visits/purge-excluded', {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    deleted: data.deleted || 0,
    ipsSkipped: data.ipsSkipped || 0,
    browserTokensSkipped: data.browserTokensSkipped || 0,
  };
};

/**
 * Subject access request (152-ФЗ ст. 14): download everything the server holds
 * about the signed-in person. Server-side the response mirrors what erasure
 * deletes, so what you can read back is exactly what you can have removed.
 * Returns false when there is no Telegram identity to prove ownership with.
 *
 * NOT wired to any UI at the moment — the "My data" block was pulled from the
 * home page until the privacy policy is published, so the app doesn't offer a
 * right it hasn't documented yet. Kept, along with the endpoint and the
 * myData* strings, so restoring the button is a self-contained change. Until
 * then an operator can still answer a request by calling the endpoint.
 */
export const exportMyData = async (userId: string): Promise<boolean> => {
  const headers = tgInitDataHeader();
  if (!headers['x-telegram-init-data']) return false;
  const res = await fetch(`/api/users/${userId}/export`, { headers });
  if (!res.ok) throw new Error(`export: HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `my-data-${userId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has certainly started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
};

export interface DoiLookup {
  doi: string;
  title: string;
  authors: string[];
  journal: string;
  publisher: string;
  /** Registry machine value ('journal-article', 'posted-content', …). */
  type: string;
  /** Year only — it belongs in the item's existing publishedDate. */
  year: string;
}

/** Admin autofill: ask the registry what it knows about a DOI. */
export const lookupDoi = async (doi: string): Promise<DoiLookup> => {
  const res = await fetch(`/api/doi/lookup?doi=${encodeURIComponent(doi)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
};

/**
 * Formatted citation for a DOI. The resolver does the formatting — owning
 * APA/MLA ourselves would mean owning every edge case in them.
 */
export const fetchCitation = async (doi: string, style: string): Promise<string> => {
  const res = await fetch(
    `/api/doi/citation?doi=${encodeURIComponent(doi)}&style=${encodeURIComponent(style)}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return (await res.json()).citation || '';
};

// ── Error log (built-in monitoring) ──────────────────────────────────────────

export interface ErrorLogRow {
  id: number;
  ts: string;
  source: 'client' | 'server';
  kind: string | null;
  message: string;
  stack: string | null;
  url: string | null;
  user_id: string | null;
  username: string | null;
  user_agent: string | null;
}

export const loadErrorLog = async (): Promise<ErrorLogRow[]> => {
  try {
    const res = await fetch('/api/admin/errors', { headers: authHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.errors || [];
  } catch {
    return [];
  }
};

export const clearErrorLog = async (): Promise<void> => {
  await writeRequest('Очистка журнала ошибок', '/api/admin/errors/clear', {
    method: 'POST',
    headers: authHeaders(),
  });
};

// ── Content scan (what can actually be indexed) ─────────────────────────────

/** Verdict for one catalogued file. See api/init.sql for what each means. */
export type ContentScanState =
  | 'text' | 'partial' | 'scan' | 'media'
  | 'external' | 'missing' | 'unsupported' | 'error'
  /** The material carries nothing at all — no file, no link. */
  | 'nothing';

export interface ContentScanRow {
  item_id: string;
  format_url: string;
  filename: string | null;
  kind: string | null;
  state: ContentScanState;
  pages: number | null;
  /** Characters extracted, whitespace excluded. */
  chars: number | null;
  size_bytes: number | null;
  detail: string | null;
  scanned_at: string;
  title: MultilingualText | null;
}

export interface ContentScanJob {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  current: string;
  error: string | null;
  stopRequested: boolean;
}

export interface ContentScanSummaryRow {
  state: ContentScanState;
  files: number;
  pages: number;
  chars: number;
}

/** How many of each kind the catalogue holds, and how many the last pass walked. */
export interface ContentScanCounts {
  formats: number;
  videos: number;
  articles: number;
}

export interface ContentScanReport {
  job: ContentScanJob;
  /**
   * When the last pass wrote its rows. Survives an API restart, unlike
   * `job.finishedAt`, which only knows about this process.
   */
  lastScanAt: string | null;
  rows: ContentScanRow[];
  summary: ContentScanSummaryRow[];
  /** From the catalogue, live. `items` is the material count. */
  catalog: ContentScanCounts & { items: number };
  /** From the last pass. Differs from `catalog` when the pass is out of date. */
  scanned: ContentScanCounts & { items: number };
}

const EMPTY_SCAN_JOB: ContentScanJob = {
  running: false, startedAt: null, finishedAt: null,
  total: 0, done: 0, current: '', error: null, stopRequested: false,
};

const EMPTY_SCAN_COUNTS = { items: 0, formats: 0, videos: 0, articles: 0 };

const EMPTY_SCAN_REPORT: ContentScanReport = {
  job: EMPTY_SCAN_JOB, lastScanAt: null, rows: [], summary: [],
  catalog: { ...EMPTY_SCAN_COUNTS },
  scanned: { ...EMPTY_SCAN_COUNTS },
};

/**
 * Read the last pass. Polled while a pass is running, so a transport failure
 * returns an empty report rather than throwing at the caller every two seconds.
 */
export const loadContentScan = async (): Promise<ContentScanReport> => {
  try {
    const res = await fetch('/api/admin/scan', { headers: authHeaders() });
    if (!res.ok) return EMPTY_SCAN_REPORT;
    const data = await res.json();
    return {
      job: { ...EMPTY_SCAN_JOB, ...(data.job || {}) },
      lastScanAt: data.lastScanAt || null,
      rows: data.rows || [],
      summary: data.summary || [],
      catalog: { ...EMPTY_SCAN_COUNTS, ...(data.catalog || {}) },
      scanned: { ...EMPTY_SCAN_COUNTS, ...(data.scanned || {}) },
    };
  } catch {
    return EMPTY_SCAN_REPORT;
  }
};

export const startContentScan = async (): Promise<void> => {
  await writeRequest('Запуск проверки', '/api/admin/scan', {
    method: 'POST',
    headers: authHeaders(),
  });
};

export const stopContentScan = async (): Promise<void> => {
  await writeRequest('Остановка проверки', '/api/admin/scan/stop', {
    method: 'POST',
    headers: authHeaders(),
  });
};

// ── Search inside the library ───────────────────────────────────────────────

export interface SearchHit {
  item_id: string;
  format_url: string;
  page: number | null;
  page_label: string | null;
  second_start: number | null;
  second_end: number | null;
  rank: number;
  /** Text around the match, with <b> around the matched words. */
  snippet: string;
  title: MultilingualText | null;
  author: string | null;
}

export interface SearchResponse {
  results: SearchHit[];
  /** Row started for this query; sent back when a result is opened. */
  logId: number | null;
}

/** Full-text search over the indexed books, videos and external sources. */
export const searchInside = async (query: string, limit = 20): Promise<SearchResponse> => {
  const q = query.trim();
  if (q.length < 3) return { results: [], logId: null };
  try {
    const qs = new URLSearchParams({ q, limit: String(limit) });
    const res = await fetch(`/api/search?${qs}`, { headers: tgInitDataHeader() });
    if (!res.ok) return { results: [], logId: null };
    const data = await res.json();
    return { results: data.results || [], logId: data.logId ?? null };
  } catch {
    return { results: [], logId: null };
  }
};

/**
 * Record that a result was opened. Fire-and-forget: the reader must open
 * whether or not the bookkeeping succeeds.
 */
export const logSearchOpened = (logId: number | null, itemId: string, position: string): void => {
  if (logId === null) return;
  fetch('/api/search/opened', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...tgInitDataHeader() },
    body: JSON.stringify({ logId, itemId, position }),
  }).catch(() => {/* never block on a metric */});
};

// ── Index (extracted text and search chunks) ────────────────────────────────

export type IndexState = 'indexed' | 'failed' | 'skipped';

export interface IndexRow {
  item_id: string;
  format_url: string;
  filename: string | null;
  state: IndexState;
  /** How the text came out: 'pdftotext' | 'epub' | … */
  method: string | null;
  pages: number | null;
  /** Characters stored, whitespace excluded. */
  chars: number | null;
  chunk_count: number | null;
  /** Share of letters among non-space characters, 0..1. Low = formulas or bad OCR. */
  quality: number | null;
  /** Pages a human corrected. They survive every re-index. */
  manual_pages: number;
  detail: string | null;
  indexed_at: string;
  title: MultilingualText | null;
}

export interface IndexTotals {
  indexed: number;
  failed: number;
  skipped: number;
  pages: number;
  chars: number;
  chunks: number;
  manual_pages: number;
  /** Files that could be indexed at all — the denominator for "12 of 21". */
  indexable: number;
}

export interface IndexJob {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  current: string;
  error: string | null;
  stopRequested: boolean;
}

export interface IndexReport {
  job: IndexJob;
  rows: IndexRow[];
  totals: IndexTotals;
}

export interface IndexPage {
  page: number;
  page_label: string | null;
  source: string;
  chars: number;
  text: string;
  quality: number;
  updated_at: string;
}

const EMPTY_INDEX_JOB: IndexJob = {
  running: false, startedAt: null, finishedAt: null,
  total: 0, done: 0, current: '', error: null, stopRequested: false,
};

const EMPTY_INDEX_REPORT: IndexReport = {
  job: EMPTY_INDEX_JOB,
  rows: [],
  totals: { indexed: 0, failed: 0, skipped: 0, pages: 0, chars: 0, chunks: 0, manual_pages: 0, indexable: 0 },
};

/** Polled while indexing runs, so a transport blip returns empty rather than throwing. */
export const loadIndexReport = async (): Promise<IndexReport> => {
  try {
    const res = await fetch('/api/admin/index', { headers: authHeaders() });
    if (!res.ok) return EMPTY_INDEX_REPORT;
    const data = await res.json();
    return {
      job: { ...EMPTY_INDEX_JOB, ...(data.job || {}) },
      rows: data.rows || [],
      totals: { ...EMPTY_INDEX_REPORT.totals, ...(data.totals || {}) },
    };
  } catch {
    return EMPTY_INDEX_REPORT;
  }
};

/** Index everything, or one material when `itemId` is given. */
export const startIndexing = async (itemId?: string): Promise<void> => {
  await writeRequest('Запуск индексации', '/api/admin/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(itemId ? { itemId } : {}),
  });
};

export const stopIndexing = async (): Promise<void> => {
  await writeRequest('Остановка индексации', '/api/admin/index/stop', {
    method: 'POST',
    headers: authHeaders(),
  });
};

export const loadIndexPages = async (
  itemId: string, formatUrl: string, offset = 0, limit = 50,
): Promise<{ total: number; pages: IndexPage[] }> => {
  const qs = new URLSearchParams({ item: itemId, format: formatUrl, offset: String(offset), limit: String(limit) });
  try {
    const res = await fetch(`/api/admin/index/pages?${qs}`, { headers: authHeaders() });
    if (!res.ok) return { total: 0, pages: [] };
    const data = await res.json();
    return { total: data.total || 0, pages: data.pages || [] };
  } catch {
    return { total: 0, pages: [] };
  }
};

/**
 * Correct one page by hand. The server marks it 'manual', which is what makes
 * the correction survive the next re-index instead of being thrown away.
 */
export const savePageText = async (
  itemId: string, formatUrl: string, page: number, text: string,
): Promise<void> => {
  await writeRequest('Сохранение страницы', '/api/admin/index/page', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ itemId, formatUrl, page, text }),
  });
};

// ── Job queue ───────────────────────────────────────────────────────────────

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRow {
  id: number;
  batch_id: number | null;
  kind: string;
  item_id: string | null;
  label: string | null;
  state: JobState;
  progress: number;
  attempts: number;
  max_attempts: number;
  detail: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobTotals {
  queued: number; running: number; done: number; failed: number; cancelled: number;
}

const EMPTY_JOB_TOTALS: JobTotals = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };

export const loadJobs = async (): Promise<{ jobs: JobRow[]; totals: JobTotals }> => {
  try {
    const res = await fetch('/api/admin/jobs', { headers: authHeaders() });
    if (!res.ok) return { jobs: [], totals: EMPTY_JOB_TOTALS };
    const data = await res.json();
    return { jobs: data.jobs || [], totals: { ...EMPTY_JOB_TOTALS, ...(data.totals || {}) } };
  } catch {
    return { jobs: [], totals: EMPTY_JOB_TOTALS };
  }
};

/** Queue a subtitle import for every uploaded .srt/.vtt with an obvious target. */
export const queueSubtitles = async (itemId?: string): Promise<{ queued: number; skipped: string[] }> => {
  const res = await writeRequest('Постановка задач', '/api/admin/jobs/subtitles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(itemId ? { itemId } : {}),
  });
  const data = await res.json();
  return { queued: data.queued || 0, skipped: data.skipped || [] };
};

/** Remove one material from the index, leaving the catalogue entry alone. */
export const unindexItem = async (itemId: string): Promise<{ files: number; chunks: number }> => {
  const res = await writeRequest('Удаление из индекса', `/api/admin/index/${itemId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  const data = await res.json();
  return { files: data.files || 0, chunks: data.chunks || 0 };
};

export const jobAction = async (id: number, action: 'cancel' | 'retry'): Promise<void> => {
  await writeRequest(action === 'cancel' ? 'Отмена задачи' : 'Повтор задачи',
    `/api/admin/jobs/${id}/${action}`, { method: 'POST', headers: authHeaders() });
};

export const cancelBatch = async (batchId: number): Promise<void> => {
  await writeRequest('Отмена пачки', `/api/admin/jobs/batch/${batchId}/cancel`, {
    method: 'POST', headers: authHeaders(),
  });
};

// ── Analytics excludes (Telegram usernames + IPs not counted in stats) ──────

const cleanUsername = (s: string): string =>
  s.replace(/^@/, '').trim().toLowerCase();
const cleanIp = (s: string): string => s.trim();

export const addAnalyticsExcludeUsername = async (username: string): Promise<void> => {
  const clean = cleanUsername(username);
  if (!clean) return;
  const list = cache.analyticsExcludes.usernames;
  if (list.includes(clean)) return;
  const prev = { ...cache };
  cache.analyticsExcludes = { ...cache.analyticsExcludes, usernames: [...list, clean] };
  await commitSettings(prev);
};

export const removeAnalyticsExcludeUsername = async (username: string): Promise<void> => {
  const prev = { ...cache };
  cache.analyticsExcludes = {
    ...cache.analyticsExcludes,
    usernames: cache.analyticsExcludes.usernames.filter(u => u !== username),
  };
  await commitSettings(prev);
};

export const addAnalyticsExcludeIp = async (ip: string): Promise<void> => {
  const clean = cleanIp(ip);
  if (!clean) return;
  const list = cache.analyticsExcludes.ips;
  if (list.includes(clean)) return;
  const prev = { ...cache };
  cache.analyticsExcludes = { ...cache.analyticsExcludes, ips: [...list, clean] };
  await commitSettings(prev);
};

export const removeAnalyticsExcludeIp = async (ip: string): Promise<void> => {
  const prev = { ...cache };
  cache.analyticsExcludes = {
    ...cache.analyticsExcludes,
    ips: cache.analyticsExcludes.ips.filter(i => i !== ip),
  };
  await commitSettings(prev);
};

// Telegram numeric user IDs — stable across username changes.
export const addAnalyticsExcludeUserId = async (id: string | number): Promise<void> => {
  const clean = String(id).trim();
  if (!clean) return;
  if (cache.analyticsExcludes.userIds.includes(clean)) return;
  const prev = { ...cache };
  cache.analyticsExcludes = {
    ...cache.analyticsExcludes,
    userIds: [...cache.analyticsExcludes.userIds, clean],
  };
  await commitSettings(prev);
};

export const removeAnalyticsExcludeUserId = async (id: string): Promise<void> => {
  const prev = { ...cache };
  cache.analyticsExcludes = {
    ...cache.analyticsExcludes,
    userIds: cache.analyticsExcludes.userIds.filter(x => x !== id),
  };
  await commitSettings(prev);
};

/**
 * Exclude one exact visitor by the pseudonym shown on their access-log rows.
 * Unlike an IP exclude this targets a single address (the stored IP is
 * truncated to a /24, so it can't), and unlike a username exclude it works for
 * a visitor who never identified themselves to Telegram.
 */
export const addAnalyticsExcludeVisitor = async (hash: string): Promise<void> => {
  const clean = (hash || '').trim();
  if (!clean) return;
  if (cache.analyticsExcludes.visitors.includes(clean)) return;
  const prev = { ...cache };
  cache.analyticsExcludes = {
    ...cache.analyticsExcludes,
    visitors: [...cache.analyticsExcludes.visitors, clean],
  };
  await commitSettings(prev);
};

export const removeAnalyticsExcludeVisitor = async (hash: string): Promise<void> => {
  const prev = { ...cache };
  cache.analyticsExcludes = {
    ...cache.analyticsExcludes,
    visitors: cache.analyticsExcludes.visitors.filter(x => x !== hash),
  };
  await commitSettings(prev);
};

// ── Browser exclude token (localStorage + server-side list) ─────────────────
// Token survives IP changes, network swaps and Telegram restarts. Each
// device that the admin marks gets its own token, so individual devices can
// be revoked later without affecting others.

const SKIP_TOKEN_KEY = 'library_skip_analytics_token';

export const getSkipAnalyticsToken = (): string => {
  try { return localStorage.getItem(SKIP_TOKEN_KEY) || ''; } catch { return ''; }
};

const generateToken = (): string => {
  const a = new Uint8Array(16);
  (window.crypto || (window as any).msCrypto).getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
};

// Register THIS browser as excluded. Generates a fresh token (if none yet),
// stores it in localStorage, and adds it server-side. Subsequent visits and
// item events from this browser will be silently dropped.
export const registerBrowserExclude = async (label: string): Promise<void> => {
  let token = getSkipAnalyticsToken();
  if (!token) {
    token = generateToken();
    try { localStorage.setItem(SKIP_TOKEN_KEY, token); } catch { /* quota */ }
  }
  // De-dupe: a browser already on the list just gets the label refreshed.
  const existing = cache.analyticsExcludes.browsers.filter(b => b.token !== token);
  const prev = { ...cache };
  cache.analyticsExcludes = {
    ...cache.analyticsExcludes,
    browsers: [...existing, { token, label, addedAt: new Date().toISOString() }],
  };
  await commitSettings(prev);
};

// Remove one browser entry from the server list. If it was THIS browser's
// own token, also clear localStorage so the indicator updates immediately.
export const removeBrowserExclude = async (token: string): Promise<void> => {
  const prev = { ...cache };
  cache.analyticsExcludes = {
    ...cache.analyticsExcludes,
    browsers: cache.analyticsExcludes.browsers.filter(b => b.token !== token),
  };
  await commitSettings(prev);
  if (getSkipAnalyticsToken() === token) {
    try { localStorage.removeItem(SKIP_TOKEN_KEY); } catch { /* noop */ }
  }
};

// Header sent on every analytics-recording request (visits + item events).
// When the token matches a registered browser exclude, the server short-
// circuits without an INSERT.
const skipAnalyticsHeader = (): Record<string, string> => {
  const t = getSkipAnalyticsToken();
  return t ? { 'x-skip-analytics': t } : {};
};

export const trackActivity = (type: 'view' | 'download', itemId: string) => {
  if (previewMode) return;
  const idx = cache.items.findIndex(i => i.id === itemId);
  if (idx < 0) return;

  const updated = { ...cache.items[idx] };
  if (type === 'view') updated.views++;
  else updated.downloads++;
  cache.items = cache.items.map((i, n) => (n === idx ? updated : i));

  // Telegram username, if available — lets the server build per-user analytics.
  const tg = (window as any).Telegram?.WebApp;
  const username = tg?.initDataUnsafe?.user?.username
    ? tg.initDataUnsafe.user.username.toLowerCase()
    : null;

  fetch(`/api/items/${itemId}/track`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...skipAnalyticsHeader(),
      ...(tg?.initData ? { 'x-telegram-init-data': tg.initData } : {}),
    },
    body: JSON.stringify({ type, username }),
  }).catch(() => {/* best effort */});
};

// ── Bookmarks ─────────────────────────────────────────────────────────────────

export const getBookmarks = async (userId: string, itemId: string): Promise<Bookmark[]> => {
  try {
    const res = await fetch(`/api/users/${userId}/bookmarks/${itemId}`, { headers: tgInitDataHeader() });
    const data = await res.json();
    return data.bookmarks || [];
  } catch {
    return [];
  }
};

export const addBookmark = async (userId: string, itemId: string, position: string, label: string): Promise<void> => {
  try {
    await fetch(`/api/users/${userId}/bookmarks/${itemId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tgInitDataHeader() },
      body: JSON.stringify({ position, label }),
    });
  } catch {/* best effort */}
};

export const deleteBookmark = async (userId: string, bookmarkId: string): Promise<void> => {
  try {
    await fetch(`/api/users/${userId}/bookmarks/${bookmarkId}`, { method: 'DELETE', headers: tgInitDataHeader() });
  } catch {/* best effort */}
};

// ── Annotations (highlights + notes, server-backed) ──────────────────────────

export const getAnnotations = async (userId: string, itemId: string): Promise<Annotation[]> => {
  try {
    const res = await fetch(`/api/users/${userId}/annotations/${itemId}`, { headers: tgInitDataHeader() });
    const data = await res.json();
    return data.annotations || [];
  } catch {
    return [];
  }
};

export const addAnnotation = async (
  userId: string, itemId: string,
  formatUrl: string,
  cfiRange: string | null,
  page: number | null,
  selectedText: string,
  note: string,
  color: HighlightColor,
): Promise<string | null> => {
  try {
    const res = await fetch(`/api/users/${userId}/annotations/${itemId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tgInitDataHeader() },
      body: JSON.stringify({ formatUrl, cfiRange, page, selectedText, note, color }),
    });
    const data = await res.json();
    return data.id || null;
  } catch {
    return null;
  }
};

export const deleteAnnotation = async (userId: string, annotationId: string): Promise<void> => {
  try {
    await fetch(`/api/users/${userId}/annotations/${annotationId}`, { method: 'DELETE', headers: tgInitDataHeader() });
  } catch { /* best effort */ }
};

// ── View history (local, per-device) ─────────────────────────────────────────

const HISTORY_KEY = 'library_view_history';
const HISTORY_MAX = 50;

export const recordView = (itemId: string): string[] => {
  let list: string[] = [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    list = raw ? JSON.parse(raw) : [];
  } catch { list = []; }
  list = [itemId, ...list.filter(id => id !== itemId)].slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch {/* quota */}
  return list;
};

export const getViewHistory = (): string[] => {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};

// ── Reading progress ──────────────────────────────────────────────────────────

export const getReadingProgress = async (userId: string, itemId: string, formatUrl: string): Promise<ReadingProgress | null> => {
  const cached = progressCache[itemId]?.[formatUrl];
  if (cached) return cached;
  try {
    const res = await fetch(`/api/users/${userId}/progress/${itemId}`, { headers: tgInitDataHeader() });
    if (res.ok) {
      const rows: Array<{ position: string; position_total: number; format_url: string }> = await res.json();
      if (!progressCache[itemId]) progressCache[itemId] = {};
      for (const row of rows) {
        progressCache[itemId][row.format_url || ''] = { position: row.position, position_total: row.position_total, format_url: row.format_url };
      }
      return progressCache[itemId][formatUrl] || null;
    }
  } catch {/* best effort */}
  return null;
};

export const saveReadingProgress = (
  userId: string, itemId: string,
  position: string, positionTotal: number, formatUrl: string,
): void => {
  if (previewMode) return;
  if (!progressCache[itemId]) progressCache[itemId] = {};
  progressCache[itemId][formatUrl] = { position, position_total: positionTotal, format_url: formatUrl };
  fetch(`/api/users/${userId}/progress/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...tgInitDataHeader() },
    body: JSON.stringify({ position, positionTotal, formatUrl }),
  }).catch(() => {/* best effort */});
};

// Returns 0–100 progress percentage for a given item — max across all its files.
export const getProgressPercent = (itemId: string): number => {
  const formats = progressCache[itemId];
  if (!formats) return 0;
  let max = 0;
  for (const p of Object.values(formats)) {
    let pct = 0;
    if (p.format_url?.endsWith('.epub')) pct = p.position_total; // stored as 0–100
    else if (p.position_total > 0) pct = Math.round((parseInt(p.position) / p.position_total) * 100);
    if (pct > max) max = pct;
  }
  return max;
};

// Item IDs the user has any active reading progress for. Used for the
// "Continue reading" shelf on the home screen. Filters out finished books
// (>=95%) and items the catalog no longer contains.
export const getInProgressItemIds = (): string[] => {
  const ids: string[] = [];
  for (const itemId of Object.keys(progressCache)) {
    const pct = getProgressPercent(itemId);
    if (pct > 0 && pct < 95) ids.push(itemId);
  }
  return ids;
};

// True when the user has reached >= 95% of any format for this item (or
// pressed "mark as finished" which writes a synthetic 100% marker row).
export const isFinished = (itemId: string): boolean => getProgressPercent(itemId) >= 95;

// Mark a book as read without actually scrolling to the end. Writes a
// synthetic progress row with format_url='__finished__' so getProgressPercent
// reports 100% via its existing max-across-formats logic.
export const markItemFinished = async (userId: string, itemId: string): Promise<void> => {
  if (!progressCache[itemId]) progressCache[itemId] = {};
  progressCache[itemId]['__finished__'] = { position: '100', position_total: 100, format_url: '__finished__' };
  try {
    await fetch(`/api/users/${userId}/progress/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...tgInitDataHeader() },
      body: JSON.stringify({ position: '100', positionTotal: 100, formatUrl: '__finished__' }),
    });
  } catch { /* best effort */ }
};

// Drop all reading-progress rows for this item — both real (per-file) progress
// and the synthetic "finished" marker. After this, the book is "fresh" again.
export const resetItemProgress = async (userId: string, itemId: string): Promise<void> => {
  delete progressCache[itemId];
  try {
    await fetch(`/api/users/${userId}/progress/${itemId}`, { method: 'DELETE', headers: tgInitDataHeader() });
  } catch { /* best effort */ }
};
