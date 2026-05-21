import React, { useEffect, useRef, useState } from 'react';
import { MediaItem, Locale } from '../types';
import { pickText, COVER_FALLBACK, handleCoverError } from '../utils';
import { getPdfThumbnail } from '../services/pdfThumb';

interface CardCoverProps {
  item: MediaItem;
  lang: Locale;
}

const CardCover: React.FC<CardCoverProps> = ({ item, lang }) => {
  const hasCover = !!item.coverUrl && item.coverUrl.trim() !== '';
  // Thumbnail fallback only for public items (private content needs auth headers).
  const pdfFormat = (!hasCover && !item.isPrivate)
    ? (item.formats || []).find(f => /\.(pdf|djvu?)$/i.test(f.url || ''))
    : undefined;

  const [thumb, setThumb] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (hasCover || !pdfFormat || !ref.current) return;
    let cancelled = false;
    const el = ref.current;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        io.disconnect();
        const url = pdfFormat.url.replace(/\.djvu?$/i, '.pdf');
        getPdfThumbnail(url).then(d => { if (!cancelled && d) setThumb(d); });
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [hasCover, pdfFormat]);

  const src = hasCover ? item.coverUrl : (thumb || COVER_FALLBACK);

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
