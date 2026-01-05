
import React, { useEffect, useState } from 'react';
import { MediaItem, Locale, FileFormat } from '../types';
import { ArrowLeft, Download, Star, Calendar, User, FileText, Activity, BookOpen, X, Lock, Heart, Globe } from 'lucide-react';
import { trackActivity, toggleFavorite, isFavorited, getUserRating, setUserRating, getAverageRating } from '../services/db';

interface ItemDetailsProps {
  item: MediaItem;
  onBack: () => void;
  onRefresh: () => void;
  lang: Locale;
  t: any;
}

const ItemDetails: React.FC<ItemDetailsProps> = ({ item, onBack, onRefresh, lang, t }) => {
  const [activeReaderUrl, setActiveReaderUrl] = useState<string | null>(null);
  const [userRating, setUserRatingState] = useState(0);
  const [avgRating, setAvgRating] = useState(item.rating);
  
  const tg = (window as any).Telegram?.WebApp;
  const userId = tg?.initDataUnsafe?.user?.id?.toString() || 'guest_user';
  
  const [isFav, setIsFav] = useState(false);

  useEffect(() => {
    trackActivity('view', item.id);
    setIsFav(isFavorited(userId, item.id));
    setUserRatingState(getUserRating(userId, item.id));
    setAvgRating(getAverageRating(item.id));
    onRefresh();
  }, [item.id, userId]);

  const handleToggleFav = () => {
    toggleFavorite(userId, item.id);
    setIsFav(!isFav);
    onRefresh();
  };

  const handleRate = (r: number) => {
    setUserRating(userId, item.id, r);
    setUserRatingState(r);
    // Immediately update average so user sees effect
    setAvgRating(getAverageRating(item.id));
  };

  const getVideoEmbed = (url?: string) => {
    if (!url) return null;
    
    // YouTube
    const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/);
    if (ytMatch) return <iframe width="100%" height="100%" src={`https://www.youtube.com/embed/${ytMatch[1]}`} frameBorder="0" allowFullScreen></iframe>;
    
    // Rutube
    const rtMatch = url.match(/rutube\.ru\/video\/([a-z0-9]+)/i);
    if (rtMatch) return <iframe width="100%" height="100%" src={`https://rutube.ru/play/embed/${rtMatch[1]}`} frameBorder="0" allowFullScreen></iframe>;
    
    // Direct file
    if (/\.(mp4|webm|ogg|mov)$/i.test(url)) {
      return <video src={url} controls className="w-full h-full bg-slate-100" poster={item.coverUrl} />;
    }
    
    return null;
  };

  const videoPlayer = getVideoEmbed(item.videoUrl);

  const handleRead = (format: FileFormat) => {
    if (format.name.toLowerCase().includes('pdf') || format.url.toLowerCase().endsWith('.pdf')) {
      setActiveReaderUrl(format.url);
      trackActivity('view', item.id);
    } else {
      window.open(format.url, '_blank');
    }
  };

  return (
    <div className="relative animate-in fade-in slide-in-from-right-4 duration-500 bg-slate-50 min-h-screen">
      <div className="h-72 w-full relative overflow-hidden">
        <img src={item.coverUrl} className="w-full h-full object-cover blur-3xl opacity-20 scale-150" alt="" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-slate-50" />
        <button 
            onClick={onBack} 
            className="absolute top-10 left-5 p-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 shadow-sm text-slate-900 active:scale-95 transition-all z-20"
        >
            <ArrowLeft size={18} strokeWidth={3} />
        </button>
      </div>

      <div className="px-6 -mt-32 relative z-10 pb-20">
        <div className="flex gap-6 items-start">
          <div className="relative">
              <img src={item.coverUrl} className="w-36 aspect-[3/4] object-cover rounded-[2.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.15)] border-4 border-white" alt="" />
              {/* Favorites Button replaces Activity Icon */}
              <button 
                  onClick={handleToggleFav}
                  className="absolute -bottom-3 -right-3 bg-red-600 text-white p-2.5 rounded-2xl shadow-xl active:scale-90 transition-all hover:bg-red-700 focus:outline-none"
                  aria-label="Toggle Favorite"
              >
                  <Heart size={20} fill={isFav ? "white" : "none"} strokeWidth={isFav ? 0 : 3} />
              </button>
          </div>
          <div className="flex-1 pt-6">
            <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-black uppercase text-red-600 bg-red-50 px-2 py-0.5 rounded-md tracking-widest">{item.type}</span>
            </div>
            <h1 className="text-2xl font-black leading-tight text-slate-900 tracking-tight drop-shadow-sm mb-3">
                {item.title[lang] || item.title.en}
            </h1>
            <div className="flex items-center gap-3 bg-white w-fit px-3 py-1.5 rounded-xl border border-slate-100 shadow-sm">
                <Star size={14} className="text-red-600 fill-red-600" />
                <span className="text-xs font-black text-slate-900 uppercase tracking-tighter">Conviction: {avgRating} / 5</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-6">
          <div className="bg-white/60 backdrop-blur-md p-5 rounded-3xl border border-white shadow-sm">
            <div className="flex items-center gap-3 mb-1">
                <User size={14} className="text-red-600" />
                <p className="text-[9px] uppercase font-black text-slate-400 tracking-widest">{t.author}</p>
            </div>
            <p className="text-sm font-black truncate text-slate-900 tracking-tight">{item.author}</p>
          </div>
          <div className="bg-white/60 backdrop-blur-md p-5 rounded-3xl border border-white shadow-sm">
            <div className="flex items-center gap-3 mb-1">
                <Calendar size={14} className="text-red-600" />
                <p className="text-[9px] uppercase font-black text-slate-400 tracking-widest">{t.published}</p>
            </div>
            <p className="text-sm font-black truncate text-slate-900 tracking-tight">{item.publishedDate}</p>
          </div>
        </div>

        {/* User Rating Section */}
        <div className="bg-white p-5 rounded-[2.5rem] border border-slate-100 shadow-sm mt-4 flex items-center justify-between px-8">
            <p className="text-[10px] uppercase font-black text-slate-400 tracking-widest">{t.rateThis}</p>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button 
                  key={star} 
                  onClick={() => handleRate(star)} 
                  className="focus:outline-none transition-transform active:scale-90 active:rotate-12"
                >
                   <Star 
                     size={22} 
                     className={`transition-colors duration-300 ${star <= userRating ? "text-yellow-400 fill-yellow-400 drop-shadow-sm" : "text-slate-200 fill-slate-50"}`}
                     strokeWidth={star <= userRating ? 0 : 2}
                   />
                </button>
              ))}
            </div>
        </div>

        <div className="mt-8">
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 mb-4 flex items-center gap-3">
              <span className="w-10 h-[2px] bg-red-600"></span>
              {t.about}
          </h2>
          <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm leading-relaxed text-slate-600 text-sm whitespace-pre-line">
            {item.description[lang] || item.description.en}
          </div>
        </div>

        {videoPlayer && (
          <div className="mt-10">
            <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 mb-4 flex items-center gap-3">
              <span className="w-10 h-[2px] bg-red-600"></span>
              {t.preview}
            </h2>
            <div className="aspect-video rounded-[2rem] overflow-hidden border-4 border-white shadow-2xl bg-slate-100 relative group">
              {videoPlayer}
            </div>
          </div>
        )}

        <div className="mt-10">
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 mb-4 flex items-center gap-3">
              <span className="w-10 h-[2px] bg-red-600"></span>
              {t.downloads}
          </h2>
          <div className="space-y-4">
            {item.formats.length > 0 ? item.formats.map(f => {
              // Permission Logic:
              // Global prohibition overrides file permission.
              // If global is allowed, file permission dictates (default to true if undefined).
              const isFileReadAllowed = (item.allowReading !== false) && (f.allowReading !== false);
              const isFileDownloadAllowed = (item.allowDownload !== false) && (f.allowDownload !== false);

              return (
                <div 
                  key={f.id} 
                  className="p-3 bg-white border border-slate-100 rounded-[2.5rem] shadow-[0_4px_20px_rgba(0,0,0,0.02)]"
                >
                  {/* Primary Action Button */}
                  {isFileReadAllowed ? (
                     <button 
                        onClick={() => handleRead(f)}
                        className="w-full bg-red-600 text-white py-4 rounded-[2rem] font-black uppercase tracking-[0.2em] text-[10px] shadow-lg shadow-red-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 mb-4"
                     >
                        <BookOpen size={16} strokeWidth={3} />
                        {t.readOnline}
                     </button>
                  ) : (
                     isFileDownloadAllowed && (
                       <a 
                          href={f.url}
                          download
                          onClick={() => trackActivity('download', item.id)}
                          className="block w-full bg-slate-900 text-white py-4 rounded-[2rem] font-black uppercase tracking-[0.2em] text-[10px] shadow-lg shadow-slate-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 mb-4"
                       >
                          <Download size={16} strokeWidth={3} />
                          Download
                       </a>
                     )
                  )}

                  {/* Metadata Row */}
                  <div className="flex items-center justify-between px-2 pb-1">
                     <div className="flex items-center gap-2">
                        {/* Format Badge (Red style) */}
                        <div className="bg-red-600 text-white px-3 py-1.5 rounded-xl shadow-md shadow-red-100 flex items-center gap-1.5">
                           <FileText size={10} strokeWidth={3} />
                           <span className="text-[9px] font-black uppercase tracking-wider">{f.name || 'FILE'}</span>
                        </div>
                        
                        {/* Language Badge */}
                        {f.language && (
                          <div className="bg-slate-100 text-slate-500 px-3 py-1.5 rounded-xl border border-slate-200 flex items-center gap-1.5">
                              <Globe size={10} strokeWidth={3} />
                              <span className="text-[9px] font-black uppercase tracking-wider">{f.language}</span>
                          </div>
                        )}

                         {/* Size Label */}
                         <span className="text-[9px] font-black text-slate-300 uppercase tracking-wider ml-1">
                            {f.size}
                         </span>
                     </div>

                     {/* Secondary Download Button */}
                     {isFileReadAllowed && isFileDownloadAllowed && (
                        <a 
                           href={f.url} 
                           download 
                           onClick={() => trackActivity('download', item.id)}
                           className="p-2 bg-white text-slate-300 hover:text-red-600 border border-slate-100 rounded-xl transition-all shadow-sm"
                        >
                           <Download size={18} strokeWidth={2.5} />
                        </a>
                     )}
                     
                     {/* Locked Indicator if nothing is allowed */}
                     {!isFileReadAllowed && !isFileDownloadAllowed && (
                        <div className="p-2 text-slate-300">
                           <Lock size={16} strokeWidth={2.5} />
                        </div>
                     )}
                  </div>
                </div>
              );
            }) : (
              <div className="p-10 text-center bg-white rounded-[2rem] border border-dashed border-slate-200 text-slate-400 text-xs font-bold uppercase tracking-widest">
                {t.noDownloads}
              </div>
            )}
          </div>
        </div>
      </div>

      {activeReaderUrl && (
        <div className="fixed inset-0 z-[500] bg-slate-900 flex flex-col animate-in fade-in duration-300">
          <header className="p-5 flex items-center justify-between bg-slate-900 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-600 rounded-lg text-white">
                <BookOpen size={16} />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase text-white/40 tracking-widest leading-none mb-1">Reader Mode</p>
                <p className="text-xs font-black text-white truncate max-w-[200px]">{item.title[lang] || item.title.en}</p>
              </div>
            </div>
            <button 
              onClick={() => setActiveReaderUrl(null)}
              className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl text-white transition-all active:scale-90"
            >
              <X size={20} />
            </button>
          </header>
          <div className="flex-1 bg-slate-800 relative">
            <iframe 
                src={`${activeReaderUrl}#toolbar=0&navpanes=0&scrollbar=0`} 
                className="w-full h-full border-none" 
                title="Document Reader"
            />
          </div>
          <footer className="p-4 bg-slate-900 text-center border-t border-white/5">
             <p className="text-[8px] font-black uppercase text-white/20 tracking-[0.4em]">{t.closeReader}</p>
          </footer>
        </div>
      )}
    </div>
  );
};

export default ItemDetails;
