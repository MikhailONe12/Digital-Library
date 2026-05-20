
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { getDb, loadDb, isFavorited, checkIsBlocked, logVisit } from './services/db';
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

  // Search & Filters State
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | 'ALL' | 'FAVORITES' | 'NEW'>('ALL');
  const [contentLangFilter, setContentLangFilter] = useState<ContentLang[]>([]);
  const [searchField, setSearchField] = useState<'all' | 'title' | 'author'>('all');
  
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

    if (tg) {
      tg.expand();
      tg.ready();
      document.body.style.backgroundColor = '#f8fafc';
      applyInsets();
      // safeAreaChanged/contentSafeAreaChanged exist on Bot API 8.0+; older
      // clients simply never fire them and we keep the env() fallback.
      try {
        tg.onEvent('safeAreaChanged', applyInsets);
        tg.onEvent('contentSafeAreaChanged', applyInsets);
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
      try {
        tg?.offEvent('safeAreaChanged', applyInsets);
        tg?.offEvent('contentSafeAreaChanged', applyInsets);
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

    // 3. Logic for "NEW" category: Filter last 30 days based on ADDED DATE, Sort DESC, Limit 20
    if (activeCategory === 'NEW') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      availableItems = availableItems
        .filter(item => {
           // Use addedDate to track when it arrived in the library
           const addedDate = new Date(item.addedDate); 
           return addedDate >= thirtyDaysAgo;
        })
        .sort((a, b) => new Date(b.addedDate).getTime() - new Date(a.addedDate).getTime())
        .slice(0, 20);
    }

    // 4. Logic for Search and other Categories
    return availableItems.filter(item => {
      const title = pickText(item.title, lang);
      const author = item.author;
      const q = searchQuery.toLowerCase();
      
      let matchesSearch = false;
      if (searchField === 'all') {
        matchesSearch = title.toLowerCase().includes(q) || author.toLowerCase().includes(q);
      } else if (searchField === 'title') {
        matchesSearch = title.toLowerCase().includes(q);
      } else if (searchField === 'author') {
        matchesSearch = author.toLowerCase().includes(q);
      }
      
      let matchesCategory = true;
      if (activeCategory === 'FAVORITES') {
        matchesCategory = isFavorited(userId, item.id);
      } else if (activeCategory === 'NEW') {
        // Already filtered above
        matchesCategory = true; 
      } else if (activeCategory !== 'ALL') {
        matchesCategory = item.type === activeCategory;
      }

      return matchesSearch && matchesCategory;
    });
  }, [db.items, db.globalAccess, searchQuery, activeCategory, user, userId, db.allowedUsers, isAdmin, lang, contentLangFilter, searchField]);

  const selectLang = (l: Locale) => {
    setLang(l);
    setIsLangMenuOpen(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-red-100 border-t-red-600 rounded-full animate-spin" />
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Loading Library</p>
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
    <div className="min-h-screen pb-10 font-sans text-slate-900 overflow-x-hidden bg-[#f8fafc]">
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
            className="flex items-center gap-2 bg-white/70 backdrop-blur-md px-4 py-2 rounded-xl border border-slate-200 text-[10px] font-bold uppercase tracking-widest text-red-600 shadow-sm transition-all hover:bg-white active:scale-95"
          >
            <Globe size={14} />
            {lang}
            <ChevronDown size={12} className={`transition-transform duration-300 ${isLangMenuOpen ? 'rotate-180' : ''}`} />
          </button>

          {isLangMenuOpen && (
            <div className="absolute right-0 mt-2 w-24 bg-white/90 backdrop-blur-xl border border-slate-200 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.1)] overflow-hidden z-[120] animate-in fade-in zoom-in-95 duration-200">
               {(['en', 'ru', 'es'] as Locale[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => selectLang(l)}
                    className={`w-full text-left px-4 py-3 text-[10px] font-black uppercase tracking-widest hover:bg-red-50 hover:text-red-600 transition-colors ${lang === l ? 'text-red-600 bg-red-50/50' : 'text-slate-500'}`}
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
          onOpenItem={(item) => {setSelectedItem(item); setCurrentPage('details');}}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
          contentLangFilter={contentLangFilter}
          setContentLangFilter={setContentLangFilter}
          searchField={searchField}
          setSearchField={setSearchField}
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
