import React, { useEffect, useRef, useState } from 'react';
import { MediaItem, Locale } from '../types';
import { pickText, COVER_FALLBACK, handleCoverError, getVideoPoster } from '../utils';
import { getPdfThumbnail } from '../services/pdfThumb';
import { getEpubThumbnail } from '../services/epubThumb';

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

  const [thumb, setThumb] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (hasCover || (!epubFormat && !pdfFormat) || !ref.current) return;
    let cancelled = false;
    const el = ref.current;
    const io = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      if (epubFormat) {
        // Try EPUB cover first (best quality); fall back to PDF page 1
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
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [hasCover, epubFormat, pdfFormat]);

  // Fall back to a video frame (e.g. YouTube) when there's no cover or document thumbnail.
  const videoPoster = !hasCover
    ? getVideoPoster(item.videos?.[0]?.url || item.videoUrl)
    : null;

  const src = hasCover ? item.coverUrl : (thumb || videoPoster || COVER_FALLBACK);

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
