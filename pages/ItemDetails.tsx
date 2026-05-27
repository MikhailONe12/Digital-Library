
import React, { useEffect, useRef, useState } from 'react';
import { MediaItem, Locale, FileFormat, Bookmark, VideoLink, Annotation, HighlightColor } from '../types';
import {
  ArrowLeft, Download, Star, Calendar, User, FileText, BookOpen, X, Lock, Heart,
  Globe, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, BookmarkPlus, BookMarked,
  Trash2, List, Sun, Moon, SunDim, Highlighter, PenLine, Eye, EyeOff, CircleDot,
  Search,
} from 'lucide-react';
// @ts-ignore
import ePub from 'epubjs';
// Custom worker entry bundles a Math.sumPrecise polyfill ahead of the pdf.js
// worker — see services/pdfWorker.ts.
import workerSrc from '../services/pdfWorker?worker&url';
import {
  trackActivity, toggleFavorite, isFavorited, getUserRating, setUserRating,
  getAverageRating, getBookmarks, addBookmark, deleteBookmark,
  getReadingProgress, saveReadingProgress,
  getAnnotations, addAnnotation, deleteAnnotation,
} from '../services/db';
import { pickText, handleCoverError, getVideoPoster } from '../utils';
import { getVideoThumbnail, isDirectVideo } from '../services/videoThumb';
import { getPdfThumbnail } from '../services/pdfThumb';
import { getEpubThumbnail } from '../services/epubThumb';

type ReaderTheme = 'default' | 'night' | 'sepia';

interface TocItem { href: string; label: string; subitems?: TocItem[] }
interface PdfTocItem { title: string; page: number; level: number; }

const HIGHLIGHT_COLORS: Record<HighlightColor, Record<string, string>> = {
  yellow: { fill: '#fbbf24', 'fill-opacity': '0.5' },
  green:  { fill: '#34d399', 'fill-opacity': '0.5' },
  blue:   { fill: '#60a5fa', 'fill-opacity': '0.5' },
  pink:   { fill: '#f472b6', 'fill-opacity': '0.5' },
};

const HIGHLIGHT_COLOR_BG: Record<HighlightColor, string> = {
  yellow: 'bg-yellow-400',
  green:  'bg-green-400',
  blue:   'bg-blue-400',
  pink:   'bg-pink-400',
};

// Underline styling for the "mini" EPUB display mode (subtle, doesn't cover text)
const HIGHLIGHT_UNDERLINE: Record<HighlightColor, Record<string, string>> = {
  yellow: { stroke: '#f59e0b', 'stroke-opacity': '0.9', 'stroke-width': '3' },
  green:  { stroke: '#10b981', 'stroke-opacity': '0.9', 'stroke-width': '3' },
  blue:   { stroke: '#3b82f6', 'stroke-opacity': '0.9', 'stroke-width': '3' },
  pink:   { stroke: '#ec4899', 'stroke-opacity': '0.9', 'stroke-width': '3' },
};

// 3-state visibility of notes/highlights: full → mini → hidden → full
type NotesDisplay = 'full' | 'mini' | 'hidden';

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
  // Pending bookmark awaiting an optional name before it's saved
  const [bookmarkDraft, setBookmarkDraft] = useState<{ position: string; defaultLabel: string } | null>(null);
  const [bookmarkName, setBookmarkName]   = useState('');

  // Annotations
  const [annotations, setAnnotations]         = useState<Annotation[]>([]);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState<{ cfiRange?: string; page?: number; text: string } | null>(null);
  const [draftNote, setDraftNote]             = useState('');
  const [draftColor, setDraftColor]           = useState<HighlightColor>('yellow');
  const [notesDisplay, setNotesDisplay]       = useState<NotesDisplay>('full');

  // Immersive mode: tap the page to hide/show the reader chrome (header/footer).
  const [chromeVisible, setChromeVisible] = useState(true);

  // Full-text search
  const [showSearch, setShowSearch]       = useState(false);
  const [searchQuery, setSearchQuery]     = useState('');
  const [searchResults, setSearchResults] = useState<{ excerpt: string; cfi?: string; page?: number }[]>([]);
  const [searching, setSearching]         = useState(false);

  // Item
  const [userRating, setUserRatingState] = useState(0);
  const [avgRating, setAvgRating]        = useState(item.rating);
  const [isFav, setIsFav]                = useState(false);

  const epubViewerRef     = useRef<HTMLDivElement>(null);
  const renditionRef      = useRef<any>(null);
  const bookRef           = useRef<any>(null);
  const pdfContainerRef   = useRef<HTMLDivElement>(null);
  const pdfDocRef         = useRef<any>(null);
  const pdfRenderTaskRef  = useRef<any>(null);
  const touchStartX       = useRef(0);
  const touchStartY       = useRef(0);
  // True while the annotation sheet is open — used to suspend ←/→ page
  // navigation so arrow keys move the text cursor inside the note textarea.
  const annotationOpenRef = useRef(false);
  // Last pointer device used — wheel/click handlers use this to skip toggling
  // reader chrome on desktop (mouse) while keeping the behaviour on mobile (touch).
  const lastPointerTypeRef = useRef<string>('touch');
  // Throttle wheel-driven page flips to one per 500 ms so a single swipe
  // gesture doesn't skip multiple pages at once.
  const wheelThrottleRef  = useRef<number>(0);

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

  // (Re)applies EPUB highlights/underlines for the given display mode. Removes
  // any existing marks first so it's safe to call repeatedly (load, theme
  // switch, mode toggle). 'hidden' clears them, 'mini' draws a thin underline,
  // 'full' draws the colored highlight.
  const applyEpubAnnotations = (rend: any, anns: Annotation[], mode: NotesDisplay) => {
    if (!rend) return;
    anns.filter(a => a.cfi_range && a.format_url === activeEpubUrl).forEach(a => {
      try { rend.annotations.remove(a.cfi_range, 'highlight'); } catch { /* absent */ }
      try { rend.annotations.remove(a.cfi_range, 'underline'); } catch { /* absent */ }
      if (mode === 'hidden') return;
      try {
        if (mode === 'mini') {
          rend.annotations.add('underline', a.cfi_range, {}, undefined, `ann-${a.id}`,
            HIGHLIGHT_UNDERLINE[a.color as HighlightColor] || HIGHLIGHT_UNDERLINE.yellow);
        } else {
          rend.annotations.add('highlight', a.cfi_range, {}, undefined, `ann-${a.id}`,
            HIGHLIGHT_COLORS[a.color as HighlightColor] || HIGHLIGHT_COLORS.yellow);
        }
      } catch { /* invalid CFI */ }
    });
  };

  const cycleNotesDisplay = () =>
    setNotesDisplay(m => (m === 'full' ? 'mini' : m === 'mini' ? 'hidden' : 'full'));

  // Keep ref in sync so keyboard handlers can read the latest value. Suspend
  // page navigation while either input sheet (note or bookmark name) is open.
  useEffect(() => { annotationOpenRef.current = annotationDraft !== null || bookmarkDraft !== null; }, [annotationDraft, bookmarkDraft]);

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
      setShowSearch(false);
      setSearchQuery('');
      setSearchResults([]);
      setChromeVisible(true);
      setAnnotationDraft(null);
      setBookmarkDraft(null);
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
        bookRef.current = book;
        const rendition = book.renderTo(epubViewerRef.current, {
          width: '100%', height: '100%', spread: 'none',
        });

        // Tap the page toggles the reader chrome — touch only. On desktop
        // (mouse) we leave the chrome always visible. Decision deferred 130 ms
        // so an in-progress text selection isn't disrupted.
        const tapToggleChrome = (win: any) => {
          setTimeout(() => {
            if (lastPointerTypeRef.current === 'mouse') return;
            if (annotationOpenRef.current) return;
            const s = win?.getSelection?.();
            if (s && s.toString().trim()) return;
            setChromeVisible(v => !v);
          }, 130);
        };
        rendition.hooks.content.register((contents: any) => {
          contents.document.addEventListener('pointerdown', (e: any) => {
            lastPointerTypeRef.current = e.pointerType || 'touch';
          });
          contents.document.addEventListener('click', () => tapToggleChrome(contents.window));
          // Mouse-wheel page navigation inside the EPUB iframe content
          contents.document.addEventListener('wheel', (e: WheelEvent) => {
            const now = Date.now();
            if (now - wheelThrottleRef.current < 500) return;
            if (Math.abs(e.deltaY) < 20) return;
            wheelThrottleRef.current = now;
            if (e.deltaY > 0) renditionRef.current?.next();
            else              renditionRef.current?.prev();
          }, { passive: true });
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
          if (annotationOpenRef.current) return; // typing a note — let arrows move the cursor
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
            applyEpubAnnotations(rendition, existingAnnotations, notesDisplay);
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
      bookRef.current = null;
      try { book?.destroy(); } catch { /* noop */ }
    };
  }, [activeEpubUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit the EPUB when the chrome is toggled (the content area changes height)
  // and re-apply highlights, which a resize can drop.
  useEffect(() => {
    if (!activeEpubUrl) return;
    const id = setTimeout(() => {
      try { renditionRef.current?.resize(); } catch { /* noop */ }
      setTimeout(() => { try { applyEpubAnnotations(renditionRef.current, annotations, notesDisplay); } catch { /* noop */ } }, 60);
    }, 60);
    return () => clearTimeout(id);
  }, [chromeVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  // EPUB zoom live update
  useEffect(() => { renditionRef.current?.themes?.fontSize(epubFontSize + '%'); }, [epubFontSize]);

  // EPUB theme live update. themes.select() re-injects the iframe stylesheet,
  // which can drop the SVG highlight overlay — re-apply highlights afterwards so
  // colored selections survive a theme switch. epub.js's select() also doesn't
  // reliably repaint already-rendered content, so we additionally set the body
  // background/color directly on every rendered iframe as a guarantee.
  useEffect(() => {
    const rend = renditionRef.current;
    if (!rend || !activeEpubUrl) return;
    rend.themes?.select(readerTheme);
    try {
      const body = (EPUB_THEMES[readerTheme] as any).body || {};
      const bg  = String(body.background || '').replace('!important', '').trim();
      const col = String(body.color || '').replace('!important', '').trim();
      rend.getContents?.().forEach((c: any) => {
        const el = c?.document?.body;
        if (!el) return;
        if (bg)  el.style.setProperty('background', bg, 'important');
        if (col) el.style.setProperty('color', col, 'important');
      });
    } catch { /* noop */ }
    const timer = setTimeout(() => applyEpubAnnotations(rend, annotations, notesDisplay), 50);
    return () => clearTimeout(timer);
  }, [readerTheme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-apply EPUB marks when the notes display mode changes
  useEffect(() => {
    const rend = renditionRef.current;
    if (!rend || !activeEpubUrl) return;
    applyEpubAnnotations(rend, annotations, notesDisplay);
  }, [notesDisplay]); // eslint-disable-line react-hooks/exhaustive-deps

  // EPUB keyboard navigation (desktop ← / →)
  useEffect(() => {
    if (!activeEpubUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (annotationOpenRef.current) return; // typing a note — let arrows move the cursor
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

        const doc = await pdfjsLib.getDocument({
          data,
          wasmUrl: '/wasm/',
          // CMap + standard-font data are required for correct text on many
          // documents (esp. Russian/CIS PDFs using Type1/CIDFont encodings or
          // non-embedded base-14 fonts).
          cMapUrl: '/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/standard_fonts/',
          // disableFontFace forces pdf.js to rasterize glyph OUTLINES directly
          // from the embedded font instead of rebuilding a browser @font-face.
          // The @font-face path mis-maps glyphs for fonts with non-standard
          // encodings (common in Russian PDFs) → garbled text. Drawing outlines
          // straight onto the canvas reproduces the document exactly.
          disableFontFace: true,
        }).promise;
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
  }, [pdfPage, pdfTotalPages, pdfScale, activeReaderUrl, chromeVisible]);

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
      if (annotationOpenRef.current) return; // typing a note — let arrows move the cursor
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

  const NotesIcon  = notesDisplay === 'full' ? Eye : notesDisplay === 'mini' ? CircleDot : EyeOff;
  const notesTitle = notesDisplay === 'full' ? 'Заметки: показаны' : notesDisplay === 'mini' ? 'Заметки: значки' : 'Заметки: скрыты';

  const refreshBookmarks = () => getBookmarks(userId, item.id).then(setBookmarks);

  // Full-text search across the open document. EPUB: load each spine section and
  // use epub.js's Section.find (returns CFI + excerpt). PDF: scan each page's
  // text content for the query. Capped at 100 hits to keep it responsive.
  const MAX_SEARCH_HITS = 100;
  const runSearch = async () => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); return; }
    setSearching(true);
    setSearchResults([]);
    try {
      if (activeEpubUrl && bookRef.current) {
        const book = bookRef.current;
        try { await book.ready; } catch { /* continue */ }
        const sections = book.spine?.spineItems || [];
        const out: { excerpt: string; cfi?: string }[] = [];
        for (const sec of sections) {
          if (out.length >= MAX_SEARCH_HITS) break;
          try {
            await sec.load(book.load.bind(book));
            const found = sec.find(q) || [];
            for (const f of found) {
              out.push({ excerpt: (f.excerpt || '').trim(), cfi: f.cfi });
              if (out.length >= MAX_SEARCH_HITS) break;
            }
          } catch { /* skip section */ }
          finally { try { sec.unload(); } catch { /* noop */ } }
        }
        setSearchResults(out);
      } else if (activeReaderUrl && pdfDocRef.current) {
        const doc = pdfDocRef.current;
        const ql = q.toLowerCase();
        const out: { excerpt: string; page: number }[] = [];
        for (let p = 1; p <= doc.numPages; p++) {
          if (out.length >= MAX_SEARCH_HITS) break;
          try {
            const page = await doc.getPage(p);
            const tc = await page.getTextContent();
            const text = tc.items.map((it: any) => it.str).join(' ');
            const lower = text.toLowerCase();
            let idx = lower.indexOf(ql);
            while (idx !== -1 && out.length < MAX_SEARCH_HITS) {
              const start = Math.max(0, idx - 40);
              const end = Math.min(text.length, idx + q.length + 40);
              out.push({
                excerpt: (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : ''),
                page: p,
              });
              idx = lower.indexOf(ql, idx + ql.length);
            }
          } catch { /* skip page */ }
        }
        setSearchResults(out);
      }
    } finally {
      setSearching(false);
    }
  };

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
      if (cfiRange && renditionRef.current && notesDisplay !== 'hidden') {
        try {
          if (notesDisplay === 'mini') {
            renditionRef.current.annotations.add('underline', cfiRange, {}, undefined, `ann-${id}`, HIGHLIGHT_UNDERLINE[draftColor]);
          } else {
            renditionRef.current.annotations.add('highlight', cfiRange, {}, undefined, `ann-${id}`, HIGHLIGHT_COLORS[draftColor]);
          }
        } catch { /* skip */ }
      }
    } else {
      const msg = 'Не удалось сохранить заметку. Сервер недоступен — обновите API (docker compose up -d --build library-api).';
      if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
      return; // keep the sheet open so the draft isn't lost
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

  const handleAddPdfBookmark = () => {
    setBookmarkName('');
    setBookmarkDraft({ position: String(pdfPage), defaultLabel: `Страница ${pdfPage}` });
  };

  const handleAddEpubBookmark = () => {
    const cfi = renditionRef.current?.currentLocation()?.start?.cfi;
    if (!cfi) return;
    setBookmarkName('');
    setBookmarkDraft({ position: cfi, defaultLabel: `Закладка ${bookmarks.filter(b => !/^\d+$/.test(b.position)).length + 1}` });
  };

  const handleSaveBookmark = async () => {
    if (!bookmarkDraft) return;
    await addBookmark(userId, item.id, bookmarkDraft.position, bookmarkName.trim() || bookmarkDraft.defaultLabel);
    setBookmarkDraft(null);
    refreshBookmarks();
  };

  const handleCancelBookmark = () => setBookmarkDraft(null);

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

  // No cover uploaded? Derive one from the content — in priority order:
  //   1. YouTube poster (sync, free)
  //   2. PDF/EPUB first page (async, cached in IDB after first render)
  //   3. Direct video frame grab (async, cached in IDB after first render)
  const [autoThumb, setAutoThumb] = useState<string>('');
  const firstVideoUrl = videoList[0]?.url;
  const hasCover = !!(item.coverUrl && item.coverUrl.trim());
  const youtubePoster = hasCover ? null : getVideoPoster(firstVideoUrl);

  useEffect(() => {
    setAutoThumb('');
    if (hasCover || youtubePoster) return;
    let cancelled = false;

    const formats = item.formats || [];
    const epubFmt = !item.isPrivate ? formats.find(f => /\.epub$/i.test(f.url || '')) : undefined;
    const pdfFmt  = !item.isPrivate ? formats.find(f => /\.(pdf|djvu?)$/i.test(f.url || '')) : undefined;

    if (epubFmt) {
      getEpubThumbnail(epubFmt.url).then(d => {
        if (cancelled) return;
        if (d) { setAutoThumb(d); return; }
        if (pdfFmt) {
          getPdfThumbnail(pdfFmt.url.replace(/\.djvu?$/i, '.pdf'))
            .then(d2 => { if (!cancelled && d2) setAutoThumb(d2); });
        }
      });
    } else if (pdfFmt) {
      getPdfThumbnail(pdfFmt.url.replace(/\.djvu?$/i, '.pdf'))
        .then(d => { if (!cancelled && d) setAutoThumb(d); });
    } else if (isDirectVideo(firstVideoUrl)) {
      getVideoThumbnail(firstVideoUrl!).then(d => { if (!cancelled && d) setAutoThumb(d); });
    }

    return () => { cancelled = true; };
  }, [item.id, item.coverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const coverSrc = hasCover
    ? item.coverUrl!
    : (youtubePoster || autoThumb || '');

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

  const BookmarksPanel = ({ onJump, isEpub }: { onJump: (b: Bookmark) => void; isEpub: boolean }) => {
    // Bookmarks aren't tagged with a format, but their position type is
    // unambiguous: PDF stores a page number, EPUB stores an "epubcfi(...)"
    // string. Show only the ones that belong to the current reader.
    const visible = bookmarks.filter(b => isEpub ? !/^\d+$/.test(b.position) : /^\d+$/.test(b.position));
    return (
    <div className="absolute inset-y-0 right-0 w-64 bg-slate-950 border-l border-white/10 flex flex-col z-30 animate-in slide-in-from-right-2 duration-200">
      <div className="p-4 border-b border-white/10 flex justify-between items-center shrink-0">
        <p className="text-[10px] font-black uppercase text-white/60 tracking-widest">Закладки</p>
        <button onClick={() => setShowBookmarks(false)} className="text-white/40 hover:text-white transition-colors"><X size={16} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {visible.length === 0 && (
          <p className="text-center text-white/20 text-[10px] uppercase tracking-widest py-8">Нет закладок</p>
        )}
        {visible.map(b => (
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
  };

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

  const AnnotationsPanel = ({ isEpub }: { isEpub: boolean }) => {
    // Show only annotations navigable in the current reader: EPUB highlights
    // carry a cfi_range, PDF page-notes carry a page. This keeps every list
    // entry clickable (a cross-format entry would have no target to jump to).
    const visible = annotations.filter(a => isEpub ? !!a.cfi_range : a.page != null);
    return (
    <div className="absolute inset-y-0 right-0 w-72 bg-slate-950 border-l border-white/10 flex flex-col z-30 animate-in slide-in-from-right-2 duration-200">
      <div className="p-4 border-b border-white/10 flex justify-between items-center shrink-0">
        <p className="text-[10px] font-black uppercase text-white/60 tracking-widest">Аннотации</p>
        <button onClick={() => setShowAnnotations(false)} className="text-white/40 hover:text-white transition-colors"><X size={16} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {visible.length === 0 && (
          <p className="text-center text-white/20 text-[10px] uppercase tracking-widest py-8">Нет аннотаций</p>
        )}
        {visible.map((a, i) => (
          <div key={a.id} className="p-3 bg-white/5 rounded-2xl group">
            <div className="flex items-start gap-2">
              <div className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${HIGHLIGHT_COLOR_BG[a.color as HighlightColor] || 'bg-yellow-400'}`} />
              <button
                onClick={() => {
                  if (isEpub && a.cfi_range) renditionRef.current?.display(a.cfi_range);
                  else if (!isEpub && a.page != null) setPdfPage(a.page);
                  setShowAnnotations(false);
                }}
                className="flex-1 text-left min-w-0"
              >
                {a.selected_text && (
                  <p className="text-[11px] text-white/50 italic line-clamp-2">"{a.selected_text}"</p>
                )}
                {a.note
                  ? <p className="text-xs font-bold text-white mt-0.5">{a.note}</p>
                  : !a.selected_text && <p className="text-xs font-bold text-white mt-0.5">Заметка {visible.length - i}</p>
                }
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
  };

  // Defined as a plain function (called as SearchPanel({}) rather than
  // <SearchPanel/>) so React reconciles the input as a stable host node and the
  // text cursor / focus survives re-renders while typing.
  const SearchPanel = () => (
    <div className="absolute inset-y-0 right-0 w-72 max-w-[85%] bg-slate-950 border-l border-white/10 flex flex-col z-30 animate-in slide-in-from-right-2 duration-200">
      <div className="p-3 border-b border-white/10 shrink-0 space-y-2">
        <div className="flex justify-between items-center">
          <p className="text-[10px] font-black uppercase text-white/60 tracking-widest">Поиск по тексту</p>
          <button onClick={() => setShowSearch(false)} className="text-white/40 hover:text-white transition-colors"><X size={16} /></button>
        </div>
        <div className="flex gap-2">
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
            placeholder="Что искать…"
            autoFocus
            className="flex-1 min-w-0 bg-white/5 text-white text-xs rounded-xl px-3 py-2.5 outline-none placeholder:text-white/30 border border-white/10 focus:border-red-500/50 transition-colors"
          />
          <button onClick={runSearch} className="px-3 bg-red-600 hover:bg-red-700 text-white rounded-xl transition-colors shrink-0"><Search size={14} /></button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {searching && (
          <p className="text-center text-white/30 text-[10px] uppercase tracking-widest py-8">Поиск…</p>
        )}
        {!searching && searchQuery.trim() && searchResults.length === 0 && (
          <p className="text-center text-white/20 text-[10px] uppercase tracking-widest py-8">Ничего не найдено</p>
        )}
        {searchResults.map((r, i) => (
          <button
            key={i}
            onClick={() => {
              if (r.cfi) renditionRef.current?.display(r.cfi);
              else if (r.page != null) setPdfPage(r.page);
              setShowSearch(false);
            }}
            className="w-full text-left p-3 bg-white/5 hover:bg-white/10 rounded-2xl transition-colors"
          >
            {r.page != null && <p className="text-[9px] text-white/30 mb-1">Стр. {r.page}</p>}
            <p className="text-[11px] text-white/70 leading-snug line-clamp-3">{r.excerpt || '…'}</p>
          </button>
        ))}
      </div>
    </div>
  );

  const AnnotationSheet = ({ isPdf }: { isPdf?: boolean }) => (
    <div className="fixed inset-x-0 bottom-0 z-[600] animate-in slide-in-from-bottom-3 duration-200"
      style={{ paddingBottom: 'calc(var(--safe-bottom, 0px))' }}>
      <div className="mx-auto max-w-2xl bg-white rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.18)] border-t border-slate-200 p-5 space-y-4 max-h-[80vh] overflow-y-auto">
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
          <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
            {isPdf ? 'Название заметки (необязательно)' : 'Комментарий (необязательно)'}
          </label>
          <textarea
            value={draftNote}
            onChange={e => setDraftNote(e.target.value)}
            placeholder={isPdf ? 'Например: Важный момент…' : 'Напишите заметку здесь…'}
            className="w-full bg-slate-50 text-slate-900 text-sm rounded-2xl p-4 resize-none outline-none placeholder:text-slate-400 border-2 border-slate-200 focus:border-red-400 transition-colors"
            rows={3}
            autoFocus={!!isPdf}
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

  const BookmarkSheet = () => (
    <div className="fixed inset-x-0 bottom-0 z-[600] animate-in slide-in-from-bottom-3 duration-200"
      style={{ paddingBottom: 'calc(var(--safe-bottom, 0px))' }}>
      <div className="mx-auto max-w-2xl bg-white rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.18)] border-t border-slate-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Новая закладка</p>
          <button onClick={handleCancelBookmark} className="p-1.5 text-slate-300 hover:text-slate-600 transition-colors rounded-lg hover:bg-slate-100">
            <X size={16} />
          </button>
        </div>
        <div>
          <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Название (необязательно)</label>
          <input
            value={bookmarkName}
            onChange={e => setBookmarkName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSaveBookmark(); }}
            placeholder={bookmarkDraft?.defaultLabel}
            className="w-full bg-slate-50 text-slate-900 text-sm rounded-2xl p-4 outline-none placeholder:text-slate-400 border-2 border-slate-200 focus:border-red-400 transition-colors"
            autoFocus
          />
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={handleCancelBookmark} className="px-4 py-2 text-slate-500 text-xs font-bold hover:text-slate-800 transition-colors rounded-xl hover:bg-slate-100">Отмена</button>
          <button onClick={handleSaveBookmark} className="px-5 py-2 bg-red-600 text-white text-xs font-black rounded-xl hover:bg-red-700 active:scale-95 transition-all shadow-md shadow-red-200">Сохранить</button>
        </div>
      </div>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="relative animate-in fade-in slide-in-from-right-4 duration-500 bg-slate-50 dark:bg-black min-h-screen">
      <div className="h-72 w-full relative overflow-hidden">
        <img src={coverSrc} onError={handleCoverError} className="w-full h-full object-cover blur-3xl opacity-20 scale-150" alt="" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-slate-50 dark:to-black" />
        <button
          onClick={onBack}
          className="absolute left-5 p-3 bg-white/80 dark:bg-[#1c1c1e]/80 backdrop-blur-xl rounded-2xl border border-slate-200 dark:border-white/10 shadow-sm text-slate-900 dark:text-white active:scale-95 transition-all z-20"
          style={{ top: 'calc(2.5rem + var(--safe-top))' }}
        >
          <ArrowLeft size={18} strokeWidth={3} />
        </button>
      </div>

      <div className="px-6 -mt-32 relative z-10 pb-20 max-w-4xl mx-auto">
        <div className="flex gap-6 items-start">
          <div className="relative">
            <img src={coverSrc} onError={handleCoverError} className="w-36 aspect-[3/4] object-cover rounded-[2.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.15)] border-4 border-white dark:border-[#1c1c1e]" alt="" />
            <button onClick={handleToggleFav} className="absolute -bottom-3 -right-3 bg-red-600 text-white p-2.5 rounded-2xl shadow-xl active:scale-90 transition-all hover:bg-red-700 focus:outline-none" aria-label="Toggle Favorite">
              <Heart size={20} fill={isFav ? "white" : "none"} strokeWidth={isFav ? 0 : 3} />
            </button>
          </div>
          <div className="flex-1 pt-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-black uppercase text-red-600 bg-red-50 dark:bg-red-500/15 px-2 py-0.5 rounded-md tracking-widest">{item.type}</span>
            </div>
            <h1 className="text-2xl font-black leading-tight text-slate-900 dark:text-white tracking-tight drop-shadow-sm mb-3">{pickText(item.title, lang)}</h1>
            <div className="flex items-center gap-3 bg-white dark:bg-[#1c1c1e] w-fit px-3 py-1.5 rounded-xl border border-slate-100 dark:border-white/10 shadow-sm">
              <Star size={14} className="text-red-600 fill-red-600" />
              <span className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-tighter">{t.rating}: {avgRating} / 5</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-6">
          <div className="bg-white/60 dark:bg-[#1c1c1e] backdrop-blur-md p-5 rounded-3xl border border-white dark:border-white/10 shadow-sm">
            <div className="flex items-center gap-3 mb-1"><User size={14} className="text-red-600" /><p className="text-[9px] uppercase font-black text-slate-400 dark:text-slate-500 tracking-widest">{t.author}</p></div>
            <p className="text-sm font-black truncate text-slate-900 dark:text-white tracking-tight">{item.author}</p>
          </div>
          <div className="bg-white/60 dark:bg-[#1c1c1e] backdrop-blur-md p-5 rounded-3xl border border-white dark:border-white/10 shadow-sm">
            <div className="flex items-center gap-3 mb-1"><Calendar size={14} className="text-red-600" /><p className="text-[9px] uppercase font-black text-slate-400 dark:text-slate-500 tracking-widest">{t.published}</p></div>
            <p className="text-sm font-black truncate text-slate-900 dark:text-white tracking-tight">{item.publishedDate}</p>
          </div>
        </div>

        <div className="bg-white dark:bg-[#1c1c1e] p-5 rounded-[2.5rem] border border-slate-100 dark:border-white/10 shadow-sm mt-4 flex items-center justify-between px-8">
          <p className="text-[10px] uppercase font-black text-slate-400 dark:text-slate-500 tracking-widest">{t.rateThis}</p>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map(star => (
              <button key={star} onClick={() => handleRate(star)} className="focus:outline-none transition-transform active:scale-90 active:rotate-12">
                <Star size={22} className={`transition-colors duration-300 ${star <= userRating ? "text-yellow-400 fill-yellow-400 drop-shadow-sm" : "text-slate-200 dark:text-slate-600 fill-slate-50 dark:fill-slate-700"}`} strokeWidth={star <= userRating ? 0 : 2} />
              </button>
            ))}
          </div>
        </div>

        {pickText(item.description, lang, '').trim() && (
          <div className="mt-8">
            <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500 mb-4 flex items-center gap-3"><span className="w-10 h-[2px] bg-red-600"></span>{t.about}</h2>
            <div className="bg-white dark:bg-[#1c1c1e] p-6 rounded-[2.5rem] border border-slate-100 dark:border-white/10 shadow-sm leading-relaxed text-slate-600 dark:text-slate-300 text-sm whitespace-pre-line">{pickText(item.description, lang, '')}</div>
          </div>
        )}

        {playableVideos.length > 0 && (
          <div className="mt-10">
            <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500 mb-4 flex items-center gap-3"><span className="w-10 h-[2px] bg-red-600"></span>{t.preview}</h2>
            <div className="space-y-6">
              {playableVideos.map(v => (
                <div key={v.id}>
                  {v.source && (
                    <span className="inline-block mb-2 text-[10px] font-black uppercase tracking-widest text-red-600 bg-red-50 dark:bg-red-500/15 px-3 py-1 rounded-lg">{v.source}</span>
                  )}
                  <div className="aspect-video rounded-[2rem] overflow-hidden border-4 border-white dark:border-[#1c1c1e] shadow-2xl bg-slate-100 dark:bg-[#1c1c1e] relative group">{v.embed}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {item.formats.length > 0 && (
        <div className="mt-10">
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500 mb-4 flex items-center gap-3"><span className="w-10 h-[2px] bg-red-600"></span>{t.downloads}</h2>
          <div className="space-y-4">
            {item.formats.map(f => {
              const isFileReadAllowed     = (item.allowReading !== false) && (f.allowReading !== false);
              const isFileDownloadAllowed = (item.allowDownload !== false) && (f.allowDownload !== false);
              return (
                <div key={f.id} className="p-3 bg-white dark:bg-[#1c1c1e] border border-slate-100 dark:border-white/10 rounded-[2.5rem] shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
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
                        <div className="bg-slate-100 dark:bg-white/10 text-slate-500 dark:text-slate-300 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-white/10 flex items-center gap-1.5">
                          <Globe size={10} strokeWidth={3} /><span className="text-[9px] font-black uppercase tracking-wider">{f.language}</span>
                        </div>
                      )}
                      <span className="text-[9px] font-black text-slate-300 dark:text-slate-500 uppercase tracking-wider ml-1">{f.size}</span>
                    </div>
                    {isFileReadAllowed && isFileDownloadAllowed && (
                      <a href={f.url} download onClick={() => trackActivity('download', item.id)} className="p-2 bg-white dark:bg-white/10 text-slate-300 dark:text-slate-400 hover:text-red-600 border border-slate-100 dark:border-white/10 rounded-xl transition-all shadow-sm">
                        <Download size={18} strokeWidth={2.5} />
                      </a>
                    )}
                    {!isFileReadAllowed && !isFileDownloadAllowed && (
                      <div className="p-2 text-slate-300 dark:text-slate-600"><Lock size={16} strokeWidth={2.5} /></div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        )}
      </div>

      {/* ── EPUB Reader ────────────────────────────────────────────────────── */}
      {activeEpubUrl && (
        <div className={`fixed inset-0 z-[500] ${READER_CHROME[readerTheme].bg} flex flex-col animate-in fade-in duration-300`}>
          <header className={`px-4 pb-4 flex items-center justify-between ${READER_CHROME[readerTheme].bg} border-b ${READER_CHROME[readerTheme].border} shrink-0 ${chromeVisible ? '' : 'hidden'}`}
            style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
            <div className="flex items-center gap-2 shrink-0">
              {toc.length > 0 && (
                <button onClick={() => { setShowToc(s => !s); setShowBookmarks(false); setShowAnnotations(false); setShowSearch(false); }}
                  className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all`} title="Содержание">
                  <List size={16} />
                </button>
              )}
              <div className="p-2 bg-red-600 rounded-lg text-white"><BookOpen size={16} /></div>
              <p className={`text-xs font-black ${READER_CHROME[readerTheme].text} truncate max-w-[120px]`}>{pickText(item.title, lang)}</p>
            </div>
            <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar min-w-0 py-2 -my-2 px-1 -mx-1">
              <button onClick={() => { setShowSearch(s => !s); setShowToc(false); setShowBookmarks(false); setShowAnnotations(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title="Поиск">
                <Search size={16} />
              </button>
              <button onClick={cycleTheme} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title="Тема">
                <ThemeIcon size={16} />
              </button>
              <button onClick={cycleNotesDisplay} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title={notesTitle}>
                <NotesIcon size={16} />
              </button>
              <button onClick={handleAddEpubBookmark} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title="Добавить закладку">
                <BookmarkPlus size={16} />
              </button>
              <button onClick={() => { setShowBookmarks(s => !s); setShowToc(false); setShowAnnotations(false); setShowSearch(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all relative shrink-0`} title="Закладки">
                <BookMarked size={16} />
                {bookmarks.filter(b => !/^\d+$/.test(b.position)).length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{bookmarks.filter(b => !/^\d+$/.test(b.position)).length}</span>}
              </button>
              <button onClick={() => { setShowAnnotations(s => !s); setShowBookmarks(false); setShowToc(false); setShowSearch(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all relative shrink-0`} title="Аннотации">
                <Highlighter size={16} />
                {annotations.filter(a => a.cfi_range).length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{annotations.filter(a => a.cfi_range).length}</span>}
              </button>
              </div>
              <button onClick={() => setActiveEpubUrl(null)} aria-label="Закрыть читалку" className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`}><X size={20} /></button>
            </div>
          </header>

          <div className="flex-1 relative overflow-hidden"
            style={{ background: readerTheme === 'night' ? '#0f172a' : readerTheme === 'sepia' ? '#f4ecd8' : '#ffffff' }}>
            <div ref={epubViewerRef} className="w-full h-full" />
            {showToc && <EpubTocPanel />}
            {showBookmarks && <BookmarksPanel isEpub={true} onJump={b => renditionRef.current?.display(b.position)} />}
            {showAnnotations && <AnnotationsPanel isEpub={true} />}
            {showSearch && SearchPanel({})}
            {annotationDraft !== null && AnnotationSheet({})}
            {bookmarkDraft !== null && BookmarkSheet({})}
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

          <footer className={`px-4 pt-3 ${READER_CHROME[readerTheme].bg} border-t ${READER_CHROME[readerTheme].border} flex items-center justify-between gap-3 shrink-0 ${chromeVisible ? '' : 'hidden'}`}
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
          <header className={`px-4 pb-4 flex items-center justify-between ${READER_CHROME[readerTheme].bg} border-b ${READER_CHROME[readerTheme].border} shrink-0 ${chromeVisible ? '' : 'hidden'}`}
            style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
            <div className="flex items-center gap-2 shrink-0">
              {pdfToc.length > 0 && (
                <button onClick={() => { setShowToc(s => !s); setShowBookmarks(false); setShowAnnotations(false); setShowSearch(false); }}
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
            <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar min-w-0 py-2 -my-2 px-1 -mx-1">
              <button onClick={() => { setShowSearch(s => !s); setShowToc(false); setShowBookmarks(false); setShowAnnotations(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title="Поиск">
                <Search size={16} />
              </button>
              <button onClick={cycleTheme} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title="Тема">
                <ThemeIcon size={16} />
              </button>
              <button onClick={cycleNotesDisplay} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title={notesTitle}>
                <NotesIcon size={16} />
              </button>
              <button onClick={handleAddPdfBookmark} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title="Добавить закладку">
                <BookmarkPlus size={16} />
              </button>
              <button onClick={() => { setShowBookmarks(s => !s); setShowAnnotations(false); setShowToc(false); setShowSearch(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all relative shrink-0`} title="Закладки">
                <BookMarked size={16} />
                {bookmarks.filter(b => /^\d+$/.test(b.position)).length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{bookmarks.filter(b => /^\d+$/.test(b.position)).length}</span>}
              </button>
              <button onClick={() => { setShowAnnotations(s => !s); setShowBookmarks(false); setShowToc(false); setShowSearch(false); }} className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all relative shrink-0`} title="Аннотации">
                <Highlighter size={16} />
                {annotations.filter(a => a.page != null).length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{annotations.filter(a => a.page != null).length}</span>}
              </button>
              <button
                onClick={() => { setAnnotationDraft({ page: pdfPage, text: '' }); setDraftNote(''); setDraftColor('yellow'); }}
                className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`} title="Добавить заметку">
                <PenLine size={16} />
              </button>
              </div>
              <button onClick={() => setActiveReaderUrl(null)} aria-label="Закрыть читалку" className={`p-2.5 ${READER_CHROME[readerTheme].btn} rounded-xl transition-all shrink-0`}><X size={20} /></button>
            </div>
          </header>

          <div className="flex-1 relative overflow-hidden">
            <div
              className={`w-full h-full overflow-auto ${PDF_BG[readerTheme]}`}
              onPointerDown={(e) => { lastPointerTypeRef.current = e.pointerType; }}
              onTouchStart={handleTouchStart}
              onTouchEnd={handlePdfTouchEnd}
              onClick={() => {
                if (lastPointerTypeRef.current === 'mouse') return;
                if (showToc || showBookmarks || showAnnotations || showSearch || annotationDraft || bookmarkDraft) return;
                setChromeVisible(v => !v);
              }}
              onWheel={(e) => {
                if (pdfScale !== 1) return; // let native overflow scroll when zoomed
                const now = Date.now();
                if (now - wheelThrottleRef.current < 500) return;
                if (Math.abs(e.deltaY) < 20) return;
                wheelThrottleRef.current = now;
                if (e.deltaY > 0) setPdfPage(p => Math.min(pdfTotalPages, p + 1));
                else              setPdfPage(p => Math.max(1, p - 1));
              }}
            >
              <div ref={pdfContainerRef} className="mx-auto w-fit" />
            </div>
            {/* Note markers for the current page — full cards, mini dots, or hidden */}
            {notesDisplay !== 'hidden' && annotations.filter(a => a.page === pdfPage).length > 0 && (
              notesDisplay === 'full' ? (
                <div className="absolute top-3 right-3 z-10 flex flex-col gap-2 max-w-[220px]">
                  {annotations.filter(a => a.page === pdfPage).map(a => (
                    <div key={a.id} className={`group relative px-3 py-2 rounded-2xl shadow-lg border border-black/5 ${HIGHLIGHT_COLOR_BG[a.color as HighlightColor] || 'bg-yellow-400'}`}>
                      <p className="text-[11px] font-bold text-slate-900 leading-snug pr-4 break-words">
                        {a.note || a.selected_text || 'Заметка'}
                      </p>
                      <button
                        onClick={() => handleDeleteAnnotation(a.id)}
                        className="absolute top-1 right-1 p-1 text-slate-900/40 hover:text-red-700 transition-colors"
                        title="Удалить"
                      >
                        <X size={12} strokeWidth={3} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="absolute top-3 right-3 z-10 flex flex-wrap gap-1.5 justify-end max-w-[120px]">
                  {annotations.filter(a => a.page === pdfPage).map(a => (
                    <div
                      key={a.id}
                      title={a.note || a.selected_text || 'Заметка'}
                      className={`w-3.5 h-3.5 rounded-full shadow border border-black/10 ${HIGHLIGHT_COLOR_BG[a.color as HighlightColor] || 'bg-yellow-400'}`}
                    />
                  ))}
                </div>
              )
            )}
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
            {showBookmarks && <BookmarksPanel isEpub={false} onJump={b => { setPdfPage(parseInt(b.position)); }} />}
            {showAnnotations && <AnnotationsPanel isEpub={false} />}
            {showSearch && SearchPanel({})}
            {annotationDraft !== null && AnnotationSheet({ isPdf: true })}
            {bookmarkDraft !== null && BookmarkSheet({})}
          </div>

          <footer className={`px-4 pt-3 ${READER_CHROME[readerTheme].bg} border-t ${READER_CHROME[readerTheme].border} flex items-center justify-between gap-3 shrink-0 ${chromeVisible ? '' : 'hidden'}`}
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
