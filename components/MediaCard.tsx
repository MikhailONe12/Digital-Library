
import React, { useEffect, useMemo, useState } from 'react';
import { MediaItem, Locale } from '../types';
import { Star, ShieldCheck, Heart, BookOpen, CheckCircle2, Play, Film, ExternalLink } from 'lucide-react';
import { pickText, hasVideo, getFirstVideoUrl, formatDuration, getDisplayedLanguages, isExternallyHosted } from '../utils';
import { isDirectVideo } from '../services/videoThumb';
import { getVideoDuration } from '../services/videoDuration';
import CardCover from './CardCover';

interface MediaCardProps {
  item: MediaItem;
  onClick: () => void;
  lang: Locale;
  isFavorited?: boolean;
  progress?: number; // 0–100
}

const MediaCard: React.FC<MediaCardProps> = ({ item, onClick, lang, isFavorited, progress }) => {

  const displayedLanguages = useMemo(() => getDisplayedLanguages(item), [item]);

  // Video cues (#1 play overlay, #2 duration badge, #3 red type chip) — visual
  // signal that this item plays instead of reading. Duration is only known
  // for direct files (mp4/webm/…); YouTube would need the Data API, so we
  // gracefully skip the badge there and rely on overlay + red chip alone.
  const isVideo = hasVideo(item);
  const isVideoType = (item.type || '').toLowerCase() === 'video';
  const firstVideoUrl = getFirstVideoUrl(item);
  const directVideoUrl = isVideo && isDirectVideo(firstVideoUrl) ? firstVideoUrl : null;
  const [duration, setDuration] = useState<number | null>(null);
  useEffect(() => {
    if (!directVideoUrl) return;
    let cancelled = false;
    getVideoDuration(directVideoUrl).then(d => { if (!cancelled) setDuration(d); });
    return () => { cancelled = true; };
  }, [directVideoUrl]);

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

        {/* #1 — Centered play-circle overlay. Universal "this is video" signal
            (YouTube / Vimeo / Netflix). pointer-events:none so the parent's
            click target keeps working. */}
        {isVideo && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center shadow-lg ring-1 ring-white/10 transition-transform duration-300 group-hover:scale-110">
              <Play size={20} className="text-white ml-0.5" fill="currentColor" strokeWidth={0} />
            </div>
          </div>
        )}

        <div className="absolute top-2.5 left-2.5 flex flex-col gap-1.5 items-start">
          {/* #3 — Type chip. When admin set this item's type to "video" the
              normally-grey chip turns red and grows a Film icon, so the slot
              that already says "Video" is the one that pops, instead of
              stacking a second chip with the same word next to it. Admin's
              type picker is untouched: detection is purely on the saved id. */}
          <div
            className={`text-white text-[10px] font-medium capitalize px-2 py-0.5 rounded-md flex items-center gap-1 ${
              isVideoType
                ? 'bg-red-600 font-semibold shadow-sm'
                : 'bg-black/35 backdrop-blur-md'
            }`}
          >
            {isVideoType && <Film size={11} strokeWidth={2.5} />}
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
          {/* Hosted elsewhere — tapping through leaves for the source's site.
              Worth signalling before the tap, not only on the detail page. */}
          {isExternallyHosted(item) && (
            <div className="bg-amber-500 text-white text-[10px] font-semibold px-2 py-0.5 rounded-md flex items-center gap-1 shadow-sm">
              <ExternalLink size={10} strokeWidth={3} />
            </div>
          )}
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

        {/* Bottom-right stack: favourite heart on top, #2 duration badge below.
            Shared flex-col so the two never overlap when a video item is also
            favourited. */}
        <div className="absolute bottom-3 right-3 flex flex-col items-end gap-1.5">
          {isFavorited && (
            <div className="bg-red-600 text-white p-1.5 rounded-full shadow-md animate-in zoom-in duration-300">
              <Heart size={11} fill="currentColor" />
            </div>
          )}
          {duration != null && (
            <div className="bg-black/70 backdrop-blur-md text-white text-[10px] font-semibold px-1.5 py-0.5 rounded tabular-nums shadow-sm">
              {formatDuration(duration)}
            </div>
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

      <div className="px-3.5 py-2.5 bg-white dark:bg-[#1c1c1e] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 shrink-0">
          <Star size={12} className="text-amber-400" fill="currentColor" />
          <span className="text-xs text-slate-900 dark:text-slate-100 font-semibold tracking-tight">{item.rating}</span>
        </div>
        {/* Primary author, full name. When the item has co-authors we append
            "+N" so the card signals "this isn't the only author" without
            stealing space from the title row above. */}
        <div className="flex items-center gap-1 min-w-0 justify-end">
          <span className="text-xs text-slate-400 dark:text-slate-500 font-normal truncate">
            {item.authors && item.authors.length ? item.authors[0] : item.author}
          </span>
          {item.authors && item.authors.length > 1 && (
            <span
              className="shrink-0 text-[10px] font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-white/[0.08] px-1.5 py-0.5 rounded-md"
              title={item.authors.slice(1).join(', ')}
            >
              +{item.authors.length - 1}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default MediaCard;
