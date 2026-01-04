
import React, { useState, useEffect, useMemo } from 'react';
import { getDb, isFavorited } from './services/db';
import { MediaItem, Locale } from './types';
import { translations } from './translations';
import Home from './pages/Home';
import Admin from './pages/Admin';
import ItemDetails from './pages/ItemDetails';
import { Layout, Globe } from 'lucide-react';

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<'home' | 'admin' | 'details'>('home');
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [db, setDb] = useState(getDb());
  const [lang, setLang] = useState<Locale>(db.defaultLanguage);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | 'ALL' | 'FAVORITES'>('ALL');

  const t = translations[lang];

  const tg = (window as any).Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;
  const userId = user?.id?.toString() || 'guest_user';

  useEffect(() => {
    if (tg) {
      tg.expand();
      tg.ready();
      document.body.style.backgroundColor = '#f8fafc';
    }

    // Секретный вход через URL: ?admin=true
    const params = new URLSearchParams(window.location.search);
    if (params.get('admin') === 'true' || params.get('admin') === '1') {
      setCurrentPage('admin');
    }
  }, [tg]);

  const filteredItems = useMemo(() => {
    const availableItems = db.items.filter(item => {
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

    return availableItems.filter(item => {
      const title = item.title[lang] || item.title.en;
      const author = item.author;
      const matchesSearch = title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            author.toLowerCase().includes(searchQuery.toLowerCase());
      
      let matchesCategory = true;
      if (activeCategory === 'FAVORITES') {
        matchesCategory = isFavorited(userId, item.id);
      } else if (activeCategory !== 'ALL') {
        matchesCategory = item.type === activeCategory;
      }

      return matchesSearch && matchesCategory;
    });
  }, [db.items, db.globalAccess, searchQuery, activeCategory, user, userId, db.allowedUsers, isAdmin, lang]);

  const toggleLang = () => {
    const langs: Locale[] = ['en', 'ru', 'es'];
    const next = langs[(langs.indexOf(lang) + 1) % langs.length];
    setLang(next);
  };

  return (
    <div className="min-h-screen pb-10 font-sans text-slate-900 overflow-x-hidden">
      {/* Precision Lang Switcher */}
      <div className="flex justify-end p-6 absolute top-0 right-0 z-[110]">
        <button onClick={toggleLang} className="flex items-center gap-2 bg-white/70 backdrop-blur-md px-4 py-2 rounded-xl border border-slate-200 text-[10px] font-bold uppercase tracking-widest text-red-600 shadow-sm transition-all hover:bg-white active:scale-95">
          <Globe size={14} />
          {lang}
        </button>
      </div>

      {currentPage === 'home' && (
        <Home 
          items={filteredItems}
          onOpenItem={(item) => {setSelectedItem(item); setCurrentPage('details');}}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
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
    </div>
  );
};

export default App;
