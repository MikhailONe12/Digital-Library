
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
  publishedDate: string;
  formats: FileFormat[];
  videoUrl?: string; 
  isPrivate: boolean;
  views: number;
  downloads: number;
  contentLanguages: Locale[];
  allowDownload: boolean; // New permission field
  allowReading: boolean;  // New permission field
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

export interface AppState {
  items: MediaItem[];
  allowedUsers: string[];
  stats: StatPoint[];
  userAnalytics: UserAnalytics[];
  userFavorites: Record<string, string[]>; // Maps user ID to array of item IDs
  customTypes: string[];
  defaultLanguage: Locale;
  globalAccess: boolean;
  botConfig: BotConfig;
}
