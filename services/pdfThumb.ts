import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Renders page 1 of a PDF to a small JPEG data URL, used as a cover fallback.
// Results are cached in-memory per URL; only one render runs per URL at a time.

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export const getPdfThumbnail = (url: string): Promise<string | null> => {
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const job = (async (): Promise<string | null> => {
    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = await resp.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data, wasmUrl: '/wasm/', cMapUrl: '/cmaps/', cMapPacked: true, standardFontDataUrl: '/standard_fonts/', disableFontFace: true }).promise;
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
      cache.set(url, dataUrl);
      doc.destroy();
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
