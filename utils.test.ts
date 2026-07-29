import { describe, it, expect } from 'vitest';
import { pickText, getYouTubeId, getVideoPoster, COVER_FALLBACK, isExternalUrl } from './utils';

describe('isExternalUrl', () => {
  const ours = 'https://library.example.com';

  it('flags a different origin', () => {
    expect(isExternalUrl('https://lib.msu.ru/book.pdf', ours)).toBe(true);
  });

  it('does not flag our own origin or relative paths', () => {
    expect(isExternalUrl('https://library.example.com/content/1/a.pdf', ours)).toBe(false);
    expect(isExternalUrl('/content/1/a.pdf', ours)).toBe(false);
  });

  it('treats a different port or scheme as external', () => {
    expect(isExternalUrl('https://library.example.com:8443/a.pdf', ours)).toBe(true);
    expect(isExternalUrl('http://library.example.com/a.pdf', ours)).toBe(true);
  });

  it('ignores non-http(s) and malformed URLs', () => {
    expect(isExternalUrl('blob:whatever', ours)).toBe(false);
    expect(isExternalUrl('data:text/plain,hi', ours)).toBe(false);
    expect(isExternalUrl('', ours)).toBe(false);
  });
});

describe('pickText', () => {
  it('returns the requested locale when present', () => {
    expect(pickText({ en: 'Hello', ru: 'Привет', es: 'Hola' }, 'ru')).toBe('Привет');
  });

  it('falls back ru → en → es when the locale is empty', () => {
    expect(pickText({ en: 'Hi', ru: '', es: '' }, 'es')).toBe('Hi');
    expect(pickText({ en: '', ru: 'Тест', es: '' }, 'en')).toBe('Тест');
  });

  it('returns the fallback for undefined text', () => {
    expect(pickText(undefined, 'en')).toBe('Untitled');
    expect(pickText(undefined, 'en', 'N/A')).toBe('N/A');
  });
});

describe('getYouTubeId', () => {
  it('extracts the id from common YouTube URL forms', () => {
    expect(getYouTubeId('https://youtu.be/abc123')).toBe('abc123');
    expect(getYouTubeId('https://www.youtube.com/watch?v=xyz789')).toBe('xyz789');
    expect(getYouTubeId('https://www.youtube.com/embed/QQQ')).toBe('QQQ');
  });

  it('returns null for non-YouTube or empty input', () => {
    expect(getYouTubeId('https://example.com/video.mp4')).toBeNull();
    expect(getYouTubeId('')).toBeNull();
  });
});

describe('getVideoPoster', () => {
  it('builds a maxresdefault thumbnail for YouTube', () => {
    expect(getVideoPoster('https://youtu.be/abc123')).toBe('https://img.youtube.com/vi/abc123/maxresdefault.jpg');
  });

  it('returns null for direct files and empty input', () => {
    expect(getVideoPoster('https://cdn.example.com/clip.mp4')).toBeNull();
    expect(getVideoPoster(null)).toBeNull();
  });
});

describe('COVER_FALLBACK', () => {
  it('is an inline SVG data URL', () => {
    expect(COVER_FALLBACK.startsWith('data:image/svg+xml')).toBe(true);
  });
});
