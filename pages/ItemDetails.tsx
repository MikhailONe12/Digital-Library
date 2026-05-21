
import React, { useEffect, useRef, useState } from 'react';
import { MediaItem, Locale, FileFormat, Bookmark, VideoLink, Annotation, HighlightColor } from '../types';
import {
  ArrowLeft, Download, Star, Calendar, User, FileText, BookOpen, X, Lock, Heart,
  Globe, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, BookmarkPlus, BookMarked,
  Trash2, List, Sun, Moon, SunDim, Highlighter, PenLine,
} from 'lucide-react';
// @ts-ignore
import ePub from 'epubjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  trackActivity, toggleFavorite, isFavorited, getUserRating, setUserRating,
  getAverageRating, getBookmarks, addBookmark, deleteBookmark,
  getReadingProgress, saveReadingProgress,
  getAnnotations, addAnnotation, deleteAnnotation,
} from '../services/db';
import { pickText, handleCoverError } from '../utils';

type ReaderTheme = 'default' | 'night' | 'sepia';

interface TocItem { href: string; label: string; subitems?: TocItem[] }
interface PdfTocItem { title: string; page: number; level: number; }

const HIGHLIGHT_COLORS: Record<HighlightColor, Record<string, string>> = {
  yellow: { fill: '#fbbf24', 'fill-opacity': '0.38' },
  green:  { fill: '#34d399', 'fill-opacity': '0.38' },
  blue:   { fill: '#60a5fa', 'fill-opacity': '0.38' },
  pink:   { fill: '#f472b6', 'fill-opacity': '0.38' },
};

const HIGHLIGHT_COLOR_BG: Record<HighlightColor, string> = {
  yellow: 'bg-yellow-400',
  green:  'bg-green-400',
  blue:   'bg-blue-400',
  pink:   'bg-pink-400',
};

const THEME_KEY   = 'reader_theme';
const FONT_KEY    = 'reader_font_size';

const EPUB_THEMES: Record<ReaderTheme, Record<string, any>> = {
  default: { body: { background: '#ffffff !important', color: '#1e293b !important' } },
  night:   { body: { background: '#0f172a !important', color: '#e2e8f0 !important' }, 'a': { color: '#60a5fa !important' } },
  sepia:   { body: { background: '#f4ecd8 !important', color: '#5b4636 !important' } },
};

const PDF_FILTER: Record<ReaderTheme, string> = {
  default: 'none',
  night:   'invert(0.88) hue-rotate(180deg)',
  sepia:   'sepia(1) brightness(0.95)',
};

const PDF_BG: Record<ReaderTheme, string> = {
  default: 'bg-gray-100',
  night:   'bg-slate-950',
  sepia:   'bg-amber-100',
};

const READER_CHROME: Record<ReaderTheme, { bg: string; border: string; btn: string; text: string; sub: string }> = {
  default: { bg: 'bg-white',     border: 'border-slate-200', btn: 'bg-slate-100 hover:bg-slate-200 text-slate-700', text: 'text-slate-900', sub: 'text-slate-400'     },
  night:   { bg: 'bg-slate-900', border: 'border-white/10',  btn: 'bg-white/10 hover:bg-white/20 text-white',       text: 'text-white',    sub: 'text-white/40'       },
  sepia:   { bg: 'bg-amber-50',  border: 'border-amber-200', btn: 'bg-amber-100 hover:bg-amber-200 text-amber-800', text: 'text-amber-900', sub: 'text-amber-700/60'  },
};

interface ItemDetailsProps {
  item: MediaItem;
  onBack: () => void;
  onRefresh: () => void;
  lang: Locale;
  t: any;
}

const ItemDetails: React.FC<ItemDetailsProps> = ({ item, onBack, onRefresh, lang, t }) => {
  const [activeReaderUrl, setActiveReaderUrl] = useState<string | null>(null);
  const [activeEpubUrl, setActiveEpubUrl]     = useState<string | null>(null);

  // PDF
  const [pdfPage, setPdfPage]             = useState(1);
  const [pdfTotalPages, setPdfTotalPages] = useState(0);
  const [pdfScale, setPdfScale]           = useState(1);
  const [pdfError, setPdfError]           = useState<string | null>(null);
  const pdfTotalPagesRef = useRef(0);

  // EPUB
  const [epubFontSize, setEpubFontSize] = useState<number>(() => {
    const v = localStorage.getItem(FONT_KEY);
    return v ? parseInt(v) : 100;
  });
  const [toc, setToc]         = useState<TocItem[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [epubError, setEpubError]     = useState<string | null>(null);
  const [epubLoading, setEpubLoading] = useState(false);

  // Theme: persisted
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(() => {
    return (localStorage.getItem(THEME_KEY) as ReaderTheme) || 'default';
  });

  // PDF TOC
  const [pdfToc, setPdfToc] = useState<PdfTocItem[]>([]);

  // Bookmarks
  const [bookmarks, setBookmarks]         = useState<Bookmark[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);

  // Annotations
  const [annotations, setAnnotations]         = useState<Annotation[]>([]);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState<{ cfiRange?: string; page?: number; text: string } | null>(null);
  const [draftNote, setDraftNote]             = useState('');
  const [draftColor, setDraftColor]           = useState<HighlightColor>('yellow');

  // Item
  const [userRating, setUserRatingState] = useState(0);
  const [avgRating, setAvgRating]        = useState(item.rating);
  const [isFav, setIsFav]                = useState(false);

  const epubViewerRef     = useRef<HTMLDivElement>(null);
  const renditionRef      = useRef<any>(null);
  const pdfContainerRef   = useRef<HTMLDivElement>(null);
  const pdfDocRef         = useRef<any>(null);
  const pdfRenderTaskRef  = useRef<any>(null);
  const touchStartX       = useRef(0);
  const touchStartY       = useRef(0);

  const tg     = (window as any).Telegram?.WebApp;
  const userId = tg?.initDataUnsafe?.user?.id?.toString() || 'guest_user';

  // Returns x-telegram-init-data header for authenticated file requests
  const tgHeaders = (): Record<string, string> => {
    const initData = tg?.initData || '';
    return initData ? { 'x-telegram-init-data': initData } : {};
  };

  // Rewrites /content/:itemId/:file → /api/file/:itemId/:file for private items
  // so Express can gate the download behind the whitelist check.
  const toProtectedUrl = (url: string): string => {
    try {
      const u = new URL(url, window.location.href);
      const m = u.pathname.match(/^\/content\/([^/]+)\/(.+)$/);
      if (m) return `/api/file/${m[1]}/${m[2]}`;
    } catch { /* already relative or malformed */ }
    return url;
  };

  // Persist theme & font choices
  useEffect(() => { localStorage.setItem(THEME_KEY, readerTheme); }, [readerTheme]);
  useEffect(() => { localStorage.setItem(FONT_KEY, String(epubFontSize)); }, [epubFontSize]);

  useEffect(() => {
    trackActivity('view', item.id);
    setIsFav(isFavorited(userId, item.id));
    setUserRatingState(getUserRating(userId, item.id));
    setAvgRating(getAverageRating(item.id));
    onRefresh();
  }, [item.id, userId]);

  useEffect(() => {
    if (activeReaderUrl || activeEpubUrl) {
      getBookmarks(userId, item.id).then(setBookmarks);
      // PDF annotations load here; EPUB loads them inside the epub effect after display()
      if (activeReaderUrl) getAnnotations(userId, item.id).then(setAnnotations);
    } else {
      setShowBookmarks(false);
      setShowToc(false);
      setShowAnnotations(false);
      setAnnotationDraft(null);
      setBookmarks([]);
      setAnnotations([]);
      setToc([]);
      setPdfToc([]);
    }
  }, [activeReaderUrl, activeEpubUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── EPUB init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeEpubUrl) return;
    setEpubError(null);
    setEpubLoading(true);
    let destroyed = false;
    let book: any = null;
    let timeout: any = null;
    const clearTimer = () => { if (timeout) { clearTimeout(timeout); timeout = null; } };

    (async () => {
      // Fetch the file ourselves. epub.js's own XHR loader has no timeout
      // handling and stalls indefinitely on slow connections; fetch() is
      // reliable and lets us show a spinner instead of a false timeout.
      //
      // The URL stored in the DB is absolute (https://library.../content/...).
      // On iOS Telegram WebApp, fetching an absolute URL can return 404 even
      // though the file exists; converting to a relative path keeps the request
      // same-origin and avoids the issue.
      let fetchUrl = activeEpubUrl;
      try {
        const parsed = new URL(activeEpubUrl);
        fetchUrl = parsed.pathname + parsed.search + parsed.hash;
      } catch { /* activeEpubUrl is already relative — use as-is */ }

      let data: ArrayBuffer;
      try {
        const resp = await fetch(fetchUrl, { headers: item.isPrivate ? tgHeaders() : {} });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        data = await resp.arrayBuffer();
      } catch (e: any) {
        if (!destroyed) {
          setEpubLoading(false);
          setEpubError('Не удалось загрузить EPUB: ' + (e?.message || String(e)));
        }
        return;
      }
      if (destroyed || !epubViewerRef.current) return;

      // Data is in hand — a stall from here on is a real rendering failure,
      // not slow network, so a watchdog is meaningful.
      timeout = setTimeout(() => {
        if (!destroyed) {
          setEpubLoading(false);
          setEpubError('EPUB не удалось отобразить (ошибка читалки).');
        }
      }, 30000);

      try {
        book = ePub(data);
        const rendition = book.renderTo(epubViewerRef.current, {
          width: '100%', height: '100%', spread: 'none',
        });

        // Register all themes upfront
        Object.entries(EPUB_THEMES).forEach(([name, styles]) => {
          rendition.themes.register(name, styles);
        });
        rendition.themes.select(readerTheme);
        rendition.themes.fontSize(epubFontSize + '%');
        renditionRef.current = rendition;

        // Load TOC
        book.loaded.navigation
          .then((nav: any) => { if (!destroyed) setToc(nav?.toc || []); })
          .catch(() => { /* TOC is optional */ });

        // Save progress on every navigation
        rendition.on('relocated', (location: any) => {
          const cfi = location?.start?.cfi;
          const pct = Math.round((location?.start?.percentage || 0) * 100);
          if (cfi) saveReadingProgress(userId, item.id, cfi, pct, activeEpubUrl);
        });

        // Capture text selection → open annotation sheet
        rendition.on('selected', (cfiRange: string, contents: any) => {
          const selectedText = contents?.window?.getSelection()?.toString().trim() || '';
          if (!selectedText) return;
          setAnnotationDraft({ cfiRange, text: selectedText });
          setDraftNote('');
          setDraftColor('yellow');
        });

        // Swipe gestures (touches inside the epub iframe bubble up through rendition events)
        rendition.on('touchstart', (ev: TouchEvent) => {
          touchStartX.current = ev.changedTouches[0].clientX;
          touchStartY.current = ev.changedTouches[0].clientY;
        });
        rendition.on('touchend', (ev: TouchEvent) => {
          const dx = ev.changedTouches[0].clientX - touchStartX.current;
          const dy = ev.changedTouches[0].clientY - touchStartY.current;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            dx < 0 ? rendition.next() : rendition.prev();
          }
        });

        // Keyboard ← / → from inside the epub iframe (where focus usually is)
        rendition.on('keyup', (ev: KeyboardEvent) => {
          if (ev.key === 'ArrowLeft')  rendition.prev();
          if (ev.key === 'ArrowRight') rendition.next();
        });

        // Restore last position, then display
        let progress: any = null;
        try { progress = await getReadingProgress(userId, item.id, activeEpubUrl); }
        catch { /* progress is best-effort */ }
        if (destroyed) return;
        const cfi = progress?.position;

        await rendition.display(cfi || undefined);
        if (!destroyed) {
          clearTimer();
          setEpubLoading(false);
          // Load annotations and apply saved highlights
          const existingAnnotations = await getAnnotations(userId, item.id);
          if (!destroyed) {
            setAnnotations(existingAnnotations);
            existingAnnotations
              .filter(a => a.cfi_range && a.format_url === activeEpubUrl)
              .forEach(a => {
                try {
                  rendition.annotations.add(
                    'highlight', a.cfi_range!, {},
                    undefined, `ann-${a.id}`,
                    HIGHLIGHT_COLORS[a.color as HighlightColor] || HIGHLIGHT_COLORS.yellow,
                  );
                } catch { /* skip invalid CFI */ }
              });
          }
        }
      } catch (e: any) {
        if (!destroyed) {
          clearTimer();
          setEpubLoading(false);
          setEpubError('Не удалось открыть EPUB: ' + (e?.message || String(e)));
        }
      }
    })();

    return () => {
      destroyed = true;
      clearTimer();
      renditionRef.current = null;
      try { book?.destroy(); } catch { /* noop */ }
    };
  }, [activeEpubUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // EPUB zoom live update
  useEffect(() => { renditionRef.current?.themes?.fontSize(epubFontSize + '%'); }, [epubFontSize]);

  // EPUB theme live update
  useEffect(() => { renditionRef.current?.themes?.select(readerTheme); }, [readerTheme]);

  // EPUB keyboard navigation (desktop ← / →)
  useEffect(() => {
    if (!activeEpubUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft')  renditionRef.current?.prev();
      if (e.key === 'ArrowRight') renditionRef.current?.next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeEpubUrl]);

  // ── PDF load ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeReaderUrl) {
      if (pdfRenderTaskRef.current) {
        try { pdfRenderTaskRef.current.cancel(); } catch { /* noop */ }
        pdfRenderTaskRef.current = null;
      }
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
      setPdfTotalPages(0);
      setPdfPage(1);
      setPdfScale(1);
      setPdfError(null);
      return;
    }
    let cancelled = false;
    setPdfError(null);
    (async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

        // Fetch the whole file upfront and hand the bytes to pdf.js. Loading
        // by URL makes pdf.js stream the file with HTTP range requests; when
        // those later requests stall, pages past the first few never get
        // their content and render blank. With the full buffer every page is
        // available immediately.
        const resp = await fetch(activeReaderUrl, { headers: item.isPrivate ? tgHeaders() : {} });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.arrayBuffer();
        if (cancelled) return;

        const doc = await pdfjsLib.getDocument({ data, wasmUrl: '/wasm/' }).promise;
        if (cancelled) { try { doc.destroy(); } catch { /* noop */ } return; }
        pdfDocRef.current = doc;

        let startPage = 1;
        try {
          const progress = await getReadingProgress(userId, item.id, activeReaderUrl);
          if (progress?.position) {
            const saved = parseInt(progress.position);
            if (saved > 0 && saved <= doc.numPages) startPage = saved;
          }
        } catch { /* progress is best-effort */ }
        if (cancelled) return;

        // Set total + page together so the render effect runs once, settled.
        setPdfTotalPages(doc.numPages);
        setPdfPage(startPage);

        // Load PDF outline (TOC) — async, best-effort
        try {
          const outline = await doc.getOutline();
          if (!cancelled && outline) {
            const resolveOutline = async (items: any[], level = 0): Promise<PdfTocItem[]> => {
              const result: PdfTocItem[] = [];
              for (const oi of items) {
                let page = 0;
                if (oi.dest) {
                  try {
                    let dest = oi.dest;
                    if (typeof dest === 'string') dest = await doc.getDestination(dest);
                    if (Array.isArray(dest) && dest[0]) page = (await doc.getPageIndex(dest[0])) + 1;
                  } catch { /* skip */ }
                }
                result.push({ title: oi.title || '…', page, level });
                if (oi.items?.length) result.push(...await resolveOutline(oi.items, level + 1));
              }
              return result;
            };
            const resolved = await resolveOutline(outline);
            if (!cancelled) setPdfToc(resolved);
          }
        } catch { /* TOC optional */ }
      } catch (e: any) {
        if (!cancelled) setPdfError('Не удалось открыть PDF: ' + (e?.message || String(e)));
      }
    })();
    return () => { cancelled = true; };
  }, [activeReaderUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // PDF render — each page is drawn onto its own fresh off-screen canvas and
  // swapped into the DOM only once fully rendered. No canvas is ever reused,
  // so there is no stale-pixel or pdf.js canvas-in-use conflict to leave a
  // page blank; the previous page stays visible until the new one is ready.
  useEffect(() => {
    if (!activeReaderUrl || pdfTotalPages === 0) return;
    const doc       = pdfDocRef.current;
    const container = pdfContainerRef.current;
    if (!doc || !container) return;

    let disposed = false;

    (async () => {
      if (pdfRenderTaskRef.current) {
        try { pdfRenderTaskRef.current.cancel(); } catch { /* noop */ }
        pdfRenderTaskRef.current = null;
      }

      let page: any;
      try { page = await doc.getPage(pdfPage); }
      catch (e: any) {
        if (!disposed) setPdfError('Ошибка загрузки страницы: ' + (e?.message || String(e)));
        return;
      }
      if (disposed) return;

      const parent          = container.parentElement;
      const containerWidth  = parent?.clientWidth  || window.innerWidth  || 800;
      const containerHeight = parent?.clientHeight || window.innerHeight || 600;
      const base            = page.getViewport({ scale: 1 });
      // 100% (pdfScale=1) fits the whole page inside the viewport (fit-to-page);
      // on wide desktop screens this avoids an oversized fit-to-width render.
      const fitScale        = Math.min(containerWidth / base.width, containerHeight / base.height);
      const viewport        = page.getViewport({ scale: fitScale * pdfScale });

      const canvas  = document.createElement('canvas');
      canvas.width  = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = 'block';
      // Apply filter directly to canvas — parent-div filters are not composited
      // correctly with GPU-accelerated canvas on desktop Chromium/Safari.
      canvas.style.filter = PDF_FILTER[readerTheme];

      let task: any;
      try {
        task = page.render({ canvas, viewport });
      } catch (e: any) {
        if (!disposed) setPdfError('Ошибка рендера: ' + (e?.message || String(e)));
        return;
      }
      pdfRenderTaskRef.current = task;
      try {
        await task.promise;
        if (disposed) return;
        container.replaceChildren(canvas);
        setPdfError(null);
      } catch (e: any) {
        if (e?.name !== 'RenderingCancelledException' && !disposed) {
          setPdfError('Ошибка рендера: ' + (e?.message || String(e)));
        }
      } finally {
        if (pdfRenderTaskRef.current === task) pdfRenderTaskRef.current = null;
      }
    })();

    return () => { disposed = true; };
  }, [pdfPage, pdfTotalPages, pdfScale, activeReaderUrl]);

  // Save PDF progress when page changes (after doc is ready)
  useEffect(() => {
    if (!activeReaderUrl || pdfTotalPages === 0) return;
    saveReadingProgress(userId, item.id, String(pdfPage), pdfTotalPages, activeReaderUrl);
  }, [pdfPage, pdfTotalPages, activeReaderUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep ref in sync for keyboard handler closure
  useEffect(() => { pdfTotalPagesRef.current = pdfTotalPages; }, [pdfTotalPages]);

  // Keyboard navigation (desktop ← / →)
  useEffect(() => {
    if (!activeReaderUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft')  setPdfPage(p => Math.max(1, p - 1));
      if (e.key === 'ArrowRight') setPdfPage(p => Math.min(pdfTotalPagesRef.current, p + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeReaderUrl]);

  // Live-update canvas filter when PDF theme changes without re-rendering the page
  useEffect(() => {
    const canvas = pdfContainerRef.current?.firstElementChild as HTMLElement | null;
    if (canvas) canvas.style.filter = PDF_FILTER[readerTheme];
  }, [readerTheme]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const cycleTheme = () => {
    setReaderTheme(t => t === 'default' ? 'night' : t === 'night' ? 'sepia' : 'default');
  };

  const ThemeIcon = readerTheme === 'night' ? Moon : readerTheme === 'sepia' ? SunDim : Sun;

  const refreshBookmarks = () => getBookmarks(userId, item.id).then(setBookmarks);

  const handleSaveAnnotation = async () => {
    if (!annotationDraft) return;
    const { cfiRange, page, text } = annotationDraft;
    const formatUrl = activeEpubUrl || activeReaderUrl || '';
    const id = await addAnnotation(userId, item.id, formatUrl, cfiRange || null, page || null, text, draftNote, draftColor);
    if (id) {
      const ann: Annotation = {
        id, item_id: item.id, format_url: formatUrl,
        cfi_range: cfiRange, page: page || null,
        selected_text: text, note: draftNote || null,
        color: draftColor, created_at: new Date().toISOString(),
      };
      setAnnotations(prev => [ann, ...prev]);
      if (cfiRange && renditionRef.current) {
        try {
          renditionRef.current.annotations.add(
            'highlight', cfiRange, {},
            undefined, `ann-${id}`,
            HIGHLIGHT_COLORS[draftColor],
          );
        } catch { /* skip */ }
      }
    }
    setAnnotationDraft(null);
    if (renditionRef.current) {
      try {
        renditionRef.current.getContents()?.forEach((c: any) => c.window?.getSelection()?.removeAllRanges());
      } catch { /* noop */ }
    }
  };

  const handleCancelAnnotation = () => {
    setAnnotationDraft(null);
    if (renditionRef.current) {
      try {
        renditionRef.current.getContents()?.forEach((c: any) => c.window?.getSelection()?.removeAllRanges());
      } catch { /* noop */ }
    }
  };

  const handleDeleteAnnotation = async (id: string) => {
    const ann = annotations.find(a => a.id === id);
    if (ann?.cfi_range && renditionRef.current) {
      try { renditionRef.current.annotations.remove(ann.cfi_range, 'highlight'); } catch { /* noop */ }
    }
    await deleteAnnotation(userId, id);
    setAnnotations(prev => prev.filter(a => a.id !== id));
  };

  const handleAddPdfBookmark = async () => {
    await addBookmark(userId, item.id, String(pdfPage), `Страница ${pdfPage}`);
    refreshBookmarks();
  };

  const handleAddEpubBookmark = async () => {
    const cfi = renditionRef.current?.currentLocation()?.start?.cfi;
    if (!cfi) return;
    await addBookmark(userId, item.id, cfi, `Закладка ${bookmarks.length + 1}`);
    refreshBookmarks();
  };

  const handleDeleteBookmark = async (id: string) => {
    await deleteBookmark(userId, id);
    refreshBookmarks();
  };

  const handleToggleFav = () => {
    toggleFavorite(userId, item.id);
    setIsFav(!isFav);
    onRefresh();
  };

  const handleRate = async (r: number) => {
    setUserRatingState(r);
    const avg = await setUserRating(userId, item.id, r);
    setAvgRating(avg);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handlePdfTouchEnd = (e: React.TouchEvent) => {
    if (pdfScale !== 1) return; // when zoomed, let native scroll handle touch
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) setPdfPage(p => Math.min(pdfTotalPages, p + 1));
      else         setPdfPage(p => Math.max(1, p - 1));
    }
  };

  const getVideoEmbed = (url?: string) => {
    if (!url) return null;
    const host = window.location.hostname;
    const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/);
    if (ytMatch) return <iframe width="100%" height="100%" src={`https://www.youtube.com/embed/${ytMatch[1]}`} frameBorder="0" allowFullScreen></iframe>;
    const rtMatch = url.match(/rutube\.ru\/video\/([a-z0-9]+)/i);
    if (rtMatch) return <iframe width="100%" height="100%" src={`https://rutube.ru/play/embed/${rtMatch[1]}`} frameBorder="0" allowFullScreen></iframe>;
    const twVod = url.match(/twitch\.tv\/videos\/(\d+)/i);
    if (twVod) return <iframe width="100%" height="100%" src={`https://player.twitch.tv/?video=${twVod[1]}&parent=${host}&autoplay=false`} frameBorder="0" allowFullScreen></iframe>;
    const twClip = url.match(/clips\.twitch\.tv\/([a-zA-Z0-9_-]+)/i);
    if (twClip) return <iframe width="100%" height="100%" src={`https://clips.twitch.tv/embed?clip=${twClip[1]}&parent=${host}`} frameBorder="0" allowFullScreen></iframe>;
    const twCh = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)\/?$/i);
    if (twCh) return <iframe width="100%" height="100%" src={`https://player.twitch.tv/?channel=${twCh[1]}&parent=${host}&autoplay=false`} frameBorder="0" allowFullScreen></iframe>;
    const vkExt = url.match(/vk(?:video)?\.(?:com|ru)\/video_ext\.php/i);
    if (vkExt) return <iframe width="100%" height="100%" src={url} frameBorder="0" allowFullScreen></iframe>;
    const vkMatch = url.match(/vk(?:video)?\.(?:com|ru)\/(?:.*?)video(-?\d+)_(\d+)/i);
    if (vkMatch) return <iframe width="100%" height="100%" src={`https://vk.com/video_ext.php?oid=${vkMatch[1]}&id=${vkMatch[2]}&hd=2`} frameBorder="0" allowFullScreen></iframe>;
    if (/\.(mp4|webm|ogg|mov)$/i.test(url)) return <video src={url} controls className="w-full h-full bg-slate-100" poster={item.coverUrl} />;
    return null;
  };

  // Prefer the new multi-video list; fall back to the legacy single videoUrl.
  const videoList: VideoLink[] = (item.videos && item.videos.length > 0)
    ? item.videos
    : (item.videoUrl ? [{ id: 'legacy', url: item.videoUrl, source: '' }] : []);
  const playableVideos = videoList
    .map(v => ({ ...v, embed: getVideoEmbed(v.url) }))
    .filter(v => v.embed);

  const handleRead = (format: FileFormat) => {
    const fileUrl = item.isPrivate ? toProtectedUrl(format.url) : format.url;
    const url = format.url.toLowerCase();
    if (url.endsWith('.pdf') || format.name.toLowerCase().includes('pdf')) {
      setActiveReaderUrl(fileUrl);
    } else if (url.endsWith('.epub')) {
      setActiveEpubUrl(fileUrl);
    } else if (url.endsWith('.djvu') || url.endsWith('.djv')) {
      // Server auto-converts DjVu→PDF on upload; old DB entries may still have
      // a .djvu URL — point to the converted .pdf so the built-in reader opens it.
      setActiveReaderUrl(fileUrl.replace(/\.djvu?$/i, '.pdf'));
    } else {
      window.open(fileUrl, '_blank');
    }
  };

  // ── Shared panels ──────────────────────────────────────────────────────────

  const BookmarksPanel = ({ onJump }: { onJump: (b: Bookmark) => void }) => (
    <div className="absolute inset-y-0 right-0 w-64 bg-slate-950 border-l border-white/10 flex flex-col z-10 animate-in slide-in-from-right-2 duration-200">
      <div className="p-4 border-b border-white/10 flex justify-between items-center shrink-0">
        <p className="text-[10px] font-black uppercase text-white/60 tracking-widest">Закладки</p>
        <button onClick={() => setShowBookmarks(false)} className="text-white/40 hover:text-white transition-colors"><X size={16} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {bookmarks.length === 0 && (
          <p className="text-center text-white/20 text-[10px] uppercase tracking-widest py-8">Нет закладок</p>
        )}
        {bookmarks.map(b => (
          <div key={b.id} className="flex items-center gap-2 p-3 bg-white/5 hover:bg-white/10 rounded-2xl transition-colors group">
            <button onClick={() => { onJump(b); setShowBookmarks(false); }} className="flex-1 text-left min-w-0">
              <p className="text-xs font-bold text-white truncate">{b.label}</p>
              <p className="text-[9px] text-white/30 mt-0.5">{new Date(b.created_at).toLocaleDateString()}</p>
            </button>
            <button onClick={() => handleDeleteBookmark(b.id)} className="p-1.5 text-white/20 hover:text-red-400 transition-colors shrink-0">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  const EpubTocPanel = () => {
    const renderItems = (items: TocItem[], depth = 0) => items.map(tocItem => (
      <React.Fragment key={tocItem.href}>
        <button
          onClick={() => { renditionRef.current?.display(tocItem.href); setShowToc(false); }}
          className="w-full text-left p-3 hover:bg-white/10 rounded-2xl transition-colors"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <p className="text-xs font-bold text-white truncate">{tocItem.label}</p>
        </button>
        {tocItem.subitems && renderItems(tocItem.subitems, depth + 1)}
      </React.Fragment>
    ));
    return (
      <div className="absolute inset-y-0 left-0 w-72 bg-slate-950 border-r border-white/10 flex flex-col z-10 animate-in slide-in-from-left-2 duration-200">
        <div className="p-4 border-b border-white/10 flex justify-between items-center shrink-0">
          <p className="text-[10px] font-black uppercase text-white/60 tracking-widest">Содержание</p>
          <button onClick={() => setShowToc(false)} className="text-white/40 hover:text-white transition-colors"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {toc.length === 0
            ? <p className="text-center text-white/20 text-[10px] uppercase tracking-widest py-8">Нет содержания</p>
            : renderItems(toc)
          }
        </div>
      </div>
    );
  };

  const PdfTocPanel = () => (
    <div className="absolute inset-y-0 left-0 w-72 bg-slate-950 border-r border-white/10 flex flex-col z-10 animate-in slide-in-from-left-2 duration-200">
      <div className="p-4 border-b border-white/10 flex justify-between items-center shrink-0">
        <p className="text-[10px] font-black uppercase text-white/60 tracking-widest">Содержание</p>
        <button onClick={() => setShowToc(false)} className="text-white/40 hover:text-white transition-colors"><X size={16} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {pdfToc.length === 0
          ? <p className="text-center text-white/20 text-[10px] uppercase tracking-widest py-8">Нет содержания</p>
          : pdfToc.map((tocItem, i) => (
              <button
                key={i}
                onClick={() => { if (tocItem.page > 0) { setPdfPage(tocItem.page); setShowToc(false); } }}
                disabled={tocItem.page === 0}
                className="w-full text-left p-3 hover:bg-white/10 rounded-2xl transition-colors disabled:opacity-40 flex items-center justify-between gap-2"
                style={{ paddingLeft: `${12 + tocItem.level * 16}px` }}
              >
                <p className="text-xs font-bold text-white truncate">{tocItem.title}</p>
                {tocItem.page > 0 && <span className="text-[9px] text-white/30 shrink-0">{tocItem.page}</span>}
              </button>
            ))
        }
      </div>
    </div>
  );

  const AnnotationsPanel = ({ isEpub }: { isEpub: boolean }) => (
    <div className="absolute inset-y-0 right-0 w-72 bg-slate-950 border-l border-white/10 flex flex-col z-10 animate-in slide-in-from-right-2 duration-200">
      <div className="p-4 border-b border-white/10 flex justify-between items-center shrink-0">
        <p className="text-[10px] font-black uppercase text-white/60 tracking-widest">Аннотации</p>
        <button onClick={() => setShowAnnotations(false)} className="text-white/40 hover:text-white transition-colors"><X size={16} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {annotations.length === 0 && (
          <p className="text-center text-white/20 text-[10px] uppercase tracking-widest py-8">Нет аннотаций</p>
        )}
        {annotations.map(a => (
          <div key={a.id} className="p-3 bg-white/5 rounded-2xl group">
            <div className="flex items-start gap-2">
              <div className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${HIGHLIGHT_COLOR_BG[a.color as HighlightColor] || 'bg-yellow-400'}`} />
              <button
                onClick={() => {
                  if (isEpub && a.cfi_range) renditionRef.current?.display(a.cfi_range);
                  else if (!isEpub && a.page) setPdfPage(a.page);
                  setShowAnnotations(false);
                }}
                className="flex-1 text-left min-w-0"
              >
                {a.selected_text && (
                  <p className="text-[11px] text-white/50 italic line-clamp-2">"{a.selected_text}"</p>
                )}
                {a.note && <p className="text-xs font-bold text-white mt-0.5">{a.note}</p>}
                <p className="text-[9px] text-white/25 mt-1">
                  {a.page ? `Стр. ${a.page} · ` : ''}{new Date(a.created_at).toLocaleDateString()}
                </p>
              </button>
              <button onClick={() => handleDeleteAnnotation(a.id)} className="p-1.5 text-white/20 hover:text-red-400 transition-colors shrink-0">
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const AnnotationSheet = ({ isPdf }: { isPdf?: boolean }) => (
    <div className="fixed inset-x-0 bottom-0 z-[600] animate-in slide-in-from-bottom-3 duration-200"
      style={{ paddingBottom: 'calc(var(--safe-bottom, 0px))' }}>
      <div className="mx-auto max-w-2xl bg-white rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.18)] border-t border-slate-200 p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">
            {isPdf ? `Заметка · стр. ${annotationDraft?.page}` : 'Выделение'}
          </p>
          <button onClick={handleCancelAnnotation} className="p-1.5 text-slate-300 hover:text-slate-600 transition-colors rounded-lg hover:bg-slate-100">
            <X size={16} />
          </button>
        </div>

        {/* Selected text quote (EPUB only) */}
        {annotationDraft?.text && (
          <div className="bg-slate-50 rounded-2xl px-4 py-3 border-l-4 border-red-500">
            <p className="text-xs text-slate-600 italic line-clamp-3">"{annotationDraft.text}"</p>
          </div>
        )}

        {/* Note input */}
        <div>
          <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Комментарий (необязательно)</label>
          <textarea
            value={draftNote}
            onChange={e => setDraftNote(e.target.value)}
            placeholder="Напишите заметку здесь…"
            className="w-full bg-slate-50 text-slate-900 text-sm rounded-2xl p-4 resize-none outline-none placeholder:text-slate-400 border-2 border-slate-200 focus:border-red-400 transition-colors"
            rows={3}
            autoFocus
          />
        </div>

        {/* Color picker + actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Цвет:</span>
            {(['yellow', 'green', 'blue', 'pink'] as HighlightColor[]).map(c => (
              <button
                key={c}
                onClick={() => setDraftColor(c)}
                className={`w-7 h-7 rounded-full transition-all ${HIGHLIGHT_COLOR_BG[c]} ${
                  draftColor === c ? 'ring-2 ring-slate-700 ring-offset-2 scale-110 shadow-md' : 'opacity-50 hover:opacity-90 hover:scale-105'
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={handleCancelAnnotation} className="px-4 py-2 text-slate-500 text-xs font-bold hover:text-slate-800 transition-colors rounded-xl hover:bg-slate-100">Отмена</button>
            <button onClick={handleSaveAnnotation} className="px-5 py-2 bg-red-600 text-white text-xs font-black rounded-xl hover:bg-red-700 active:scale-95 transition-all shadow-md shadow-red-200">Сохранить</button>
          </div>
        </div>
      </div>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="relative animate-in fade-in slide-in-from-right-4 duration-500 bg-slate-50 min-h-screen">
      <div className="h-72 w-full relative overflow-hidden">
        <img src={item.coverUrl} onError={handleCoverError} className="w-full h-full object-cover blur-3xl opacity-20 scale-150" alt="" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-slate-50" />
        <button
          onClick={onBack}
          className="absolute left-5 p-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 shadow-sm text-slate-900 active:scale-95 transition-all z-20"
          style={{ top: 'calc(2.5rem + var(--safe-top))' }}
        >
          <ArrowLeft size={18} strokeWidth={3} />
        </button>
      </div>

      <div className="px-6 -mt-32 relative z-10 pb-20 max-w-4xl mx-auto">
        <div className="flex gap-6 items-start">
          <div className="relative">
            <img src={item.coverUrl} onError={handleCoverError} className="w-36 aspect-[3/4] object-cover rounded-[2.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.15)] border-4 border-white" alt="" />
            <button onClick={handleToggleFav} className="absolute -bottom-3 -right-3 bg-red-600 text-white p-2.5 rounded-2xl shadow-xl active:scale-90 transition-all hover:bg-red-700 focus:outline-none" aria-label="Toggle Favorite">
              <Heart size={20} fill={isFav ? "white" : "none"} strokeWidth={isFav ? 0 : 3} />
            </button>
          </div>
          <div className="flex-1 pt-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-black uppercase text-red-600 bg-red-50 px-2 py-0.5 rounded-md tracking-widest">{item.type}</span>
            </div>
            <h1 className="text-2xl font-black leading-tight text-slate-900 tracking-tight drop-shadow-sm mb-3">{pickText(item.title, lang)}</h1>
            <div className="flex items-center gap-3 bg-white w-fit px-3 py-1.5 rounded-xl border border-slate-100 shadow-sm">
              <Star size={14} className="text-red-600 fill-red-600" />
              <span className="text-xs font-black text-slate-900 uppercase tracking-tighter">{t.rating}: {avgRating} / 5</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-6">
          <div className="bg-white/60 backdrop-blur-md p-5 rounded-3xl border border-white shadow-sm">
            <div className="flex items-center gap-3 mb-1"><User size={14} className="text-red-600" /><p className="text-[9px] uppercase font-black text-slate-400 tracking-widest">{t.author}</p></div>
            <p className="text-sm font-black truncate text-slate-900 tracking-tight">{item.author}</p>
          </div>
          <div className="bg-white/60 backdrop-blur-md p-5 rounded-3xl border border-white shadow-sm">
            <div className="flex items-center gap-3 mb-1"><Calendar size={14} className="text-red-600" /><p className="text-[9px] uppercase font-black text-slate-400 tracking-widest">{t.published}</p></div>
            <p className="text-sm font-black truncate text-slate-900 tracking-tight">{item.publishedDate}</p>
          </div>
        </div>

        <div className="bg-white p-5 rounded-[2.5rem] border border-slate-100 shadow-sm mt-4 flex items-center justify-between px-8">
          <p className="text-[10px] uppercase font-black text-slate-400 tracking-widest">{t.rateThis}</p>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map(star => (
              <button key={star} onClick={() => handleRate(star)} className="focus:outline-none transition-transform active:scale-90 active:rotate-12">
                <Star size={22} className={`transition-colors duration-300 ${star <= userRating ? "text-yellow-400 fill-yellow-400 drop-shadow-sm" : "text-slate-200 fill-slate-50"}`} strokeWidth={star <= userRating ? 0 : 2} />
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8">
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 mb-4 flex items-center gap-3"><span className="w-10 h-[2px] bg-red-600"></span>{t.about}</h2>
          <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm leading-relaxed text-slate-600 text-sm whitespace-pre-line">{pickText(item.description, lang, '')}</div>
        </div>

        {playableVideos.length > 0 && (
          <div className="mt-10">
            <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 mb-4 flex items-center gap-3"><span className="w-10 h-[2px] bg-red-600"></span>{t.preview}</h2>
            <div className="space-y-6">
              {playableVideos.map(v => (
                <div key={v.id}>
                  {v.source && (
                    <span className="inline-block mb-2 text-[10px] font-black uppercase tracking-widest text-red-600 bg-red-50 px-3 py-1 rounded-lg">{v.source}</span>
                  )}
                  <div className="aspect-video rounded-[2rem] overflow-hidden border-4 border-white shadow-2xl bg-slate-100 relative group">{v.embed}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-10">
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 mb-4 flex items-center gap-3"><span className="w-10 h-[2px] bg-red-600"></span>{t.downloads}</h2>
          <div className="space-y-4">
            {item.formats.length > 0 ? item.formats.map(f => {
              const isFileReadAllowed     = (item.allowReading !== false) && (f.allowReading !== false);
              const isFileDownloadAllowed = (item.allowDownload !== false) && (f.allowDownload !== false);
              return (
                <div key={f.id} className="p-3 bg-white border border-slate-100 rounded-[2.5rem] shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
                  {isFileReadAllowed ? (
                    <button onClick={() => handleRead(f)} className="w-full bg-red-600 text-white py-4 rounded-[2rem] font-black uppercase tracking-[0.2em] text-[10px] shadow-lg shadow-red-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 mb-4">
                      <BookOpen size={16} strokeWidth={3} />{t.readOnline}
                    </button>
                  ) : (
                    isFileDownloadAllowed && (
                      <a href={f.url} download onClick={() => trackActivity('download', item.id)} className="block w-full bg-slate-900 text-white py-4 rounded-[2rem] font-black uppercase tracking-[0.2em] text-[10px] shadow-lg shadow-slate-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 mb-4">
                        <Download size={16} strokeWidth={3} />Download
                      </a>
                    )
                  )}
                  <div className="flex items-center justify-between px-2 pb-1">
                    <div className="flex items-center gap-2">
                      <div className="bg-red-600 text-white px-3 py-1.5 rounded-xl shadow-md shadow-red-100 flex items-center gap-1.5">
                        <FileText size={10} strokeWidth={3} /><span className="text-[9px] font-black uppercase tracking-wider">{f.name || 'FILE'}</span>
                      </div>
                      {f.language && (
                        <div className="bg-slate-100 text-slate-500 px-3 py-1.5 rounded-xl border border-slate-200 flex items-center gap-1.5">
                          <Globe size={10} strokeWidth={3} /><span className="text-[9px] font-black uppercase tracking-wider">{f.language}</span>
                        </div>
                      )}
                      <span className="text-[9px] font-black text-slate-300 uppercase tracking-wider ml-1">{f.size}</span>
                    </div>
                    {isFileReadAllowed && isFileDownloadAllowed && (
                      <a href={f.url} download onClick={() => trackActivity('download', item.id)} className="p-2 bg-white text-slate-300 hover:text-red-600 border border-slate-100 rounded-xl transition-all shadow-sm">
                        <Download size={18} strokeWidth={2.5} />
                      </a>
                    )}
                    {!isFileReadAllowed && !isFileDownloadAllowed && (
                      <div className="p-2 text-slate-300"><Lock size={16} strokeWidth={2.5} /></div>
                    )}
                  </div>
                </div>
              );
            }) : (
              <div className="p-10 text-center bg-white rounded-[2rem] border border-dashed border-slate-200 text-slate-400 text-xs font-bold uppercase tracking-widest">{t.noDownloads}</div>
            )}
          </div>
        </div>
      </div>

      {/* ── EPUB Reader ────────────────────────────────────────────────────── */}
      {activeEpubUrl && (
        <div className={`fixed inset-0 z-[500] ${READER_CHROME[readerTheme].bg} flex flex-col animate-in fade-in duration-300`}>
          <header className={`px-4 pb-4 flex items-center justify-between ${READER_CHROME[readerTheme].bg} border-b ${READER_CHROME[readerTheme].border} shrink-0`}
            style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
            <div className="flex items-center gap-2">
              {toc.length > 0 && (
                <button onClick={() => { setShowToc(s => !s); setShowBookmarks(false); setShowAnnotations(false); }}
                  className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`} title="Содержание">
                  <List size={16} />
                </button>
              )}
              <div className="p-2 bg-red-600 rounded-lg text-white"><BookOpen size={16} /></div>
              <p className={`text-xs font-black ${READER_CHROME[readerTheme].text} truncate max-w-[120px]`}>{pickText(item.title, lang)}</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={cycleTheme} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`} title="Тема">
                <ThemeIcon size={16} />
              </button>
              <button onClick={handleAddEpubBookmark} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`} title="Добавить закладку">
                <BookmarkPlus size={16} />
              </button>
              <button onClick={() => { setShowBookmarks(s => !s); setShowToc(false); setShowAnnotations(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all relative`} title="Закладки">
                <BookMarked size={16} />
                {bookmarks.length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{bookmarks.length}</span>}
              </button>
              <button onClick={() => { setShowAnnotations(s => !s); setShowBookmarks(false); setShowToc(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all relative`} title="Аннотации">
                <Highlighter size={16} />
                {annotations.length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{annotations.length}</span>}
              </button>
              <button onClick={() => setActiveEpubUrl(null)} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`}><X size={20} /></button>
            </div>
          </header>

          <div className="flex-1 relative overflow-hidden"
            style={{ background: readerTheme === 'night' ? '#0f172a' : readerTheme === 'sepia' ? '#f4ecd8' : '#ffffff' }}>
            <div ref={epubViewerRef} className="w-full h-full" />
            {showToc && <EpubTocPanel />}
            {showBookmarks && <BookmarksPanel onJump={b => renditionRef.current?.display(b.position)} />}
            {showAnnotations && <AnnotationsPanel isEpub={true} />}
            {annotationDraft !== null && <AnnotationSheet />}
            {epubLoading && !epubError && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-8 h-8 border-4 border-slate-300 border-t-red-600 rounded-full animate-spin" />
              </div>
            )}
            {epubError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center bg-slate-900">
                <p className="text-[10px] font-black uppercase text-red-400 tracking-widest">Ошибка просмотра EPUB</p>
                <p className="text-xs text-white/60 break-words max-w-sm">{epubError}</p>
              </div>
            )}
          </div>

          <footer className={`px-4 pt-3 ${READER_CHROME[readerTheme].bg} border-t ${READER_CHROME[readerTheme].border} flex items-center justify-between gap-3 shrink-0`}
            style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}>
            <button onClick={() => renditionRef.current?.prev()} className={`flex-1 max-w-[150px] py-4 flex items-center justify-center ${READER_CHROME[readerTheme].btn} rounded-2xl transition-all active:scale-95`}><ChevronLeft size={26} /></button>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => setEpubFontSize(s => Math.max(70, s - 10))} disabled={epubFontSize <= 70} className={`p-2.5 ${READER_CHROME[readerTheme].btn} disabled:opacity-30 rounded-xl transition-all`}><ZoomOut size={16} /></button>
              <span className={`text-[10px] font-black ${READER_CHROME[readerTheme].sub} w-11 text-center`}>{epubFontSize}%</span>
              <button onClick={() => setEpubFontSize(s => Math.min(200, s + 10))} disabled={epubFontSize >= 200} className={`p-2.5 ${READER_CHROME[readerTheme].btn} disabled:opacity-30 rounded-xl transition-all`}><ZoomIn size={16} /></button>
            </div>
            <button onClick={() => renditionRef.current?.next()} className={`flex-1 max-w-[150px] py-4 flex items-center justify-center ${READER_CHROME[readerTheme].btn} rounded-2xl transition-all active:scale-95`}><ChevronRight size={26} /></button>
          </footer>
        </div>
      )}

      {/* ── PDF Reader ─────────────────────────────────────────────────────── */}
      {activeReaderUrl && (
        <div className={`fixed inset-0 z-[500] ${READER_CHROME[readerTheme].bg} flex flex-col animate-in fade-in duration-300`}>
          <header className={`px-4 pb-4 flex items-center justify-between ${READER_CHROME[readerTheme].bg} border-b ${READER_CHROME[readerTheme].border} shrink-0`}
            style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
            <div className="flex items-center gap-2">
              {pdfToc.length > 0 && (
                <button onClick={() => { setShowToc(s => !s); setShowBookmarks(false); setShowAnnotations(false); }}
                  className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`} title="Содержание">
                  <List size={16} />
                </button>
              )}
              <div className="p-2 bg-red-600 rounded-lg text-white"><BookOpen size={16} /></div>
              <div>
                <p className={`text-[10px] font-black uppercase ${READER_CHROME[readerTheme].sub} tracking-widest leading-none mb-1`}>PDF Reader</p>
                <p className={`text-xs font-black ${READER_CHROME[readerTheme].text} truncate max-w-[110px]`}>{pickText(item.title, lang)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={cycleTheme} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`} title="Тема">
                <ThemeIcon size={16} />
              </button>
              <button onClick={handleAddPdfBookmark} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`} title="Добавить закладку">
                <BookmarkPlus size={16} />
              </button>
              <button onClick={() => { setShowBookmarks(s => !s); setShowAnnotations(false); setShowToc(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all relative`} title="Закладки">
                <BookMarked size={16} />
                {bookmarks.length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{bookmarks.length}</span>}
              </button>
              <button onClick={() => { setShowAnnotations(s => !s); setShowBookmarks(false); setShowToc(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all relative`} title="Аннотации">
                <Highlighter size={16} />
                {annotations.length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{annotations.length}</span>}
              </button>
              <button
                onClick={() => { setAnnotationDraft({ page: pdfPage, text: '' }); setDraftNote(''); setDraftColor('yellow'); setShowAnnotations(false); }}
                className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`} title="Добавить заметку">
                <PenLine size={16} />
              </button>
              <button onClick={() => setActiveReaderUrl(null)} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`}><X size={20} /></button>
            </div>
          </header>

          <div className="flex-1 relative overflow-hidden">
            <div
              className={`w-full h-full overflow-auto ${PDF_BG[readerTheme]}`}
              onTouchStart={handleTouchStart}
              onTouchEnd={handlePdfTouchEnd}
            >
              <div ref={pdfContainerRef} className="mx-auto w-fit" />
            </div>
            {pdfTotalPages === 0 && !pdfError && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-8 h-8 border-4 border-white/10 border-t-red-600 rounded-full animate-spin" />
              </div>
            )}
            {pdfError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center bg-slate-900">
                <p className="text-[10px] font-black uppercase text-red-400 tracking-widest">Ошибка просмотра PDF</p>
                <p className="text-xs text-white/60 break-words max-w-sm">{pdfError}</p>
              </div>
            )}
            {showToc && <PdfTocPanel />}
            {showBookmarks && <BookmarksPanel onJump={b => { setPdfPage(parseInt(b.position)); }} />}
            {showAnnotations && <AnnotationsPanel isEpub={false} />}
            {annotationDraft !== null && <AnnotationSheet isPdf={true} />}
          </div>

          <footer className={`px-4 pt-3 ${READER_CHROME[readerTheme].bg} border-t ${READER_CHROME[readerTheme].border} flex items-center justify-between gap-3 shrink-0`}
            style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}>
            <button onClick={() => setPdfPage(p => Math.max(1, p - 1))} disabled={pdfPage <= 1} className={`flex-1 max-w-[150px] py-4 flex items-center justify-center ${READER_CHROME[readerTheme].btn} disabled:opacity-30 rounded-2xl transition-all active:scale-95`}><ChevronLeft size={26} /></button>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <div className="flex items-center gap-1">
                <button onClick={() => setPdfScale(s => Math.max(0.1, +(s - 0.1).toFixed(2)))} disabled={pdfScale <= 0.1} className={`p-2.5 ${READER_CHROME[readerTheme].btn} disabled:opacity-30 rounded-xl transition-all`}><ZoomOut size={16} /></button>
                <span className={`text-[10px] font-black ${READER_CHROME[readerTheme].sub} w-11 text-center`}>{Math.round(pdfScale * 100)}%</span>
                <button onClick={() => setPdfScale(s => Math.min(3, +(s + 0.1).toFixed(2)))} disabled={pdfScale >= 3} className={`p-2.5 ${READER_CHROME[readerTheme].btn} disabled:opacity-30 rounded-xl transition-all`}><ZoomIn size={16} /></button>
              </div>
              <p className={`text-[9px] font-black ${READER_CHROME[readerTheme].sub} tracking-widest`}>{pdfTotalPages > 0 ? `${pdfPage} / ${pdfTotalPages}` : '...'}</p>
            </div>
            <button onClick={() => setPdfPage(p => Math.min(pdfTotalPages, p + 1))} disabled={pdfPage >= pdfTotalPages} className={`flex-1 max-w-[150px] py-4 flex items-center justify-center ${READER_CHROME[readerTheme].btn} disabled:opacity-30 rounded-2xl transition-all active:scale-95`}><ChevronRight size={26} /></button>
          </footer>
        </div>
      )}
    </div>
  );
};

export default ItemDetails;
