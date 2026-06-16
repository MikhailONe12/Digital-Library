
import React, { useState, useEffect, useMemo, useRef, useDeferredValue, Suspense, lazy } from 'react';
import { getDb, loadDb, isFavorited, isInWishlist, checkIsBlocked, logVisit, getAverageRating, recordView, getViewHistory, getProgressPercent } from './services/db';
import { MediaItem, Locale, ContentLang } from './types';
import { translations } from './translations';
import { filterAndSortItems, Scope } from './services/catalog';
import Home from './pages/Home';
import { Globe, ChevronDown, ShieldAlert, ServerCrash, RotateCcw } from 'lucide-react';
import Toaster from './components/Toaster';

// Heavy, rarely-first screens are code-split so the catalog loads fast.
// Admin pulls in recharts; ItemDetails pulls in the PDF/EPUB readers.
const Admin = lazy(() => import('./pages/Admin'));
const ItemDetails = lazy(() => import('./pages/ItemDetails'));

const FullscreenSpinner: React.FC = () => (
  <div className="fixed inset-0 z-[400] bg-white dark:bg-black flex items-center justify-center">
    <div className="w-11 h-11 border-[3px] border-red-100 dark:border-white/10 border-t-red-600 rounded-full animate-spin" />
  </div>
);

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<'home' | 'admin' | 'details'>('home');
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [db, setDb] = useState(getDb());
  const [lang, setLang] = useState<Locale>(db.defaultLanguage);
  const [isBlocked, setIsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Search & Filters State — persisted across sessions
  const _savedFilters = (() => {
    try { return JSON.parse(localStorage.getItem('library_filters') || '{}'); } catch { return {}; }
  })();

  const [searchQuery, setSearchQuery] = useState('');
  // Scope = personal-collection axis, category = content-type axis. They used
  // to be a single `activeCategory` field that smuggled both ideas through
  // one chip row; splitting lets the user pick "Favorites × Videos" naturally.
  // Migration from the legacy LS shape: a stored 'FAVORITES'/'WISHLIST'/
  // 'HISTORY'/'FINISHED' becomes the new scope; a stored type id becomes the
  // category; 'NEW' silently maps to (LIBRARY, ALL) because new-arrivals is
  // now a Home shelf, not a saved filter.
  const _initialScope: Scope = (() => {
    if (_savedFilters.scope) return _savedFilters.scope;
    const legacy = _savedFilters.activeCategory;
    if (legacy === 'FAVORITES' || legacy === 'WISHLIST' || legacy === 'HISTORY' || legacy === 'FINISHED') return legacy;
    return 'LIBRARY';
  })();
  const _initialCategory: string = (() => {
    // One-time reset: the Home was restructured (type chips → section shelves),
    // so the default landing view is now the shelves Home (category ''). Anyone
    // whose last session persisted a grid view ('ALL' or a type id) is reset
    // once so they actually see the new layout instead of an opaque flat grid.
    if (!localStorage.getItem('home_shelves_v2')) {
      try { localStorage.setItem('home_shelves_v2', '1'); } catch {}
      return '';
    }
    // Empty string is the "no chip selected, show shelves only" default;
    // 'ALL' means the user has explicitly opened the catalog grid via the
    // "Все" chip. Custom type ids ('BOOK' etc.) flow through unchanged.
    if (typeof _savedFilters.category === 'string') return _savedFilters.category;
    const legacy = _savedFilters.activeCategory;
    if (!legacy || ['ALL', 'FAVORITES', 'WISHLIST', 'HISTORY', 'FINISHED', 'NEW'].includes(legacy)) return '';
    return legacy;
  })();
  const [scope, setScope] = useState<Scope>(_initialScope);
  const [category, setCategory] = useState<string>(_initialCategory);
  const [contentLangFilter, setContentLangFilter] = useState<ContentLang[]>(
    _savedFilters.contentLangFilter || [],
  );
  const [tagFilter, setTagFilter] = useState<string[]>(_savedFilters.tagFilter || []);
  const [searchField, setSearchField] = useState<'all' | 'title' | 'author'>(
    _savedFilters.searchField || 'all',
  );
  const [sortBy, setSortBy] = useState<'recent' | 'rating' | 'views' | 'alpha'>(
    _savedFilters.sortBy || 'recent',
  );
  const [viewHistory, setViewHistory] = useState<string[]>(getViewHistory());
  
  const [isLangMenuOpen, setIsLangMenuOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);
  // #30 — Deep-link target captured before the catalogue is loaded; resolved
  // by an effect once db.items is populated. Avoids racing the loadDb fetch.
  const pendingDeepLinkRef = useRef<{ kind: 'item'; id: string } | null>(null);

  const t = translations[lang];

  const tg = (window as any).Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;
  const userId = user?.id?.toString() || 'guest_user';
  const username = user?.username || 'guest';

  // Loads the catalog and runs the security/visit-log step. Distinguishes a
  // hard load failure (→ retry screen) from a genuinely empty catalog.
  const loadData = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      await loadDb(userId);
    } catch {
      setLoadError(true);
      setLoading(false);
      return;
    }

    let ip = 'unknown';
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      ip = data.ip;
    } catch {
      console.warn('Could not fetch IP, logging as unknown');
    }

    if (checkIsBlocked(username, ip)) {
      setIsBlocked(true);
    } else {
      logVisit(username, ip, tg?.platform || 'web');
    }

    setDb(getDb());
    setLoading(false);
  };

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

    // #30 — Deep-link routing. Pre-existing URL → state on first paint, then
    // a popstate listener keeps the back/forward buttons honest. Routes are
    // intentionally simple so we don't pull in react-router:
    //   /                  → home
    //   /admin             → admin (also legacy ?admin=true)
    //   /item/:id          → details for the given catalogue id
    //   /?tag=X / ?author=X / ?q=X → home with filter pre-applied
    const params = new URLSearchParams(window.location.search);
    const path = window.location.pathname;
    if (path === '/admin' || params.get('admin') === 'true' || params.get('admin') === '1') {
      setCurrentPage('admin');
    } else {
      const m = path.match(/^\/item\/([a-zA-Z0-9_-]+)\/?$/);
      if (m) {
        // selectedItem gets resolved once the catalogue loads — see effect below.
        pendingDeepLinkRef.current = { kind: 'item', id: m[1] };
      } else {
        // Apply home-page filter pre-fills.
        const tag    = params.get('tag');
        const author = params.get('author');
        const q      = params.get('q');
        if (tag)    { setTagFilter([tag]); }
        if (author) { setSearchField('author'); setSearchQuery(author); }
        if (q)      { setSearchQuery(q); }
      }
    }

    loadData();

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

  // Defer the search term so typing stays responsive on large catalogs.
  const deferredSearch = useDeferredValue(searchQuery);

  const filteredItems = useMemo(() => filterAndSortItems(db.items, {
    searchQuery: deferredSearch,
    searchField,
    scope,
    category,
    contentLangFilter,
    tagFilter,
    sortBy,
    lang,
    isAdmin,
    globalAccess: db.globalAccess,
    allowedUsers: db.allowedUsers,
    user,
    isFavorite: (id) => isFavorited(userId, id),
    isWishlisted: (id) => isInWishlist(userId, id),
    ratingOf: getAverageRating,
    progressOf: getProgressPercent,
    viewHistory,
  }), [db.items, db.globalAccess, deferredSearch, scope, category, user, userId, db.allowedUsers, isAdmin, lang, contentLangFilter, tagFilter, searchField, sortBy, viewHistory]);

  // Same access-controlled list, but without search / tag / scope / category
  // filters — used by the "Continue reading" and "New arrivals" Home shelves
  // and the tag chip generator.
  const accessibleItems = useMemo(() => filterAndSortItems(db.items, {
    searchQuery: '', searchField: 'all', scope: 'LIBRARY', category: 'ALL',
    contentLangFilter: [], tagFilter: [], sortBy: 'recent', lang, isAdmin,
    globalAccess: db.globalAccess, allowedUsers: db.allowedUsers, user,
    isFavorite: () => false, ratingOf: getAverageRating, viewHistory: [],
  }), [db.items, db.globalAccess, db.allowedUsers, isAdmin, user, lang]);

  // Persist filter state whenever it changes. The legacy `activeCategory`
  // field is no longer written; it lingers in localStorage for one cycle so
  // a downgrade still finds something sensible, then gets overwritten.
  useEffect(() => {
    try {
      localStorage.setItem('library_filters', JSON.stringify({ searchField, sortBy, contentLangFilter, tagFilter, scope, category }));
    } catch { /* quota */ }
  }, [searchField, sortBy, contentLangFilter, tagFilter, scope, category]);

  // Reflect the UI locale on <html lang> for assistive tech and the browser.
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  // #30 — Resolve a deep-link captured before the catalogue was loaded.
  // Runs once items appear in cache; if the id matches an item we navigate
  // into it, otherwise we silently drop the request.
  useEffect(() => {
    if (!pendingDeepLinkRef.current || db.items.length === 0) return;
    const target = pendingDeepLinkRef.current;
    pendingDeepLinkRef.current = null;
    if (target.kind === 'item') {
      const it = db.items.find(i => i.id === target.id);
      if (it) {
        setViewHistory(recordView(it.id));
        setSelectedItem(it);
        setCurrentPage('details');
      }
    }
  }, [db.items]);

  // #30 — Sync browser URL to the current page so deep links can be copied
  // and shared. Replace, not push, on first state setup; subsequent
  // navigations push a new history entry so the back button is meaningful.
  useEffect(() => {
    let path = '/';
    if (currentPage === 'admin') path = '/admin';
    else if (currentPage === 'details' && selectedItem) path = `/item/${encodeURIComponent(selectedItem.id)}`;
    if (window.location.pathname !== path) {
      window.history.pushState({ page: currentPage, id: selectedItem?.id || null }, '', path);
    }
  }, [currentPage, selectedItem]);

  // Back / forward button: read the URL and apply the matching page state.
  useEffect(() => {
    const onPop = () => {
      const path = window.location.pathname;
      if (path === '/admin') {
        setCurrentPage('admin');
        setSelectedItem(null);
      } else {
        const m = path.match(/^\/item\/([a-zA-Z0-9_-]+)\/?$/);
        if (m) {
          const it = db.items.find(i => i.id === m[1]);
          if (it) { setSelectedItem(it); setCurrentPage('details'); return; }
        }
        setCurrentPage('home');
        setSelectedItem(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [db.items]);

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

  if (loadError) {
    return (
      <div className="min-h-screen bg-white dark:bg-black flex flex-col items-center justify-center p-10 text-center">
        <div className="p-6 bg-red-50 dark:bg-red-600/10 rounded-full mb-6">
          <ServerCrash size={48} className="text-red-600" />
        </div>
        <h1 className="text-xl font-black text-slate-900 dark:text-white uppercase tracking-tight mb-3">{t.loadErrorTitle}</h1>
        <p className="text-xs font-bold text-slate-400 max-w-xs leading-relaxed mb-8">{t.loadErrorDesc}</p>
        <button
          onClick={loadData}
          className="flex items-center gap-2 px-6 py-3 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700"
        >
          <RotateCcw size={16} /> {t.retry}
        </button>
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
            aria-label={t.lang}
            aria-haspopup="menu"
            aria-expanded={isLangMenuOpen}
            className="flex items-center gap-1.5 glass-card px-3.5 py-2 rounded-xl text-xs font-medium uppercase text-red-600 transition-all active:scale-95"
          >
            <Globe size={14} aria-hidden="true" />
            {lang}
            <ChevronDown size={12} aria-hidden="true" className={`transition-transform duration-300 ${isLangMenuOpen ? 'rotate-180' : ''}`} />
          </button>

          {isLangMenuOpen && (
            <div role="menu" className="absolute right-0 mt-2 w-24 glass-card rounded-xl shadow-card-hover overflow-hidden z-[120] animate-in fade-in zoom-in-95 duration-200">
               {(['en', 'ru', 'es'] as Locale[]).map((l) => (
                  <button
                    key={l}
                    role="menuitemradio"
                    aria-checked={lang === l}
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
          allItems={accessibleItems}
          onOpenItem={(item) => { setViewHistory(recordView(item.id)); setSelectedItem(item); setCurrentPage('details'); }}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          scope={scope}
          setScope={setScope}
          category={category}
          setCategory={setCategory}
          contentLangFilter={contentLangFilter}
          setContentLangFilter={setContentLangFilter}
          tagFilter={tagFilter}
          setTagFilter={setTagFilter}
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
        <Suspense fallback={<FullscreenSpinner />}>
          <ItemDetails
            item={selectedItem}
            onBack={() => {setCurrentPage('home'); setSelectedItem(null);}}
            onRefresh={() => setDb(getDb())}
            onOpenItem={(it) => { setViewHistory(recordView(it.id)); setSelectedItem(it); }}
            onOpenAuthor={(author) => {
              // Jump back to the catalog with the author filter pre-applied.
              // Clear competing filters so the result list shows everything
              // the author has — not the intersection with current tag/lang/
              // category selections.
              setSearchField('author');
              setSearchQuery(author);
              setScope('LIBRARY');
              setCategory('ALL');
              setContentLangFilter([]);
              setTagFilter([]);
              setSelectedItem(null);
              setCurrentPage('home');
            }}
            onOpenTag={(tag) => {
              // Same "jump home with one filter" pattern as author. Tag filter
              // is AND-matched, so clear search + category + lang to avoid
              // empty result lists.
              setSearchField('all');
              setSearchQuery('');
              setScope('LIBRARY');
              setCategory('ALL');
              setContentLangFilter([]);
              setTagFilter([tag]);
              setSelectedItem(null);
              setCurrentPage('home');
            }}
            lang={lang}
            t={t}
          />
        </Suspense>
      )}

      {currentPage === 'admin' && (
        <Suspense fallback={<FullscreenSpinner />}>
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
        </Suspense>
      )}

      {/* Version footer — readers are fixed z-[500] and cover this automatically */}
      <div
        className="fixed bottom-0 right-0 z-10 pointer-events-none px-4"
        style={{ paddingBottom: 'calc(0.375rem + var(--safe-bottom))' }}
      >
        <p className="text-[8px] font-black text-slate-400/50 uppercase tracking-[0.25em]">{t.version}</p>
      </div>

      <Toaster />
    </div>
  );
};

export default App;
