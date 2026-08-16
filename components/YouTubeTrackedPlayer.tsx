// YouTube embed via the IFrame Player API so we can read getCurrentTime() /
// getDuration() and persist them into user_reading_progress every ~5s while
// playing. Same row shape as direct videos and books, so MediaCard's % badge
// + progress bar + "Continue reading" shelf pick the video up automatically
// — without a Data API key.

import React, { useEffect, useRef } from 'react';
import { getReadingProgress, saveReadingProgress } from '../services/db';
import { setVideoDuration } from '../services/videoDuration';

interface Props {
  videoId: string;
  url: string; // canonical URL used as the format_url progress key
  userId: string;
  itemId: string;
  /**
   * Second a search result points at. It wins over the saved position: the
   * player was opened to hear that moment, not to resume watching.
   */
  startSeconds?: number | null;
}

const YT_API_SRC = 'https://www.youtube.com/iframe_api';
let ytApiPromise: Promise<void> | null = null;

const loadYouTubeApi = (): Promise<void> => {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as any).YT?.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise<void>((resolve) => {
    const w = window as any;
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch { /* noop */ } resolve(); };
    const already = Array.from(document.scripts).some(s => s.src === YT_API_SRC);
    if (!already) {
      const s = document.createElement('script');
      s.src = YT_API_SRC;
      s.async = true;
      document.head.appendChild(s);
    }
  });
  return ytApiPromise;
};

const SAVE_EVERY_MS = 5000;

const YouTubeTrackedPlayer: React.FC<Props> = ({ videoId, url, userId, itemId, startSeconds = null }) => {
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

    loadYouTubeApi().then(() => {
      if (cancelled || !hostRef.current) return;
      const YT = (window as any).YT;
      if (!YT?.Player) return;

      // YT.Player replaces the host element with an <iframe> of its own.
      // It expects an empty div with an id; we create one inside hostRef.
      const target = document.createElement('div');
      target.style.width = '100%';
      target.style.height = '100%';
      hostRef.current.innerHTML = '';
      hostRef.current.appendChild(target);

      playerRef.current = new YT.Player(target, {
        videoId,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, origin: window.location.origin },
        events: {
          onReady: async () => {
            const p = playerRef.current;
            const d = p?.getDuration?.() || 0;
            if (d > 0) setVideoDuration(url, d);
            if (startSeconds && startSeconds > 0) {
              p?.seekTo?.(startSeconds, true);
              p?.playVideo?.();
              return;
            }
            try {
              const prog = await getReadingProgress(userId, itemId, url);
              const t = prog ? parseFloat(prog.position) : NaN;
              if (Number.isFinite(t) && t > 5 && d > 0 && t < d - 5) {
                p?.seekTo?.(t, true);
              }
            } catch { /* best-effort restore */ }
          },
          onStateChange: (e: any) => {
            // 1=playing, 2=paused, 0=ended, 3=buffering, 5=cued
            if (e.data === 1) startPoll();
            else if (e.data === 2 || e.data === 0) stopPoll();
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      flush();
      try { playerRef.current?.destroy?.(); } catch { /* noop */ }
      playerRef.current = null;
    };
  }, [videoId, url, userId, itemId]);

  return <div ref={hostRef} className="w-full h-full" />;
};

export default YouTubeTrackedPlayer;
