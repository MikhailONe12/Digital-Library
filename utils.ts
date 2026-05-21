import { Locale, MultilingualText } from './types';

export const pickText = (
  text: MultilingualText | undefined,
  lang: Locale,
  fallback: string = 'Untitled'
): string => {
  if (!text) return fallback;
  return text[lang] || text.ru || text.en || text.es || fallback;
};

export const COVER_FALLBACK =
  'data:image/svg+xml;charset=UTF-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">' +
      '<rect fill="#f1f5f9" width="300" height="400"/>' +
      '<text x="150" y="205" font-family="Inter,Arial,sans-serif" font-size="14" font-weight="900" fill="#94a3b8" text-anchor="middle" letter-spacing="2">NO COVER</text>' +
    '</svg>'
  );

export const handleCoverError = (e: React.SyntheticEvent<HTMLImageElement>) => {
  const img = e.currentTarget;
  if (img.src !== COVER_FALLBACK) img.src = COVER_FALLBACK;
};

export const getYouTubeId = (url: string): string | null => {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/);
  return m ? m[1] : null;
};

// Best-effort cover image derived from a video URL. YouTube exposes a stable
// thumbnail of an early representative frame; other sources fall back to null.
export const getVideoPoster = (videoUrl?: string | null): string | null => {
  const yt = getYouTubeId(videoUrl || '');
  if (yt) return `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
  return null;
};
