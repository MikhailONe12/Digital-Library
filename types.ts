
export type Locale = 'en' | 'ru' | 'es';

// Language tag for content files/videos (superset of UI locales)
export type ContentLang = Locale | 'it' | 'fr' | 'de';

export interface MultilingualText {
  en: string;
  ru: string;
  es: string;
}

export interface CustomType {
  id: string;
  en: string;
  ru: string;
  es: string;
}

export interface FileFormat {
  id: string;
  name: string;
  url: string;
  size: string;
  language?: ContentLang; // Language specific to this file
  allowDownload?: boolean; // Per-file permission
  allowReading?: boolean;  // Per-file permission
  /**
   * The file lives on a third party's server (an institutional library, a
   * publisher, an archive). When true the app never renders it in a built-in
   * reader and never serves it — the link always opens at the origin site, so
   * we can catalogue the work without redistributing someone else's file.
   * Set explicitly rather than guessed from the URL: mistaking "their PDF" for
   * "our PDF" is exactly the licence breach this flag exists to prevent.
   */
  external?: boolean;
}

/** Who actually hosts an externally-linked work. Shown as attribution. */
export interface SourceInfo {
  name: string;  // e.g. "Moscow State University Research Library"
  url?: string;  // the source's own page for the work (or its homepage)
}

/**
 * Distribution licence for an item's content. `code` is a preset id from
 * services/licenses.ts, or CUSTOM_LICENSE_CODE when a source needs wording
 * the preset list doesn't cover.
 */
export interface LicenseInfo {
  code: string;
  name?: string;   // free-text licence name — only used when code is CUSTOM
  url?: string;    // link to the licence text
  holder?: string; // rights holder, required for CC-BY-style attribution
  note?: string;   // any extra wording the source requires verbatim
}

/**
 * Registry metadata for a scholarly publication, looked up by DOI.
 *
 * `type` deliberately holds the registry's own machine value ('journal-article',
 * 'posted-content', …) rather than a display string: a free-text type can't be
 * filtered on, and everyone spells it differently. The human label is derived
 * at render time — see services/publication.ts.
 *
 * Note what this does NOT claim. A DOI is not evidence of peer review (arXiv
 * and SSRN preprints have them too), and 'journal-article' only reflects how
 * the publisher registered the record. The UI reports what the registry says
 * and attributes it as such, instead of stamping the work as reviewed.
 *
 * The publication year is not here on purpose — it belongs in the existing
 * `publishedDate`, which already accepts a bare year. A second year field is
 * how the two drift apart.
 */
export interface PublicationInfo {
  /** Bare DOI, e.g. "10.1007/s11403-023-00379-8" — no scheme, no doi.org. */
  doi: string;
  /** Registry type, verbatim. Absent when the record was filled in by hand. */
  type?: string;
  /** Journal / book / proceedings the work appeared in (CSL container-title). */
  journal?: string;
  publisher?: string;
}

export interface VideoLink {
  id: string;
  url: string;
  source: string; // YouTube | RuTube | Twitch | VK | custom label
  language?: ContentLang; // Language of this video
}

// External web article / social-media post associated with an item.
// Rendered in-app via a server-side readability extraction (or oEmbed widget
// for known social sources where readability won't work).
export interface ArticleLink {
  id: string;
  url: string;
  source: string;     // 'Twitter' | 'X' | 'YandexZen' | 'VK' | 'Telegram' | custom
  title?: string;     // Manual override (otherwise pulled from <title> on extract)
  language?: ContentLang;
}

export interface MediaItem {
  id: string;
  title: MultilingualText;
  description: MultilingualText;
  coverUrl: string;
  type: string; // Dynamic type
  rating: number;
  /**
   * Primary author name (free text). Kept as a non-optional string for
   * backward compatibility with all the existing read sites (search,
   * deep-link, item cards). `author === authors[0]` is maintained as an
   * invariant by `normalizeItem`.
   */
  author: string;
  /**
   * Full ordered list of co-authors. Optional because legacy items only had
   * the single `author` string; `normalizeItem` synthesises a one-element
   * array when missing so downstream code can rely on its presence.
   */
  authors?: string[];
  publishedDate: string; // When the content was originally released (e.g. book release year)
  addedDate: string;     // When the content was added to THIS library (ISO String)
  formats: FileFormat[];
  videoUrl?: string;       // legacy single video (kept for backward compatibility)
  videos?: VideoLink[];    // multiple videos with source labels
  articles?: ArticleLink[]; // external articles / social posts
  series?: string;         // series name (free text); items sharing it are linked
  seriesOrder?: number;    // 1-based position within the series
  tags?: string[];         // free-form keywords for filtering / discovery
  /** Set when the work is hosted elsewhere — powers the attribution line. */
  source?: SourceInfo;
  /** Distribution licence; absent means "not stated" (treated as ARR). */
  license?: LicenseInfo;
  /** Scholarly identifiers; absent for most items (videos, courses, books). */
  publication?: PublicationInfo;
  isPrivate: boolean;
  views: number;
  downloads: number;
  contentLanguages: ContentLang[]; // Global item languages
  allowDownload: boolean; // Global permission
  allowReading: boolean;  // Global permission
}

export interface StatPoint {
  date: string;
  views: number;
  downloads: number;
}

export interface UserAnalytics {
  username: string;
  views: number;
  downloads: number;
  lastActive: string;
  itemViews: Record<string, number>;     // {itemId: viewCount}
  itemDownloads: Record<string, number>; // {itemId: downloadCount}
}

export interface VisitLog {
  id: string;
  timestamp: string;
  username: string;
  /** Anonymised: last IPv4 octet zeroed, IPv6 truncated to /48 (#37). */
  ip: string;
  /**
   * Keyed digest of the visitor's full address. Equal values mean the same
   * visitor; the address itself can't be recovered from it. Absent on rows
   * written before the column existed, and when the server has no stable key.
   */
  ip_hash?: string;
  platform: string;
  device: string;
}

export interface Bookmark {
  id: string;
  user_id: string;
  item_id: string;
  position: string;
  label: string;
  created_at: string;
}

export interface ReadingProgress {
  position: string;
  position_total: number; // PDF: total pages; EPUB: percentage 0–100
  format_url: string | null;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface Annotation {
  id: string;
  item_id: string;
  format_url: string;
  cfi_range?: string | null;
  page?: number | null;
  selected_text: string;
  note?: string | null;
  color: HighlightColor;
  created_at: string;
}

export interface AppState {
  items: MediaItem[];
  allowedUsers: string[]; // Whitelist
  blacklist: string[];    // Blacklist (Usernames & IPs)
  visitLogs: VisitLog[];  // Access logs
  stats: StatPoint[];
  userAnalytics: UserAnalytics[];
  userFavorites: Record<string, string[]>; // Maps user ID to array of item IDs
  userRatings: Record<string, Record<string, number>>; // Maps user ID to { itemId: rating }
  customTypes: CustomType[];
  defaultLanguage: Locale;
  globalAccess: boolean;
  /** Identifiers that should NOT be counted in traffic or per-item
   *  analytics. Applied at write-time (events from these visitors aren't
   *  recorded) and partially at read-time (visit_logs / item_events get
   *  filtered by username + IP that were stored on them).
   *   • usernames — Telegram @handles (case-insensitive, no leading @)
   *   • ips       — raw IPv4/IPv6 strings
   *   • userIds   — Telegram numeric user IDs (stable; username can change)
   *   • browsers  — per-device tokens; stable across IP changes. Clients
   *     that have set localStorage.library_skip_analytics_token send it as
   *     `x-skip-analytics` header; if it matches any registered token, the
   *     server skips the insert.
   */
  analyticsExcludes: {
    usernames: string[];
    ips: string[];
    userIds: string[];
    browsers: { token: string; label: string; addedAt: string }[];
    /** Visitor pseudonyms (VisitLog.ip_hash) — one exact visitor each. */
    visitors: string[];
  };
}
