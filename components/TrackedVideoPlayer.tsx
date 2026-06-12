// Direct video (mp4/webm/ogg/mov) player that persists `currentTime` into
// user_reading_progress every ~5s while playing — same row schema as books
// — so the home "Continue reading" shelf picks up the video automatically
// and MediaCard's progress bar / % badge light up. Also seeds the duration
// cache as soon as metadata is known.

import React, { useEffect, useRef } from 'react';
import { getReadingProgress, saveReadingProgress } from '../services/db';
import { setVideoDuration } from '../services/videoDuration';

interface Props {
  url: string;
  userId: string;
  itemId: string;
  poster?: string;
}

const SAVE_EVERY_MS = 5000;

const TrackedVideoPlayer: React.FC<Props> = ({ url, userId, itemId, poster }) => {
  const ref = useRef<HTMLVideoElement | null>(null);
  const lastSaveRef = useRef<number>(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;

    const save = (force = false) => {
      if (!el || !el.duration) return;
      const now = Date.now();
      if (!force && now - lastSaveRef.current < SAVE_EVERY_MS) return;
      lastSaveRef.current = now;
      saveReadingProgress(userId, itemId, String(Math.floor(el.currentTime)), Math.floor(el.duration), url);
    };

    const onMeta = () => {
      if (!el?.duration) return;
      setVideoDuration(url, el.duration);
    };
    const onTime = () => save(false);
    const onPause = () => save(true);

    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onPause);

    // Restore — wait until duration is known so we never seek past the end.
    getReadingProgress(userId, itemId, url).then(p => {
      if (cancelled || !el) return;
      const t = p ? parseFloat(p.position) : NaN;
      if (!Number.isFinite(t) || t <= 0) return;
      const seek = () => {
        if (!el || !el.duration) return;
        if (t < el.duration - 1) { try { el.currentTime = t; } catch { /* noop */ } }
      };
      if (el.readyState >= 1 && el.duration) seek();
      else el.addEventListener('loadedmetadata', seek, { once: true });
    });

    return () => {
      cancelled = true;
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onPause);
      // Final flush so a closed reader doesn't lose the last few seconds.
      save(true);
    };
  }, [url, userId, itemId]);

  return (
    <video
      ref={ref}
      src={url}
      controls
      preload="metadata"
      className="w-full h-full bg-slate-100"
      poster={poster}
    />
  );
};

export default TrackedVideoPlayer;
