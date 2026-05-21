
import React, { useMemo } from 'react';
import { MediaItem, Locale, ContentLang } from '../types';
import { TrendingUp, ShieldCheck, Heart, BookOpen } from 'lucide-react';
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
        className="group relative bg-white rounded-3xl overflow-hidden border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.03)] active:scale-[0.97] transition-all hover:shadow-[0_15px_35px_rgba(0,0,0,0.06)] hover:border-red-100"
    >
      <div className="aspect-[3/4] relative overflow-hidden">
        <CardCover item={item} lang={lang} />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-900/60 via-transparent group-hover:from-red-900/40 transition-colors" />

        {isFavorited && (
          <div className="absolute bottom-3 right-3 bg-red-600 text-white p-1.5 rounded-full shadow-lg border border-white/20 animate-in zoom-in duration-300">
            <Heart size={10} fill="currentColor" />
          </div>
        )}

        <div className="absolute top-3 left-3 flex flex-col gap-1.5 items-start">
          <div className="bg-red-600 text-white text-[7px] font-black uppercase px-2 py-1 rounded-md shadow-lg shadow-red-900/20 tracking-[0.1em]">
              {item.type}
          </div>
          <div className="flex flex-wrap gap-1 max-w-[100px]">
            {displayedLanguages.map(l => (
              <div key={l} className="bg-white/80 backdrop-blur-md text-slate-900 text-[6px] font-black uppercase px-1.5 py-0.5 rounded border border-white/40 shadow-sm">
                {l}
              </div>
            ))}
          </div>
        </div>

        <div className="absolute top-3 right-3 flex flex-col items-end gap-1.5">
          {item.isPrivate && (
            <div className="bg-white/90 backdrop-blur-md text-red-600 text-[8px] font-black uppercase px-2.5 py-1 rounded-lg border border-red-500/20 flex items-center gap-1 shadow-sm">
              <ShieldCheck size={10} />
              Tier 1
            </div>
          )}
          {progress != null && progress > 0 && (
            <div className="bg-red-600 text-white text-[8px] font-black uppercase px-2 py-1 rounded-lg border border-white/20 flex items-center gap-1 shadow-lg shadow-red-900/20">
              <BookOpen size={9} strokeWidth={3} />
              {Math.min(100, Math.round(progress))}%
            </div>
          )}
        </div>

        <div className="absolute bottom-4 left-4 right-4">
            <h3 className="text-white text-sm font-black tracking-tight leading-tight line-clamp-2 drop-shadow-sm">
                {pickText(item.title, lang)}
            </h3>
        </div>

        {/* Reading progress bar */}
        {progress != null && progress > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20">
            <div
              className="h-full bg-red-500 transition-all duration-500"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        )}
      </div>

      <div className="px-4 py-3 bg-white flex items-center justify-between border-t border-slate-50">
        <div className="flex items-center gap-1.5">
          <div className={`p-1 rounded-md ${item.rating > 4.5 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
              <TrendingUp size={10} />
          </div>
          <span className="text-[11px] text-slate-900 font-extrabold tracking-tight">{item.rating}</span>
        </div>
        <span className="text-[9px] text-slate-400 font-bold truncate max-w-[60px] uppercase tracking-tighter italic">
            {item.author.split(' ')[0]}
        </span>
      </div>
    </div>
  );
};

export default MediaCard;
