// Twitch VOD player via the official Twitch.Player JS SDK so we can read
// getCurrentTime() / getDuration() and persist progress to user_reading_progress
// every 5s while playing — same row schema as books / audio / direct video /
// YouTube / RuTube. Only VODs are tracked: live channels have no meaningful
// current time, and clips are 30-60s so progress doesn't add value.

import React, { useEffect, useRef } from 'react';
import { getReadingProgress, saveReadingProgress } from '../services/db';
import { setVideoDuration } from '../services/videoDuration';

interface Props {
  videoId: string; // numeric Twitch VOD id
  url: string;
  userId: string;
  itemId: string;
}

const SDK_SRC = 'https://player.twitch.tv/js/embed/v1.js';
let sdkPromise: Promise<void> | null = null;

const loadSdk = (): Promise<void> => {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as any).Twitch?.Player) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve) => {
    const already = Array.from(document.scripts).some(s => s.src === SDK_SRC);
    if (already) { resolve(); return; }
    const s = document.createElement('script');
    s.src = SDK_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => resolve(); // graceful: degrades to no tracking
    document.head.appendChild(s);
  });
  return sdkPromise;
};

const SAVE_EVERY_MS = 5000;

const TwitchTrackedPlayer: React.FC<Props> = ({ videoId, url, userId, itemId }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const pollRef = useRef<number | null>(null);
  const lastSaveRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;

    const flush = () => {
      const p = playerRef.current;
      if (!p?.getCurrentTime || !p?.getDuration) return;
      const t = p.getCurrentTime();
      const d = p.getDuration();
      if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return;
      saveReadingProgress(userId, itemId, String(Math.floor(t)), Math.floor(d), url);
      setVideoDuration(url, d);
    };
    const startPoll = () => {
      if (pollRef.current) return;
      pollRef.current = window.setInterval(() => {
        const now = Date.now();
        if (now - lastSaveRef.current < SAVE_EVERY_MS) return;
        lastSaveRef.current = now;
        flush();
      }, 1000);
    };
    const stopPoll = () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      flush();
    };

    loadSdk().then(() => {
      if (cancelled || !hostRef.current) return;
      const Twitch = (window as any).Twitch;
      if (!Twitch?.Player) return;

      const target = document.createElement('div');
      target.style.width = '100%';
      target.style.height = '100%';
      hostRef.current.innerHTML = '';
      hostRef.current.appendChild(target);

      playerRef.current = new Twitch.Player(target, {
        video: videoId,
        width: '100%',
        height: '100%',
        autoplay: false,
      });
      const E = Twitch.Player;
      playerRef.current.addEventListener(E.READY, async () => {
        const p = playerRef.current;
        const d = p?.getDuration?.() || 0;
        if (d > 0) setVideoDuration(url, d);
        try {
          const prog = await getReadingProgress(userId, itemId, url);
          const t = prog ? parseFloat(prog.position) : NaN;
          if (Number.isFinite(t) && t > 5 && d > 0 && t < d - 5) p.seek?.(t);
        } catch { /* best-effort */ }
      });
      playerRef.current.addEventListener(E.PLAY, startPoll);
      playerRef.current.addEventListener(E.PAUSE, stopPoll);
      playerRef.current.addEventListener(E.ENDED, stopPoll);
    });

    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      flush();
      // Twitch.Player has no public destroy(); clearing the host removes its
      // iframe and disconnects event listeners with it.
      if (hostRef.current) hostRef.current.innerHTML = '';
      playerRef.current = null;
    };
  }, [videoId, url, userId, itemId]);

  return <div ref={hostRef} className="w-full h-full" />;
};

export default TwitchTrackedPlayer;
