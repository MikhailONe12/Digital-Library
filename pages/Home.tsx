
import React, { useMemo, useRef, useState } from 'react';
import { MediaItem, Locale, ContentLang, CustomType } from '../types';
import MediaCard from '../components/MediaCard';
import { Search, Heart, Sparkles, SlidersHorizontal, User, Type, Globe, Clock, ArrowUpDown, Star, Flame, ArrowDownAZ, CalendarClock, BookOpen, Tags as TagsIcon, CheckCircle2 } from 'lucide-react';
import { isFavorited, getAverageRating, getProgressPercent, getInProgressItemIds } from '../services/db';
import { pickText } from '../utils';

interface HomeProps {
  items: MediaItem[];
  allItems: MediaItem[]; // Unfiltered — used for the "Continue reading" shelf
  onOpenItem: (item: MediaItem) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  activeCategory: string | 'ALL' | 'FAVORITES' | 'NEW' | 'HISTORY' | 'FINISHED';
  setActiveCategory: (cat: string | 'ALL' | 'FAVORITES' | 'NEW' | 'HISTORY' | 'FINISHED') => void;
  contentLangFilter: ContentLang[];
  setContentLangFilter: (langs: ContentLang[]) => void;
  tagFilter: string[];
  setTagFilter: (tags: string[]) => void;
  searchField: 'all' | 'title' | 'author';
  setSearchField: (f: 'all' | 'title' | 'author') => void;
  sortBy: 'recent' | 'rating' | 'views' | 'alpha';
  setSortBy: (s: 'recent' | 'rating' | 'views' | 'alpha') => void;
  categories: CustomType[];
  lang: Locale;
  t: any;
  onSecretAdminTrigger?: () => void;
}

const Home: React.FC<HomeProps> = ({
  items, allItems, onOpenItem, searchQuery, setSearchQuery, activeCategory, setActiveCategory,
  contentLangFilter, setContentLangFilter, tagFilter, setTagFilter,
  searchField, setSearchField,
  sortBy, setSortBy,
  categories, lang, t, onSecretAdminTrigger
}) => {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  const tg = (window as any).Telegram?.WebApp;
  const userId = tg?.initDataUnsafe?.user?.id?.toString() || 'guest_user';

  // Continue-reading shelf: items with active progress, ordered by % asc so the
  // furthest-from-finished show first (they're more likely to be the active read).
  const continueItems = useMemo(() => {
    const ids = new Set(getInProgressItemIds());
    if (ids.size === 0) return [];
    return allItems
      .filter(i => ids.has(i.id))
      .map(i => ({ item: i, pct: getProgressPercent(i.id) }))
      .sort((a, b) => b.pct - a.pct) // closer to finish first
      .slice(0, 12);
  }, [allItems]);

  // All unique tags across the visible catalog — for the filter chip list.
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of allItems) for (const tag of item.tags || []) if (tag) set.add(tag);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allItems]);

  const toggleTag = (tag: string) => {
    setTagFilter(tagFilter.includes(tag) ? tagFilter.filter(x => x !== tag) : [...tagFilter, tag]);
  };

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
    <div
      className="px-4 sm:px-6 lg:px-10 max-w-7xl mx-auto"
      style={{ paddingTop: 'calc(3rem + var(--safe-top))' }}
    >
      <header className="mb-10 relative select-none">
        <div
          className="flex items-center gap-3.5 mb-2 cursor-pointer active:opacity-70 transition-opacity"
          onMouseDown={handleStart}
          onMouseUp={handleEnd}
          onMouseLeave={handleEnd}
          onTouchStart={handleStart}
          onTouchEnd={handleEnd}
        >
            <img src="/icon.svg" alt="OptionsData" className="w-12 h-12 rounded-2xl shadow-card" />
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight">Options<span className="text-red-600">Data</span></h1>
        </div>
        <p className="text-slate-400 dark:text-slate-500 text-sm font-normal tracking-wide ml-0.5">
            Digital Library
        </p>
      </header>

      <div className="relative mb-6 z-20" role="search">
        <div className="relative group">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-red-600 transition-colors" size={19} aria-hidden="true" />
          <input
            type="text" placeholder={t.search}
            aria-label={t.search}
            className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/[0.08] rounded-2xl py-4 pl-14 pr-14 text-[15px] font-normal text-slate-900 dark:text-white shadow-sm focus:outline-none focus:border-red-500 focus:ring-4 focus:ring-red-500/10 transition-all placeholder:text-slate-400"
            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            onClick={() => setIsFilterOpen(!isFilterOpen)}
            aria-label={t.filters}
            aria-expanded={isFilterOpen}
            className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-2.5 rounded-xl transition-all ${isFilterOpen || contentLangFilter.length > 0 || tagFilter.length > 0 || searchField !== 'all' || sortBy !== 'recent' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-red-600 hover:bg-slate-200/60 dark:hover:bg-white/10'}`}
          >
            <SlidersHorizontal size={18} strokeWidth={2.25} />
          </button>
        </div>

        {/* Expandable Filter Panel */}
        {isFilterOpen && (
           <div className="absolute top-full left-0 right-0 mt-3 glass-card rounded-2xl p-5 shadow-card-hover animate-in slide-in-from-top-4 fade-in duration-300 z-30">
              <div className="space-y-5">
                 {/* Content Language Filter */}
                 <div className="space-y-2.5">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2 ml-0.5">
                       <Globe size={13} /> {t.contentLang}
                    </p>
                    <div className="flex flex-wrap gap-2">
                       {/* ALL button — clears selection */}
                       <button
                         onClick={() => setContentLangFilter([])}
                         className={`px-3.5 py-2 rounded-lg text-xs font-medium transition-all ${contentLangFilter.length === 0 ? 'bg-red-600 text-white' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'}`}
                       >
                         {t.anyLang}
                       </button>
                       {(['en', 'ru', 'es', 'it', 'fr', 'de'] as const).map(l => {
                         const active = contentLangFilter.includes(l);
                         const toggle = () => setContentLangFilter(
                           active ? contentLangFilter.filter(x => x !== l) : [...contentLangFilter, l]
                         );
                         return (
                           <button
                             key={l}
                             onClick={toggle}
                             className={`px-3.5 py-2 rounded-lg text-xs font-medium uppercase transition-all ${active ? 'bg-red-600 text-white' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'}`}
                           >
                             {l}
                           </button>
                         );
                       })}
                    </div>
                 </div>

                 {/* Search Field Filter */}
                 <div className="space-y-2.5">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2 ml-0.5">
                       <Search size={13} /> {t.searchIn}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                        <button
                           onClick={() => setSearchField('all')}
                           className={`flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl text-xs font-medium transition-all ${searchField === 'all' ? 'bg-red-600 text-white' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'}`}
                        >
                           <Sparkles size={15} /> {t.searchAll}
                        </button>
                        <button
                           onClick={() => setSearchField('title')}
                           className={`flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl text-xs font-medium transition-all ${searchField === 'title' ? 'bg-red-600 text-white' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'}`}
                        >
                           <Type size={15} /> {t.searchTitle}
                        </button>
                        <button
                           onClick={() => setSearchField('author')}
                           className={`flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl text-xs font-medium transition-all ${searchField === 'author' ? 'bg-red-600 text-white' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'}`}
                        >
                           <User size={15} /> {t.searchAuthor}
                        </button>
                    </div>
                 </div>

                 {/* Tags */}
                 {availableTags.length > 0 && (
                   <div className="space-y-2.5">
                      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2 ml-0.5">
                         <TagsIcon size={13} /> {t.tags}
                      </p>
                      <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                         {availableTags.map(tag => {
                           const active = tagFilter.includes(tag);
                           return (
                             <button
                               key={tag}
                               onClick={() => toggleTag(tag)}
                               className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${active ? 'bg-red-600 text-white' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'}`}
                             >
                               #{tag}
                             </button>
                           );
                         })}
                      </div>
                   </div>
                 )}

                 {/* Sort */}
                 <div className="space-y-2.5">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2 ml-0.5">
                       <ArrowUpDown size={13} /> {t.sortBy}
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                       {([
                         { key: 'recent', label: t.sortRecent, icon: CalendarClock },
                         { key: 'rating', label: t.sortRating, icon: Star },
                         { key: 'views',  label: t.sortViews,  icon: Flame },
                         { key: 'alpha',  label: t.sortAlpha,  icon: ArrowDownAZ },
                       ] as const).map(({ key, label, icon: Icon }) => (
                          <button
                            key={key}
                            onClick={() => setSortBy(key)}
                            className={`flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl text-xs font-medium transition-all ${sortBy === key ? 'bg-red-600 text-white' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'}`}
                          >
                             <Icon size={15} /> {label}
                          </button>
                       ))}
                    </div>
                 </div>
              </div>
           </div>
        )}
      </div>

      <div className="flex gap-2.5 overflow-x-auto pb-8 mt-4 no-scrollbar scroll-smooth" role="group" aria-label={t.filters}>
        {/* Favorites Button */}
        <button
          onClick={() => setActiveCategory('FAVORITES')}
          className={`flex-shrink-0 w-12 h-10 flex items-center justify-center rounded-xl transition-all duration-200 ${
            activeCategory === 'FAVORITES'
            ? 'bg-red-600 text-white'
            : 'bg-white dark:bg-[#1c1c1e] text-slate-500 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]'
          }`}
          aria-label="Favorites"
          aria-pressed={activeCategory === 'FAVORITES'}
        >
          <Heart size={19} fill={activeCategory === 'FAVORITES' ? 'currentColor' : 'none'} strokeWidth={2.25} />
        </button>

        {/* History Button */}
        <button
          onClick={() => setActiveCategory('HISTORY')}
          className={`flex-shrink-0 w-12 h-10 flex items-center justify-center rounded-xl transition-all duration-200 ${
            activeCategory === 'HISTORY'
            ? 'bg-red-600 text-white'
            : 'bg-white dark:bg-[#1c1c1e] text-slate-500 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]'
          }`}
          aria-label={t.history}
          aria-pressed={activeCategory === 'HISTORY'}
          title={t.history}
        >
          <Clock size={19} strokeWidth={2.25} />
        </button>

        {/* Finished Button — books read to >= 95% */}
        <button
          onClick={() => setActiveCategory('FINISHED')}
          className={`flex-shrink-0 w-12 h-10 flex items-center justify-center rounded-xl transition-all duration-200 ${
            activeCategory === 'FINISHED'
            ? 'bg-green-600 text-white'
            : 'bg-white dark:bg-[#1c1c1e] text-green-600 dark:text-green-400 border border-slate-200 dark:border-white/[0.08]'
          }`}
          aria-label={t.finished}
          aria-pressed={activeCategory === 'FINISHED'}
          title={t.finished}
        >
          <CheckCircle2 size={19} strokeWidth={2.25} />
        </button>

        {/* New Arrivals Button */}
        <button
          onClick={() => setActiveCategory('NEW')}
          className={`flex-shrink-0 flex items-center gap-1.5 px-5 h-10 rounded-xl text-sm font-medium transition-all duration-200 ${
            activeCategory === 'NEW'
            ? 'bg-red-600 text-white'
            : 'bg-white dark:bg-[#1c1c1e] text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]'
          }`}
          aria-pressed={activeCategory === 'NEW'}
        >
          <Sparkles size={16} fill={activeCategory === 'NEW' ? 'currentColor' : 'none'} strokeWidth={2.25} />
          {t.new}
        </button>

        <button
          onClick={() => setActiveCategory('ALL')}
          className={`flex-shrink-0 whitespace-nowrap px-6 h-10 rounded-xl text-sm font-medium transition-all duration-200 ${
            activeCategory === 'ALL'
            ? 'bg-red-600 text-white'
            : 'bg-white dark:bg-[#1c1c1e] text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]'
          }`}
          aria-pressed={activeCategory === 'ALL'}
        >
          {t.all}
        </button>
        {categories.map(cat => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            aria-pressed={activeCategory === cat.id}
            className={`flex-shrink-0 whitespace-nowrap px-6 h-10 rounded-xl text-sm font-medium transition-all duration-200 ${
              activeCategory === cat.id
              ? 'bg-red-600 text-white'
              : 'bg-white dark:bg-[#1c1c1e] text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]'
            }`}
          >
            {cat[lang] || cat.en || cat.id}
          </button>
        ))}
      </div>

      {/* Continue reading shelf — only when not actively filtering / searching */}
      {continueItems.length > 0 && activeCategory === 'ALL' && !searchQuery.trim() && contentLangFilter.length === 0 && tagFilter.length === 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500 mb-4 flex items-center gap-3">
            <BookOpen size={14} className="text-red-600" />
            <span className="w-6 h-[2px] bg-red-600" />
            {t.continueReading}
          </h2>
          <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 sm:-mx-6 lg:-mx-10 px-4 sm:px-6 lg:px-10 no-scrollbar snap-x snap-mandatory">
            {continueItems.map(({ item, pct }) => (
              <button
                key={item.id}
                onClick={() => onOpenItem(item)}
                className="flex-shrink-0 w-44 snap-start text-left bg-white dark:bg-[#1c1c1e] rounded-2xl overflow-hidden border border-slate-200 dark:border-white/[0.08] shadow-card active:scale-[0.97] transition-all hover:shadow-card-hover"
              >
                <div className="aspect-[3/4] relative overflow-hidden bg-slate-100 dark:bg-white/[0.04]">
                  {item.coverUrl && <img src={item.coverUrl} className="w-full h-full object-cover" alt="" />}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                  <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/30">
                    <div className="h-full bg-red-500" style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                  <div className="absolute bottom-2 left-2 right-2">
                    <p className="text-white text-xs font-bold tracking-tight line-clamp-2 drop-shadow">{pickText(item.title, lang)}</p>
                    <p className="text-white/70 text-[10px] mt-0.5">{Math.round(pct)}%</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 sm:gap-6 animate-in fade-in slide-in-from-bottom-5 duration-700">
        {items.map(item => (
          <MediaCard
            key={item.id}
            item={{...item, rating: getAverageRating(item.id)}}
            onClick={() => onOpenItem(item)}
            lang={lang}
            isFavorited={isFavorited(userId, item.id)}
            progress={getProgressPercent(item.id)}
          />
        ))}
      </div>

      {items.length === 0 && (
          <div className="py-24 text-center">
              <div className="inline-flex p-6 bg-slate-100 dark:bg-white/[0.06] rounded-full text-slate-300 dark:text-slate-600 mb-5">
                  {activeCategory === 'FAVORITES' ? <Heart size={36} /> : activeCategory === 'NEW' ? <Sparkles size={36} /> : activeCategory === 'HISTORY' ? <Clock size={36} /> : activeCategory === 'FINISHED' ? <CheckCircle2 size={36} /> : <Search size={36} />}
              </div>
              <p className="text-slate-400 dark:text-slate-500 font-medium text-sm">
                {activeCategory === 'FAVORITES' ? t.noFavoritesYet : activeCategory === 'NEW' ? t.noRecentItems : activeCategory === 'HISTORY' ? t.noHistoryYet : activeCategory === 'FINISHED' ? t.noFinishedYet : t.noResults}
              </p>
          </div>
      )}
    </div>
  );
};

export default Home;
