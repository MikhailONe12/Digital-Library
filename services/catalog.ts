import { MediaItem, Locale, ContentLang } from '../types';
import { pickText } from '../utils';

export type SortBy = 'recent' | 'rating' | 'views' | 'alpha';
export type SpecialCategory = 'ALL' | 'FAVORITES' | 'NEW' | 'HISTORY' | 'FINISHED';

export interface CatalogQuery {
  searchQuery: string;
  searchField: 'all' | 'title' | 'author';
  activeCategory: string | SpecialCategory;
  contentLangFilter: ContentLang[];
  /** AND filter — only items having every tag in this list match. */
  tagFilter?: string[];
  sortBy: SortBy;
  lang: Locale;
  isAdmin: boolean;
  globalAccess: boolean;
  allowedUsers: string[];
  user?: { id: number | string; username?: string } | null;
  isFavorite: (itemId: string) => boolean;
  ratingOf: (itemId: string) => number;
  /** Reading-progress lookup (0-100). Used by the FINISHED category. */
  progressOf?: (itemId: string) => number;
  viewHistory: string[];
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  now?: number;
}

const NEW_WINDOW_DAYS = 30;
const NEW_LIMIT = 20;

// Lowercase + strip diacritics so "Tolstoi" matches "Tolstói", "ё" ~ "е", etc.
export const normalizeText = (s: string): string =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Relevance score for an item against an already-normalized needle. Higher is
// better: title beats author beats description; a prefix/word-start match beats
// a mid-word substring. Returns 0 when nothing matches the selected field(s).
export const scoreItem = (
  item: MediaItem,
  needle: string,
  searchField: 'all' | 'title' | 'author',
  lang: Locale,
): number => {
  if (!needle) return 0;
  const title = normalizeText(pickText(item.title, lang));
  const author = normalizeText(item.author || '');
  const desc = normalizeText(pickText(item.description, lang, ''));

  const fields: Array<[number, string]> =
    searchField === 'title' ? [[60, title]]
    : searchField === 'author' ? [[45, author]]
    : [[60, title], [45, author], [25, desc]];

  const wordStart = new RegExp(`\\b${escapeRegExp(needle)}`);
  let best = 0;
  for (const [base, text] of fields) {
    if (!text.includes(needle)) continue;
    let s = base;
    if (text.startsWith(needle)) s += 30;
    else if (wordStart.test(text)) s += 15;
    if (s > best) best = s;
  }
  return best;
};

// Pure catalog pipeline: permissions → language → search → category → sort.
// Extracted from App.tsx so the behaviour can be unit-tested in isolation.
export const filterAndSortItems = (items: MediaItem[], q: CatalogQuery): MediaItem[] => {
  // 1. Access control
  let available = items.filter(item => {
    if (!item.isPrivate) return true;
    if (q.isAdmin) return true;
    if (q.globalAccess) return true;
    if (q.user) {
      const whitelisted =
        q.allowedUsers.includes(String(q.user.id)) ||
        (!!q.user.username && q.allowedUsers.includes(q.user.username.toLowerCase()));
      if (whitelisted) return true;
    }
    return false;
  });

  // 2. Content language
  if (q.contentLangFilter.length > 0) {
    available = available.filter(item =>
      q.contentLangFilter.some(l => item.contentLanguages.includes(l)),
    );
  }

  // 2b. Tags (every selected tag must be present on the item)
  if (q.tagFilter && q.tagFilter.length > 0) {
    const wanted = q.tagFilter.map(t => t.toLowerCase());
    available = available.filter(item => {
      const tags = (item.tags || []).map(t => t.toLowerCase());
      return wanted.every(w => tags.includes(w));
    });
  }

  // 3. Search (title + author + description, diacritics-insensitive)
  const needle = normalizeText(q.searchQuery.trim());
  const searching = needle.length > 0;
  const scores = new Map<string, number>();
  if (searching) {
    available = available.filter(item => {
      const s = scoreItem(item, needle, q.searchField, q.lang);
      if (s > 0) scores.set(item.id, s);
      return s > 0;
    });
  }

  // 4. Category (NEW and HISTORY have their own ordering and return early)
  if (q.activeCategory === 'FAVORITES') {
    available = available.filter(item => q.isFavorite(item.id));
  } else if (q.activeCategory === 'FINISHED') {
    const pct = q.progressOf || (() => 0);
    available = available.filter(item => pct(item.id) >= 95);
  } else if (q.activeCategory === 'NEW') {
    const cutoff = (q.now ?? Date.now()) - NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return available
      .filter(item => new Date(item.addedDate).getTime() >= cutoff)
      .sort((a, b) => new Date(b.addedDate).getTime() - new Date(a.addedDate).getTime())
      .slice(0, NEW_LIMIT);
  } else if (q.activeCategory === 'HISTORY') {
    const order = new Map(q.viewHistory.map((id, i) => [id, i]));
    return available
      .filter(item => order.has(item.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  } else if (q.activeCategory !== 'ALL') {
    available = available.filter(item => item.type === q.activeCategory);
  }

  // 5. Sort — relevance first while searching, otherwise the chosen order
  const sorted = [...available];
  if (searching) {
    sorted.sort((a, b) => {
      const diff = (scores.get(b.id) || 0) - (scores.get(a.id) || 0);
      if (diff !== 0) return diff;
      return new Date(b.addedDate).getTime() - new Date(a.addedDate).getTime();
    });
    return sorted;
  }
  if (q.sortBy === 'recent') {
    sorted.sort((a, b) => new Date(b.addedDate).getTime() - new Date(a.addedDate).getTime());
  } else if (q.sortBy === 'rating') {
    sorted.sort((a, b) => q.ratingOf(b.id) - q.ratingOf(a.id));
  } else if (q.sortBy === 'views') {
    sorted.sort((a, b) => (b.views || 0) - (a.views || 0));
  } else if (q.sortBy === 'alpha') {
    sorted.sort((a, b) => pickText(a.title, q.lang).localeCompare(pickText(b.title, q.lang)));
  }
  return sorted;
};
