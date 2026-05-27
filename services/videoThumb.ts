// Captures a representative frame from a directly-playable video file
// (mp4/webm/…) and returns it as a cached data URL, for use as an auto-cover
// when no cover image was uploaded. Same-origin uploads won't taint the canvas;
// cross-origin sources without CORS resolve to null (caught) and fall back.
// Two-layer cache: in-memory Map backed by IndexedDB (survives reload).

import { thumbCacheGet, thumbCacheSet } from './thumbCache';

const memCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

// True if the URL points to a video file we can frame-grab in a <video> element.
export const isDirectVideo = (url?: string | null): boolean =>
  !!url && /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(url);

export const getVideoThumbnail = (url: string): Promise<string | null> => {
  if (!url) return Promise.resolve(null);
  if (memCache.has(url)) return Promise.resolve(memCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const p = (async (): Promise<string | null> => {
    // Check IDB before grabbing a video frame (saves bandwidth on revisit)
    const cached = await thumbCacheGet(url);
    if (cached) { memCache.set(url, cached); return cached; }

    return new Promise<string | null>((resolve) => {
      let fetchUrl = url;
      try { const u = new URL(url); fetchUrl = u.pathname + u.search + u.hash; } catch { /* relative */ }

      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'metadata';
      video.playsInline = true;

      let done = false;
      const finish = (result: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { video.removeAttribute('src'); video.load(); } catch { /* noop */ }
        if (result) {
          memCache.set(url, result);
          thumbCacheSet(url, result); // persist async
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), 15000);

      video.addEventListener('loadedmetadata', () => {
        const t = Math.min(1, (video.duration || 2) * 0.1) || 0.1;
        try { video.currentTime = t; } catch { finish(null); }
      });

      video.addEventListener('seeked', () => {
        try {
          const w = video.videoWidth, h = video.videoHeight;
          if (!w || !h) { finish(null); return; }
          const scale = Math.min(1, 600 / Math.max(w, h));
          const canvas = document.createElement('canvas');
          canvas.width  = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          const ctx = canvas.getContext('2d');
          if (!ctx) { finish(null); return; }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.8));
        } catch { finish(null); }
      });

      video.addEventListener('error', () => finish(null));
      video.src = fetchUrl;
    });
  })().finally(() => { inflight.delete(url); });

  inflight.set(url, p);
  return p;
};
