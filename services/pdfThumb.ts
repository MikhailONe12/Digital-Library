import workerSrc from './pdfWorker?worker&url';
import { thumbCacheGet, thumbCacheSet } from './thumbCache';

// Renders page 1 of a PDF to a small JPEG data URL, used as a cover fallback.
// Two-layer cache: in-memory Map (instant) backed by IndexedDB (survives reload).

const memCache  = new Map<string, string>();
const inflight  = new Map<string, Promise<string | null>>();

export const getPdfThumbnail = (url: string): Promise<string | null> => {
  if (memCache.has(url)) return Promise.resolve(memCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const job = (async (): Promise<string | null> => {
    // Check IDB before fetching the whole file
    const cached = await thumbCacheGet(url);
    if (cached) { memCache.set(url, cached); return cached; }

    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = await resp.arrayBuffer();
      const doc = await pdfjsLib.getDocument({
        data,
        wasmUrl: '/wasm/',
        cMapUrl: '/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/standard_fonts/',
        disableFontFace: true,
      }).promise;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = 300 / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      doc.destroy();
      memCache.set(url, dataUrl);
      thumbCacheSet(url, dataUrl); // persist async, don't await
      return dataUrl;
    } catch (e) {
      console.warn('pdf thumbnail failed:', e);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, job);
  return job;
};
