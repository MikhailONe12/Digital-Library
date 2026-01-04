
import React, { useRef } from 'react';
import { MediaItem, Locale } from '../types';
import MediaCard from '../components/MediaCard';
import { Search, TrendingUp, BarChart3, Heart } from 'lucide-react';
import { isFavorited } from '../services/db';

interface HomeProps {
  items: MediaItem[];
  onOpenItem: (item: MediaItem) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  activeCategory: string | 'ALL' | 'FAVORITES';
  setActiveCategory: (cat: string | 'ALL' | 'FAVORITES') => void;
  categories: string[];
  lang: Locale;
  t: any;
  onSecretAdminTrigger?: () => void;
}

const Home: React.FC<HomeProps> = ({ 
  items, onOpenItem, searchQuery, setSearchQuery, activeCategory, setActiveCategory, categories, lang, t, onSecretAdminTrigger 
}) => {
  const timerRef = useRef<number | null>(null);

  const tg = (window as any).Telegram?.WebApp;
  const userId = tg?.initDataUnsafe?.user?.id?.toString() || 'guest_user';

  // Секретный триггер: зажатие логотипа на 2 секунды
  const handleStart = () => {
    timerRef.current = window.setTimeout(() => {
      if (onSecretAdminTrigger) onSecretAdminTrigger();
    }, 2000);
  };

  const handleEnd = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  return (
    <div className="px-5 pt-12">
      <header className="mb-14 relative select-none">
        <div 
          className="flex items-center gap-4 mb-3 cursor-pointer active:opacity-70 transition-opacity"
          onMouseDown={handleStart}
          onMouseUp={handleEnd}
          onMouseLeave={handleEnd}
          onTouchStart={handleStart}
          onTouchEnd={handleEnd}
        >
            <div className="p-3 bg-red-600 rounded-2xl text-white shadow-xl shadow-red-200">
                <BarChart3 size={28} />
            </div>
            <h1 className="text-4xl font-black text-slate-900 tracking-tighter uppercase">Options<span className="text-red-600 font-extrabold italic">HUB</span></h1>
        </div>
        <p className="text-slate-400 text-[11px] uppercase font-black tracking-[0.5em] flex items-center gap-2 ml-1">
            Digital Library <TrendingUp size={14} className="text-red-600" />
        </p>
      </header>

      <div className="relative mb-10 group">
        <Search className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-red-600 transition-colors" size={20} />
        <input 
          type="text" placeholder={t.search} 
          className="w-full bg-white border border-slate-200 rounded-[2rem] py-6 pl-16 pr-6 text-sm font-medium shadow-sm focus:outline-none focus:ring-8 focus:ring-red-500/5 focus:border-red-600 transition-all placeholder:text-slate-300"
          value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="flex gap-3 overflow-x-auto pb-10 no-scrollbar scroll-smooth">
        {/* Favorites Button */}
        <button 
          onClick={() => setActiveCategory('FAVORITES')} 
          className={`flex-shrink-0 w-14 h-14 flex items-center justify-center rounded-2xl transition-all duration-300 ${
            activeCategory === 'FAVORITES' 
            ? 'bg-red-600 text-white shadow-[0_15px_30px_rgba(220,38,38,0.25)]' 
            : 'bg-white text-red-600 border border-slate-200 hover:border-red-200'
          }`}
          aria-label="Favorites"
        >
          <Heart size={20} fill={activeCategory === 'FAVORITES' ? 'currentColor' : 'none'} strokeWidth={3} />
        </button>

        <button 
          onClick={() => setActiveCategory('ALL')} 
          className={`whitespace-nowrap px-10 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all duration-300 ${
            activeCategory === 'ALL' 
            ? 'bg-red-600 text-white shadow-[0_15px_30px_rgba(220,38,38,0.25)]' 
            : 'bg-white text-slate-500 border border-slate-200 hover:border-red-200'
          }`}
        >
          {t.all}
        </button>
        {categories.map(cat => (
          <button 
            key={cat} 
            onClick={() => setActiveCategory(cat)} 
            className={`whitespace-nowrap px-10 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all duration-300 ${
              activeCategory === cat 
              ? 'bg-red-600 text-white shadow-[0_15px_30px_rgba(220,38,38,0.25)]' 
              : 'bg-white text-slate-500 border border-slate-200 hover:border-red-200'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-6 animate-in fade-in slide-in-from-bottom-5 duration-700">
        {items.map(item => (
          <MediaCard 
            key={item.id} 
            item={item} 
            onClick={() => onOpenItem(item)} 
            lang={lang} 
            isFavorited={isFavorited(userId, item.id)}
          />
        ))}
      </div>

      {items.length === 0 && (
          <div className="py-24 text-center">
              <div className="inline-flex p-6 bg-slate-100 rounded-full text-slate-300 mb-6">
                  {activeCategory === 'FAVORITES' ? <Heart size={40} /> : <Search size={40} />}
              </div>
              <p className="text-slate-400 font-bold uppercase tracking-widest text-xs">
                {activeCategory === 'FAVORITES' ? 'No favorites yet' : 'No Alpha Found'}
              </p>
          </div>
      )}
    </div>
  );
};

export default Home;
