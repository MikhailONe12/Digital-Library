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
