/**
 * IndexedDB 进度存储服务
 * 支持双轨进度跟踪：点击进入浏览模式（临时）和沉浸式刷模式（持久化）
 */

const DB_NAME = "douyin-index-progress";
const DB_VERSION = 1;
const STORE_NAME = "progress";

export type BrowseMode = "click" | "immersive";
export type ContentType = "video" | "gallery" | "live";

export interface ProgressRecord {
  /** 主键: `${contentType}:${contentId}:${browseMode}` */
  key: string;
  contentId: number;
  contentType: ContentType;
  browseMode: BrowseMode;
  /** 视频: 秒数, 图集: 页码, 实况: 时间戳 */
  progress: number;
  /** 总长度 */
  total?: number;
  updatedAt: number;
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
        store.createIndex("contentId", "contentId", { unique: false });
        store.createIndex("browseMode", "browseMode", { unique: false });
      }
    };
  });
}

function makeKey(contentId: number, contentType: ContentType, browseMode: BrowseMode): string {
  return `${contentType}:${contentId}:${browseMode}`;
}

/** 保存进度（沉浸式模式持久化，点击模式仅会话内） */
export async function saveProgress(
  contentId: number,
  contentType: ContentType,
  browseMode: BrowseMode,
  progress: number,
  total?: number
): Promise<void> {
  // 点击模式不持久化
  if (browseMode === "click") {
    sessionProgress.set(makeKey(contentId, contentType, browseMode), { progress, total });
    return;
  }
  const db = await openDB();
  const record: ProgressRecord = {
    key: makeKey(contentId, contentType, browseMode),
    contentId,
    contentType,
    browseMode,
    progress,
    total,
    updatedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 读取进度 */
export async function getProgress(
  contentId: number,
  contentType: ContentType,
  browseMode: BrowseMode
): Promise<ProgressRecord | null> {
  // 点击模式从会话存储读取
  if (browseMode === "click") {
    const sess = sessionProgress.get(makeKey(contentId, contentType, browseMode));
    if (!sess) return null;
    return {
      key: makeKey(contentId, contentType, browseMode),
      contentId,
      contentType,
      browseMode,
      progress: sess.progress,
      total: sess.total,
      updatedAt: Date.now(),
    };
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(makeKey(contentId, contentType, browseMode));
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** 清除指定内容的进度 */
export async function clearProgress(
  contentId: number,
  contentType: ContentType,
  browseMode: BrowseMode
): Promise<void> {
  if (browseMode === "click") {
    sessionProgress.delete(makeKey(contentId, contentType, browseMode));
    return;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(makeKey(contentId, contentType, browseMode));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 清除所有沉浸式模式进度 */
export async function clearAllImmersiveProgress(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index("browseMode");
    const req = idx.openCursor(IDBKeyRange.only("immersive"));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 会话内进度（点击模式）
const sessionProgress = new Map<string, { progress: number; total?: number }>();
