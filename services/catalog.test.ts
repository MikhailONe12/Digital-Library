import { describe, it, expect } from 'vitest';
import { filterAndSortItems, CatalogQuery } from './catalog';
import { MediaItem } from '../types';

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: 'x',
  type: 'BOOK',
  title: { en: 'Title', ru: '', es: '' },
  description: { en: '', ru: '', es: '' },
  author: 'Author',
  isPrivate: false,
  contentLanguages: ['en'],
  formats: [],
  addedDate: '2026-01-01T00:00:00.000Z',
  publishedDate: '2026-01-01',
  views: 0,
  downloads: 0,
  rating: 0,
  allowDownload: true,
  allowReading: true,
  ...over,
} as MediaItem);

const baseQuery = (over: Partial<CatalogQuery> = {}): CatalogQuery => ({
  searchQuery: '',
  searchField: 'all',
  activeCategory: 'ALL',
  contentLangFilter: [],
  sortBy: 'recent',
  lang: 'en',
  isAdmin: false,
  globalAccess: false,
  allowedUsers: [],
  user: null,
  isFavorite: () => false,
  ratingOf: () => 0,
  viewHistory: [],
  ...over,
});

describe('access control', () => {
  const pub = item({ id: 'pub', isPrivate: false });
  const priv = item({ id: 'priv', isPrivate: true });

  it('hides private items from anonymous visitors', () => {
    const res = filterAndSortItems([pub, priv], baseQuery());
    expect(res.map(i => i.id)).toEqual(['pub']);
  });

  it('shows private items to admins', () => {
    const res = filterAndSortItems([pub, priv], baseQuery({ isAdmin: true }));
    expect(res.map(i => i.id).sort()).toEqual(['priv', 'pub']);
  });

  it('shows everything when global access is on', () => {
    const res = filterAndSortItems([pub, priv], baseQuery({ globalAccess: true }));
    expect(res).toHaveLength(2);
  });

  it('shows private items to whitelisted users (by id or username)', () => {
    const byId = filterAndSortItems([priv], baseQuery({ user: { id: 42 }, allowedUsers: ['42'] }));
    expect(byId).toHaveLength(1);
    const byName = filterAndSortItems([priv], baseQuery({ user: { id: 1, username: 'Neo' }, allowedUsers: ['neo'] }));
    expect(byName).toHaveLength(1);
    const denied = filterAndSortItems([priv], baseQuery({ user: { id: 1, username: 'trinity' }, allowedUsers: ['neo'] }));
    expect(denied).toHaveLength(0);
  });
});

describe('search', () => {
  const dune = item({ id: 'dune', title: { en: 'Dune', ru: '', es: '' }, author: 'Herbert' });
  const sapiens = item({ id: 'sap', title: { en: 'Sapiens', ru: '', es: '' }, author: 'Harari' });
  const all = [dune, sapiens];

  it('matches title or author with "all"', () => {
    expect(filterAndSortItems(all, baseQuery({ searchQuery: 'dune' })).map(i => i.id)).toEqual(['dune']);
    expect(filterAndSortItems(all, baseQuery({ searchQuery: 'harari' })).map(i => i.id)).toEqual(['sap']);
  });

  it('restricts to title or author field', () => {
    expect(filterAndSortItems(all, baseQuery({ searchQuery: 'herbert', searchField: 'title' }))).toHaveLength(0);
    expect(filterAndSortItems(all, baseQuery({ searchQuery: 'herbert', searchField: 'author' })).map(i => i.id)).toEqual(['dune']);
  });
});

describe('categories', () => {
  it('filters by custom type', () => {
    const b = item({ id: 'b', type: 'BOOK' });
    const v = item({ id: 'v', type: 'VIDEO' });
    expect(filterAndSortItems([b, v], baseQuery({ activeCategory: 'VIDEO' })).map(i => i.id)).toEqual(['v']);
  });

  it('FAVORITES keeps only favorited items', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    const res = filterAndSortItems([a, b], baseQuery({ activeCategory: 'FAVORITES', isFavorite: id => id === 'b' }));
    expect(res.map(i => i.id)).toEqual(['b']);
  });

  it('NEW keeps items within 30 days, newest first', () => {
    const now = Date.parse('2026-02-01T00:00:00.000Z');
    const fresh = item({ id: 'fresh', addedDate: '2026-01-20T00:00:00.000Z' });
    const old = item({ id: 'old', addedDate: '2025-11-01T00:00:00.000Z' });
    const fresher = item({ id: 'fresher', addedDate: '2026-01-29T00:00:00.000Z' });
    const res = filterAndSortItems([fresh, old, fresher], baseQuery({ activeCategory: 'NEW', now }));
    expect(res.map(i => i.id)).toEqual(['fresher', 'fresh']);
  });

  it('HISTORY orders by view-history sequence', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    const c = item({ id: 'c' });
    const res = filterAndSortItems([a, b, c], baseQuery({ activeCategory: 'HISTORY', viewHistory: ['c', 'a'] }));
    expect(res.map(i => i.id)).toEqual(['c', 'a']);
  });
});

describe('sorting', () => {
  const a = item({ id: 'a', title: { en: 'Apple', ru: '', es: '' }, views: 5, addedDate: '2026-01-01T00:00:00.000Z' });
  const z = item({ id: 'z', title: { en: 'Zebra', ru: '', es: '' }, views: 99, addedDate: '2026-03-01T00:00:00.000Z' });
  const all = [a, z];

  it('alpha sorts by localized title', () => {
    expect(filterAndSortItems(all, baseQuery({ sortBy: 'alpha' })).map(i => i.id)).toEqual(['a', 'z']);
  });
  it('views sorts descending', () => {
    expect(filterAndSortItems(all, baseQuery({ sortBy: 'views' })).map(i => i.id)).toEqual(['z', 'a']);
  });
  it('recent sorts by addedDate descending', () => {
    expect(filterAndSortItems(all, baseQuery({ sortBy: 'recent' })).map(i => i.id)).toEqual(['z', 'a']);
  });
  it('rating uses the injected ratingOf', () => {
    const ratingOf = (id: string) => (id === 'a' ? 5 : 1);
    expect(filterAndSortItems(all, baseQuery({ sortBy: 'rating', ratingOf })).map(i => i.id)).toEqual(['a', 'z']);
  });
});
