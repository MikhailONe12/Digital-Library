
import React from 'react';
import { MediaItem, Locale } from '../types';
import { TrendingUp, ShieldCheck, Heart } from 'lucide-react';

interface MediaCardProps {
  item: MediaItem;
  onClick: () => void;
  lang: Locale;
  isFavorited?: boolean;
}

const MediaCard: React.FC<MediaCardProps> = ({ item, onClick, lang, isFavorited }) => {
  return (
    <div 
        onClick={onClick} 
        className="group relative bg-white rounded-3xl overflow-hidden border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.03)] active:scale-[0.97] transition-all hover:shadow-[0_15px_35px_rgba(0,0,0,0.06)] hover:border-red-100"
    >
      <div className="aspect-[3/4] relative overflow-hidden">
        <img 
            src={item.coverUrl} 
            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" 
            alt={item.title[lang]} 
        />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-900/60 via-transparent group-hover:from-red-900/40 transition-colors" />
        
        {/* Favorite Indicator */}
        {isFavorited && (
          <div className="absolute bottom-3 right-3 bg-red-600 text-white p-1.5 rounded-full shadow-lg border border-white/20 animate-in zoom-in duration-300">
            <Heart size={10} fill="currentColor" />
          </div>
        )}

        {/* Top-Left Labels Group */}
        <div className="absolute top-3 left-3 flex flex-col gap-1.5 items-start">
          <div className="bg-red-600 text-white text-[7px] font-black uppercase px-2 py-1 rounded-md shadow-lg shadow-red-900/20 tracking-[0.1em]">
              {item.type}
          </div>
          <div className="flex flex-wrap gap-1 max-w-[100px]">
            {item.contentLanguages?.map(l => (
              <div key={l} className="bg-white/80 backdrop-blur-md text-slate-900 text-[6px] font-black uppercase px-1.5 py-0.5 rounded border border-white/40 shadow-sm">
                {l}
              </div>
            ))}
          </div>
        </div>

        {item.isPrivate && (
          <div className="absolute top-3 right-3 bg-white/90 backdrop-blur-md text-red-600 text-[8px] font-black uppercase px-2.5 py-1 rounded-lg border border-red-500/20 flex items-center gap-1 shadow-sm">
            <ShieldCheck size={10} />
            Tier 1
          </div>
        )}
        
        <div className="absolute bottom-4 left-4 right-4">
            <h3 className="text-white text-sm font-black tracking-tight leading-tight line-clamp-2 drop-shadow-sm">
                {item.title[lang] || item.title.en}
            </h3>
        </div>
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
