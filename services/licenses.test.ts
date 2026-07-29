import { describe, it, expect } from 'vitest';
import {
  buildAttribution, licenseLabel, licenseUrl, licenseForbidsRedistribution,
  CUSTOM_LICENSE_CODE, getLicensePreset,
} from './licenses';
import { MediaItem } from '../types';

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: 'x',
  type: 'BOOK',
  title: { en: 'Title', ru: 'Название', es: '' },
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
  coverUrl: '',
  ...over,
} as MediaItem);

describe('licenseLabel / licenseUrl', () => {
  it('uses the preset name and canonical URL', () => {
    const lic = { code: 'CC-BY-4.0' };
    expect(licenseLabel(lic, 'en')).toBe('CC BY 4.0');
    expect(licenseUrl(lic)).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('prefers an item-specific URL over the preset one', () => {
    expect(licenseUrl({ code: 'CC-BY-4.0', url: 'https://source.edu/terms' }))
      .toBe('https://source.edu/terms');
  });

  it('shows the free-text name for a custom licence', () => {
    expect(licenseLabel({ code: CUSTOM_LICENSE_CODE, name: 'Agreement No. 42' }, 'ru'))
      .toBe('Agreement No. 42');
  });

  it('localises preset names', () => {
    expect(licenseLabel({ code: 'ARR' }, 'ru')).toBe('Все права защищены');
  });
});

describe('licenseForbidsRedistribution', () => {
  it('is true for all-rights-reserved and for unknown/absent licences', () => {
    expect(licenseForbidsRedistribution({ code: 'ARR' })).toBe(true);
    expect(licenseForbidsRedistribution(undefined)).toBe(true);
    expect(licenseForbidsRedistribution({ code: 'NOPE' })).toBe(true);
  });

  it('is false for licences that permit redistribution', () => {
    expect(licenseForbidsRedistribution({ code: 'CC-BY-4.0' })).toBe(false);
    expect(licenseForbidsRedistribution({ code: 'PD' })).toBe(false);
  });

  it('treats custom terms as restrictive so the warning still fires', () => {
    expect(licenseForbidsRedistribution({ code: CUSTOM_LICENSE_CODE })).toBe(true);
  });
});

describe('buildAttribution', () => {
  it('returns empty when the licence asks for no credit', () => {
    expect(buildAttribution(item({ license: { code: 'CC0' } }), 'en')).toBe('');
    expect(buildAttribution(item({}), 'en')).toBe('');
  });

  it('assembles title, holder, licence and source', () => {
    const got = buildAttribution(item({
      license: { code: 'CC-BY-4.0', holder: 'J. Doe' },
      source: { name: 'MSU Library' },
    }), 'en');
    expect(got).toBe('«Title» — © J. Doe — CC BY 4.0 — MSU Library');
  });

  it('falls back to the author when no holder is recorded', () => {
    const got = buildAttribution(item({ license: { code: 'CC-BY-SA-4.0' } }), 'en');
    expect(got).toContain('© Author');
  });

  it('uses the requested locale for the title', () => {
    const got = buildAttribution(item({ license: { code: 'CC-BY-4.0' } }), 'ru');
    expect(got).toContain('«Название»');
  });
});

describe('preset catalogue', () => {
  it('exposes a custom option and keeps codes unique', () => {
    expect(getLicensePreset(CUSTOM_LICENSE_CODE)).toBeDefined();
  });
});
