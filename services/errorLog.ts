// Lightweight client-side error reporter — the browser half of the built-in
// monitoring that replaces an external Sentry. Installs global handlers for
// uncaught errors and unhandled promise rejections, and exposes captureError()
// for explicit reporting (used by the React error boundary). Reports are POSTed
// to /api/errors, which is rate-limited server-side.

interface ErrorReport {
  kind: 'error' | 'unhandledrejection' | 'react';
  message: string;
  stack?: string;
  url?: string;
}

// De-dupe identical messages within a short window so a render loop or a
// repeating interval can't spam the endpoint (and the DB) hundreds of times.
const recentlySent = new Map<string, number>();
const DEDUP_WINDOW = 10_000; // 10s

const tgHeaders = (): Record<string, string> => {
  const initData = (window as any).Telegram?.WebApp?.initData || '';
  return initData ? { 'x-telegram-init-data': initData } : {};
};

// Reports that can never be acted on. Without this filter they crowd out the
// ones that matter — the log was 12 entries deep and all but one of them came
// from here.
//
//  • Crawlers. Googlebot and friends run environments we don't target and have
//    no service-worker support, so they reliably generate failures no visitor
//    ever sees. Nothing they report is about our code.
//  • Service-worker registration. The PWA plugin ships a self-destroying
//    worker whose only job is to clear a legacy cache; registerSW.js rejects
//    wherever registration isn't available (crawlers, pages opened by raw IP
//    instead of the domain). Failing there is expected and harmless — the app
//    doesn't depend on the worker.
const CRAWLER_UA = /bot\b|crawler|spider|slurp|headlesschrome|lighthouse|pingdom|gtmetrix|semrush|ahrefs/i;
const NOISE = [
  /ServiceWorker/i,
  /service worker/i,
  /registerSW/i,
];

const isNoise = (r: ErrorReport): boolean => {
  try {
    if (CRAWLER_UA.test(navigator.userAgent || '')) return true;
  } catch { /* no navigator — keep the report */ }
  const text = `${r.message || ''} ${r.stack || ''} ${r.url || ''}`;
  return NOISE.some(re => re.test(text));
};

export const captureError = (r: ErrorReport): void => {
  try {
    if (isNoise(r)) return;
    const sig = `${r.kind}:${r.message}`.slice(0, 200);
    const now = Date.now();
    const last = recentlySent.get(sig);
    if (last && now - last < DEDUP_WINDOW) return;
    recentlySent.set(sig, now);
    // Prune the dedup map opportunistically.
    if (recentlySent.size > 50) {
      for (const [k, t] of recentlySent) if (now - t > DEDUP_WINDOW) recentlySent.delete(k);
    }

    const body = JSON.stringify({
      kind: r.kind,
      message: (r.message || '(no message)').slice(0, 2000),
      stack: (r.stack || '').slice(0, 8000),
      url: r.url || location.href,
    });

    // keepalive lets the report survive a navigation/unload that may follow a
    // fatal error. Fire-and-forget — logging must never throw.
    fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tgHeaders() },
      body,
      keepalive: true,
    }).catch(() => { /* offline / blocked — give up silently */ });
  } catch { /* never let the reporter itself surface */ }
};

let installed = false;
export const installErrorReporting = (): void => {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    captureError({
      kind: 'error',
      message: e.message || String(e.error || 'Unknown error'),
      stack: e.error?.stack,
      url: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : location.href,
    });
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason: any = e.reason;
    captureError({
      kind: 'unhandledrejection',
      message: reason?.message || String(reason) || 'Unhandled promise rejection',
      stack: reason?.stack,
    });
  });
};
