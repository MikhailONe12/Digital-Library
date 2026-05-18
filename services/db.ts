import { AppState, MediaItem, VisitLog } from '../types';

// ── Storage keys ─────────────────────────────────────────────────────────────

const SERVER_API_KEY_STORAGE = 'library_server_api_key';
const LOCAL_STATE_STORAGE = 'library_local_v1';

// ── Server API key ───────────────────────────────────────────────────────────

export const getServerApiKey = (): string =>
  localStorage.getItem(SERVER_API_KEY_STORAGE) || '';

export const setServerApiKey = (key: string) =>
  localStorage.setItem(SERVER_API_KEY_STORAGE, key);

// ── Default (empty) state ────────────────────────────────────────────────────

const DEFAULT_BOT_CONFIG = {
  token: '',
  username: 'Digital_Library_ONE_bot',
  welcomeMessage: {
    en: 'Welcome to OptionsData Digital Library! Access professional assets directly in Telegram.',
    ru: 'Добро пожаловать в цифровую библиотеку OptionsData! Профессиональные активы прямо в Telegram.',
    es: '¡Bienvenido a la biblioteca digital de OptionsData! Accede a activos profesionales directamente en Telegram.',
  },
  webAppUrl: typeof window !== 'undefined' ? window.location.origin : '',
};

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
  botConfig: { ...DEFAULT_BOT_CONFIG },
});

// In-memory cache — source of truth for the UI between renders.
let cache: AppState = emptyState();

// ── Local-only slice (per-browser, moves to DB in Step 5) ────────────────────

interface LocalSlice {
  visitLogs: AppState['visitLogs'];
  stats: AppState['stats'];
  userAnalytics: AppState['userAnalytics'];
  userFavorites: AppState['userFavorites'];
  userRatings: AppState['userRatings'];
}

const readLocalSlice = (): LocalSlice => {
  try {
    const raw = localStorage.getItem(LOCAL_STATE_STORAGE);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        visitLogs: p.visitLogs || [],
        stats: p.stats || [],
        userAnalytics: p.userAnalytics || [],
        userFavorites: p.userFavorites || {},
        userRatings: p.userRatings || {},
      };
    }
  } catch {/* ignore */}
  return { visitLogs: [], stats: [], userAnalytics: [], userFavorites: {}, userRatings: {} };
};

const saveLocalSlice = () => {
  const slice: LocalSlice = {
    visitLogs: cache.visitLogs,
    stats: cache.stats,
    userAnalytics: cache.userAnalytics,
    userFavorites: cache.userFavorites,
    userRatings: cache.userRatings,
  };
  try {
    localStorage.setItem(LOCAL_STATE_STORAGE, JSON.stringify(slice));
  } catch {/* ignore */}
};

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
    botConfig: cache.botConfig,
  };
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(settings),
  }).then(warnIfFailed('PUT settings')).catch(e => console.warn('PUT settings failed:', e));
};

// ── Load / get ───────────────────────────────────────────────────────────────

export const loadDb = async (): Promise<AppState> => {
  const local = readLocalSlice();
  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const remote = await res.json();
      cache = {
        items: (remote.items || []).map(normalizeItem),
        allowedUsers: remote.allowedUsers || [],
        blacklist: remote.blacklist || [],
        customTypes: (remote.customTypes && remote.customTypes.length)
          ? remote.customTypes
          : emptyState().customTypes,
        defaultLanguage: remote.defaultLanguage || 'ru',
        globalAccess: !!remote.globalAccess,
        botConfig: remote.botConfig || { ...DEFAULT_BOT_CONFIG },
        ...local,
      };
    } else {
      console.warn('loadDb: HTTP', res.status);
      cache = { ...emptyState(), ...local };
    }
  } catch (e) {
    console.warn('loadDb failed, using empty state:', e);
    cache = { ...emptyState(), ...local };
  }
  return getDb();
};

export const getDb = (): AppState => ({ ...cache });

// Used by the admin JSON import — overwrites everything.
export const saveDb = (data: AppState) => {
  cache = {
    ...emptyState(),
    ...data,
    items: (data.items || []).map(normalizeItem),
  };
  saveLocalSlice();
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

// ── Favorites (per-browser) ──────────────────────────────────────────────────

export const toggleFavorite = (userId: string, itemId: string) => {
  const favorites = cache.userFavorites[userId]
    ? [...cache.userFavorites[userId]]
    : [];
  const index = favorites.indexOf(itemId);
  if (index > -1) favorites.splice(index, 1);
  else favorites.push(itemId);
  cache.userFavorites = { ...cache.userFavorites, [userId]: favorites };
  saveLocalSlice();
};

export const isFavorited = (userId: string, itemId: string): boolean =>
  cache.userFavorites[userId]?.includes(itemId) || false;

// ── Ratings (per-browser) ────────────────────────────────────────────────────

export const setUserRating = (userId: string, itemId: string, rating: number) => {
  const userRecord = { ...(cache.userRatings[userId] || {}), [itemId]: rating };
  cache.userRatings = { ...cache.userRatings, [userId]: userRecord };
  saveLocalSlice();
};

export const getUserRating = (userId: string, itemId: string): number =>
  cache.userRatings[userId]?.[itemId] || 0;

export const getAverageRating = (itemId: string): number => {
  let sum = 0;
  let count = 0;
  Object.values(cache.userRatings).forEach(userRecord => {
    if (userRecord[itemId]) {
      sum += userRecord[itemId];
      count++;
    }
  });
  if (count > 0) return parseFloat((sum / count).toFixed(1));
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

export const updateBotConfig = (config: AppState['botConfig']) => {
  cache.botConfig = config;
  putSettings();
};

// ── Visit logs (per-browser, moves to DB in Step 5) ──────────────────────────

export const logVisit = (username: string, ip: string, platform: string) => {
  const log: VisitLog = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    username: username || 'guest',
    ip: ip || 'unknown',
    platform: platform || 'web',
    device: navigator.userAgent,
  };
  cache.visitLogs = [log, ...cache.visitLogs].slice(0, 2000);
  saveLocalSlice();
};

// ── Stats ────────────────────────────────────────────────────────────────────

export const resetStats = () => {
  cache.stats = [];
  cache.userAnalytics = [];
  cache.items = cache.items.map(item => ({ ...item, views: 0, downloads: 0 }));
  saveLocalSlice();
  fetch('/api/items/reset-stats', { method: 'POST', headers: authHeaders() })
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

  // Server-side counter (public endpoint, no key required).
  fetch(`/api/items/${itemId}/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  }).catch(() => {/* best effort */});

  // Local daily timeline.
  const today = new Date().toISOString().split('T')[0];
  const statIndex = cache.stats.findIndex(s => s.date === today);
  if (statIndex >= 0) {
    if (type === 'view') cache.stats[statIndex].views++;
    else cache.stats[statIndex].downloads++;
  } else {
    cache.stats.push({
      date: today,
      views: type === 'view' ? 1 : 0,
      downloads: type === 'download' ? 1 : 0,
    });
  }

  // Local per-user analytics.
  const tg = (window as any).Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;
  if (user && user.username) {
    const username = user.username.toLowerCase();
    let userRecord = cache.userAnalytics.find(u => u.username === username);
    if (!userRecord) {
      userRecord = { username, views: 0, downloads: 0, lastActive: today, itemViews: {}, itemDownloads: {} };
      cache.userAnalytics.push(userRecord);
    }
    if (!userRecord.itemViews) userRecord.itemViews = {};
    if (!userRecord.itemDownloads) userRecord.itemDownloads = {};
    if (type === 'view') {
      userRecord.views++;
      userRecord.itemViews[itemId] = (userRecord.itemViews[itemId] || 0) + 1;
    }
    if (type === 'download') {
      userRecord.downloads++;
      userRecord.itemDownloads[itemId] = (userRecord.itemDownloads[itemId] || 0) + 1;
    }
    userRecord.lastActive = today;
  }

  saveLocalSlice();
};
