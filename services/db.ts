import { AppState, MediaItem, Bookmark, ReadingProgress } from '../types';

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
  customTypes: ['BOOK', 'ARTICLE', 'JOURNAL', 'VIDEO', 'COURSE'],
  defaultLanguage: 'ru',
  globalAccess: false,
});

// In-memory cache — source of truth for the UI between renders.
let cache: AppState = emptyState();

// Server-computed average ratings, keyed by item id.
let avgRatings: Record<string, number> = {};

// Reading progress cache, keyed by item id.
let progressCache: Record<string, ReadingProgress> = {};

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

const putItem = (item: MediaItem) => {
  fetch(`/api/items/${item.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(item),
  }).then(warnIfFailed('PUT item')).catch(e => console.warn('PUT item failed:', e));
};

const removeItem = (id: string) => {
  fetch(`/api/items/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }).then(warnIfFailed('DELETE item')).catch(e => console.warn('DELETE item failed:', e));
};

const putSettings = () => {
  const settings = {
    allowedUsers: cache.allowedUsers,
    blacklist: cache.blacklist,
    customTypes: cache.customTypes,
    defaultLanguage: cache.defaultLanguage,
    globalAccess: cache.globalAccess,
  };
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(settings),
  }).then(warnIfFailed('PUT settings')).catch(e => console.warn('PUT settings failed:', e));
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
        progressCache[p.item_id] = { position: p.position, position_total: p.position_total, format_url: p.format_url };
      }
    }
  } catch (e) {
    console.warn('loadUserData failed:', e);
  }
};

// ── Load / get ───────────────────────────────────────────────────────────────

export const loadDb = async (userId?: string): Promise<AppState> => {
  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const remote = await res.json();
      cache = {
        ...emptyState(),
        items: (remote.items || []).map(normalizeItem),
        allowedUsers: remote.allowedUsers || [],
        blacklist: remote.blacklist || [],
        customTypes: (remote.customTypes && remote.customTypes.length)
          ? remote.customTypes
          : emptyState().customTypes,
        defaultLanguage: remote.defaultLanguage || 'ru',
        globalAccess: !!remote.globalAccess,
      };
      avgRatings = remote.ratings || {};
    } else {
      console.warn('loadDb: HTTP', res.status);
      cache = emptyState();
      avgRatings = {};
    }
  } catch (e) {
    console.warn('loadDb failed, using empty state:', e);
    cache = emptyState();
    avgRatings = {};
  }
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
export const saveDb = (data: AppState) => {
  cache = {
    ...emptyState(),
    ...data,
    items: (data.items || []).map(normalizeItem),
  };
  cache.items.forEach(putItem);
  putSettings();
};

// ── Items ────────────────────────────────────────────────────────────────────

export const updateItem = (item: MediaItem) => {
  const exists = cache.items.some(i => i.id === item.id);
  cache.items = exists
    ? cache.items.map(i => (i.id === item.id ? item : i))
    : [...cache.items, item];
  putItem(item);
};

export const deleteItem = (id: string) => {
  cache.items = cache.items.filter(i => i.id !== id);
  removeItem(id);
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

export const addUserToWhitelist = (username: string) => {
  const clean = username.replace('@', '').trim().toLowerCase();
  if (clean && !cache.allowedUsers.includes(clean)) {
    cache.allowedUsers = [...cache.allowedUsers, clean];
    putSettings();
  }
};

export const removeUserFromWhitelist = (username: string) => {
  cache.allowedUsers = cache.allowedUsers.filter(u => u !== username);
  putSettings();
};

// ── Blacklist ────────────────────────────────────────────────────────────────

export const addToBlacklist = (entry: string) => {
  const clean = entry.replace('@', '').trim().toLowerCase();
  if (clean && !cache.blacklist.includes(clean)) {
    cache.blacklist = [...cache.blacklist, clean];
    putSettings();
  }
};

export const removeFromBlacklist = (entry: string) => {
  cache.blacklist = cache.blacklist.filter(e => e !== entry);
  putSettings();
};

export const checkIsBlocked = (username?: string, ip?: string): boolean => {
  const list = cache.blacklist || [];
  if (username && list.includes(username.replace('@', '').toLowerCase())) return true;
  if (ip && list.includes(ip.trim())) return true;
  return false;
};

// ── Custom types ─────────────────────────────────────────────────────────────

export const addCustomType = (type: string) => {
  const upperType = type.trim().toUpperCase();
  if (upperType && !cache.customTypes.includes(upperType)) {
    cache.customTypes = [...cache.customTypes, upperType];
    putSettings();
  }
};

export const deleteCustomType = (type: string) => {
  cache.customTypes = cache.customTypes.filter(t => t !== type);
  putSettings();
};

// ── Misc settings ────────────────────────────────────────────────────────────

export const toggleGlobalAccess = (enabled: boolean) => {
  cache.globalAccess = enabled;
  putSettings();
};

// ── Visit logs (server-backed) ───────────────────────────────────────────────

export const logVisit = (username: string, ip: string, platform: string) => {
  fetch('/api/visits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: username || 'guest',
      ip: ip || 'unknown',
      platform: platform || 'web',
      device: navigator.userAgent,
    }),
  }).catch(() => {/* best effort */});
};

// ── Stats (server-backed) ────────────────────────────────────────────────────

export const resetStats = (): Promise<unknown> => {
  cache.stats = [];
  cache.userAnalytics = [];
  cache.items = cache.items.map(item => ({ ...item, views: 0, downloads: 0 }));
  return fetch('/api/items/reset-stats', { method: 'POST', headers: authHeaders() })
    .then(warnIfFailed('reset-stats'))
    .catch(e => console.warn('reset-stats failed:', e));
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
    headers: { 'Content-Type': 'application/json' },
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

// ── Reading progress ──────────────────────────────────────────────────────────

export const getReadingProgress = async (userId: string, itemId: string): Promise<ReadingProgress | null> => {
  if (progressCache[itemId]) return progressCache[itemId];
  try {
    const res = await fetch(`/api/users/${userId}/progress/${itemId}`);
    if (res.ok) {
      const data = await res.json();
      if (data) { progressCache[itemId] = data; return data; }
    }
  } catch {/* best effort */}
  return null;
};

export const saveReadingProgress = (
  userId: string, itemId: string,
  position: string, positionTotal: number, formatUrl: string,
): void => {
  progressCache[itemId] = { position, position_total: positionTotal, format_url: formatUrl };
  fetch(`/api/users/${userId}/progress/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position, positionTotal, formatUrl }),
  }).catch(() => {/* best effort */});
};

// Returns 0–100 progress percentage for a given item from cache.
export const getProgressPercent = (itemId: string): number => {
  const p = progressCache[itemId];
  if (!p) return 0;
  if (p.format_url?.endsWith('.epub')) return p.position_total; // stored as 0–100
  if (p.position_total > 0) return Math.round((parseInt(p.position) / p.position_total) * 100);
  return 0;
};
