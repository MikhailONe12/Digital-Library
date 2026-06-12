// Reads the `duration` field off a direct video file's metadata block and
// caches it. Used by MediaCard to render the YouTube-style MM:SS badge on
// video items. Cheaper than getVideoThumbnail because we never need to seek
// or paint a canvas — only loadedmetadata.
//
// Two-layer cache: in-memory Map (fast hot path) backed by localStorage
// (survives reload, integer is tiny — won't dent the 5 MB quota). YouTube
// URLs return null since the duration would require an API key + quota.

const LS_PREFIX = 'video_dur:';
const memCache = new Map<string, number | null>();
const inflight = new Map<string, Promise<number | null>>();

const readLS = (url: string): number | null => {
  try {
    const v = localStorage.getItem(LS_PREFIX + url);
    if (v === null) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
};

const writeLS = (url: string, sec: number) => {
  try { localStorage.setItem(LS_PREFIX + url, String(sec)); } catch { /* quota / private mode */ }
};

export const getVideoDuration = (url: string): Promise<number | null> => {
  if (!url) return Promise.resolve(null);
  if (memCache.has(url)) return Promise.resolve(memCache.get(url)!);
  const fromLS = readLS(url);
  if (fromLS !== null) { memCache.set(url, fromLS); return Promise.resolve(fromLS); }
  if (inflight.has(url)) return inflight.get(url)!;

  const p = new Promise<number | null>((resolve) => {
    let fetchUrl = url;
    try { const u = new URL(url); fetchUrl = u.pathname + u.search + u.hash; } catch { /* relative */ }

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;

    let done = false;
    const finish = (sec: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { video.removeAttribute('src'); video.load(); } catch { /* noop */ }
      memCache.set(url, sec);
      if (sec !== null) writeLS(url, sec);
      resolve(sec);
    };
    const timer = setTimeout(() => finish(null), 10000);

    video.addEventListener('loadedmetadata', () => {
      const d = video.duration;
      finish(Number.isFinite(d) && d > 0 ? d : null);
    });
    video.addEventListener('error', () => finish(null));
    video.src = fetchUrl;
  }).finally(() => { inflight.delete(url); });

  inflight.set(url, p);
  return p;
};

// Seed the cache from outside (YouTube IFrame API, an open <video> element
// inside the details page, etc.) so MediaCard's duration badge lights up
// for the next render without a second round-trip.
export const setVideoDuration = (url: string, sec: number): void => {
  if (!url || !Number.isFinite(sec) || sec <= 0) return;
  memCache.set(url, sec);
  writeLS(url, sec);
};
