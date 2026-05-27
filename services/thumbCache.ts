// Persistent IndexedDB cache for auto-generated thumbnails (PDF page-1,
// EPUB cover, video frame). Thumbnails are large data-URLs that would bust
// localStorage's 5 MB quota, so they live in IDB instead.
//
// The store is keyed by the source file URL. Entries never expire — if the
// file changes the admin would normally re-upload it at a new URL.

const DB_NAME    = 'library-thumbs';
const DB_VERSION = 1;
const STORE      = 'thumbs';

let _db: IDBDatabase | null = null;
let _opening: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  _opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => { _db = req.result; _opening = null; resolve(_db); };
    req.onerror   = () => { _opening = null; reject(req.error); };
  });
  return _opening;
};

export const thumbCacheGet = async (key: string): Promise<string | null> => {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch {
    return null;
  }
};

export const thumbCacheSet = async (key: string, dataUrl: string): Promise<void> => {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(dataUrl, key);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch {
    // IDB unavailable (private mode quota) — silent, in-memory cache still works
  }
};
