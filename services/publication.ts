// DOI handling and publication-type vocabulary.
//
// Two jobs: normalise whatever an admin pastes into a bare DOI, and turn the
// registry's machine type into something a reader understands — without
// overstating what the registry actually asserts.
//
// On that last point: a DOI says a work is registered, not that it was peer
// reviewed. arXiv and SSRN preprints carry DOIs, and 'journal-article' only
// reflects how the publisher filed the record. So every label here is phrased
// as a description of the record, the UI attributes it to the registry, and
// nothing in this file ever produces the words "peer reviewed" on its own
// authority.

import { Locale } from '../types';

export interface PublicationTypePreset {
  /** CSL / Crossref machine value, stored verbatim on the item. */
  code: string;
  en: string;
  ru: string;
  es: string;
}

/**
 * The types worth naming. Anything outside this list still round-trips — it is
 * stored and shown as-is rather than being coerced into a wrong label.
 */
export const PUBLICATION_TYPES: PublicationTypePreset[] = [
  { code: 'journal-article',     en: 'Journal article',      ru: 'Статья в журнале',      es: 'Artículo de revista' },
  // Crossref files preprints under 'posted-content'.
  { code: 'posted-content',      en: 'Preprint',             ru: 'Препринт',              es: 'Preprint' },
  { code: 'proceedings-article', en: 'Conference paper',     ru: 'Доклад конференции',    es: 'Ponencia' },
  { code: 'book',                en: 'Book',                 ru: 'Книга',                 es: 'Libro' },
  { code: 'book-chapter',        en: 'Book chapter',         ru: 'Глава книги',           es: 'Capítulo de libro' },
  { code: 'monograph',           en: 'Monograph',            ru: 'Монография',            es: 'Monografía' },
  { code: 'report',              en: 'Report',               ru: 'Отчёт',                 es: 'Informe' },
  { code: 'dissertation',        en: 'Dissertation',         ru: 'Диссертация',           es: 'Tesis' },
  { code: 'dataset',             en: 'Dataset',              ru: 'Набор данных',          es: 'Conjunto de datos' },
  { code: 'reference-entry',     en: 'Reference entry',      ru: 'Справочная статья',     es: 'Entrada de referencia' },
];

export const getPublicationType = (code?: string): PublicationTypePreset | undefined =>
  PUBLICATION_TYPES.find(p => p.code === code);

/**
 * Human label for a registry type. Unknown codes come back tidied rather than
 * dropped: 'journal-issue' → 'Journal issue' is more honest than showing
 * nothing or guessing at a translation we don't have.
 */
export const publicationTypeLabel = (code: string | undefined, lang: Locale): string => {
  const c = (code || '').trim();
  if (!c) return '';
  const preset = getPublicationType(c);
  if (preset) return preset[lang] || preset.en;
  const words = c.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A DOI as registered: `10.` + registrant code + `/` + an opaque suffix.
 * The suffix is deliberately permissive (publishers put almost anything in
 * it) but must not contain whitespace, and we cap the length so a pasted
 * essay can't become a URL path.
 */
const DOI_RE = /^10\.\d{4,9}\/\S+$/;

/**
 * Reduce anything an admin might paste to a bare DOI, or '' if it isn't one.
 * Accepts a plain DOI, the `doi:` scheme, and doi.org / dx.doi.org URLs —
 * those are the three forms publishers put on a landing page.
 */
export const normalizeDoi = (raw: string): string => {
  let s = (raw || '').trim();
  if (!s) return '';
  s = s.replace(/^doi:\s*/i, '');
  // Strip a resolver prefix, with or without scheme.
  s = s.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
  s = s.replace(/^https?:\/\//i, '');
  // Copied out of prose a DOI often arrives wrapped or sentence-terminated.
  // Unwrap only a matched pair, because a bare trailing ')' can be part of the
  // DOI itself — Elsevier issues plenty like 10.1016/S0140-6736(01)05627-6.
  if (/^\(.*\)$/.test(s) || /^\[.*\]$/.test(s)) s = s.slice(1, -1);
  s = s.replace(/[.,;]+$/, '').trim();
  if (s.length > 256) return '';
  return DOI_RE.test(s) ? s : '';
};

export const isValidDoi = (raw: string): boolean => !!normalizeDoi(raw);

/** Canonical resolver link for display and for the "open" action. */
export const doiUrl = (doi: string): string => {
  const clean = normalizeDoi(doi);
  return clean ? `https://doi.org/${clean}` : '';
};

/** Citation styles offered in the UI. `bibtex` is a format, not a CSL style. */
export const CITATION_STYLES = ['apa', 'modern-language-association', 'bibtex'] as const;
export type CitationStyle = typeof CITATION_STYLES[number];

export const citationStyleLabel = (style: CitationStyle): string =>
  style === 'apa' ? 'APA'
  : style === 'modern-language-association' ? 'MLA'
  : 'BibTeX';
