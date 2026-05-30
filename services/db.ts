import { AppState, MediaItem, Bookmark, ReadingProgress, Annotation, HighlightColor, CustomType } from '../types';
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
    { id: 'COURSE',  en: 'Course',  ru: 'Курс',    es: 'Curso' },
  ],
  defaultLanguage: 'ru',
  globalAccess: false,
  analyticsExcludes: { usernames: [], ips: [], userIds: [], browsers: [] },
});

// In-memory cache — source of truth for the UI between renders.
let cache: AppState = emptyState();

// Server-computed average ratings, keyed by item id.
let avgRatings: Record<string, number> = {};

// Reading progress cache, keyed by itemId → formatUrl → progress.
let progressCache: Record<string, Record<string, ReadingProgress>> = {};

// ── Item normalization (backward compatibility) ──────────────────────────────

const normalizeItem = (item: any): MediaItem => ({
  ...item,
  contentLanguages: item.contentLanguages || ['en'],
  allowDownload: item.allowDownload !== undefined ? item.allowDownload : true,
  allowReading: item.allowReading !== undefined ? item.allowReading : true,
  addedDate: item.addedDate || (item.publishedDate ? new Date(item.publishedDate).toISOString() : new Date().toISOString()),
  views: item.views || 0,
  downloads: item.downloads || 0,
  rating: item.rating || 0,
  formats: (item.formats || []).map((f: any) => ({
    ...f,
    allowDownload: f.allowDownload !== undefined ? f.allowDownload : true,
    allowReading: f.allowReading !== undefined ? f.allowReading : true,
  })),
});

// ── Server requests ──────────────────────────────────────────────────────────

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
      fetch(`/api/users/${userId}/favorites`),
      fetch(`/api/users/${userId}/ratings`),
      fetch(`/api/users/${userId}/progress`),
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
    throw new Error(`loadDb: HTTP ${res.status}`);
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
  }).then(warnIfFailed('favorite')).catch(e => console.warn('favorite failed:', e));
};

export const isFavorited = (userId: string, itemId: string): boolean =>
  cache.userFavorites[userId]?.includes(itemId) || false;

// ── Ratings (server-backed) ──────────────────────────────────────────────────

export const setUserRating = async (
  userId: string, itemId: string, rating: number,
): Promise<number> => {
  const userRecord = { ...(cache.userRatings[userId] || {}), [itemId]: rating };
  cache.userRatings = { ...cache.userRatings, [userId]: userRecord };

  try {
    const res = await fetch(`/api/users/${userId}/ratings/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
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

export const checkIsBlocked = (username?: string, ip?: string): boolean => {
  const list = cache.blacklist || [];
  if (username && list.includes(username.replace('@', '').toLowerCase())) return true;
  if (ip && list.includes(ip.trim())) return true;
  return false;
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

export const logVisit = (username: string, ip: string, platform: string) => {
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
      ip: ip || 'unknown',
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
    const res = await fetch(`/api/users/${userId}/bookmarks/${itemId}`);
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position, label }),
    });
  } catch {/* best effort */}
};

export const deleteBookmark = async (userId: string, bookmarkId: string): Promise<void> => {
  try {
    await fetch(`/api/users/${userId}/bookmarks/${bookmarkId}`, { method: 'DELETE' });
  } catch {/* best effort */}
};

// ── Annotations (highlights + notes, server-backed) ──────────────────────────

export const getAnnotations = async (userId: string, itemId: string): Promise<Annotation[]> => {
  try {
    const res = await fetch(`/api/users/${userId}/annotations/${itemId}`);
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
      headers: { 'Content-Type': 'application/json' },
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
    await fetch(`/api/users/${userId}/annotations/${annotationId}`, { method: 'DELETE' });
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
    const res = await fetch(`/api/users/${userId}/progress/${itemId}`);
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
  if (!progressCache[itemId]) progressCache[itemId] = {};
  progressCache[itemId][formatUrl] = { position, position_total: positionTotal, format_url: formatUrl };
  fetch(`/api/users/${userId}/progress/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: '100', positionTotal: 100, formatUrl: '__finished__' }),
    });
  } catch { /* best effort */ }
};

// Drop all reading-progress rows for this item — both real (per-file) progress
// and the synthetic "finished" marker. After this, the book is "fresh" again.
export const resetItemProgress = async (userId: string, itemId: string): Promise<void> => {
  delete progressCache[itemId];
  try {
    await fetch(`/api/users/${userId}/progress/${itemId}`, { method: 'DELETE' });
  } catch { /* best effort */ }
};
