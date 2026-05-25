// Minimal dependency-free toast store. Both React components and plain modules
// (e.g. services/db.ts) can push toasts; <Toaster/> renders whatever is here.

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastItem { id: number; kind: ToastKind; message: string; }

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();
let seq = 0;

const emit = () => { for (const l of listeners) l([...toasts]); };

const remove = (id: number) => { toasts = toasts.filter(t => t.id !== id); emit(); };

const push = (kind: ToastKind, message: string, ttl: number): number => {
  const id = ++seq;
  toasts = [...toasts, { id, kind, message }];
  emit();
  if (ttl > 0) setTimeout(() => remove(id), ttl);
  return id;
};

export const toast = {
  success: (m: string) => push('success', m, 3500),
  error:   (m: string) => push('error',   m, 6000),
  info:    (m: string) => push('info',    m, 3500),
  dismiss: remove,
};

export const subscribeToasts = (l: Listener): (() => void) => {
  listeners.add(l);
  l([...toasts]);
  return () => { listeners.delete(l); };
};
