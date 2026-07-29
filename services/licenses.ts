// Distribution licences for catalogued works.
//
// Two jobs: give the admin a typical list to pick from instead of typing legal
// wording by hand, and give the item page the facts it needs to display a
// correct attribution line. CC licences make attribution a *condition of use*,
// so `buildAttribution` assembles the exact sentence those licences ask for.
//
// The list is deliberately short — the common cases plus CUSTOM for a source
// with its own terms (institutional agreements, publisher-specific wording).

import { LicenseInfo, Locale, MediaItem } from '../types';
import { pickText } from '../utils';

export interface LicensePreset {
  code: string;
  en: string;
  ru: string;
  es: string;
  /** Canonical URL of the licence text; '' when there's nothing to link to. */
  url: string;
  /**
   * Does the licence permit us to hand the file itself to a user? Drives the
   * advisory warning shown when an admin enables downloads on a work whose
   * licence doesn't allow redistribution.
   */
  allowsRedistribution: boolean;
  /** Must the author / rights holder be credited wherever the work appears? */
  requiresAttribution: boolean;
}

export const CUSTOM_LICENSE_CODE = 'CUSTOM';

/** Fallback when an item has no licence recorded: assume nothing is granted. */
export const DEFAULT_LICENSE_CODE = 'ARR';

export const LICENSE_PRESETS: LicensePreset[] = [
  {
    code: 'ARR',
    en: 'All rights reserved', ru: 'Все права защищены', es: 'Todos los derechos reservados',
    url: '',
    allowsRedistribution: false, requiresAttribution: false,
  },
  {
    code: 'PD',
    en: 'Public domain', ru: 'Общественное достояние', es: 'Dominio público',
    url: 'https://en.wikipedia.org/wiki/Public_domain',
    allowsRedistribution: true, requiresAttribution: false,
  },
  {
    code: 'CC0',
    en: 'CC0 1.0 (no rights reserved)', ru: 'CC0 1.0 (без прав)', es: 'CC0 1.0 (sin derechos)',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    allowsRedistribution: true, requiresAttribution: false,
  },
  {
    code: 'CC-BY-4.0',
    en: 'CC BY 4.0', ru: 'CC BY 4.0', es: 'CC BY 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    allowsRedistribution: true, requiresAttribution: true,
  },
  {
    code: 'CC-BY-SA-4.0',
    en: 'CC BY-SA 4.0', ru: 'CC BY-SA 4.0', es: 'CC BY-SA 4.0',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    allowsRedistribution: true, requiresAttribution: true,
  },
  {
    code: 'CC-BY-NC-4.0',
    en: 'CC BY-NC 4.0', ru: 'CC BY-NC 4.0', es: 'CC BY-NC 4.0',
    url: 'https://creativecommons.org/licenses/by-nc/4.0/',
    allowsRedistribution: true, requiresAttribution: true,
  },
  {
    code: 'CC-BY-ND-4.0',
    en: 'CC BY-ND 4.0', ru: 'CC BY-ND 4.0', es: 'CC BY-ND 4.0',
    url: 'https://creativecommons.org/licenses/by-nd/4.0/',
    allowsRedistribution: true, requiresAttribution: true,
  },
  {
    code: 'CC-BY-NC-SA-4.0',
    en: 'CC BY-NC-SA 4.0', ru: 'CC BY-NC-SA 4.0', es: 'CC BY-NC-SA 4.0',
    url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    allowsRedistribution: true, requiresAttribution: true,
  },
  {
    code: 'CC-BY-NC-ND-4.0',
    en: 'CC BY-NC-ND 4.0', ru: 'CC BY-NC-ND 4.0', es: 'CC BY-NC-ND 4.0',
    url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    allowsRedistribution: true, requiresAttribution: true,
  },
  {
    code: CUSTOM_LICENSE_CODE,
    en: 'Other / custom terms', ru: 'Другая / особые условия', es: 'Otra / términos propios',
    // A custom licence carries its own URL on the item; nothing canonical here.
    url: '',
    // Unknown terms — assume the strict side so the download warning still fires.
    allowsRedistribution: false, requiresAttribution: true,
  },
];

export const getLicensePreset = (code?: string): LicensePreset | undefined =>
  LICENSE_PRESETS.find(p => p.code === code);

/** Display name: the custom free-text name when set, otherwise the preset. */
export const licenseLabel = (license: LicenseInfo | undefined, lang: Locale): string => {
  if (!license) return '';
  if (license.code === CUSTOM_LICENSE_CODE) {
    return (license.name || '').trim() || getLicensePreset(CUSTOM_LICENSE_CODE)?.[lang] || '';
  }
  const preset = getLicensePreset(license.code);
  return preset ? preset[lang] : (license.name || license.code);
};

/** Item-specific URL wins so a source can point at its own terms page. */
export const licenseUrl = (license: LicenseInfo | undefined): string => {
  if (!license) return '';
  if (license.url) return license.url;
  return getLicensePreset(license.code)?.url || '';
};

/** True when handing the raw file to a user would exceed the licence. */
export const licenseForbidsRedistribution = (license: LicenseInfo | undefined): boolean => {
  const preset = getLicensePreset(license?.code || DEFAULT_LICENSE_CODE);
  return preset ? !preset.allowsRedistribution : true;
};

export const licenseRequiresAttribution = (license: LicenseInfo | undefined): boolean =>
  !!getLicensePreset(license?.code)?.requiresAttribution;

/**
 * The credit line CC-style licences require: title, rights holder, licence and
 * — for works we merely link to — where the work actually lives. Returns '' when
 * the licence asks for nothing, so callers can skip the block entirely.
 */
export const buildAttribution = (item: MediaItem, lang: Locale): string => {
  if (!licenseRequiresAttribution(item.license)) return '';
  const parts: string[] = [`«${pickText(item.title, lang)}»`];
  const holder = (item.license?.holder || '').trim() || (item.authors?.[0] || item.author || '').trim();
  if (holder) parts.push(`© ${holder}`);
  const label = licenseLabel(item.license, lang);
  if (label) parts.push(label);
  const sourceName = (item.source?.name || '').trim();
  if (sourceName) parts.push(sourceName);
  return parts.join(' — ');
};
