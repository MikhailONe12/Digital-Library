// VK Video embed wrapped to opportunistically persist watch position.
// VK's iframe API is poorly documented, so we listen defensively: any
// message from a vk.com / vkvideo.* origin is scanned for numeric
// time / duration / state fields under several common keys. If usable
// fields appear, we save every 5s — same row schema as other media.
// If VK changes its protocol the embed still plays; we just stop saving.

import React, { useEffect, useRef } from 'react';
import { getReadingProgress, saveReadingProgress } from '../services/db';
import { setVideoDuration } from '../services/videoDuration';

interface Props {
  src: string; // embed URL — what the <iframe> actually points at
  url: string; // canonical URL used as the format_url progress key
  userId: string;
  itemId: string;
}

const SAVE_EVERY_MS = 5000;
const VK_ORIGIN_RE = /\bvk(?:video)?\.(?:com|ru)$/i;

const pickNumber = (...vals: any[]): number | null => {
  for (const v of vals) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
};

const VKTrackedPlayer: React.FC<Props> = ({ src, url, userId, itemId }) => {
  const ifr = useRef<HTMLIFrameElement | null>(null);
  const durationRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const playingRef = useRef<boolean>(false);
  const lastSaveRef = useRef<number>(0);
  const restoredRef = useRef<boolean>(false);

  useEffect(() => {
    const flush = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSaveRef.current < SAVE_EVERY_MS) return;
      const t = timeRef.current;
      const d = durationRef.current;
      if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0 || t < 0) return;
      lastSaveRef.current = now;
      saveReadingProgress(userId, itemId, String(Math.floor(t)), Math.floor(d), url);
    };

    const tryRestore = async () => {
      if (restoredRef.current || durationRef.current <= 0) return;
      restoredRef.current = true;
      try {
        const prog = await getReadingProgress(userId, itemId, url);
        const t = prog ? parseFloat(prog.position) : NaN;
        if (!Number.isFinite(t) || t <= 5 || t >= durationRef.current - 5) return;
        const w = ifr.current?.contentWindow;
        if (!w) return;
        // Best-effort seek across the two protocol shapes I've seen in VK
        // embeds. If neither lands, the user just resumes from the start.
        try { w.postMessage({ type: 'method', method: 'seek', value: t }, '*'); } catch { /* noop */ }
        try { w.postMessage({ method: 'seek', value: t }, '*'); } catch { /* noop */ }
      } catch { /* best-effort */ }
    };

    const onMessage = (e: MessageEvent) => {
      const host = (() => { try { return new URL(e.origin).hostname; } catch { return ''; } })();
      if (!VK_ORIGIN_RE.test(host) && !String(e.origin || '').includes('vk')) return;
      let data: any = e.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (!data || typeof data !== 'object') return;

      const v = data.value ?? data.data ?? {};
      const t = pickNumber(data.time, data.currentTime, data.position, data.progress, v?.time, v?.currentTime, v?.position);
      if (t !== null) timeRef.current = t;

      const d = pickNumber(data.duration, v?.duration);
      if (d !== null && d > 0) {
        durationRef.current = d;
        setVideoDuration(url, d);
        tryRestore();
      }

      const stateRaw = data.state ?? v?.state ?? (typeof data.type === 'string' ? data.type : '') ?? (typeof v === 'string' ? v : '');
      const state = String(stateRaw || '').toLowerCase();
      if (state.includes('play') && !state.includes('pause') && !state.includes('un')) playingRef.current = true;
      else if (state.includes('paus') || state.includes('end') || state.includes('stop')) {
        playingRef.current = false;
        flush(true);
      }
    };

    const tick = window.setInterval(() => {
      if (playingRef.current) flush(false);
    }, 1000);

    window.addEventListener('message', onMessage);
    return () => {
      clearInterval(tick);
      window.removeEventListener('message', onMessage);
      flush(true);
    };
  }, [src, url, userId, itemId]);

  return (
    <iframe
      ref={ifr}
      width="100%"
      height="100%"
      src={src}
      frameBorder="0"
      allowFullScreen
      allow="autoplay; fullscreen; encrypted-media"
    />
  );
};

export default VKTrackedPlayer;
