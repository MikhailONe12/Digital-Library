import { MediaItem, Locale, ContentLang } from '../types';
import { pickText } from '../utils';

export type SortBy = 'recent' | 'rating' | 'views' | 'alpha';
export type SpecialCategory = 'ALL' | 'FAVORITES' | 'NEW' | 'HISTORY';

export interface CatalogQuery {
  searchQuery: string;
  searchField: 'all' | 'title' | 'author';
  activeCategory: string | SpecialCategory;
  contentLangFilter: ContentLang[];
  sortBy: SortBy;
  lang: Locale;
  isAdmin: boolean;
  globalAccess: boolean;
  allowedUsers: string[];
  user?: { id: number | string; username?: string } | null;
  isFavorite: (itemId: string) => boolean;
  ratingOf: (itemId: string) => number;
  viewHistory: string[];
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  now?: number;
}

const NEW_WINDOW_DAYS = 30;
const NEW_LIMIT = 20;

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

  // 3. Search
  const needle = q.searchQuery.toLowerCase();
  available = available.filter(item => {
    const title = pickText(item.title, q.lang).toLowerCase();
    const author = (item.author || '').toLowerCase();
    if (q.searchField === 'title') return title.includes(needle);
    if (q.searchField === 'author') return author.includes(needle);
    return title.includes(needle) || author.includes(needle);
  });

  // 4. Category (NEW and HISTORY have their own ordering and return early)
  if (q.activeCategory === 'FAVORITES') {
    available = available.filter(item => q.isFavorite(item.id));
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

  // 5. Sort
  const sorted = [...available];
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
