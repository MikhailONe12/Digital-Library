import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { subscribeToasts, toast, ToastItem } from '../services/toast';

const STYLES: Record<ToastItem['kind'], { ring: string; icon: React.ReactNode }> = {
  success: { ring: 'border-green-200 text-green-700', icon: <CheckCircle2 size={16} className="text-green-600 shrink-0" /> },
  error:   { ring: 'border-red-200 text-red-700',     icon: <AlertCircle size={16} className="text-red-600 shrink-0" /> },
  info:    { ring: 'border-slate-200 text-slate-700', icon: <Info size={16} className="text-slate-500 shrink-0" /> },
};

const Toaster: React.FC = () => {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  if (items.length === 0) return null;

  return (
    <div
      className="fixed z-[1000] left-1/2 -translate-x-1/2 flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm pointer-events-none"
      style={{ bottom: 'calc(1rem + var(--safe-bottom))' }}
      aria-live="polite"
    >
      {items.map(t => {
        const s = STYLES[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-lg border bg-white dark:bg-[#1c1c1e] dark:border-white/10 text-xs font-bold animate-in slide-in-from-bottom-4 fade-in duration-300 ${s.ring}`}
          >
            {s.icon}
            <span className="flex-1 leading-snug break-words">{t.message}</span>
            <button onClick={() => toast.dismiss(t.id)} aria-label="Закрыть" className="text-slate-300 hover:text-slate-500 shrink-0">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default Toaster;
