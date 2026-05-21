
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
}

export interface VideoLink {
  id: string;
  url: string;
  source: string; // YouTube | RuTube | Twitch | VK | custom label
  language?: ContentLang; // Language of this video
}

export interface MediaItem {
  id: string;
  title: MultilingualText;
  description: MultilingualText;
  coverUrl: string;
  type: string; // Dynamic type
  rating: number;
  author: string;
  publishedDate: string; // When the content was originally released (e.g. book release year)
  addedDate: string;     // When the content was added to THIS library (ISO String)
  formats: FileFormat[];
  videoUrl?: string;       // legacy single video (kept for backward compatibility)
  videos?: VideoLink[];    // multiple videos with source labels
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
  ip: string;
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
}
