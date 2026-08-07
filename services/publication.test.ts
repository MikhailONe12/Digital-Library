import { describe, it, expect } from 'vitest';
import {
  normalizeDoi, isValidDoi, doiUrl, publicationTypeLabel, getPublicationType,
  PUBLICATION_TYPES,
} from './publication';

describe('normalizeDoi', () => {
  const doi = '10.1007/s11403-023-00379-8';

  it('accepts the bare form unchanged', () => {
    expect(normalizeDoi(doi)).toBe(doi);
  });

  it('strips the forms a publisher page actually shows', () => {
    expect(normalizeDoi(`https://doi.org/${doi}`)).toBe(doi);
    expect(normalizeDoi(`http://dx.doi.org/${doi}`)).toBe(doi);
    expect(normalizeDoi(`doi.org/${doi}`)).toBe(doi);
    expect(normalizeDoi(`doi:${doi}`)).toBe(doi);
    expect(normalizeDoi(`DOI: ${doi}`)).toBe(doi);
    expect(normalizeDoi(`  ${doi}  `)).toBe(doi);
  });

  it('drops punctuation picked up when copying from prose', () => {
    expect(normalizeDoi(`${doi}.`)).toBe(doi);
    expect(normalizeDoi(`${doi},`)).toBe(doi);
    expect(normalizeDoi(`(${doi})`)).toBe(doi);
    expect(normalizeDoi(`[${doi}]`)).toBe(doi);
  });

  it('keeps parentheses that belong to the DOI', () => {
    // Elsevier-style identifiers really do contain them.
    const lancet = '10.1016/S0140-6736(01)05627-6';
    expect(normalizeDoi(lancet)).toBe(lancet);
    expect(normalizeDoi(`https://doi.org/${lancet}`)).toBe(lancet);
    expect(normalizeDoi(`(${lancet})`)).toBe(lancet);
  });

  it('rejects things that are not DOIs', () => {
    expect(normalizeDoi('')).toBe('');
    expect(normalizeDoi('not a doi')).toBe('');
    expect(normalizeDoi('11.1007/x')).toBe('');       // must start 10.
    expect(normalizeDoi('10.7/x')).toBe('');          // registrant too short
    expect(normalizeDoi('10.1007')).toBe('');         // no suffix
    expect(normalizeDoi('10.1007/')).toBe('');        // empty suffix
    expect(normalizeDoi('10.1007/a b')).toBe('');     // whitespace in suffix
  });

  it('refuses an absurdly long string rather than building a huge URL', () => {
    expect(normalizeDoi('10.1007/' + 'x'.repeat(300))).toBe('');
  });

  it('is the basis for isValidDoi and doiUrl', () => {
    expect(isValidDoi(`https://doi.org/${doi}`)).toBe(true);
    expect(isValidDoi('nope')).toBe(false);
    expect(doiUrl(`doi:${doi}`)).toBe(`https://doi.org/${doi}`);
    expect(doiUrl('nope')).toBe('');
  });
});

describe('publicationTypeLabel', () => {
  it('localises the types we know', () => {
    expect(publicationTypeLabel('journal-article', 'ru')).toBe('Статья в журнале');
    expect(publicationTypeLabel('journal-article', 'en')).toBe('Journal article');
  });

  it('calls posted-content what it is — a preprint', () => {
    expect(publicationTypeLabel('posted-content', 'ru')).toBe('Препринт');
  });

  it('tidies an unknown registry type instead of dropping or guessing it', () => {
    expect(publicationTypeLabel('journal-issue', 'ru')).toBe('Journal issue');
    expect(publicationTypeLabel('peer-review', 'en')).toBe('Peer review');
  });

  it('returns empty for no type at all', () => {
    expect(publicationTypeLabel(undefined, 'ru')).toBe('');
    expect(publicationTypeLabel('', 'en')).toBe('');
  });
});

describe('type vocabulary', () => {
  it('has unique codes', () => {
    const codes = PUBLICATION_TYPES.map(p => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('never asserts peer review — that is not what a DOI proves', () => {
    for (const p of PUBLICATION_TYPES) {
      for (const label of [p.en, p.ru, p.es]) {
        expect(label.toLowerCase()).not.toContain('peer');
        expect(label.toLowerCase()).not.toContain('рецензи');
      }
    }
  });

  it('looks up by code', () => {
    expect(getPublicationType('book-chapter')?.ru).toBe('Глава книги');
    expect(getPublicationType('nope')).toBeUndefined();
  });
});
