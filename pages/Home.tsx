
import React, { useRef, useState } from 'react';
import { MediaItem, Locale } from '../types';
import MediaCard from '../components/MediaCard';
import { Search, TrendingUp, BarChart3, Heart, Sparkles, SlidersHorizontal, User, Type, Globe, Check } from 'lucide-react';
import { isFavorited, getAverageRating } from '../services/db';

interface HomeProps {
  items: MediaItem[];
  onOpenItem: (item: MediaItem) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  activeCategory: string | 'ALL' | 'FAVORITES' | 'NEW';
  setActiveCategory: (cat: string | 'ALL' | 'FAVORITES' | 'NEW') => void;
  contentLangFilter: Locale | 'ALL';
  setContentLangFilter: (l: Locale | 'ALL') => void;
  searchField: 'all' | 'title' | 'author';
  setSearchField: (f: 'all' | 'title' | 'author') => void;
  categories: string[];
  lang: Locale;
  t: any;
  onSecretAdminTrigger?: () => void;
}

const Home: React.FC<HomeProps> = ({ 
  items, onOpenItem, searchQuery, setSearchQuery, activeCategory, setActiveCategory, 
  contentLangFilter, setContentLangFilter, searchField, setSearchField,
  categories, lang, t, onSecretAdminTrigger 
}) => {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
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

      <div className="relative mb-6 z-20">
        <div className="relative group">
          <Search className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-red-600 transition-colors" size={20} />
          <input 
            type="text" placeholder={t.search} 
            className="w-full bg-white border border-slate-200 rounded-[2rem] py-6 pl-16 pr-16 text-sm font-medium shadow-sm focus:outline-none focus:ring-8 focus:ring-red-500/5 focus:border-red-600 transition-all placeholder:text-slate-300"
            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button 
            onClick={() => setIsFilterOpen(!isFilterOpen)}
            className={`absolute right-3 top-1/2 -translate-y-1/2 p-3 rounded-full transition-all ${isFilterOpen || contentLangFilter !== 'ALL' || searchField !== 'all' ? 'bg-red-600 text-white shadow-md' : 'text-slate-400 hover:text-red-600 hover:bg-slate-50'}`}
          >
            <SlidersHorizontal size={18} strokeWidth={2.5} />
          </button>
        </div>

        {/* Expandable Filter Panel */}
        {isFilterOpen && (
           <div className="absolute top-full left-0 right-0 mt-4 bg-white/90 backdrop-blur-xl border border-white/50 rounded-[2.5rem] p-6 shadow-[0_20px_50px_rgba(0,0,0,0.1)] animate-in slide-in-from-top-4 fade-in duration-300 z-30">
              <div className="space-y-6">
                 {/* Content Language Filter */}
                 <div className="space-y-3">
                    <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest flex items-center gap-2 ml-1">
                       <Globe size={12} /> {t.contentLang}
                    </p>
                    <div className="flex flex-wrap gap-2">
                       {(['ALL', 'en', 'ru', 'es'] as const).map(l => (
                          <button 
                            key={l}
                            onClick={() => setContentLangFilter(l)}
                            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${contentLangFilter === l ? 'bg-slate-900 text-white shadow-lg' : 'bg-white border border-slate-100 text-slate-400 hover:border-slate-300'}`}
                          >
                             {l === 'ALL' ? t.anyLang : l}
                             {contentLangFilter === l && <Check size={10} strokeWidth={4} />}
                          </button>
                       ))}
                    </div>
                 </div>

                 {/* Search Field Filter */}
                 <div className="space-y-3">
                    <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest flex items-center gap-2 ml-1">
                       <Search size={12} /> {t.searchIn}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                        <button 
                           onClick={() => setSearchField('all')}
                           className={`flex flex-col items-center justify-center gap-1.5 py-3 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all border ${searchField === 'all' ? 'bg-red-50 border-red-200 text-red-600' : 'bg-white border-slate-100 text-slate-400'}`}
                        >
                           <Sparkles size={14} /> {t.searchAll}
                        </button>
                        <button 
                           onClick={() => setSearchField('title')}
                           className={`flex flex-col items-center justify-center gap-1.5 py-3 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all border ${searchField === 'title' ? 'bg-red-50 border-red-200 text-red-600' : 'bg-white border-slate-100 text-slate-400'}`}
                        >
                           <Type size={14} /> {t.searchTitle}
                        </button>
                        <button 
                           onClick={() => setSearchField('author')}
                           className={`flex flex-col items-center justify-center gap-1.5 py-3 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all border ${searchField === 'author' ? 'bg-red-50 border-red-200 text-red-600' : 'bg-white border-slate-100 text-slate-400'}`}
                        >
                           <User size={14} /> {t.searchAuthor}
                        </button>
                    </div>
                 </div>
              </div>
           </div>
        )}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-10 mt-4 no-scrollbar scroll-smooth">
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

        {/* New Arrivals Button */}
        <button 
          onClick={() => setActiveCategory('NEW')} 
          className={`flex-shrink-0 flex items-center gap-2 px-6 h-14 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all duration-300 ${
            activeCategory === 'NEW' 
            ? 'bg-red-600 text-white shadow-[0_15px_30px_rgba(220,38,38,0.25)]' 
            : 'bg-white text-red-600 border border-slate-200 hover:border-red-200'
          }`}
        >
          <Sparkles size={16} fill={activeCategory === 'NEW' ? 'currentColor' : 'none'} strokeWidth={3} />
          {t.new}
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
            item={{...item, rating: getAverageRating(item.id)}} 
            onClick={() => onOpenItem(item)} 
            lang={lang} 
            isFavorited={isFavorited(userId, item.id)}
          />
        ))}
      </div>

      {items.length === 0 && (
          <div className="py-24 text-center">
              <div className="inline-flex p-6 bg-slate-100 rounded-full text-slate-300 mb-6">
                  {activeCategory === 'FAVORITES' ? <Heart size={40} /> : activeCategory === 'NEW' ? <Sparkles size={40} /> : <Search size={40} />}
              </div>
              <p className="text-slate-400 font-bold uppercase tracking-widest text-xs">
                {activeCategory === 'FAVORITES' ? 'No favorites yet' : activeCategory === 'NEW' ? 'No recent drops' : 'No Alpha Found'}
              </p>
          </div>
      )}
    </div>
  );
};

export default Home;
