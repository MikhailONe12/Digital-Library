
import { AppState, MediaItem, StatPoint, UserAnalytics } from '../types';

const DB_KEY = 'mediavault_db_v4'; 

const INITIAL_DATA: AppState = {
  items: [
    {
      id: '1',
      title: { en: 'The Art of Code', ru: 'Искусство кода', es: 'El arte del código' },
      description: { 
        en: 'A deep dive into elegant software architecture.', 
        ru: 'Глубокое погружение в элегантную архитектуру ПО.', 
        es: 'Una имерсия profunda en la архитектуры de software elegante.' 
      },
      coverUrl: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&q=80&w=400&h=600',
      type: 'BOOK',
      rating: 4.8,
      author: 'John Developer',
      publishedDate: '2023-10-15',
      formats: [{ id: 'f1', name: 'PDF', url: '#', size: '2.4MB' }],
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      isPrivate: false,
      views: 1240,
      downloads: 450,
      contentLanguages: ['en', 'ru'],
      allowDownload: true,
      allowReading: true
    },
    {
      id: '2',
      title: { en: 'Clean Architecture', ru: 'Чистая архитектура', es: 'Arquitectura Limpia' },
      description: { 
        en: 'A Craftsman\'s Guide to Software Structure and Design.', 
        ru: 'Руководство ремесленника по структуре и дизайну программного обеспечения.', 
        es: 'Una guía del artesano para la estructura y el diseño del software.' 
      },
      coverUrl: 'https://images.unsplash.com/photo-1531427186611-ecfd6d936c79?auto=format&fit=crop&q=80&w=400&h=600',
      type: 'BOOK',
      rating: 4.9,
      author: 'Robert Martin',
      publishedDate: '2023-05-20',
      formats: [{ id: 'f2', name: 'EPUB', url: '#', size: '1.8MB' }],
      isPrivate: false,
      views: 890,
      downloads: 310,
      contentLanguages: ['en'],
      allowDownload: true,
      allowReading: true
    },
    {
      id: '3',
      title: { en: 'The Pragmatic Programmer', ru: 'Программист-прагматик', es: 'El Programador Pragmático' },
      description: { 
        en: 'From Journeyman to Master. Your journey to mastery begins here.', 
        ru: 'Путь от подмастерья к мастеру. Ваше путешествие к мастерству начинается здесь.', 
        es: 'De oficial a maestro. Tu viaje hacia la maestría comienza aquí.' 
      },
      coverUrl: 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?auto=format&fit=crop&q=80&w=400&h=600',
      type: 'BOOK',
      rating: 4.9,
      author: 'Andrew Hunt',
      publishedDate: '2023-11-01',
      formats: [{ id: 'f3', name: 'PDF', url: '#', size: '4.2MB' }],
      isPrivate: true,
      views: 2100,
      downloads: 520,
      contentLanguages: ['en', 'ru', 'es'],
      allowDownload: true,
      allowReading: true
    },
    {
      id: '4',
      title: { en: 'AI & ML Quarterly', ru: 'AI и ML Ежеквартальник', es: 'IA y ML Trimestral' },
      description: { 
        en: 'Latest breakthroughs in artificial intelligence and deep learning.', 
        ru: 'Последние достижения в области искусственного интеллекта и глубокого обучения.', 
        es: 'Últimos avances en inteligencia artificial y aprendizaje profundo.' 
      },
      coverUrl: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&q=80&w=400&h=600',
      type: 'JOURNAL',
      rating: 4.7,
      author: 'Tech Institute',
      publishedDate: '2024-01-10',
      formats: [{ id: 'f4', name: 'Interactive PDF', url: '#', size: '12.5MB' }],
      isPrivate: false,
      views: 560,
      downloads: 120,
      contentLanguages: ['en'],
      allowDownload: true,
      allowReading: true
    },
    {
      id: '5',
      title: { en: 'Mastering Modern React', ru: 'Освоение современного React', es: 'Dominando React Moderno' },
      description: { 
        en: 'Advanced patterns and performance optimization in React 19.', 
        ru: 'Продвинутые паттерны и оптимизация производительности в React 19.', 
        es: 'Patrones avanzados y optimización de rendimiento en React 19.' 
      },
      coverUrl: 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?auto=format&fit=crop&q=80&w=400&h=600',
      type: 'VIDEO',
      rating: 4.6,
      author: 'Elena Smith',
      publishedDate: '2024-02-15',
      formats: [{ id: 'f5', name: 'Source Code', url: '#', size: '0.5MB' }],
      videoUrl: 'https://www.youtube.com/watch?v=Tn6-PIqc4UM',
      isPrivate: false,
      views: 3400,
      downloads: 880,
      contentLanguages: ['en', 'ru'],
      allowDownload: true,
      allowReading: true
    },
    {
      id: '6',
      title: { en: 'Pro TypeScript Patterns', ru: 'TypeScript паттерны для профи', es: 'Patrones Pro de TypeScript' },
      description: { 
        en: 'Deep dive into utility types and generics.', 
        ru: 'Глубокое погружение в служебные типы и дженерики.', 
        es: 'Inmersión profunda en tipos de utilidad y genéricos.' 
      },
      coverUrl: 'https://images.unsplash.com/photo-1516116216624-53e697fedbea?auto=format&fit=crop&q=80&w=400&h=600',
      type: 'VIDEO',
      rating: 4.9,
      author: 'Alex Typer',
      publishedDate: '2023-12-12',
      formats: [],
      videoUrl: 'https://www.youtube.com/watch?v=VguJQxBsc_0',
      isPrivate: true,
      views: 1500,
      downloads: 45,
      contentLanguages: ['en'],
      allowDownload: true,
      allowReading: true
    },
    {
      id: '7',
      title: { en: 'Trading Psychology 101', ru: 'Психология трейдинга 101', es: 'Psicología del Trading 101' },
      description: { 
        en: 'Mastering your mind for consistent trading results.', 
        ru: 'Освоение своего разума для стабильных результатов в трейдинге.', 
        es: 'Dominando tu mente para resultados de trading consistentes.' 
      },
      coverUrl: 'https://images.unsplash.com/photo-1611974714024-462cd497ae98?auto=format&fit=crop&q=80&w=400&h=600',
      type: 'VIDEO',
      rating: 4.5,
      author: 'Mark Market',
      publishedDate: '2024-03-01',
      formats: [{ id: 'f6', name: 'Workbook', url: '#', size: '1.2MB' }],
      videoUrl: 'https://www.youtube.com/watch?v=Yp69mS-rCnc',
      isPrivate: false,
      views: 4200,
      downloads: 1200,
      contentLanguages: ['ru', 'en'],
      allowDownload: true,
      allowReading: true
    }
  ],
  allowedUsers: ['admin_username', 'pro_trader_77'],
  stats: [
    { date: '2023-10-01', views: 120, downloads: 40 },
    { date: '2023-10-02', views: 150, downloads: 55 },
    { date: '2023-10-03', views: 110, downloads: 30 },
    { date: '2023-10-04', views: 180, downloads: 80 },
    { date: '2023-10-05', views: 220, downloads: 90 },
  ],
  userAnalytics: [],
  userFavorites: {},
  customTypes: ['BOOK', 'ARTICLE', 'JOURNAL', 'VIDEO', 'COURSE'],
  defaultLanguage: 'ru',
  globalAccess: false,
  botConfig: {
    token: '',
    username: 'OptionsHUB_Bot',
    welcomeMessage: {
      en: 'Welcome to OptionsHUB Digital Library! Access professional assets directly in Telegram.',
      ru: 'Добро пожаловать в цифровую библиотеку OptionsHUB! Профессиональные активы прямо в Telegram.',
      es: '¡Bienvenido a la biblioteca digital de OptionsHUB! Accede a activos profesionales directamente en Telegram.'
    },
    webAppUrl: window.location.origin
  }
};

export const getDb = (): AppState => {
  const saved = localStorage.getItem(DB_KEY);
  if (!saved) {
    localStorage.setItem(DB_KEY, JSON.stringify(INITIAL_DATA));
    return INITIAL_DATA;
  }
  const parsed = JSON.parse(saved);
  // Ensure botConfig and contentLanguages and permissions exist for older versions
  if (!parsed.botConfig) {
    parsed.botConfig = INITIAL_DATA.botConfig;
  }
  if (!parsed.userFavorites) {
    parsed.userFavorites = {};
  }
  parsed.items = parsed.items.map((item: any) => ({
    ...item,
    contentLanguages: item.contentLanguages || ['en'],
    allowDownload: item.allowDownload !== undefined ? item.allowDownload : true,
    allowReading: item.allowReading !== undefined ? item.allowReading : true
  }));
  saveDb(parsed);
  return parsed;
};

export const saveDb = (data: AppState) => {
  localStorage.setItem(DB_KEY, JSON.stringify(data));
};

export const updateItem = (item: MediaItem) => {
  const db = getDb();
  const index = db.items.findIndex(i => i.id === item.id);
  if (index >= 0) db.items[index] = item;
  else db.items.push(item);
  saveDb(db);
};

export const deleteItem = (id: string) => {
  const db = getDb();
  db.items = db.items.filter(i => i.id !== id);
  saveDb(db);
};

export const toggleFavorite = (userId: string, itemId: string) => {
  const db = getDb();
  if (!db.userFavorites[userId]) {
    db.userFavorites[userId] = [];
  }
  const favorites = db.userFavorites[userId];
  const index = favorites.indexOf(itemId);
  if (index > -1) {
    favorites.splice(index, 1);
  } else {
    favorites.push(itemId);
  }
  saveDb(db);
};

export const isFavorited = (userId: string, itemId: string): boolean => {
  const db = getDb();
  return db.userFavorites[userId]?.includes(itemId) || false;
};

export const addUserToWhitelist = (username: string) => {
  const db = getDb();
  const cleanUsername = username.replace('@', '').trim().toLowerCase();
  if (cleanUsername && !db.allowedUsers.includes(cleanUsername)) {
    db.allowedUsers.push(cleanUsername);
    saveDb(db);
  }
};

export const removeUserFromWhitelist = (username: string) => {
  const db = getDb();
  db.allowedUsers = db.allowedUsers.filter(u => u !== username);
  saveDb(db);
};

export const toggleGlobalAccess = (enabled: boolean) => {
  const db = getDb();
  db.globalAccess = enabled;
  saveDb(db);
};

export const updateBotConfig = (config: AppState['botConfig']) => {
  const db = getDb();
  db.botConfig = config;
  saveDb(db);
};

export const trackActivity = (type: 'view' | 'download', itemId: string) => {
  const db = getDb();
  const item = db.items.find(i => i.id === itemId);
  if (!item) return;

  // Global increment
  if (type === 'view') item.views++;
  if (type === 'download') item.downloads++;

  // Date tracking
  const today = new Date().toISOString().split('T')[0];
  const statIndex = db.stats.findIndex(s => s.date === today);
  if (statIndex >= 0) {
    if (type === 'view') db.stats[statIndex].views++;
    else db.stats[statIndex].downloads++;
  } else {
    db.stats.push({ date: today, views: type === 'view' ? 1 : 0, downloads: type === 'download' ? 1 : 0 });
  }

  // User tracking
  const tg = (window as any).Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;
  if (user && user.username) {
    const username = user.username.toLowerCase();
    let userRecord = db.userAnalytics.find(u => u.username === username);
    if (!userRecord) {
      userRecord = { username, views: 0, downloads: 0, lastActive: today };
      db.userAnalytics.push(userRecord);
    }
    if (type === 'view') userRecord.views++;
    if (type === 'download') userRecord.downloads++;
    userRecord.lastActive = today;
  }

  saveDb(db);
};
