
import React, { useMemo } from 'react';
import { MediaItem, Locale, ContentLang } from '../types';
import { Star, ShieldCheck, Heart, BookOpen, CheckCircle2 } from 'lucide-react';
import { pickText } from '../utils';
import CardCover from './CardCover';

interface MediaCardProps {
  item: MediaItem;
  onClick: () => void;
  lang: Locale;
  isFavorited?: boolean;
  progress?: number; // 0–100
}

const MediaCard: React.FC<MediaCardProps> = ({ item, onClick, lang, isFavorited, progress }) => {

  const displayedLanguages = useMemo(() => {
    const fileLanguages = item.formats.map(f => f.language).filter((l): l is ContentLang => !!l);
    const globalLanguages = item.contentLanguages || [];
    return Array.from(new Set([...globalLanguages, ...fileLanguages]));
  }, [item]);

  return (
    <div
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
        role="button"
        tabIndex={0}
        aria-label={pickText(item.title, lang)}
        className="group relative bg-white dark:bg-[#1c1c1e] rounded-2xl overflow-hidden border border-slate-200 dark:border-white/[0.08] shadow-card active:scale-[0.97] transition-all duration-300 hover:shadow-card-hover cursor-pointer focus:outline-none focus-visible:ring-4 focus-visible:ring-red-500/40 focus-visible:border-red-500"
    >
      <div className="aspect-[3/4] relative overflow-hidden">
        <CardCover item={item} lang={lang} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/5 to-transparent" />

        {isFavorited && (
          <div className="absolute bottom-3 right-3 bg-red-600 text-white p-1.5 rounded-full shadow-md animate-in zoom-in duration-300">
            <Heart size={11} fill="currentColor" />
          </div>
        )}

        <div className="absolute top-2.5 left-2.5 flex flex-col gap-1.5 items-start">
          <div className="bg-black/35 backdrop-blur-md text-white text-[10px] font-medium capitalize px-2 py-0.5 rounded-md">
              {item.type}
          </div>
          <div className="flex flex-wrap gap-1 max-w-[100px]">
            {displayedLanguages.map(l => (
              <div key={l} className="bg-white/85 backdrop-blur-md text-slate-700 text-[10px] font-medium uppercase px-1.5 py-0.5 rounded">
                {l}
              </div>
            ))}
          </div>
        </div>

        <div className="absolute top-2.5 right-2.5 flex flex-col items-end gap-1.5">
          {item.isPrivate && (
            <div className="bg-black/35 backdrop-blur-md text-white text-[10px] font-medium px-2 py-0.5 rounded-md flex items-center gap-1">
              <ShieldCheck size={11} />
              Tier 1
            </div>
          )}
          {progress != null && progress > 0 && (
            progress >= 95 ? (
              <div className="bg-green-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded-md flex items-center gap-1 shadow-sm">
                <CheckCircle2 size={10} strokeWidth={2.5} />
              </div>
            ) : (
              <div className="bg-red-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded-md flex items-center gap-1 shadow-sm">
                <BookOpen size={10} strokeWidth={2.5} />
                {Math.round(progress)}%
              </div>
            )
          )}
        </div>

        <div className="absolute bottom-3.5 left-3.5 right-3.5">
            <h3 className="text-white text-sm font-semibold tracking-tight leading-snug line-clamp-2 drop-shadow-sm">
                {pickText(item.title, lang)}
            </h3>
        </div>

        {/* Reading progress bar — green when finished (>= 95%), red while in progress */}
        {progress != null && progress > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20">
            <div
              className={`h-full transition-all duration-500 ${progress >= 95 ? 'bg-green-500' : 'bg-red-500'}`}
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        )}
      </div>

      <div className="px-3.5 py-2.5 bg-white dark:bg-[#1c1c1e] flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Star size={12} className="text-amber-400" fill="currentColor" />
          <span className="text-xs text-slate-900 dark:text-slate-100 font-semibold tracking-tight">{item.rating}</span>
        </div>
        <span className="text-xs text-slate-400 dark:text-slate-500 font-normal truncate max-w-[90px]">
            {item.author.split(' ')[0]}
        </span>
      </div>
    </div>
  );
};

export default MediaCard;
