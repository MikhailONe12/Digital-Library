
import React, { useEffect, useRef, useState } from 'react';
import { MediaItem, Locale, FileFormat, Bookmark } from '../types';
import {
  ArrowLeft, Download, Star, Calendar, User, FileText, BookOpen, X, Lock, Heart,
  Globe, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, BookmarkPlus, BookMarked,
  Trash2, List, Sun, Moon, SunDim,
} from 'lucide-react';
// @ts-ignore
import ePub from 'epubjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  trackActivity, toggleFavorite, isFavorited, getUserRating, setUserRating,
  getAverageRating, getBookmarks, addBookmark, deleteBookmark,
  getReadingProgress, saveReadingProgress,
} from '../services/db';
import { pickText, handleCoverError } from '../utils';

type ReaderTheme = 'default' | 'night' | 'sepia';

interface TocItem { href: string; label: string; subitems?: TocItem[] }

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
  sepia:   'sepia(0.75) brightness(1.05)',
};

const PDF_BG: Record<ReaderTheme, string> = {
  default: 'bg-slate-800',
  night:   'bg-slate-950',
  sepia:   'bg-amber-100',
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

  // EPUB
  const [epubFontSize, setEpubFontSize] = useState<number>(() => {
    const v = localStorage.getItem(FONT_KEY);
    return v ? parseInt(v) : 100;
  });
  const [toc, setToc]         = useState<TocItem[]>([]);
  const [showToc, setShowToc] = useState(false);

  // Theme: persisted
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(() => {
    return (localStorage.getItem(THEME_KEY) as ReaderTheme) || 'default';
  });

  // Bookmarks
  const [bookmarks, setBookmarks]         = useState<Bookmark[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);

  // Item
  const [userRating, setUserRatingState] = useState(0);
  const [avgRating, setAvgRating]        = useState(item.rating);
  const [isFav, setIsFav]                = useState(false);

  const epubViewerRef     = useRef<HTMLDivElement>(null);
  const renditionRef      = useRef<any>(null);
  const pdfCanvasRef      = useRef<HTMLCanvasElement>(null);
  const pdfDocRef         = useRef<any>(null);
  const pdfRenderTaskRef  = useRef<any>(null);
  const touchStartX       = useRef(0);
  const touchStartY       = useRef(0);

  const tg     = (window as any).Telegram?.WebApp;
  const userId = tg?.initDataUnsafe?.user?.id?.toString() || 'guest_user';

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
    } else {
      setShowBookmarks(false);
      setShowToc(false);
      setBookmarks([]);
      setToc([]);
    }
  }, [activeReaderUrl, activeEpubUrl]);

  // ── EPUB init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeEpubUrl || !epubViewerRef.current) return;
    const book = ePub(activeEpubUrl);
    const rendition = book.renderTo(epubViewerRef.current, {
      width: '100%', height: '100%', spread: 'none',
    });

    // Register all themes upfront
    Object.entries(EPUB_THEMES).forEach(([name, styles]) => {
      rendition.themes.register(name, styles);
    });
    rendition.themes.select(readerTheme);
    rendition.themes.fontSize(epubFontSize + '%');

    // Load TOC
    book.loaded.navigation.then((nav: any) => setToc(nav?.toc || []));

    // Restore last position or start at beginning
    getReadingProgress(userId, item.id).then(progress => {
      if (progress?.format_url?.endsWith('.epub') && progress.position) {
        rendition.display(progress.position);
      } else {
        rendition.display();
      }
    });

    // Save progress on every navigation
    rendition.on('relocated', (location: any) => {
      const cfi = location?.start?.cfi;
      const pct = Math.round((location?.start?.percentage || 0) * 100);
      if (cfi) saveReadingProgress(userId, item.id, cfi, pct, activeEpubUrl);
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

    renditionRef.current = rendition;
    return () => { renditionRef.current = null; book.destroy(); };
  }, [activeEpubUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // EPUB zoom live update
  useEffect(() => { renditionRef.current?.themes?.fontSize(epubFontSize + '%'); }, [epubFontSize]);

  // EPUB theme live update
  useEffect(() => { renditionRef.current?.themes?.select(readerTheme); }, [readerTheme]);

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
        const doc = await pdfjsLib.getDocument(activeReaderUrl).promise;
        if (cancelled) { try { doc.destroy(); } catch { /* noop */ } return; }
        pdfDocRef.current = doc;

        let startPage = 1;
        try {
          const progress = await getReadingProgress(userId, item.id);
          if (progress?.format_url?.endsWith('.pdf') && progress.position) {
            const saved = parseInt(progress.position);
            if (saved > 0 && saved <= doc.numPages) startPage = saved;
          }
        } catch { /* progress is best-effort */ }
        if (cancelled) return;

        // Set total + page together so the render effect runs once, settled.
        setPdfTotalPages(doc.numPages);
        setPdfPage(startPage);
      } catch (e: any) {
        if (!cancelled) setPdfError('Не удалось открыть PDF: ' + (e?.message || String(e)));
      }
    })();
    return () => { cancelled = true; };
  }, [activeReaderUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // PDF render — re-renders on every page/scale change. Spurious effect
  // re-runs simply re-render the same page rather than leaving it blank.
  useEffect(() => {
    if (!activeReaderUrl || pdfTotalPages === 0) return;
    const doc    = pdfDocRef.current;
    const canvas = pdfCanvasRef.current;
    if (!doc || !canvas) return;

    let disposed = false;

    (async () => {
      // Cancel any in-flight render before drawing a new one. pdf.js throws if
      // two render() calls overlap on the same canvas, so this must land.
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
      if (disposed || pdfCanvasRef.current !== canvas) return;

      const containerWidth = canvas.parentElement?.clientWidth || window.innerWidth || 800;
      const base           = page.getViewport({ scale: 1 });
      const viewport       = page.getViewport({ scale: (containerWidth / base.width) * pdfScale });
      canvas.width  = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      let task: any;
      try {
        // Pass `canvas` (the pdf.js v5 recommended param) — pdf.js creates its
        // own opaque 2D context internally.
        task = page.render({ canvas, viewport });
      } catch (e: any) {
        if (!disposed) setPdfError('Ошибка рендера: ' + (e?.message || String(e)));
        return;
      }
      pdfRenderTaskRef.current = task;
      try {
        await task.promise;
        if (!disposed) setPdfError(null);
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  const cycleTheme = () => {
    setReaderTheme(t => t === 'default' ? 'night' : t === 'night' ? 'sepia' : 'default');
  };

  const ThemeIcon = readerTheme === 'night' ? Moon : readerTheme === 'sepia' ? SunDim : Sun;

  const refreshBookmarks = () => getBookmarks(userId, item.id).then(setBookmarks);

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
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) setPdfPage(p => Math.min(pdfTotalPages, p + 1));
      else         setPdfPage(p => Math.max(1, p - 1));
    }
  };

  const getVideoEmbed = (url?: string) => {
    if (!url) return null;
    const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/);
    if (ytMatch) return <iframe width="100%" height="100%" src={`https://www.youtube.com/embed/${ytMatch[1]}`} frameBorder="0" allowFullScreen></iframe>;
    const rtMatch = url.match(/rutube\.ru\/video\/([a-z0-9]+)/i);
    if (rtMatch) return <iframe width="100%" height="100%" src={`https://rutube.ru/play/embed/${rtMatch[1]}`} frameBorder="0" allowFullScreen></iframe>;
    if (/\.(mp4|webm|ogg|mov)$/i.test(url)) return <video src={url} controls className="w-full h-full bg-slate-100" poster={item.coverUrl} />;
    return null;
  };

  const videoPlayer = getVideoEmbed(item.videoUrl);

  const handleRead = (format: FileFormat) => {
    const url = format.url.toLowerCase();
    if (url.endsWith('.pdf') || format.name.toLowerCase().includes('pdf')) {
      setActiveReaderUrl(format.url);
    } else if (url.endsWith('.epub')) {
      setActiveEpubUrl(format.url);
    } else {
      window.open(format.url, '_blank');
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

  const TocPanel = () => {
    const renderItems = (items: TocItem[], depth = 0) => items.map(item => (
      <React.Fragment key={item.href}>
        <button
          onClick={() => { renditionRef.current?.display(item.href); setShowToc(false); }}
          className="w-full text-left p-3 hover:bg-white/10 rounded-2xl transition-colors"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <p className="text-xs font-bold text-white truncate">{item.label}</p>
        </button>
        {item.subitems && renderItems(item.subitems, depth + 1)}
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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="relative animate-in fade-in slide-in-from-right-4 duration-500 bg-slate-50 min-h-screen">
      <div className="h-72 w-full relative overflow-hidden">
        <img src={item.coverUrl} onError={handleCoverError} className="w-full h-full object-cover blur-3xl opacity-20 scale-150" alt="" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-slate-50" />
        <button onClick={onBack} className="absolute top-10 left-5 p-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 shadow-sm text-slate-900 active:scale-95 transition-all z-20">
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
              <span className="text-xs font-black text-slate-900 uppercase tracking-tighter">Conviction: {avgRating} / 5</span>
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

        {videoPlayer && (
          <div className="mt-10">
            <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 mb-4 flex items-center gap-3"><span className="w-10 h-[2px] bg-red-600"></span>{t.preview}</h2>
            <div className="aspect-video rounded-[2rem] overflow-hidden border-4 border-white shadow-2xl bg-slate-100 relative group">{videoPlayer}</div>
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
        <div className="fixed inset-0 z-[500] flex flex-col animate-in fade-in duration-300"
          style={{ background: readerTheme === 'sepia' ? '#f4ecd8' : readerTheme === 'night' ? '#0f172a' : '#1e293b' }}>
          <header className="p-4 flex items-center justify-between border-b border-white/10 shrink-0"
            style={{ background: readerTheme === 'sepia' ? '#e8d5b0' : '#0f172a' }}>
            <div className="flex items-center gap-2">
              {toc.length > 0 && (
                <button onClick={() => { setShowToc(s => !s); setShowBookmarks(false); }}
                  className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all" title="Содержание">
                  <List size={16} />
                </button>
              )}
              <div className="p-2 bg-red-600 rounded-lg text-white"><BookOpen size={16} /></div>
              <p className="text-xs font-black text-white truncate max-w-[130px]">{pickText(item.title, lang)}</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={cycleTheme} className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all" title="Тема">
                <ThemeIcon size={16} />
              </button>
              <button onClick={handleAddEpubBookmark} className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all" title="Добавить закладку">
                <BookmarkPlus size={16} />
              </button>
              <button onClick={() => { setShowBookmarks(s => !s); setShowToc(false); }} className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all relative" title="Закладки">
                <BookMarked size={16} />
                {bookmarks.length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{bookmarks.length}</span>}
              </button>
              <button onClick={() => setActiveEpubUrl(null)} className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all"><X size={20} /></button>
            </div>
          </header>

          <div className="flex-1 relative overflow-hidden">
            <div ref={epubViewerRef} className="w-full h-full" />
            {showToc && <TocPanel />}
            {showBookmarks && <BookmarksPanel onJump={b => renditionRef.current?.display(b.position)} />}
          </div>

          <footer className="p-3 border-t border-white/5 flex items-center justify-between shrink-0"
            style={{ background: readerTheme === 'sepia' ? '#e8d5b0' : '#0f172a' }}>
            <button onClick={() => renditionRef.current?.prev()} className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl text-white transition-all active:scale-90"><ChevronLeft size={22} /></button>
            <div className="flex items-center gap-1">
              <button onClick={() => setEpubFontSize(s => Math.max(70, s - 15))} disabled={epubFontSize <= 70} className="p-2 bg-white/10 hover:bg-white/20 disabled:opacity-30 rounded-xl text-white transition-all"><ZoomOut size={15} /></button>
              <span className="text-[9px] font-black text-white/40 w-10 text-center">{epubFontSize}%</span>
              <button onClick={() => setEpubFontSize(s => Math.min(200, s + 15))} disabled={epubFontSize >= 200} className="p-2 bg-white/10 hover:bg-white/20 disabled:opacity-30 rounded-xl text-white transition-all"><ZoomIn size={15} /></button>
            </div>
            <button onClick={() => renditionRef.current?.next()} className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl text-white transition-all active:scale-90"><ChevronRight size={22} /></button>
          </footer>
        </div>
      )}

      {/* ── PDF Reader ─────────────────────────────────────────────────────── */}
      {activeReaderUrl && (
        <div className="fixed inset-0 z-[500] bg-slate-900 flex flex-col animate-in fade-in duration-300">
          <header className="p-4 flex items-center justify-between bg-slate-900 border-b border-white/10 shrink-0">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-600 rounded-lg text-white"><BookOpen size={16} /></div>
              <div>
                <p className="text-[10px] font-black uppercase text-white/40 tracking-widest leading-none mb-1">PDF Reader</p>
                <p className="text-xs font-black text-white truncate max-w-[160px]">{pickText(item.title, lang)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={cycleTheme} className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all" title="Тема">
                <ThemeIcon size={16} />
              </button>
              <button onClick={handleAddPdfBookmark} className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all" title="Добавить закладку">
                <BookmarkPlus size={16} />
              </button>
              <button onClick={() => setShowBookmarks(s => !s)} className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all relative" title="Закладки">
                <BookMarked size={16} />
                {bookmarks.length > 0 && <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] w-4 h-4 rounded-full flex items-center justify-center font-black">{bookmarks.length}</span>}
              </button>
              <button onClick={() => setActiveReaderUrl(null)} className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all"><X size={20} /></button>
            </div>
          </header>

          <div className="flex-1 relative overflow-hidden">
            <div
              className={`w-full h-full overflow-y-auto ${PDF_BG[readerTheme]} flex justify-center`}
              onTouchStart={handleTouchStart}
              onTouchEnd={handlePdfTouchEnd}
            >
              <canvas
                ref={pdfCanvasRef}
                className="max-w-full self-start"
                style={{ filter: PDF_FILTER[readerTheme] }}
              />
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
                <a
                  href={activeReaderUrl}
                  download
                  onClick={() => trackActivity('download', item.id)}
                  className="bg-red-600 text-white px-5 py-3 rounded-2xl font-black uppercase tracking-[0.2em] text-[10px] flex items-center gap-2"
                >
                  <Download size={14} strokeWidth={3} />Скачать файл
                </a>
              </div>
            )}
            {showBookmarks && <BookmarksPanel onJump={b => { setPdfPage(parseInt(b.position)); }} />}
          </div>

          <footer className="p-3 bg-slate-900 border-t border-white/5 flex items-center justify-between shrink-0">
            <button onClick={() => setPdfPage(p => Math.max(1, p - 1))} disabled={pdfPage <= 1} className="p-3 bg-white/10 hover:bg-white/20 disabled:opacity-30 rounded-2xl text-white transition-all active:scale-90"><ChevronLeft size={22} /></button>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <button onClick={() => setPdfScale(s => Math.max(0.5, +(s - 0.25).toFixed(2)))} disabled={pdfScale <= 0.5} className="p-2 bg-white/10 hover:bg-white/20 disabled:opacity-30 rounded-xl text-white transition-all"><ZoomOut size={15} /></button>
                <span className="text-[9px] font-black text-white/40 w-10 text-center">{Math.round(pdfScale * 100)}%</span>
                <button onClick={() => setPdfScale(s => Math.min(3, +(s + 0.25).toFixed(2)))} disabled={pdfScale >= 3} className="p-2 bg-white/10 hover:bg-white/20 disabled:opacity-30 rounded-xl text-white transition-all"><ZoomIn size={15} /></button>
              </div>
              <p className="text-[9px] font-black text-white/40 tracking-widest">{pdfTotalPages > 0 ? `${pdfPage} / ${pdfTotalPages}` : '...'}</p>
            </div>
            <button onClick={() => setPdfPage(p => Math.min(pdfTotalPages, p + 1))} disabled={pdfPage >= pdfTotalPages} className="p-3 bg-white/10 hover:bg-white/20 disabled:opacity-30 rounded-2xl text-white transition-all active:scale-90"><ChevronRight size={22} /></button>
          </footer>
        </div>
      )}
    </div>
  );
};

export default ItemDetails;
