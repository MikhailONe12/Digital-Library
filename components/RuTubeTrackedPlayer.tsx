// RuTube embed wrapped to persist watch position into user_reading_progress.
// RuTube exposes a postMessage API on its iframe: it auto-dispatches
// player:currentTime / player:durationChange / player:playing|paused|ended
// events, and accepts player:getCurrentTime / player:setCurrentTime commands.
// We listen passively and save every 5s while playing — same row schema as
// books, audio, direct video and YouTube, so MediaCard's % badge, progress
// bar and the Continue-reading shelf all light up automatically.

import React, { useEffect, useRef } from 'react';
import { getReadingProgress, saveReadingProgress } from '../services/db';
import { setVideoDuration } from '../services/videoDuration';

interface Props {
  videoId: string;
  url: string;
  userId: string;
  itemId: string;
}

const SAVE_EVERY_MS = 5000;

const RuTubeTrackedPlayer: React.FC<Props> = ({ videoId, url, userId, itemId }) => {
  const ifr = useRef<HTMLIFrameElement | null>(null);
  const durationRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const playingRef = useRef<boolean>(false);
  const lastSaveRef = useRef<number>(0);
  const restoredRef = useRef<boolean>(false);

  useEffect(() => {
    const post = (type: string, data?: any) => {
      const w = ifr.current?.contentWindow;
      if (!w) return;
      try { w.postMessage(data === undefined ? { type } : { type, data }, '*'); } catch { /* noop */ }
    };

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
        if (Number.isFinite(t) && t > 5 && t < durationRef.current - 5) {
          post('player:setCurrentTime', { time: t });
        }
      } catch { /* best-effort */ }
    };

    const onMessage = (e: MessageEvent) => {
      if (!/(^|\.)rutube\.ru$/.test(new URL(e.origin || 'http://x').hostname || '')) {
        if (!String(e.origin || '').includes('rutube.ru')) return;
      }
      let data: any = e.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (!data || typeof data !== 'object') return;
      const type = String(data.type || data.event || '');
      const payload = data.data ?? data.value ?? {};

      if (type === 'player:durationChange' || type === 'player:duration') {
        const d = Number(payload?.duration ?? payload);
        if (Number.isFinite(d) && d > 0) {
          durationRef.current = d;
          setVideoDuration(url, d);
          tryRestore();
        }
      } else if (type === 'player:currentTime' || type === 'player:progress') {
        const t = Number(payload?.time ?? payload?.currentTime ?? payload);
        if (Number.isFinite(t)) timeRef.current = t;
        // Some embeds report duration alongside progress — pick it up too.
        const d = Number(payload?.duration);
        if (Number.isFinite(d) && d > 0) {
          durationRef.current = d;
          setVideoDuration(url, d);
          tryRestore();
        }
      } else if (type === 'player:playing' || type === 'player:play') {
        playingRef.current = true;
      } else if (type === 'player:paused' || type === 'player:pause') {
        playingRef.current = false;
        flush(true);
      } else if (type === 'player:ended') {
        playingRef.current = false;
        flush(true);
      } else if (type === 'player:changeState') {
        const s = String(payload?.state ?? payload ?? '').toLowerCase();
        playingRef.current = s === 'playing' || s === 'play';
        if (!playingRef.current) flush(true);
      }
    };

    // Belt-and-braces poll: if the embed doesn't auto-dispatch currentTime
    // (older builds didn't), pull it ourselves. Cheap — one postMessage per
    // second, ignored by the iframe if it doesn't speak the protocol.
    const tick = window.setInterval(() => {
      post('player:getCurrentTime');
      if (durationRef.current <= 0) post('player:getDuration');
      if (playingRef.current) flush(false);
    }, 1000);

    window.addEventListener('message', onMessage);
    return () => {
      clearInterval(tick);
      window.removeEventListener('message', onMessage);
      flush(true);
    };
  }, [videoId, url, userId, itemId]);

  return (
    <iframe
      ref={ifr}
      width="100%"
      height="100%"
      src={`https://rutube.ru/play/embed/${videoId}`}
      frameBorder="0"
      allowFullScreen
      allow="autoplay; fullscreen; encrypted-media"
    />
  );
};

export default RuTubeTrackedPlayer;
