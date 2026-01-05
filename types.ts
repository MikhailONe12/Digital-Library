
export type Locale = 'en' | 'ru' | 'es';

export interface MultilingualText {
  en: string;
  ru: string;
  es: string;
}

export interface FileFormat {
  id: string;
  name: string;
  url: string;
  size: string;
  language?: Locale; // Language specific to this file
  allowDownload?: boolean; // Per-file permission
  allowReading?: boolean;  // Per-file permission
}

export interface BotConfig {
  token: string;
  username: string;
  welcomeMessage: MultilingualText;
  webAppUrl: string;
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
  videoUrl?: string; 
  isPrivate: boolean;
  views: number;
  downloads: number;
  contentLanguages: Locale[]; // Global item languages
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
}

export interface VisitLog {
  id: string;
  timestamp: string;
  username: string;
  ip: string;
  platform: string;
  device: string;
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
  customTypes: string[];
  defaultLanguage: Locale;
  globalAccess: boolean;
  botConfig: BotConfig;
}
