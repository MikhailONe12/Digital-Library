// Multi-author chip editor for the admin item form. The first chip is the
// "primary" author — what the home-card / search / deep-link surface as
// `item.author` (the other library code keeps using that field for backward
// compatibility). Drag isn't supported yet, but click → ← / → → reorders so
// the primary slot can be moved without retyping.

import React, { useState } from 'react';
import { X, Plus, ArrowLeft, ArrowRight, Crown } from 'lucide-react';

interface Props {
  authors: string[];
  onChange: (authors: string[]) => void;
  placeholder?: string;
  /** Displayed above the chip row — when omitted the label is hidden. */
  label?: string;
}

const AuthorsEditor: React.FC<Props> = ({ authors, onChange, placeholder, label }) => {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const v = draft.trim();
    if (!v) return;
    // Comma / semicolon split lets users paste "Иванов, Петров" and get two
    // chips in one go. Duplicates are dropped silently (case-insensitive).
    const parts = v.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    const lower = new Set(authors.map(a => a.toLowerCase()));
    const next = [...authors];
    for (const p of parts) {
      if (lower.has(p.toLowerCase())) continue;
      lower.add(p.toLowerCase());
      next.push(p);
    }
    onChange(next);
    setDraft('');
  };

  const remove = (i: number) => {
    const next = authors.slice();
    next.splice(i, 1);
    onChange(next);
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= authors.length) return;
    const next = authors.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {label && (
        <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-2 block">
          {label}
        </label>
      )}
      {/* Input row — Enter or comma commits. Backspace on empty input pops
          the last chip, mirroring the GitHub / Linear chip pattern. */}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={placeholder}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && draft === '' && authors.length > 0) {
              remove(authors.length - 1);
            }
          }}
          className="flex-1 min-w-0 bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08] rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
        />
        <button
          type="button"
          onClick={commit}
          disabled={!draft.trim()}
          className="px-4 bg-red-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest disabled:opacity-40 active:scale-95 transition-all shrink-0 flex items-center gap-1"
        >
          <Plus size={12} strokeWidth={3} />
        </button>
      </div>

      {authors.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {authors.map((a, i) => (
            <span
              key={`${a}-${i}`}
              className={`inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg text-[11px] font-bold border ${
                i === 0
                  ? 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300 border-red-100 dark:border-red-500/20'
                  : 'bg-slate-50 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 border-slate-100 dark:border-white/[0.08]'
              }`}
            >
              {i === 0 && <Crown size={10} strokeWidth={2.5} className="text-red-600 dark:text-red-400" />}
              <span className="max-w-[180px] truncate">{a}</span>
              {/* Reorder + remove. The arrows only appear from position 2 on,
                  because the leftmost chip already wears the crown. */}
              {i > 0 && (
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  className="p-0.5 hover:bg-white/40 dark:hover:bg-white/10 rounded transition-colors"
                  title="Make primary"
                >
                  <ArrowLeft size={10} strokeWidth={2.5} />
                </button>
              )}
              {i < authors.length - 1 && (
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  className="p-0.5 hover:bg-white/40 dark:hover:bg-white/10 rounded transition-colors"
                >
                  <ArrowRight size={10} strokeWidth={2.5} />
                </button>
              )}
              <button
                type="button"
                onClick={() => remove(i)}
                className="p-0.5 hover:bg-red-500/20 rounded transition-colors"
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default AuthorsEditor;
