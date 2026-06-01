import React, { useEffect, useRef, useState } from 'react';
import { MediaItem, Locale } from '../types';
import { pickText, COVER_FALLBACK, handleCoverError, getVideoPoster } from '../utils';
import { getPdfThumbnail } from '../services/pdfThumb';
import { getEpubThumbnail } from '../services/epubThumb';
import { getVideoThumbnail, isDirectVideo } from '../services/videoThumb';

interface CardCoverProps {
  item: MediaItem;
  lang: Locale;
}

const CardCover: React.FC<CardCoverProps> = ({ item, lang }) => {
  const hasCover = !!item.coverUrl && item.coverUrl.trim() !== '';
  // Thumbnail fallback only for public items (private content needs auth headers).
  const formats = item.formats || [];
  const epubFormat = (!hasCover && !item.isPrivate)
    ? formats.find(f => /\.epub$/i.test(f.url || ''))
    : undefined;
  const pdfFormat = (!hasCover && !item.isPrivate)
    ? formats.find(f => /\.(pdf|djvu?)$/i.test(f.url || ''))
    : undefined;

  // YouTube exposes a poster synchronously; direct video files need a frame grab.
  const firstVideoUrl = item.videos?.[0]?.url || item.videoUrl;
  const youtubePoster = !hasCover ? getVideoPoster(firstVideoUrl) : null;
  const directVideoUrl = (!hasCover && !epubFormat && !pdfFormat && !youtubePoster && isDirectVideo(firstVideoUrl))
    ? firstVideoUrl
    : undefined;

  const [thumb, setThumb] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement>(null);

  // Generation logic used to be gated behind an IntersectionObserver to keep
  // bandwidth low on the catalog grid, but it caused blank tiles in
  // horizontal strips (series/author/continue-reading) where the IO root +
  // overflow-x scrolling interact in unreliable ways across browsers. The
  // underlying thumbnailers are already two-layer cached (in-memory + IDB)
  // so on a repeat render they resolve synchronously; on first render the
  // cost is one bounded async task per visible tile. Worth it for reliable
  // covers everywhere.
  useEffect(() => {
    if (hasCover || (!epubFormat && !pdfFormat && !directVideoUrl)) return;
    let cancelled = false;
    if (epubFormat) {
      getEpubThumbnail(epubFormat.url).then(d => {
        if (cancelled) return;
        if (d) { setThumb(d); return; }
        if (pdfFormat) {
          const url = pdfFormat.url.replace(/\.djvu?$/i, '.pdf');
          getPdfThumbnail(url).then(d2 => { if (!cancelled && d2) setThumb(d2); });
        }
      });
    } else if (pdfFormat) {
      const url = pdfFormat.url.replace(/\.djvu?$/i, '.pdf');
      getPdfThumbnail(url).then(d => { if (!cancelled && d) setThumb(d); });
    } else if (directVideoUrl) {
      getVideoThumbnail(directVideoUrl).then(d => { if (!cancelled && d) setThumb(d); });
    }
    return () => { cancelled = true; };
  }, [hasCover, epubFormat?.url, pdfFormat?.url, directVideoUrl]);

  const src = hasCover ? item.coverUrl : (thumb || youtubePoster || COVER_FALLBACK);

  return (
    <img
      ref={ref}
      src={src}
      onError={handleCoverError}
      className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
      alt={pickText(item.title, lang)}
    />
  );
};

export default CardCover;
