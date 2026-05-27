import { thumbCacheGet, thumbCacheSet } from './thumbCache';

// Extracts the cover image from an EPUB and returns it as a data URL.
// Two-layer cache: in-memory Map backed by IndexedDB (survives reload).

const memCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export const getEpubThumbnail = (url: string): Promise<string | null> => {
  if (memCache.has(url)) return Promise.resolve(memCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const p = (async (): Promise<string | null> => {
    // Check IDB before fetching the whole file
    const cached = await thumbCacheGet(url);
    if (cached) { memCache.set(url, cached); return cached; }

    try {
      let fetchUrl = url;
      try {
        const parsed = new URL(url);
        fetchUrl = parsed.pathname + parsed.search + parsed.hash;
      } catch { /* already relative */ }

      const resp = await fetch(fetchUrl);
      if (!resp.ok) return null;
      const data = await resp.arrayBuffer();

      // @ts-ignore — load epubjs on demand so it stays out of the initial bundle
      const ePub = (await import('epubjs')).default;
      const book = ePub(data);
      const coverUrl: string | null = await (book.coverUrl() as Promise<string | null>);
      if (!coverUrl) { book.destroy(); return null; }

      // Convert object-URL → stable dataURL for caching
      const blobResp = await fetch(coverUrl);
      const blob = await blobResp.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      book.destroy();
      memCache.set(url, dataUrl);
      thumbCacheSet(url, dataUrl); // persist async, don't await
      return dataUrl;
    } catch {
      return null;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, p);
  return p;
};
