const DB_NAME = "douyin-index-watch-later";
const DB_VERSION = 1;
const STORE_NAME = "watch-later";

export interface WatchLaterRecord {
  key: string;
  workId: number;
  createdAt: number;
}

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      dbInstance = req.result;
      resolve(dbInstance);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("workId", "workId", { unique: true });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
  });
}

function makeKey(workId: number): string {
  return `work:${workId}`;
}

export async function toggleWatchLater(workId: number): Promise<boolean> {
  const exists = await isWatchLater(workId);
  if (exists) {
    await removeWatchLater(workId);
    return false;
  } else {
    await addWatchLater(workId);
    return true;
  }
}

export async function addWatchLater(workId: number): Promise<void> {
  const db = await openDB();
  const record: WatchLaterRecord = {
    key: makeKey(workId),
    workId,
    createdAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeWatchLater(workId: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(makeKey(workId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function isWatchLater(workId: number): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(makeKey(workId));
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getWatchLaterWorkIds(): Promise<number[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const results = req.result as WatchLaterRecord[];
      results.sort((a, b) => b.createdAt - a.createdAt);
      resolve(results.map((r) => r.workId));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllWatchLater(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
