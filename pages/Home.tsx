
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MediaItem, Locale, ContentLang, CustomType } from '../types';
import MediaCard from '../components/MediaCard';
import CardCover from '../components/CardCover';
import { Search, Heart, Sparkles, SlidersHorizontal, User, Type, Globe, Clock, ArrowUpDown, Star, Flame, ArrowDownAZ, CalendarClock, BookOpen, Tags as TagsIcon, CheckCircle2, X, BookmarkPlus, Play } from 'lucide-react';
import { isFavorited, isInWishlist, getAverageRating, getProgressPercent, getInProgressItemIds } from '../services/db';
import { pickText, hasVideo } from '../utils';
import { Scope, selectNewArrivals } from '../services/catalog';

interface HomeProps {
  items: MediaItem[];
  allItems: MediaItem[]; // Unfiltered — used for the Continue / New shelves
  onOpenItem: (item: MediaItem) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** Personal collection axis: Library / Favorites / Wishlist / History / Finished. */
  scope: Scope;
  setScope: (s: Scope) => void;
  /** Content type axis: 'ALL' or a custom type id. */
  category: string;
  setCategory: (c: string) => void;
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

// Click-and-drag horizontal scrolling for the Home shelves. Touch already
// works via native swipe; without this, desktop / mouse users have no way to
// move the strip (no-scrollbar hides the scrollbar). Suppresses the
// following click event when the pointer actually moved, so dragging across
// a card doesn't accidentally open it.
const useDragScroll = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;
    let moved = false;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      isDown = true;
      moved = false;
      startX = e.pageX - el.offsetLeft;
      scrollLeft = el.scrollLeft;
      el.style.cursor = 'grabbing';
      // Disable snap-proximity for the duration of the drag so the browser
      // never pulls the scroll back to a card edge mid-motion — that's what
      // made the strip feel like it stutters under the pointer. The class-
      // level `snap-x snap-proximity` re-applies on release, giving the
      // strip a gentle alignment at rest.
      el.style.scrollSnapType = 'none';
      el.style.userSelect = 'none';
    };
    const stop = () => {
      if (!isDown) return;
      isDown = false;
      el.style.cursor = 'grab';
      el.style.scrollSnapType = '';
      el.style.userSelect = '';
    };
    const onMove = (e: MouseEvent) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - el.offsetLeft;
      const walk = x - startX;
      if (Math.abs(walk) > 4) moved = true;
      el.scrollLeft = scrollLeft - walk;
    };
    const onClickCapture = (e: MouseEvent) => {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    };
    el.style.cursor = 'grab';
    el.addEventListener('mousedown', onDown);
    el.addEventListener('mouseleave', stop);
    el.addEventListener('mouseup', stop);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('mouseleave', stop);
      el.removeEventListener('mouseup', stop);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('click', onClickCapture, true);
    };
  }, []);
  return ref;
};

const Home: React.FC<HomeProps> = ({
  items, allItems, onOpenItem, searchQuery, setSearchQuery,
  scope, setScope, category, setCategory,
  contentLangFilter, setContentLangFilter, tagFilter, setTagFilter,
  searchField, setSearchField,
  sortBy, setSortBy,
  categories, lang, t, onSecretAdminTrigger
}) => {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  // Anchor for the "Show all →" link inside the New-arrivals shelf, so the
  // tap lands on the grid even on long screens.
  const gridRef = useRef<HTMLDivElement | null>(null);

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

  // New-arrivals shelf: same idea as Continue reading but pulled from the
  // full accessible catalog so it's stable regardless of the current scope /
  // category — this is the replacement for the old "Новинки" filter chip.
  const newItems = useMemo(() => selectNewArrivals(allItems), [allItems]);

  // Two independent visibility tests now that shelves and the catalog grid
  // live side-by-side. `broadLibrary` = "user isn't drilling into a sub-set"
  // (LIBRARY scope, no search / tag / lang filter). The shelves only make
  // sense in that broad context — for FAVORITES, HISTORY, or a "show me
  // only books" view they'd duplicate the very list the user just asked
  // to narrow. The grid hides only on the pristine Home (broad library +
  // no category chip); the moment "Все" lights up or any other chip is
  // tapped, the grid joins the shelves below them.
  const broadLibrary =
    scope === 'LIBRARY' &&
    !searchQuery.trim() &&
    contentLangFilter.length === 0 &&
    tagFilter.length === 0;
  const showShelves = broadLibrary && (category === '' || category === 'ALL');
  const showGrid = !broadLibrary || !!category;

  // Refs for drag-scrolling each shelf with the mouse (touch already works
  // via the browser's native swipe). Separate refs so dragging one shelf
  // doesn't drag the other.
  const continueScrollRef = useDragScroll();
  const newScrollRef = useDragScroll();

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
            className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/[0.08] rounded-2xl py-4 pl-14 pr-24 text-[15px] font-normal text-slate-900 dark:text-white shadow-sm focus:outline-none focus:border-red-500 focus:ring-4 focus:ring-red-500/10 transition-all placeholder:text-slate-400"
            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
          />
          {/* Clear button — shown only when the query is non-empty so it never
              shifts the layout against the filter pill on the right. */}
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              aria-label={t.clearSearch}
              type="button"
              className="absolute right-14 top-1/2 -translate-y-1/2 p-2 rounded-xl text-slate-400 hover:text-red-600 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
            >
              <X size={16} strokeWidth={2.5} />
            </button>
          )}
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

      {/* Active filter chips — visible representation of every filter that's
          currently constraining the result list, with an X on each so the
          user can drop them individually (or all at once). Replaces the
          previous "invisible filter" UX where landing here from a tag chip
          gave no clue what was filtering and no way to clear it.
          Each chip type:
            • searchField !== 'all' → "Поиск по: Автор/Название"
            • tagFilter[]           → one chip per tag (#tag)
            • contentLangFilter[]   → one chip per lang code
          searchQuery already lives inside the search input above, with its
          own X — so it's not duplicated here. */}
      {(tagFilter.length > 0 || contentLangFilter.length > 0 || searchField !== 'all') && (
        <div className="flex flex-wrap items-center gap-2 mb-6 -mt-2">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mr-1">{t.activeFilters}:</span>

          {searchField !== 'all' && (
            <button
              onClick={() => setSearchField('all')}
              className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300 rounded-lg text-[11px] font-bold border border-red-100 dark:border-red-500/20 hover:bg-red-100 dark:hover:bg-red-500/25 active:scale-95 transition-all"
            >
              {searchField === 'author' ? t.searchAuthor : t.searchTitle}
              <X size={11} strokeWidth={3} />
            </button>
          )}

          {tagFilter.map(tag => (
            <button
              key={`tag-${tag}`}
              onClick={() => setTagFilter(tagFilter.filter(x => x !== tag))}
              className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300 rounded-lg text-[11px] font-bold border border-red-100 dark:border-red-500/20 hover:bg-red-100 dark:hover:bg-red-500/25 active:scale-95 transition-all"
            >
              #{tag}
              <X size={11} strokeWidth={3} />
            </button>
          ))}

          {contentLangFilter.map(l => (
            <button
              key={`lang-${l}`}
              onClick={() => setContentLangFilter(contentLangFilter.filter(x => x !== l))}
              className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300 rounded-lg text-[11px] font-bold border border-red-100 dark:border-red-500/20 hover:bg-red-100 dark:hover:bg-red-500/25 active:scale-95 transition-all uppercase"
            >
              {l}
              <X size={11} strokeWidth={3} />
            </button>
          ))}

          {/* "Clear all" only when there are 2+ filters — for a single chip the
              X on the chip itself is enough, the extra button would be noise. */}
          {(tagFilter.length + contentLangFilter.length + (searchField !== 'all' ? 1 : 0)) > 1 && (
            <button
              onClick={() => { setTagFilter([]); setContentLangFilter([]); setSearchField('all'); }}
              className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors ml-1 underline underline-offset-2"
            >
              {t.clearFilters}
            </button>
          )}
        </div>
      )}

      {/* Scope row — personal-collection axis (which corner of the library
          we're looking at). One job per row: this picks the scope, the row
          below picks the content type. Visually denser than the old icon-
          only chips so it doesn't dominate the header. */}
      <div className="flex gap-2 overflow-x-auto pb-3 mt-4 no-scrollbar scroll-smooth" role="tablist" aria-label={t.scopeLibrary}>
        {([
          { key: 'LIBRARY',   label: t.scopeLibrary, icon: BookOpen,     activeBg: 'bg-red-600',   activeText: 'text-white' },
          { key: 'FAVORITES', label: t.favorites,    icon: Heart,        activeBg: 'bg-red-600',   activeText: 'text-white' },
          { key: 'WISHLIST',  label: t.wishlist,     icon: BookmarkPlus, activeBg: 'bg-red-600',   activeText: 'text-white' },
          { key: 'HISTORY',   label: t.history,      icon: Clock,        activeBg: 'bg-red-600',   activeText: 'text-white' },
          { key: 'FINISHED',  label: t.finished,     icon: CheckCircle2, activeBg: 'bg-green-600', activeText: 'text-white' },
        ] as const).map(({ key, label, icon: Icon, activeBg, activeText }) => {
          const active = scope === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              onClick={() => setScope(key)}
              className={`flex-shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl text-[13px] font-semibold transition-all duration-200 ${
                active
                  ? `${activeBg} ${activeText}`
                  : 'bg-white dark:bg-[#1c1c1e] text-slate-500 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]'
              }`}
            >
              <Icon size={15} strokeWidth={2.25} fill={active && (key === 'FAVORITES' || key === 'WISHLIST') ? 'currentColor' : 'none'} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Category row — content-type axis. Pure type filter; no personal-
          collection chips here any more, and no NEW (that's now a shelf).
          The "Все" chip now toggles between the shelves-only Home (no chip)
          and the full catalog grid (chip on) — the same affordance the
          New-arrivals shelf's "Show all →" routes through. */}
      <div className="flex gap-2.5 overflow-x-auto pb-8 mt-1 no-scrollbar scroll-smooth" role="group" aria-label={t.filters}>
        <button
          onClick={() => setCategory(category === 'ALL' ? '' : 'ALL')}
          className={`flex-shrink-0 whitespace-nowrap px-6 h-10 rounded-xl text-sm font-medium transition-all duration-200 ${
            category === 'ALL'
            ? 'bg-red-600 text-white'
            : 'bg-white dark:bg-[#1c1c1e] text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]'
          }`}
          aria-pressed={category === 'ALL'}
        >
          {t.all}
        </button>
        {categories.map(cat => (
          <button
            key={cat.id}
            onClick={() => setCategory(cat.id)}
            aria-pressed={category === cat.id}
            className={`flex-shrink-0 whitespace-nowrap px-6 h-10 rounded-xl text-sm font-medium transition-all duration-200 ${
              category === cat.id
              ? 'bg-red-600 text-white'
              : 'bg-white dark:bg-[#1c1c1e] text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]'
            }`}
          >
            {cat[lang] || cat.en || cat.id}
          </button>
        ))}
      </div>

      {/* Continue reading shelf — default view only */}
      {continueItems.length > 0 && showShelves && (
        <div className="mb-8">
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500 mb-4 flex items-center gap-3">
            <BookOpen size={14} className="text-red-600" />
            <span className="w-6 h-[2px] bg-red-600" />
            {t.continueReading}
          </h2>
          <div
            ref={continueScrollRef}
            className="flex gap-3 overflow-x-auto pb-3 no-scrollbar snap-x snap-proximity"
          >
            {continueItems.map(({ item, pct }) => (
              <button
                key={item.id}
                onClick={() => onOpenItem(item)}
                className="flex-shrink-0 w-44 snap-start text-left bg-white dark:bg-[#1c1c1e] rounded-2xl overflow-hidden active:scale-[0.97] transition-all"
              >
                <div className="aspect-[3/4] relative overflow-hidden bg-slate-100 dark:bg-white/[0.04] group">
                  {/* CardCover lazily derives a thumbnail from the first PDF/EPUB
                      page or video frame when no coverUrl is set — same as the
                      main grid, so the shelf no longer shows blank tiles. */}
                  <div className="absolute inset-0"><CardCover item={item} lang={lang} /></div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                  {/* Centred play badge — same affordance the main grid uses
                      for video items; without it a paused mid-watch video
                      looks like a book tile that just happens to have a
                      progress bar. */}
                  {hasVideo(item) && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-10 h-10 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center shadow-lg ring-1 ring-white/10">
                        <Play size={16} className="text-white ml-0.5" fill="currentColor" strokeWidth={0} />
                      </div>
                    </div>
                  )}
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

      {/* New-arrivals shelf — replaces the old NEW filter chip. "Show all →"
          flips the sort to recent and scrolls to the grid, which is the
          deep-dive escape hatch for users with a lot of recent imports.
          The link sits next to the title (not flushed right with ml-auto)
          so the heading row stays the same visual width as Continue and
          doesn't stretch to the viewport edge on wide screens. */}
      {newItems.length > 0 && showShelves && (
        <div className="mb-8">
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500 mb-4 flex items-center gap-3">
            <Sparkles size={14} className="text-red-600" />
            <span className="w-6 h-[2px] bg-red-600" />
            <span>{t.new}</span>
            <button
              onClick={() => {
                // Activate the "Все" chip — that's what brings the catalog
                // grid into view; sortBy stays at whatever the user picked
                // (already 'recent' by default, so new arrivals lead).
                setCategory('ALL');
                setSortBy('recent');
                // After the chip activates and the grid mounts, scroll to it.
                // setTimeout so the layout has run before we measure.
                setTimeout(() => gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
              }}
              className="inline-flex items-center gap-1 text-[10px] font-bold tracking-widest text-red-600 dark:text-red-400 hover:underline normal-case"
            >
              {t.showAll} →
            </button>
          </h2>
          <div
            ref={newScrollRef}
            className="flex gap-3 overflow-x-auto pb-3 no-scrollbar snap-x snap-proximity"
          >
            {newItems.map(item => (
              <button
                key={item.id}
                onClick={() => onOpenItem(item)}
                className="flex-shrink-0 w-44 snap-start text-left bg-white dark:bg-[#1c1c1e] rounded-2xl overflow-hidden active:scale-[0.97] transition-all"
              >
                <div className="aspect-[3/4] relative overflow-hidden bg-slate-100 dark:bg-white/[0.04]">
                  <div className="absolute inset-0"><CardCover item={item} lang={lang} /></div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                  {/* Centred play badge — matches the main grid's video cue
                      so the shelf doesn't disguise videos as books. */}
                  {hasVideo(item) && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-10 h-10 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center shadow-lg ring-1 ring-white/10">
                        <Play size={16} className="text-white ml-0.5" fill="currentColor" strokeWidth={0} />
                      </div>
                    </div>
                  )}
                  <div className="absolute top-2 left-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-600 text-white text-[9px] font-black uppercase tracking-widest">
                    <Sparkles size={9} fill="currentColor" strokeWidth={2.5} /> {t.new}
                  </div>
                  <div className="absolute bottom-2 left-2 right-2">
                    <p className="text-white text-xs font-bold tracking-tight line-clamp-2 drop-shadow">{pickText(item.title, lang)}</p>
                    {item.author && <p className="text-white/70 text-[10px] mt-0.5 line-clamp-1">{item.author}</p>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Catalog grid + empty state — only when the user has explicitly opted
          in (picked the "Все" chip, a specific type, a non-Library scope, or
          typed into search / filters). On the default Home the page ends at
          the shelves above; the grid would just duplicate everything shown
          there in a less navigable form. */}
      {showGrid && (
        <>
          <div ref={gridRef} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 sm:gap-6 animate-in fade-in slide-in-from-bottom-5 duration-700">
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
                {scope === 'FAVORITES' ? <Heart size={36} /> : scope === 'WISHLIST' ? <BookmarkPlus size={36} /> : scope === 'HISTORY' ? <Clock size={36} /> : scope === 'FINISHED' ? <CheckCircle2 size={36} /> : <Search size={36} />}
              </div>
              <p className="text-slate-400 dark:text-slate-500 font-medium text-sm">
                {scope === 'FAVORITES' ? t.noFavoritesYet : scope === 'WISHLIST' ? t.noWishlistYet : scope === 'HISTORY' ? t.noHistoryYet : scope === 'FINISHED' ? t.noFinishedYet : t.noResults}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Home;
