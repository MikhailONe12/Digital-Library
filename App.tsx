
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { getDb, loadDb, isFavorited, checkIsBlocked, logVisit, getAverageRating, recordView, getViewHistory } from './services/db';
import { MediaItem, Locale, ContentLang } from './types';
import { translations } from './translations';
import { pickText } from './utils';
import Home from './pages/Home';
import Admin from './pages/Admin';
import ItemDetails from './pages/ItemDetails';
import { Layout, Globe, ChevronDown, ShieldAlert } from 'lucide-react';

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<'home' | 'admin' | 'details'>('home');
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [db, setDb] = useState(getDb());
  const [lang, setLang] = useState<Locale>(db.defaultLanguage);
  const [isBlocked, setIsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  // Search & Filters State — persisted across sessions
  const _savedFilters = (() => {
    try { return JSON.parse(localStorage.getItem('library_filters') || '{}'); } catch { return {}; }
  })();

  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | 'ALL' | 'FAVORITES' | 'NEW' | 'HISTORY'>(
    _savedFilters.activeCategory || 'ALL',
  );
  const [contentLangFilter, setContentLangFilter] = useState<ContentLang[]>(
    _savedFilters.contentLangFilter || [],
  );
  const [searchField, setSearchField] = useState<'all' | 'title' | 'author'>(
    _savedFilters.searchField || 'all',
  );
  const [sortBy, setSortBy] = useState<'recent' | 'rating' | 'views' | 'alpha'>(
    _savedFilters.sortBy || 'recent',
  );
  const [viewHistory, setViewHistory] = useState<string[]>(getViewHistory());
  
  const [isLangMenuOpen, setIsLangMenuOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  const t = translations[lang];

  const tg = (window as any).Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;
  const userId = user?.id?.toString() || 'guest_user';
  const username = user?.username || 'guest';

  // DATA LOAD + SECURITY CHECK + LOGGING
  useEffect(() => {
    // Push Telegram's safe-area insets into CSS vars consumed by index.css.
    // safeAreaInset = device notch / home indicator; contentSafeAreaInset =
    // space taken by Telegram's own chrome. Their sum is the real padding.
    const applyInsets = () => {
      const sa  = tg?.safeAreaInset || {};
      const csa = tg?.contentSafeAreaInset || {};
      const root = document.documentElement.style;
      root.setProperty('--tg-safe-top',    ((sa.top || 0)    + (csa.top || 0))    + 'px');
      root.setProperty('--tg-safe-bottom', ((sa.bottom || 0) + (csa.bottom || 0)) + 'px');
    };

    // Sync colour scheme with Telegram (or OS prefers-color-scheme on web).
    // Toggling the `dark` class on <html> flips all Tailwind dark: variants
    // and the CSS surface tokens in index.css.
    const applyTheme = () => {
      const dark = tg?.colorScheme
        ? tg.colorScheme === 'dark'
        : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', !!dark);
    };
    applyTheme();
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    mql?.addEventListener?.('change', applyTheme);

    if (tg) {
      tg.expand();
      tg.ready();
      applyInsets();
      // safeAreaChanged/contentSafeAreaChanged exist on Bot API 8.0+; older
      // clients simply never fire them and we keep the env() fallback.
      try {
        tg.onEvent('safeAreaChanged', applyInsets);
        tg.onEvent('contentSafeAreaChanged', applyInsets);
        tg.onEvent('themeChanged', applyTheme);
      } catch { /* event unsupported on this Telegram client */ }
    }

    // Секретный вход через URL: ?admin=true
    const params = new URLSearchParams(window.location.search);
    if (params.get('admin') === 'true' || params.get('admin') === '1') {
      setCurrentPage('admin');
    }

    const init = async () => {
      // 1. Load catalog, settings & this user's favorites/ratings from the server.
      await loadDb(userId);

      // 2. Resolve visitor IP (2s timeout, best effort).
      let ip = 'unknown';
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await res.json();
        ip = data.ip;
      } catch (e) {
        console.warn('Could not fetch IP, logging as unknown');
      }

      // 3. Security gate + visit logging.
      if (checkIsBlocked(username, ip)) {
        setIsBlocked(true);
      } else {
        logVisit(username, ip, tg?.platform || 'web');
      }

      setDb(getDb());
      setLoading(false);
    };

    init();

    // Click outside handler for language menu
    const handleClickOutside = (event: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(event.target as Node)) {
        setIsLangMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      mql?.removeEventListener?.('change', applyTheme);
      try {
        tg?.offEvent('safeAreaChanged', applyInsets);
        tg?.offEvent('contentSafeAreaChanged', applyInsets);
        tg?.offEvent('themeChanged', applyTheme);
      } catch { /* event unsupported on this Telegram client */ }
    };
  }, [tg]);

  const filteredItems = useMemo(() => {
    // 1. First, filter by permissions (Access Control)
    let availableItems = db.items.filter(item => {
      if (!item.isPrivate) return true;
      if (isAdmin) return true;
      if (db.globalAccess) return true;
      if (user) {
        const isWhitelisted = db.allowedUsers.includes(user.id.toString()) || 
                             (user.username && db.allowedUsers.includes(user.username.toLowerCase()));
        if (isWhitelisted) return true;
      }
      return false;
    });

    // 2. Filter by Content Language
    if (contentLangFilter.length > 0) {
      availableItems = availableItems.filter(item =>
        contentLangFilter.some(l => item.contentLanguages.includes(l))
      );
    }

    // 3. Search filter
    const q = searchQuery.toLowerCase();
    availableItems = availableItems.filter(item => {
      const title = pickText(item.title, lang).toLowerCase();
      const author = item.author.toLowerCase();
      if (searchField === 'title') return title.includes(q);
      if (searchField === 'author') return author.includes(q);
      return title.includes(q) || author.includes(q);
    });

    // 4. Category filter
    if (activeCategory === 'FAVORITES') {
      availableItems = availableItems.filter(item => isFavorited(userId, item.id));
    } else if (activeCategory === 'NEW') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return availableItems
        .filter(item => new Date(item.addedDate) >= thirtyDaysAgo)
        .sort((a, b) => new Date(b.addedDate).getTime() - new Date(a.addedDate).getTime())
        .slice(0, 20);
    } else if (activeCategory === 'HISTORY') {
      const order = new Map(viewHistory.map((id, i) => [id, i]));
      return availableItems
        .filter(item => order.has(item.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    } else if (activeCategory !== 'ALL') {
      availableItems = availableItems.filter(item => item.type === activeCategory);
    }

    // 5. Sorting (FAVORITES / ALL / type sections)
    const sorted = [...availableItems];
    if (sortBy === 'recent') {
      sorted.sort((a, b) => new Date(b.addedDate).getTime() - new Date(a.addedDate).getTime());
    } else if (sortBy === 'rating') {
      sorted.sort((a, b) => getAverageRating(b.id) - getAverageRating(a.id));
    } else if (sortBy === 'views') {
      sorted.sort((a, b) => (b.views || 0) - (a.views || 0));
    } else if (sortBy === 'alpha') {
      sorted.sort((a, b) => pickText(a.title, lang).localeCompare(pickText(b.title, lang)));
    }
    return sorted;
  }, [db.items, db.globalAccess, searchQuery, activeCategory, user, userId, db.allowedUsers, isAdmin, lang, contentLangFilter, searchField, sortBy, viewHistory]);

  // Persist filter state whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('library_filters', JSON.stringify({ searchField, sortBy, contentLangFilter, activeCategory }));
    } catch { /* quota */ }
  }, [searchField, sortBy, contentLangFilter, activeCategory]);

  const selectLang = (l: Locale) => {
    setLang(l);
    setIsLangMenuOpen(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-11 h-11 border-[3px] border-red-100 dark:border-white/10 border-t-red-600 rounded-full animate-spin" />
          <p className="text-sm font-medium text-slate-400 dark:text-slate-500">Loading Library</p>
        </div>
      </div>
    );
  }

  if (isBlocked && !isAdmin) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-10 text-center">
        <div className="p-8 bg-red-600/10 rounded-full mb-6 animate-pulse">
           <ShieldAlert size={64} className="text-red-600" />
        </div>
        <h1 className="text-3xl font-black text-white uppercase tracking-tighter mb-4">{t.accessDenied}</h1>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest max-w-xs leading-relaxed">
          {t.accessDeniedDesc}
        </p>
        <p className="mt-10 text-[9px] font-mono text-slate-700">Code: 403_FORBIDDEN_ENTITY</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-10 font-sans text-slate-900 dark:text-slate-100 overflow-x-hidden bg-white dark:bg-black">
      {/* Precision Lang Switcher Dropdown */}
      <div
        className={`absolute top-0 left-0 right-0 z-[110] pointer-events-none ${
          currentPage === 'home'
            ? 'pt-[calc(6.75rem_+_var(--safe-top))] sm:pt-[calc(3.75rem_+_var(--safe-top))]'
            : 'pt-[calc(1.5rem_+_var(--safe-top))]'
        }`}
        ref={langMenuRef}
      >
        <div className={`flex justify-end ${currentPage === 'home' ? 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-10' : 'px-6'}`}>
        <div className="relative pointer-events-auto">
          <button
            onClick={() => setIsLangMenuOpen(!isLangMenuOpen)}
            className="flex items-center gap-1.5 glass-card px-3.5 py-2 rounded-xl text-xs font-medium uppercase text-red-600 transition-all active:scale-95"
          >
            <Globe size={14} />
            {lang}
            <ChevronDown size={12} className={`transition-transform duration-300 ${isLangMenuOpen ? 'rotate-180' : ''}`} />
          </button>

          {isLangMenuOpen && (
            <div className="absolute right-0 mt-2 w-24 glass-card rounded-xl shadow-card-hover overflow-hidden z-[120] animate-in fade-in zoom-in-95 duration-200">
               {(['en', 'ru', 'es'] as Locale[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => selectLang(l)}
                    className={`w-full text-left px-4 py-2.5 text-xs font-medium uppercase transition-colors hover:bg-red-500/10 hover:text-red-600 ${lang === l ? 'text-red-600 bg-red-500/10' : 'text-slate-500 dark:text-slate-300'}`}
                  >
                    {l}
                  </button>
               ))}
            </div>
          )}
        </div>
        </div>
      </div>

      {currentPage === 'home' && (
        <Home
          items={filteredItems}
          onOpenItem={(item) => { setViewHistory(recordView(item.id)); setSelectedItem(item); setCurrentPage('details'); }}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
          contentLangFilter={contentLangFilter}
          setContentLangFilter={setContentLangFilter}
          searchField={searchField}
          setSearchField={setSearchField}
          sortBy={sortBy}
          setSortBy={setSortBy}
          categories={db.customTypes}
          lang={lang}
          t={t}
          onSecretAdminTrigger={() => setCurrentPage('admin')}
        />
      )}

      {currentPage === 'details' && selectedItem && (
        <ItemDetails 
          item={selectedItem} 
          onBack={() => {setCurrentPage('home'); setSelectedItem(null);}} 
          onRefresh={() => setDb(getDb())}
          lang={lang}
          t={t}
        />
      )}

      {currentPage === 'admin' && (
        <Admin
          onBack={() => setCurrentPage('home')}
          db={db}
          onUpdate={() => setDb(getDb())}
          onLogout={() => {setIsAdmin(false); setCurrentPage('home');}}
          setIsAdmin={setIsAdmin}
          isAdmin={isAdmin}
          lang={lang}
          t={t}
        />
      )}

      {/* Version footer — readers are fixed z-[500] and cover this automatically */}
      <div
        className="fixed bottom-0 right-0 z-10 pointer-events-none px-4"
        style={{ paddingBottom: 'calc(0.375rem + var(--safe-bottom))' }}
      >
        <p className="text-[8px] font-black text-slate-400/50 uppercase tracking-[0.25em]">{t.version}</p>
      </div>
    </div>
  );
};

export default App;
