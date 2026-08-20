import Database from "@tauri-apps/plugin-sql";
import type {
  AuthorRow,
  FileRow,
  WorkRow,
  ExcelRowRecord,
  ExcelBatchRow,
} from "@/types";

const SCHEMA_VERSION = "9";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  signature TEXT,
  folder_path TEXT,
  created_at INTEGER,
  import_log_id INTEGER
);

CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT UNIQUE,
  author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  work_type TEXT,
  topics TEXT,
  publish_time INTEGER,
  duration INTEGER,
  width INTEGER,
  height INTEGER,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  favorite_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  play_count INTEGER DEFAULT 0,
  cover_static TEXT,
  cover_dynamic TEXT,
  video_uri TEXT,
  download_url TEXT,
  music_author TEXT,
  music_title TEXT,
  hidden_tags TEXT,
  extra_info TEXT,
  file_count INTEGER DEFAULT 0,
  created_at INTEGER,
  import_log_id INTEGER,
  source_type TEXT,
  original_author TEXT,
  collect_time INTEGER,
  sec_uid TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,
  absolute_path TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  extension TEXT,
  media_type TEXT,
  seq INTEGER DEFAULT 0,
  size_bytes INTEGER,
  mtime INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS thumbnails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  thumb_path TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  generated_at INTEGER
);

CREATE TABLE IF NOT EXISTS import_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_path TEXT NOT NULL,
  total_authors INTEGER,
  total_works INTEGER,
  total_files INTEGER,
  skipped_files INTEGER DEFAULT 0,
  unmatched_files INTEGER DEFAULT 0,
  excel_files TEXT,
  errors TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- Excel 元数据缓存表：单独导入 xlsx 时缓存行数据，供后续作品导入复用
-- 不创建 works 记录，仅作为元数据来源
CREATE TABLE IF NOT EXISTS excel_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  source_uid TEXT NOT NULL,
  source_type TEXT DEFAULT '',
  source_filename TEXT NOT NULL,
  source_path TEXT NOT NULL,
  work_id TEXT,
  description TEXT,
  topics TEXT,
  publish_time TEXT,
  collect_time TEXT,
  duration TEXT,
  height INTEGER,
  width INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  favorite_count INTEGER,
  share_count INTEGER,
  play_count INTEGER,
  cover_static TEXT,
  cover_dynamic TEXT,
  video_uri TEXT,
  download_url TEXT,
  music_author TEXT,
  music_title TEXT,
  hidden_tags TEXT,
  extra_info TEXT,
  sec_uid TEXT,
  author_name TEXT,
  author_signature TEXT,
  work_type TEXT,
  imported_at INTEGER NOT NULL
);

-- 标签计数物化表：百万级作品库唯一标签可达 20 万+，
-- 全量回传 WebView 会撑爆渲染进程（OOM 白屏）。
-- 重建时用递归 CTE 在 SQLite 内聚合（仅一次性开销），日常查询走本表 + LIMIT。
CREATE TABLE IF NOT EXISTS tag_counts (
  tag TEXT NOT NULL,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL,
  PRIMARY KEY (is_hidden, tag)
) WITHOUT ROWID;

-- 轻量 KV 元数据（如 tag_counts 构建时的 works 行数，用于启动时 staleness 校验）
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_works_author ON works(author_id);
CREATE INDEX IF NOT EXISTS idx_works_publish ON works(publish_time DESC);
CREATE INDEX IF NOT EXISTS idx_works_type ON works(work_type);
CREATE INDEX IF NOT EXISTS idx_works_title ON works(title);
CREATE INDEX IF NOT EXISTS idx_works_topics ON works(topics);
CREATE INDEX IF NOT EXISTS idx_files_work ON files(work_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(absolute_path);
CREATE INDEX IF NOT EXISTS idx_thumbnails_file ON thumbnails(file_id);
CREATE INDEX IF NOT EXISTS idx_authors_import ON authors(import_log_id);
CREATE INDEX IF NOT EXISTS idx_works_import ON works(import_log_id);
CREATE INDEX IF NOT EXISTS idx_works_source ON works(source_type);
CREATE INDEX IF NOT EXISTS idx_works_original_author ON works(original_author);
CREATE INDEX IF NOT EXISTS idx_excel_rows_uid_type ON excel_rows(source_uid, source_type);
CREATE INDEX IF NOT EXISTS idx_excel_rows_work_id ON excel_rows(work_id);
CREATE INDEX IF NOT EXISTS idx_excel_rows_batch ON excel_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_excel_rows_path ON excel_rows(source_path);
CREATE INDEX IF NOT EXISTS idx_tag_counts_hidden_count ON tag_counts(is_hidden, count DESC);
`;

let dbInstance: Database | null = null;

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

function getLocalDayStart(ts: number): number {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function parseDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length === 3) {
    const [h, m, sec] = parts;
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(sec);
  }
  if (parts.length === 2) {
    const [m, sec] = parts;
    return parseInt(m) * 60 + parseFloat(sec);
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseDateTime(s: string | null | undefined): number | null {
  if (!s) return null;
  // 统一将 T 替换为空格，确保 ISO 格式和普通格式都解析为本地时间
  const normalized = s.replace(/T/, " ").replace(/\./g, ":");
  const d = new Date(normalized);
  const t = d.getTime();
  return isNaN(t) ? null : Math.floor(t / 1000);
}

export async function initDatabase(dbFilePath: string): Promise<boolean> {
  const connStr = `sqlite:${dbFilePath}`;
  dbInstance = await Database.load(connStr);
  await dbInstance.execute("PRAGMA foreign_keys = ON;");
  await dbInstance.execute("PRAGMA journal_mode = WAL;");
  await dbInstance.execute("PRAGMA synchronous = NORMAL;");
  // 设置 busy_timeout：锁冲突时等待最多 5 秒，避免立即返回 "database is locked"
  await dbInstance.execute("PRAGMA busy_timeout = 5000;");

  let currentVersion: string | null = null;
  try {
    const rows = await dbInstance.select<{ version: string }[]>(
      "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    );
    currentVersion = rows[0]?.version ?? null;
  } catch {
    // schema_version 表不存在，全新数据库
  }

  if (currentVersion === null) {
    console.log("[DB] Fresh database, creating schema v3...");
    await dbInstance.execute(SCHEMA_SQL, []);
  } else if (currentVersion !== SCHEMA_VERSION) {
    console.log(`[DB] Schema version mismatch: ${currentVersion} -> ${SCHEMA_VERSION}, migrating...`);
    await migrateSchema(dbInstance, currentVersion);
  }

  await dbInstance.execute(
    "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)",
    [SCHEMA_VERSION, nowTs()]
  );

  // 标签计数物化表 staleness 校验：首次升级 / 上次导入未正常重建时在此补一次
  // （百万作品约 5-10s，仅一次；此后启动为两次瞬时 COUNT 查询）
  await ensureTagCountsFresh();
  return true;
}

/**
 * 非破坏性迁移：通过 ALTER TABLE 增量添加缺失的列，保留用户数据
 */
async function migrateSchema(db: Database, fromVersion: string): Promise<void> {
  // v2 -> v3: 添加 import_log_id 列、扩展 import_logs 表
  if (fromVersion < "3") {
    // authors 表添加 import_log_id
    try {
      await db.execute("ALTER TABLE authors ADD COLUMN import_log_id INTEGER");
      console.log("[DB] 已添加 authors.import_log_id 列");
    } catch {
      // 列已存在
    }
    // works 表添加 import_log_id
    try {
      await db.execute("ALTER TABLE works ADD COLUMN import_log_id INTEGER");
      console.log("[DB] 已添加 works.import_log_id 列");
    } catch {
      // 列已存在
    }
    // import_logs 表添加新列
    for (const col of [
      "skipped_files INTEGER DEFAULT 0",
      "unmatched_files INTEGER DEFAULT 0",
      "excel_files TEXT",
      "errors TEXT",
    ]) {
      const colName = col.split(" ")[0];
      try {
        await db.execute(`ALTER TABLE import_logs ADD COLUMN ${col}`);
        console.log(`[DB] 已添加 import_logs.${colName} 列`);
      } catch {
        // 列已存在
      }
    }
    // 添加新索引
    try {
      await db.execute("CREATE INDEX IF NOT EXISTS idx_authors_import ON authors(import_log_id)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_works_import ON works(import_log_id)");
    } catch {
      // ignore
    }
  }
  // v3 -> v4: 添加 works.source_type 列（区分收藏作品/喜欢作品）
  if (fromVersion < "4") {
    try {
      await db.execute("ALTER TABLE works ADD COLUMN source_type TEXT");
      console.log("[DB] 已添加 works.source_type 列");
    } catch {
      // 列已存在
    }
    try {
      await db.execute("CREATE INDEX IF NOT EXISTS idx_works_source ON works(source_type)");
    } catch {
      // ignore
    }
  }
  // v4 -> v5: 添加 works.original_author 列（收藏/喜欢作品文件夹中媒体文件的原始作者）
  if (fromVersion < "5") {
    try {
      await db.execute("ALTER TABLE works ADD COLUMN original_author TEXT");
      console.log("[DB] 已添加 works.original_author 列");
    } catch {
      // 列已存在
    }
    try {
      await db.execute("CREATE INDEX IF NOT EXISTS idx_works_original_author ON works(original_author)");
    } catch {
      // ignore
    }
  }
  // v5 -> v6: 添加 works.collect_time（Excel 采集时间）和 works.sec_uid（作者 SEC-UID，用于主页链接）
  if (fromVersion < "6") {
    try {
      await db.execute("ALTER TABLE works ADD COLUMN collect_time INTEGER");
      console.log("[DB] 已添加 works.collect_time 列");
    } catch {
      // 列已存在
    }
    try {
      await db.execute("ALTER TABLE works ADD COLUMN sec_uid TEXT");
      console.log("[DB] 已添加 works.sec_uid 列");
    } catch {
      // 列已存在
    }
  }
  // v7/v8 -> v9: 标签计数物化表（替代 v8 那个会卡住大库启动的 hidden_tags 部分索引方案）
  if (fromVersion < "9") {
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tag_counts (
          tag TEXT NOT NULL,
          is_hidden INTEGER NOT NULL DEFAULT 0,
          count INTEGER NOT NULL,
          PRIMARY KEY (is_hidden, tag)
        ) WITHOUT ROWID
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_tag_counts_hidden_count ON tag_counts(is_hidden, count DESC)"
      );
      console.log("[DB] 已创建 tag_counts 物化表（schema v9）");
    } catch (e) {
      console.warn("[DB] tag_counts 表创建失败:", e);
    }
  }
  // v6 -> v7: 新增 excel_rows 表（Excel 元数据缓存，用于单独导入 xlsx 不创建作品）
  if (fromVersion < "7") {
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS excel_rows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER NOT NULL,
          source_uid TEXT NOT NULL,
          source_type TEXT DEFAULT '',
          source_filename TEXT NOT NULL,
          source_path TEXT NOT NULL,
          work_id TEXT,
          description TEXT,
          topics TEXT,
          publish_time TEXT,
          collect_time TEXT,
          duration TEXT,
          height INTEGER,
          width INTEGER,
          like_count INTEGER,
          comment_count INTEGER,
          favorite_count INTEGER,
          share_count INTEGER,
          play_count INTEGER,
          cover_static TEXT,
          cover_dynamic TEXT,
          video_uri TEXT,
          download_url TEXT,
          music_author TEXT,
          music_title TEXT,
          hidden_tags TEXT,
          extra_info TEXT,
          sec_uid TEXT,
          author_name TEXT,
          author_signature TEXT,
          work_type TEXT,
          imported_at INTEGER NOT NULL
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_excel_rows_uid_type ON excel_rows(source_uid, source_type)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_excel_rows_work_id ON excel_rows(work_id)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_excel_rows_batch ON excel_rows(batch_id)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_excel_rows_path ON excel_rows(source_path)");
      console.log("[DB] 已创建 excel_rows 表（schema v7）");
    } catch (e) {
      console.warn("[DB] excel_rows 表创建失败（可能已存在）:", e);
    }
  }
}

export function getDb(): Database {
  if (!dbInstance) {
    throw new Error("数据库尚未初始化，请先调用 initDatabase()");
  }
  return dbInstance;
}

export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

// ============ 作者 ============

export async function upsertAuthor(
  author: Omit<AuthorRow, "id" | "created_at"> & { importLogId?: number | null }
): Promise<number> {
  const db = getDb();
  const ts = nowTs();
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM authors WHERE uid = ?",
    [author.uid]
  );
  if (existing.length > 0) {
    const id = existing[0].id;
    await db.execute(
      `UPDATE authors SET
        name = COALESCE(?, name),
        signature = COALESCE(?, signature),
        folder_path = COALESCE(?, folder_path),
        import_log_id = COALESCE(?, import_log_id)
       WHERE id = ?`,
      [
        author.name,
        author.signature ?? null,
        author.folder_path ?? null,
        author.importLogId ?? null,
        id,
      ]
    );
    return id;
  }
  const result = await db.execute(
    `INSERT INTO authors (uid, name, signature, folder_path, created_at, import_log_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      author.uid,
      author.name,
      author.signature ?? null,
      author.folder_path ?? null,
      ts,
      author.importLogId ?? null,
    ]
  );
  return result.lastInsertId ?? 0;
}

export async function getAuthors(): Promise<(AuthorRow & { work_count: number })[]> {
  const db = getDb();
  // 关联子查询走 idx_works_author 索引，避免 LEFT JOIN + GROUP BY 在大库上全量物化
  return db.select<(AuthorRow & { work_count: number })[]>(
    `SELECT a.*, COALESCE((SELECT COUNT(*) FROM works w WHERE w.author_id = a.id), 0) AS work_count
     FROM authors a
     ORDER BY a.name COLLATE NOCASE`
  );
}

export async function getAuthorByUid(uid: string): Promise<AuthorRow | null> {
  const db = getDb();
  const rows = await db.select<AuthorRow[]>("SELECT * FROM authors WHERE uid = ?", [uid]);
  return rows[0] ?? null;
}

// ============ 作品 ============

export interface WorkInsertMeta {
  workId?: string | null;
  authorId?: number | null;
  title?: string | null;
  description?: string | null;
  workType?: string | null;
  topics?: string | null;
  publishTime?: number | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  likeCount?: number | null;
  commentCount?: number | null;
  favoriteCount?: number | null;
  shareCount?: number | null;
  playCount?: number | null;
  coverStatic?: string | null;
  coverDynamic?: string | null;
  videoUri?: string | null;
  downloadUrl?: string | null;
  musicAuthor?: string | null;
  musicTitle?: string | null;
  hiddenTags?: string | null;
  extraInfo?: string | null;
  fileCount?: number;
  importLogId?: number | null;
  sourceType?: string | null;
  originalAuthor?: string | null;
  collectTime?: number | null;
  secUid?: string | null;
}

async function updateWorkById(db: Database, id: number, meta: WorkInsertMeta): Promise<void> {
  await db.execute(
    `UPDATE works SET
      author_id = COALESCE(?, author_id),
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      work_type = COALESCE(?, work_type),
      topics = COALESCE(?, topics),
      publish_time = COALESCE(?, publish_time),
      duration = COALESCE(?, duration),
      width = COALESCE(?, width),
      height = COALESCE(?, height),
      like_count = COALESCE(?, like_count),
      comment_count = COALESCE(?, comment_count),
      favorite_count = COALESCE(?, favorite_count),
      share_count = COALESCE(?, share_count),
      play_count = COALESCE(?, play_count),
      cover_static = COALESCE(?, cover_static),
      cover_dynamic = COALESCE(?, cover_dynamic),
      video_uri = COALESCE(?, video_uri),
      download_url = COALESCE(?, download_url),
      music_author = COALESCE(?, music_author),
      music_title = COALESCE(?, music_title),
      hidden_tags = COALESCE(?, hidden_tags),
      extra_info = COALESCE(?, extra_info),
      file_count = COALESCE(?, file_count),
      import_log_id = COALESCE(?, import_log_id),
      source_type = COALESCE(?, source_type),
      original_author = COALESCE(?, original_author),
      collect_time = COALESCE(?, collect_time),
      sec_uid = COALESCE(?, sec_uid)
     WHERE id = ?`,
    [
      meta.authorId ?? null,
      meta.title ?? null,
      meta.description ?? null,
      meta.workType ?? null,
      meta.topics ?? null,
      meta.publishTime ?? null,
      meta.duration ?? null,
      meta.width ?? null,
      meta.height ?? null,
      meta.likeCount ?? null,
      meta.commentCount ?? null,
      meta.favoriteCount ?? null,
      meta.shareCount ?? null,
      meta.playCount ?? null,
      meta.coverStatic ?? null,
      meta.coverDynamic ?? null,
      meta.videoUri ?? null,
      meta.downloadUrl ?? null,
      meta.musicAuthor ?? null,
      meta.musicTitle ?? null,
      meta.hiddenTags ?? null,
      meta.extraInfo ?? null,
      meta.fileCount ?? null,
      meta.importLogId ?? null,
      meta.sourceType ?? null,
      meta.originalAuthor ?? null,
      meta.collectTime ?? null,
      meta.secUid ?? null,
      id,
    ]
  );
  invalidateWorksTotalCache();
}

/** 按 id 更新作品元数据（用于重复导入时补充 topics/hidden_tags） */
export async function updateWorkMetadata(id: number, meta: WorkInsertMeta): Promise<void> {
  const db = getDb();
  await updateWorkById(db, id, meta);
}

export async function findWorkByTitleAndDate(
  authorId: number,
  title: string,
  publishDate: number | null
): Promise<WorkRow | null> {
  const db = getDb();
  if (publishDate) {
    const dayStart = getLocalDayStart(publishDate);
    const dayEnd = dayStart + 86400;
    const rows = await db.select<WorkRow[]>(
      `SELECT * FROM works
       WHERE author_id = ? AND title = ? AND publish_time >= ? AND publish_time < ?
       LIMIT 1`,
      [authorId, title, dayStart, dayEnd]
    );
    return rows[0] ?? null;
  }
  const rows = await db.select<WorkRow[]>(
    `SELECT * FROM works WHERE author_id = ? AND title = ? LIMIT 1`,
    [authorId, title]
  );
  return rows[0] ?? null;
}

export async function getWorks(filter?: {
  authorIds?: number[];
  authorUids?: string[];
  workType?: string;
  keyword?: string;
  tags?: string[];
  hiddenTags?: string[];
  workIds?: number[];
  sourceType?: string;
  sourceAuthorUid?: string;
  originalAuthor?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: WorkRow[]; total: number }> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter?.authorIds && filter.authorIds.length > 0) {
    // 作者 id 直筛：走 idx_works_author 索引（实测 21~2140 作品作者均 ≤3ms，
    // 对比全表扫描 0.57s / 时间索引走查 10.6s）。id 由 store 端从内存 authors 解析。
    const placeholders = filter.authorIds.map(() => "?").join(",");
    where.push(`w.author_id IN (${placeholders})`);
    params.push(...filter.authorIds);
  } else if (filter?.authorUids && filter.authorUids.length > 0) {
    // uid 兜底路径（store 内存中找不到对应作者时）：EXISTS 每行探测，仅罕见情况使用
    const placeholders = filter.authorUids.map(() => "?").join(",");
    where.push(
      `EXISTS (SELECT 1 FROM authors a WHERE a.id = w.author_id AND a.uid IN (${placeholders}))`
    );
    params.push(...filter.authorUids);
  }
  if (filter?.workType && filter.workType !== "all") {
    where.push("w.work_type = ?");
    params.push(filter.workType);
  }
  // source_type 筛选：可同时指定 sourceType 和 authorUid，精确到某作者的收藏/喜欢作品
  if (filter?.sourceType) {
    where.push("w.source_type = ?");
    params.push(filter.sourceType);
  }
  if (filter?.sourceAuthorUid) {
    where.push(
      "EXISTS (SELECT 1 FROM authors a2 WHERE a2.id = w.author_id AND a2.uid = ?)"
    );
    params.push(filter.sourceAuthorUid);
  }
  if (filter?.originalAuthor) {
    where.push("w.original_author = ?");
    params.push(filter.originalAuthor);
  }

  if (filter?.workIds && filter.workIds.length > 0) {
    const placeholders = filter.workIds.map(() => "?").join(",");
    where.push(`w.id IN (${placeholders})`);
    params.push(...filter.workIds);
  }

  // 多标签筛选：作品需要同时包含所有选中的标签（AND逻辑）
  // 匹配语义：topics 以空格分词，词等于 "#tag" 或 "tag"（ASCII 不区分大小写，与旧版 LIKE 行为一致）。
  // 用 ' '||topics||' ' 空格填充 + instr 实现（2 次匹配替代旧版 8 个 LIKE 模式，扫描成本减半）：
  // 首词/末词/整串/中间词均被覆盖，且不会误命中更长标签（如 "cos" 不会匹配 "#cosplay"，因为 # 前是空格判断）。
  // lower() 仅处理 ASCII（SQLite 无 ICU），与 LIKE 的不区分大小写范围一致
  if (filter?.tags && filter.tags.length > 0) {
    for (const tag of filter.tags) {
      const tagLower = tag.toLowerCase();
      where.push(
        "(instr(lower(' '||w.topics||' '), ?) > 0 OR instr(lower(' '||w.topics||' '), ?) > 0)"
      );
      params.push(` #${tagLower} `, ` ${tagLower} `);
    }
  }

  // 多隐藏标签筛选：作品需要同时包含所有选中的隐藏标签（AND逻辑）
  if (filter?.hiddenTags && filter.hiddenTags.length > 0) {
    for (const tag of filter.hiddenTags) {
      const tagLower = tag.toLowerCase();
      where.push(
        "(instr(lower(' '||w.hidden_tags||' '), ?) > 0 OR instr(lower(' '||w.hidden_tags||' '), ?) > 0)"
      );
      params.push(` #${tagLower} `, ` ${tagLower} `);
    }
  }

  if (filter?.keyword) {
    where.push(
      "(w.title LIKE ? OR w.description LIKE ? OR w.original_author LIKE ? OR EXISTS (SELECT 1 FROM authors a WHERE a.id = w.author_id AND a.name LIKE ?))"
    );
    const kw = `%${filter.keyword}%`;
    params.push(kw, kw, kw, kw);
  }
  // "有文件的作品"条件：EXISTS 走 idx_files_work 索引，等价于旧版 LEFT JOIN + GROUP BY + HAVING COUNT(f.id)>0，
  // 但避免在 10GB 库上物化整个 works×files 连接（COUNT 侧尤其致命）
  const whereSql = `WHERE EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)${
    where.length ? " AND " + where.join(" AND ") : ""
  }`;
  // 查询计划选择（实测 113 万作品库）：
  // - 索引走查（默认）：ORDER BY publish_time DESC 沿索引逐行回表过滤，匹配稀疏时要扫完全部索引——
  //   作者筛选（21 作品）10.6s、低频标签 5.0s，这是侧边栏点击卡顿的元凶；
  // - 全表扫描+排序（NOT INDEXED）：顺序读全表过滤后排序取前 N，稳定 ~1s；
  // - authorIds 直筛：走 idx_works_author，毫秒级（最优），交给优化器自由选择。
  // 因此：authorIds/workIds 筛选不干预计划；其余选择性筛选强制全表扫描；无筛选保留时间索引早停（0ms）。
  const hasWorkIdsFilter = (filter?.workIds?.length ?? 0) > 0;
  const hasAuthorIdsFilter = (filter?.authorIds?.length ?? 0) > 0;
  const selectiveFilter =
    !hasWorkIdsFilter &&
    !hasAuthorIdsFilter &&
    ((filter?.authorUids?.length ?? 0) > 0 ||
      (!!filter?.workType && filter.workType !== "all") ||
      (filter?.tags?.length ?? 0) > 0 ||
      (filter?.hiddenTags?.length ?? 0) > 0 ||
      !!filter?.keyword ||
      !!filter?.originalAuthor ||
      !!filter?.sourceType ||
      !!filter?.sourceAuthorUid);
  const worksSrc = selectiveFilter ? "works w NOT INDEXED" : "works w";
  const limit = filter?.limit ?? 100;
  const offset = filter?.offset ?? 0;
  // rows-first：先取行，不足一页说明已到末尾 → total = offset + 行数，省掉一次 COUNT 全扫；
  // 满页才需要 COUNT 获取准确总数（authorIds 直筛路径的 COUNT 走索引，毫秒级）
  const rows = await db.select<WorkRow[]>(
    `SELECT w.* FROM ${worksSrc} ${whereSql}
     ORDER BY w.publish_time DESC NULLS LAST
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  let total: number;
  if (rows.length < limit) {
    total = offset + rows.length;
  } else {
    // COUNT 缓存：同一筛选条件的总数在数据未变更期间不变。
    // 实测无筛选 COUNT(*) with EXISTS 在 113 万作品库上 ~250ms（每次切回"全部作者"都要付一次），
    // 标签等选择性筛选的 NOT INDEXED COUNT 更贵；缓存后筛选来回切换 0ms。
    // 任何 works/files 增删改处调用 invalidateWorksTotalCache() 失效。
    const cacheKey = `${whereSql}||${params.map((p) => String(p)).join("\u0001")}`;
    const cached = worksTotalCache.get(cacheKey);
    if (cached !== undefined) {
      total = cached;
    } else {
      total = (
        await db.select<{ c: number }[]>(
          `SELECT COUNT(*) AS c FROM works w ${whereSql}`,
          params
        )
      )[0].c;
      if (worksTotalCache.size >= WORKS_TOTAL_CACHE_MAX) {
        // FIFO 淘汰：Map 迭代顺序即插入顺序，删最早的键
        const oldest = worksTotalCache.keys().next().value;
        if (oldest !== undefined) worksTotalCache.delete(oldest);
      }
      worksTotalCache.set(cacheKey, total);
    }
  }
  return { rows, total };
}

/** getWorks COUNT 总数缓存（按 whereSql+params 签名），数据变更时整体失效 */
const worksTotalCache = new Map<string, number>();
const WORKS_TOTAL_CACHE_MAX = 24;

/** works 数据代数：每次增删改 +1，供上层列表快照缓存判断是否过期 */
let worksDataGeneration = 0;
export function getWorksDataGeneration(): number {
  return worksDataGeneration;
}

/** works/files 发生增删改后调用，使各筛选条件的总数缓存失效 */
export function invalidateWorksTotalCache(): void {
  worksTotalCache.clear();
  worksDataGeneration++;
}

/**
 * 标签统计：tag_counts 物化表方案。
 *
 * 演进历史：
 * 1. 旧版把百万级标签字符串全量拉到 JS 逐条 split —— WebView OOM 白屏；
 * 2. 中期改为递归 CTE 直接聚合，但结果集（20 万+ 唯一标签）仍全量回传
 *    WebView 并放入 Vue 响应式数组，启动依旧撑爆渲染进程；
 * 3. 现方案：CTE 仅在"重建"时作为 INSERT ... SELECT 的数据源在 SQLite 内
 *    一次性物化到 tag_counts 表（无 IPC 行传输），日常查询走物化表 +
 *    LIMIT + SQL 端 LIKE 过滤，回传行数严格有界（≤ limit）。
 *
 * CTE 边界处理：
 * - 制表符/换行先归一为空格（对齐旧 JS 版 /\s+/ 语义）
 * - rest 中无空格时整段作为最后一个标签并终止（防止 instr=0 死循环）
 */
const TAG_REBUILD_SQL = (col: string, isHidden: number) => `
WITH RECURSIVE split(tag, rest) AS (
  SELECT '', replace(replace(replace(${col}, char(9), ' '), char(10), ' '), char(13), ' ') || ' '
  FROM works
  WHERE ${col} IS NOT NULL AND ${col} != ''
  UNION ALL
  SELECT
    ltrim(
      substr(rest, 1, CASE WHEN instr(rest, ' ') > 0 THEN instr(rest, ' ') - 1 ELSE LENGTH(rest) END),
      '#'
    ),
    CASE WHEN instr(rest, ' ') > 0 THEN substr(rest, instr(rest, ' ') + 1) ELSE '' END
  FROM split
  WHERE rest <> ''
)
INSERT INTO tag_counts (tag, is_hidden, count)
SELECT tag, ${isHidden}, COUNT(*) FROM split WHERE tag <> '' GROUP BY tag`;

/** 重建标签计数物化表（导入/元数据补充/回滚后调用；百万作品约 5-10s，全程在 SQLite 内执行） */
export async function rebuildTagCounts(): Promise<void> {
  const db = getDb();
  const t0 = Date.now();
  await db.execute("DELETE FROM tag_counts");
  await db.execute(TAG_REBUILD_SQL("topics", 0));
  await db.execute(TAG_REBUILD_SQL("hidden_tags", 1));
  const worksCount = (await db.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM works"))[0].c;
  await db.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('tag_counts_works', ?)", [
    String(worksCount),
  ]);
  console.log(`[DB] 标签计数已重建（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}

/** 启动时校验物化表是否过期（构建时的 works 行数 ≠ 当前行数即重建），保证断电/中断后自愈 */
async function ensureTagCountsFresh(): Promise<void> {
  try {
    const db = getDb();
    const meta = await db.select<{ value: string }[]>(
      "SELECT value FROM app_meta WHERE key = 'tag_counts_works'"
    );
    const built = meta[0]?.value ? parseInt(meta[0].value, 10) : -1;
    const current = (await db.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM works"))[0].c;
    if (built === current) return;
    console.log(`[DB] 标签计数物化表过期（构建于 ${built} 作品，当前 ${current}），重建中...`);
    await rebuildTagCounts();
  } catch (e) {
    console.warn("[DB] 标签计数校验失败:", e);
  }
}

/** 标签查询结果：有界的条目列表 + 匹配总数（总数用于侧边栏徽标，不随条目截断） */
export interface TagPage {
  items: { name: string; count: number }[];
  total: number;
}

async function getTagPage(
  isHidden: number,
  opts?: { keyword?: string; limit?: number }
): Promise<TagPage> {
  const db = getDb();
  const limit = Math.max(1, Math.min(opts?.limit ?? 500, 10000));
  const where: string[] = ["is_hidden = ?"];
  const params: unknown[] = [isHidden];
  if (opts?.keyword) {
    where.push("tag LIKE ?");
    params.push(`%${opts.keyword}%`);
  }
  const whereSql = where.join(" AND ");
  const total = (
    await db.select<{ c: number }[]>(`SELECT COUNT(*) AS c FROM tag_counts WHERE ${whereSql}`, params)
  )[0].c;
  const items = await db.select<{ name: string; count: number }[]>(
    `SELECT tag AS name, count FROM tag_counts WHERE ${whereSql} ORDER BY count DESC LIMIT ?`,
    [...params, limit]
  );
  return { items, total };
}

/**
 * 普通标签分页查询（高频优先）。
 * keyword 在 SQL 端做 LIKE 过滤，可命中全量 20 万+ 标签（无需全部载入内存）。
 */
export async function getTopics(opts?: { keyword?: string; limit?: number }): Promise<TagPage> {
  return getTagPage(0, opts);
}

/** 隐藏标签分页查询（同 getTopics） */
export async function getHiddenTags(opts?: { keyword?: string; limit?: number }): Promise<TagPage> {
  return getTagPage(1, opts);
}

/**
 * 获取集合作者（枫临的收藏/枫临的喜欢）下的原始作者列表。
 * 用于侧边栏展开后显示子项：千寻-收藏、孔熊猫-收藏 等。
 * 排除包含"发布"的 source_type。
 */
export async function getCollectionChildren(): Promise<
  {
    collectionAuthorId: number;
    collectionAuthorUid: string;
    collectionAuthorName: string;
    originalAuthor: string;
    sourceType: string;
    count: number;
  }[]
> {
  const db = getDb();
  const rows = await db.select<
    {
      author_id: number;
      author_uid: string;
      author_name: string;
      original_author: string;
      source_type: string;
      count: number;
    }[]
  >(
    `SELECT w.author_id, a.uid AS author_uid, a.name AS author_name,
            w.original_author, w.source_type, COUNT(*) as count
     FROM works w
     JOIN authors a ON a.id = w.author_id
     WHERE w.original_author IS NOT NULL AND w.original_author != ''
       AND w.source_type IS NOT NULL AND w.source_type NOT LIKE '%发布%'
     GROUP BY w.author_id, w.original_author, w.source_type
     ORDER BY a.name COLLATE NOCASE, w.original_author COLLATE NOCASE`
  );
  return rows.map((r) => ({
    collectionAuthorId: r.author_id,
    collectionAuthorUid: r.author_uid,
    collectionAuthorName: r.author_name,
    originalAuthor: r.original_author,
    sourceType: r.source_type,
    count: r.count,
  }));
}

// ============ 文件 ============

export async function insertFile(file: Omit<FileRow, "id" | "created_at">): Promise<number> {
  const db = getDb();
  const ts = nowTs();
  const result = await db.execute(
    `INSERT OR REPLACE INTO files
     (work_id, absolute_path, filename, extension, media_type, seq, size_bytes, mtime, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      file.work_id,
      file.absolute_path,
      file.filename,
      file.extension ?? null,
      file.media_type ?? null,
      file.seq ?? 0,
      file.size_bytes ?? null,
      file.mtime ?? null,
      ts,
    ]
  );
  invalidateWorksTotalCache();
  return result.lastInsertId ?? 0;
}

/**
 * 批量插入文件记录（多行INSERT，每批一条语句）
 * 比逐条 insertFile 快 10-50 倍，是大规模导入的主要性能优化
 *
 * 注意：不使用 BEGIN/COMMIT 手动事务。Tauri SQL 插件底层使用连接池，
 * 每次 db.execute() 可能使用不同连接，手动事务会导致 "database is locked" 错误。
 * SQLite 单条 INSERT 语句本身是原子的，足以保证每批数据的完整性。
 *
 * SQLite 参数限制：999 个/语句，每行 9 列 → 每语句最多 111 行，实际取 100
 */
export async function insertFilesBatch(
  files: Array<Omit<FileRow, "id" | "created_at">>
): Promise<number> {
  if (files.length === 0) return 0;
  const db = getDb();
  const ts = nowTs();
  const BATCH_SIZE = 100; // 100 rows * 9 params = 900 < 999 limit
  let totalInserted = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const chunk = files.slice(i, i + BATCH_SIZE);
    const placeholders = chunk
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    const params: unknown[] = [];
    for (const f of chunk) {
      params.push(
        f.work_id,
        f.absolute_path,
        f.filename,
        f.extension ?? null,
        f.media_type ?? null,
        f.seq ?? 0,
        f.size_bytes ?? null,
        f.mtime ?? null,
        ts
      );
    }
    await db.execute(
      `INSERT OR REPLACE INTO files
       (work_id, absolute_path, filename, extension, media_type, seq, size_bytes, mtime, created_at)
       VALUES ${placeholders}`,
      params
    );
    totalInserted += chunk.length;
  }
  invalidateWorksTotalCache();
  return totalInserted;
}

export async function getFilesByWork(workId: number): Promise<FileRow[]> {
  const db = getDb();
  return db.select<FileRow[]>(
    "SELECT * FROM files WHERE work_id = ? ORDER BY seq ASC, filename ASC",
    [workId]
  );
}

/**
 * 按作者+精确发布时间戳查找已有作品（用于去重）。
 * 注意：按精确时间戳匹配，而非按天匹配——避免同一天不同作品被错误合并。
 */
export async function findWorkByAuthorAndDate(
  authorId: number,
  publishTime: number | null,
  originalAuthor?: string | null
): Promise<{ id: number } | null> {
  const db = getDb();
  if (publishTime === null || publishTime <= 0) return null;
  // 收藏/喜欢文件夹内：按 author_id + publish_time + original_author 精确匹配
  // 避免不同原始作者的同日作品被误匹配为同一作品
  if (originalAuthor) {
    const rows = await db.select<{ id: number }[]>(
      "SELECT id FROM works WHERE author_id = ? AND publish_time = ? AND original_author = ? LIMIT 1",
      [authorId, publishTime, originalAuthor]
    );
    return rows[0] ?? null;
  }
  // 普通文件夹：按 author_id + publish_time 匹配
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM works WHERE author_id = ? AND publish_time = ? LIMIT 1",
    [authorId, publishTime]
  );
  return rows[0] ?? null;
}

export async function findWorkByAuthorAndTitle(
  authorId: number,
  title: string,
  publishTime: number | null,
  originalAuthor?: string | null
): Promise<{ id: number } | null> {
  const db = getDb();
  if (originalAuthor) {
    // 收藏/喜欢文件夹内：额外匹配 original_author，避免不同作者的同标题作品混在一起
    if (publishTime !== null) {
      const rows = await db.select<{ id: number }[]>(
        "SELECT id FROM works WHERE author_id = ? AND title = ? AND publish_time = ? AND original_author = ? LIMIT 1",
        [authorId, title, publishTime, originalAuthor]
      );
      if (rows.length > 0) return rows[0];
    } else {
      const rows = await db.select<{ id: number }[]>(
        "SELECT id FROM works WHERE author_id = ? AND title = ? AND (publish_time IS NULL OR publish_time = 0) AND original_author = ? LIMIT 1",
        [authorId, title, originalAuthor]
      );
      if (rows.length > 0) return rows[0];
    }
    return null;
  }
  if (publishTime !== null) {
    const rows = await db.select<{ id: number }[]>(
      "SELECT id FROM works WHERE author_id = ? AND title = ? AND publish_time = ? LIMIT 1",
      [authorId, title, publishTime]
    );
    if (rows.length > 0) return rows[0];
  } else {
    const rows = await db.select<{ id: number }[]>(
      "SELECT id FROM works WHERE author_id = ? AND title = ? AND (publish_time IS NULL OR publish_time = 0) LIMIT 1",
      [authorId, title]
    );
    if (rows.length > 0) return rows[0];
  }
  return null;
}

/** 检查文件路径是否已存在 */
export async function fileExists(absolutePath: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select<{ cnt: number }[]>(
    "SELECT COUNT(*) as cnt FROM files WHERE absolute_path = ?",
    [absolutePath]
  );
  return (rows[0]?.cnt ?? 0) > 0;
}

/**
 * 按作者加载已有文件路径集合（内存有界：仅当前作者的文件，随作者迭代释放）
 * 百万级文件时全量 Set 会占用数百 MB 内存，故按作者分批加载
 */
export async function getExistingFilePathsByAuthor(authorId: number): Promise<Set<string>> {
  const db = getDb();
  const rows = await db.select<{ absolute_path: string }[]>(
    "SELECT absolute_path FROM files WHERE work_id IN (SELECT id FROM works WHERE author_id = ?)",
    [authorId]
  );
  return new Set(rows.map((r) => r.absolute_path));
}

/** 获取所有已存在作品的 work_id → id 映射（去重 + 免 SELECT 定位） */
export async function getExistingWorkIdMap(): Promise<Map<string, number>> {
  const db = getDb();
  const rows = await db.select<{ work_id: string; id: number }[]>(
    "SELECT work_id, id FROM works WHERE work_id IS NOT NULL"
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.work_id, r.id);
  return map;
}

/** 获取 works 表当前最大 id（批量插入前预分配自增 id 用） */
export async function getMaxWorkId(): Promise<number> {
  const db = getDb();
  const rows = await db.select<{ maxId: number | null }[]>(
    "SELECT MAX(id) AS maxId FROM works"
  );
  return rows[0]?.maxId ?? 0;
}

/**
 * 批量插入新作品（显式 id 由调用方从 getMaxWorkId()+1 预分配）。
 * 显式插入 AUTOINCREMENT 表会自动推进 sqlite_sequence，不影响后续自增。
 * 替代逐条 upsertWorkByWorkId（每条 2 次 IPC），批量后 IPC 数减少 99%+。
 */
export async function insertWorksBatch(
  works: Array<WorkInsertMeta & { id: number }>
): Promise<number> {
  if (works.length === 0) return 0;
  const db = getDb();
  const ts = nowTs();
  // 31 列（id + 30 业务列）× 每批 30 行 = 930 参数 < 999 上限
  const ROW_PLACEHOLDER = `(${Array(31).fill("?").join(", ")})`;
  const BATCH_SIZE = 30;
  let totalInserted = 0;

  for (let i = 0; i < works.length; i += BATCH_SIZE) {
    const chunk = works.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => ROW_PLACEHOLDER).join(", ");
    const params: unknown[] = [];
    for (const w of chunk) {
      params.push(
        w.id,
        w.workId ?? null,
        w.authorId ?? null,
        w.title ?? null,
        w.description ?? null,
        w.workType ?? null,
        w.topics ?? null,
        w.publishTime ?? null,
        w.duration ?? null,
        w.width ?? null,
        w.height ?? null,
        w.likeCount ?? null,
        w.commentCount ?? null,
        w.favoriteCount ?? null,
        w.shareCount ?? null,
        w.playCount ?? null,
        w.coverStatic ?? null,
        w.coverDynamic ?? null,
        w.videoUri ?? null,
        w.downloadUrl ?? null,
        w.musicAuthor ?? null,
        w.musicTitle ?? null,
        w.hiddenTags ?? null,
        w.extraInfo ?? null,
        w.fileCount ?? null,
        ts,
        w.importLogId ?? null,
        w.sourceType ?? null,
        w.originalAuthor ?? null,
        w.collectTime ?? null,
        w.secUid ?? null
      );
    }
    await db.execute(
      `INSERT INTO works
       (id, work_id, author_id, title, description, work_type, topics, publish_time,
        duration, width, height, like_count, comment_count, favorite_count, share_count,
        play_count, cover_static, cover_dynamic, video_uri, download_url, music_author,
        music_title, hidden_tags, extra_info, file_count, created_at, import_log_id,
        source_type, original_author, collect_time, sec_uid)
       VALUES ${placeholders}`,
      params
    );
    totalInserted += chunk.length;
  }
  invalidateWorksTotalCache();
  return totalInserted;
}

/**
 * 一次性加载某作者的全部已有作品，用于内存中去重匹配
 * 替代逐条 findWorkByAuthorAndTitle/findWorkByAuthorAndDate 查询，减少 IPC 调用
 */
export interface ExistingWorkInfo {
  id: number;
  workId: string | null;
  title: string | null;
  publishTime: number | null;
  originalAuthor: string | null;
  fileCount: number | null;
  /** 0/1：是否已有话题等 Excel 元数据（用于判断重复导入时是否需要补充更新） */
  hasTopics: number;
}

export async function getWorksByAuthorForMatching(authorId: number): Promise<ExistingWorkInfo[]> {
  const db = getDb();
  return db.select<ExistingWorkInfo[]>(
    "SELECT id, work_id AS workId, title, publish_time AS publishTime, original_author AS originalAuthor, file_count AS fileCount, (topics IS NOT NULL AND topics != '') AS hasTopics FROM works WHERE author_id = ?",
    [authorId]
  );
}

export async function getFilesByWorks(workIds: number[]): Promise<FileRow[]> {
  const db = getDb();
  if (workIds.length === 0) return [];
  const placeholders = workIds.map(() => "?").join(",");
  return db.select<FileRow[]>(
    `SELECT * FROM files WHERE work_id IN (${placeholders}) ORDER BY work_id ASC, seq ASC, filename ASC`,
    workIds
  );
}

/**
 * 轻量作品 id 池（刷抖音模式的随机抽取源）：仅返回有媒体文件的作品 id。
 * 百万级作品时仅传输 number 数组（~8MB），替代全量拉取作品+文件对象导致的 WebView OOM。
 */
export async function getWorkIdsForPlaylist(): Promise<number[]> {
  const db = getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT w.id FROM works w WHERE EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"
  );
  return rows.map((r) => r.id);
}

/**
 * 按 id 批量删除作品（files 经外键 ON DELETE CASCADE 级联删除）。
 * 用于"取消导入且不保留"时回滚本次新建的作品；分批 IN 避免超出 SQLite 变量上限。
 */
export async function deleteWorksByIds(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const placeholders = chunk.map(() => "?").join(",");
    await db.execute(`DELETE FROM works WHERE id IN (${placeholders})`, chunk);
  }
  invalidateWorksTotalCache();
}

export async function clearFilesByWork(workId: number): Promise<void> {
  const db = getDb();
  await db.execute("DELETE FROM files WHERE work_id = ?", [workId]);
  invalidateWorksTotalCache();
}

export async function updateWorkFileCount(workId: number): Promise<void> {
  const db = getDb();
  await db.execute(
    `UPDATE works SET file_count = (SELECT COUNT(*) FROM files WHERE work_id = ?) WHERE id = ?`,
    [workId, workId]
  );
}

// ============ 缩略图 ============

export async function upsertThumbnail(
  fileId: number,
  thumbPath: string,
  width?: number | null,
  height?: number | null
): Promise<number> {
  const db = getDb();
  const ts = nowTs();
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM thumbnails WHERE file_id = ?",
    [fileId]
  );
  if (existing.length > 0) {
    const id = existing[0].id;
    await db.execute(
      "UPDATE thumbnails SET thumb_path = ?, width = ?, height = ?, generated_at = ? WHERE id = ?",
      [thumbPath, width ?? null, height ?? null, ts, id]
    );
    return id;
  }
  const result = await db.execute(
    `INSERT INTO thumbnails (file_id, thumb_path, width, height, generated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [fileId, thumbPath, width ?? null, height ?? null, ts]
  );
  return result.lastInsertId ?? 0;
}

// ============ 维护 ============

export async function clearAllData(): Promise<void> {
  const db = getDb();
  await db.execute("DELETE FROM thumbnails;");
  await db.execute("DELETE FROM files;");
  await db.execute("DELETE FROM works;");
  await db.execute("DELETE FROM authors;");
  await db.execute("DELETE FROM import_logs;");
  invalidateWorksTotalCache();
}

export interface ImportLogRow {
  id: number;
  root_path: string;
  total_authors: number;
  total_works: number;
  total_files: number;
  skipped_files?: number;
  unmatched_files?: number;
  excel_files?: string | null;
  errors?: string | null;
  status: string;
  started_at: number;
  finished_at: number;
}

export async function getImportLogs(): Promise<ImportLogRow[]> {
  const db = getDb();
  return db.select<ImportLogRow[]>(
    "SELECT * FROM import_logs ORDER BY started_at DESC LIMIT 50"
  );
}

export async function deleteImportLog(id: number): Promise<void> {
  const db = getDb();
  await db.execute("DELETE FROM import_logs WHERE id = ?", [id]);
}

/** 清空全部导入历史记录（仅删除 import_logs 表，不影响已导入的数据） */
export async function clearAllImportLogs(): Promise<void> {
  const db = getDb();
  await db.execute("DELETE FROM import_logs");
}

/**
 * 创建导入日志（状态 running），返回日志 ID
 * 导入开始时调用，导入结束时调用 finishImportLog 更新统计
 */
export async function createImportLog(rootPath: string): Promise<number> {
  const db = getDb();
  const ts = nowTs();
  const result = await db.execute(
    `INSERT INTO import_logs (root_path, status, started_at)
     VALUES (?, ?, ?)`,
    [rootPath, "running", ts]
  );
  return result.lastInsertId ?? 0;
}

/**
 * 完成导入日志：更新统计、xlsx 文件列表、状态
 */
export async function finishImportLog(
  id: number,
  stats: {
    totalAuthors: number;
    totalWorks: number;
    totalFiles: number;
    skippedFiles: number;
    unmatchedFiles: number;
    excelFiles: string[];
    errors: string[];
    status: string;
  }
): Promise<void> {
  const db = getDb();
  const ts = nowTs();
  await db.execute(
    `UPDATE import_logs SET
      total_authors = ?,
      total_works = ?,
      total_files = ?,
      skipped_files = ?,
      unmatched_files = ?,
      excel_files = ?,
      errors = ?,
      status = ?,
      finished_at = ?
     WHERE id = ?`,
    [
      stats.totalAuthors,
      stats.totalWorks,
      stats.totalFiles,
      stats.skippedFiles,
      stats.unmatchedFiles,
      JSON.stringify(stats.excelFiles),
      stats.errors.length > 0 ? JSON.stringify(stats.errors) : null,
      stats.status,
      ts,
      id,
    ]
  );
}

/**
 * 级联删除导入：删除该次导入关联的全部作者和作品（同时删除文件、缩略图记录）
 *
 * 匹配策略（兼容 v3 前的旧数据）：
 * 1. 优先按 import_log_id 精确匹配（v3+ 新导入的数据）
 * 2. 兜底按 root_path 匹配 folder_path（旧数据 import_log_id 为 NULL）
 *    —— 旧数据没有 import_log_id，只能通过 root_path 前缀定位作者
 *
 * 删除顺序：files → thumbnails → works → authors → import_logs
 */
export async function deleteImportLogCascade(importLogId: number): Promise<void> {
  const db = getDb();

  // 获取该次导入的 root_path（用于兜底匹配旧数据）
  const logRows = await db.select<{ root_path: string }[]>(
    "SELECT root_path FROM import_logs WHERE id = ?",
    [importLogId]
  );
  const rootPath = logRows[0]?.root_path ?? "";

  // 1. 收集该次导入的所有 author_id
  //    匹配条件：import_log_id 精确匹配 OR（旧数据 import_log_id 为 NULL 且 folder_path 在 root_path 下）
  //    folder_path 在 root_path 下的判断：folder_path 以 root_path + 路径分隔符开头
  const authorRows = await db.select<{ id: number }[]>(
    `SELECT id FROM authors
     WHERE import_log_id = ?
        OR (import_log_id IS NULL
            AND folder_path IS NOT NULL
            AND length(folder_path) > length(?)
            AND substr(folder_path, 1, length(?)) = ?
            AND substr(folder_path, length(?) + 1, 1) IN ('/', '\\'))`,
    [importLogId, rootPath, rootPath, rootPath, rootPath]
  );
  const authorIds = authorRows.map((r) => r.id);

  // 2. 收集该次导入的所有 work_id（兜底：import_log_id 匹配 或 author 在上面收集的范围内）
  const workRows = await db.select<{ id: number }[]>(
    `SELECT id FROM works
     WHERE import_log_id = ?
        OR (import_log_id IS NULL AND author_id IN (
          SELECT id FROM authors
          WHERE import_log_id IS NULL
            AND folder_path IS NOT NULL
            AND length(folder_path) > length(?)
            AND substr(folder_path, 1, length(?)) = ?
            AND substr(folder_path, length(?) + 1, 1) IN ('/', '\\')
        ))`,
    [importLogId, rootPath, rootPath, rootPath, rootPath]
  );
  const workIds = workRows.map((r) => r.id);

  // 3. 删除这些作品关联的文件和缩略图（不依赖外键级联，确保彻底清理）
  for (const w of workIds) {
    await db.execute(
      "DELETE FROM thumbnails WHERE file_id IN (SELECT id FROM files WHERE work_id = ?)",
      [w]
    );
    await db.execute("DELETE FROM files WHERE work_id = ?", [w]);
  }

  // 4. 删除该次导入的 works（兜底，处理 author 已被其他导入覆盖的情况）
  if (workIds.length > 0) {
    const placeholders = workIds.map(() => "?").join(",");
    await db.execute(`DELETE FROM works WHERE id IN (${placeholders})`, workIds);
  }

  // 5. 删除该次导入的 authors（级联删除其名下 works、files、thumbnails）
  for (const a of authorIds) {
    await db.execute(
      "DELETE FROM thumbnails WHERE file_id IN (SELECT id FROM files WHERE work_id IN (SELECT id FROM works WHERE author_id = ?))",
      [a]
    );
    await db.execute(
      "DELETE FROM files WHERE work_id IN (SELECT id FROM works WHERE author_id = ?)",
      [a]
    );
    await db.execute("DELETE FROM works WHERE author_id = ?", [a]);
    await db.execute("DELETE FROM authors WHERE id = ?", [a]);
  }

  // 6. 删除 import_logs 记录（导入管理Tab删除时同步清除日志记录）
  await db.execute("DELETE FROM import_logs WHERE id = ?", [importLogId]);
  invalidateWorksTotalCache();
}

/**
 * 统计某次导入关联的作者数和作品数（用于删除前预览）
 * 同样使用 root_path 兜底匹配旧数据
 */
export async function getImportLogStats(
  importLogId: number
): Promise<{ authorCount: number; workCount: number; fileCount: number }> {
  const db = getDb();

  // 获取 root_path
  const logRows = await db.select<{ root_path: string }[]>(
    "SELECT root_path FROM import_logs WHERE id = ?",
    [importLogId]
  );
  const rootPath = logRows[0]?.root_path ?? "";

  const rows = await db.select<{ a: number; w: number; f: number }[]>(
    `SELECT
      (SELECT COUNT(*) FROM authors
       WHERE import_log_id = ?
          OR (import_log_id IS NULL
              AND folder_path IS NOT NULL
              AND length(folder_path) > length(?)
              AND substr(folder_path, 1, length(?)) = ?
              AND substr(folder_path, length(?) + 1, 1) IN ('/', '\\'))) AS a,
      (SELECT COUNT(*) FROM works
       WHERE import_log_id = ?
          OR (import_log_id IS NULL AND author_id IN (
            SELECT id FROM authors
            WHERE import_log_id IS NULL
              AND folder_path IS NOT NULL
              AND length(folder_path) > length(?)
              AND substr(folder_path, 1, length(?)) = ?
              AND substr(folder_path, length(?) + 1, 1) IN ('/', '\\')
          ))) AS w,
      (SELECT COUNT(*) FROM files WHERE work_id IN (
        SELECT id FROM works
        WHERE import_log_id = ?
           OR (import_log_id IS NULL AND author_id IN (
             SELECT id FROM authors
             WHERE import_log_id IS NULL
               AND folder_path IS NOT NULL
               AND length(folder_path) > length(?)
               AND substr(folder_path, 1, length(?)) = ?
               AND substr(folder_path, length(?) + 1, 1) IN ('/', '\\')
           ))
      )) AS f`,
    [
      importLogId, rootPath, rootPath, rootPath, rootPath,
      importLogId, rootPath, rootPath, rootPath, rootPath,
      importLogId, rootPath, rootPath, rootPath, rootPath,
    ]
  );
  return {
    authorCount: rows[0]?.a ?? 0,
    workCount: rows[0]?.w ?? 0,
    fileCount: rows[0]?.f ?? 0,
  };
}

export async function deleteAuthorById(authorId: number): Promise<void> {
  const db = getDb();
  // 先删除该作者下所有作品的文件和缩略图
  const workIds = await db.select<{ id: number }[]>(
    "SELECT id FROM works WHERE author_id = ?",
    [authorId]
  );
  for (const w of workIds) {
    await db.execute("DELETE FROM thumbnails WHERE file_id IN (SELECT id FROM files WHERE work_id = ?)", [w.id]);
    await db.execute("DELETE FROM files WHERE work_id = ?", [w.id]);
  }
  await db.execute("DELETE FROM works WHERE author_id = ?", [authorId]);
  await db.execute("DELETE FROM authors WHERE id = ?", [authorId]);
  invalidateWorksTotalCache();
}

// ============ Excel 元数据缓存（excel_rows） ============

/**
 * 将 ExcelMetaRow 数组批量写入 excel_rows 缓存表
 * 同一 source_path 已存在时跳过（避免重复缓存）
 *
 * @param rows Excel 元数据行
 * @param sourcePath xlsx 文件绝对路径（去重键）
 * @param sourceFilename xlsx 文件名
 * @param sourceUid 作者 UID（来自文件名解析）
 * @param sourceType 来源类型（发布作品/收藏作品/喜欢作品）
 * @returns 实际插入的行数
 */
export async function insertExcelRows(
  rows: Array<{
    workId?: string | null;
    description?: string | null;
    topics?: string | null;
    publishTime?: string | null;
    collectTime?: string | null;
    duration?: string | null;
    height?: number | null;
    width?: number | null;
    likeCount?: number | null;
    commentCount?: number | null;
    favoriteCount?: number | null;
    shareCount?: number | null;
    playCount?: number | null;
    coverStatic?: string | null;
    coverDynamic?: string | null;
    videoUri?: string | null;
    downloadUrl?: string | null;
    musicAuthor?: string | null;
    musicTitle?: string | null;
    hiddenTags?: string | null;
    extraInfo?: string | null;
    secUid?: string | null;
    authorName?: string | null;
    authorSignature?: string | null;
    workType?: string | null;
  }>,
  sourcePath: string,
  sourceFilename: string,
  sourceUid: string,
  sourceType: string
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();

  // 同 source_path 已缓存则直接跳过（重新导入时由调用方先 deleteExcelRowsByPath）
  const existing = await db.select<{ cnt: number }[]>(
    "SELECT COUNT(*) AS cnt FROM excel_rows WHERE source_path = ?",
    [sourcePath]
  );
  if ((existing[0]?.cnt ?? 0) > 0) {
    console.log("[DB] excel_rows 已缓存，跳过:", sourceFilename);
    return 0;
  }

  const batchId = nowTs();
  // 31 列 × 每批 30 行 = 930 个参数，留出余量
  const BATCH_SIZE = 30;
  // 列数（含首尾 batch_id/imported_at 共 31 列），用代码生成占位符避免手工计数出错
  // 之前手写 30 个 ? 导致 "30 values for 31 columns"，缓存写入全部失败
  const ROW_PLACEHOLDER = `(${Array(31).fill("?").join(", ")})`;
  let totalInserted = 0;

  // 注意：不使用 BEGIN/COMMIT 手动事务（Tauri SQL 插件连接池会导致 locked 错误）
  // 每批 INSERT 是单条语句，SQLite 保证其原子性
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => ROW_PLACEHOLDER).join(", ");
    const params: unknown[] = [];
    for (const r of chunk) {
      params.push(
        batchId,
        sourceUid,
        sourceType,
        sourceFilename,
        sourcePath,
        r.workId ?? null,
        r.description ?? null,
        r.topics ?? null,
        r.publishTime ?? null,
        r.collectTime ?? null,
        r.duration ?? null,
        r.height ?? null,
        r.width ?? null,
        r.likeCount ?? null,
        r.commentCount ?? null,
        r.favoriteCount ?? null,
        r.shareCount ?? null,
        r.playCount ?? null,
        r.coverStatic ?? null,
        r.coverDynamic ?? null,
        r.videoUri ?? null,
        r.downloadUrl ?? null,
        r.musicAuthor ?? null,
        r.musicTitle ?? null,
        r.hiddenTags ?? null,
        r.extraInfo ?? null,
        r.secUid ?? null,
        r.authorName ?? null,
        r.authorSignature ?? null,
        r.workType ?? null,
        batchId
      );
    }
    await db.execute(
      `INSERT INTO excel_rows
       (batch_id, source_uid, source_type, source_filename, source_path,
        work_id, description, topics, publish_time, collect_time, duration,
        height, width, like_count, comment_count, favorite_count, share_count,
        play_count, cover_static, cover_dynamic, video_uri, download_url,
        music_author, music_title, hidden_tags, extra_info, sec_uid,
        author_name, author_signature, work_type, imported_at)
       VALUES ${placeholders}`,
      params
    );
    totalInserted += chunk.length;
  }
  return totalInserted;
}

/** 检查某 xlsx 文件是否已缓存（按 source_path 精确匹配） */
export async function isExcelCached(sourcePath: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select<{ cnt: number }[]>(
    "SELECT COUNT(*) AS cnt FROM excel_rows WHERE source_path = ?",
    [sourcePath]
  );
  return (rows[0]?.cnt ?? 0) > 0;
}

/** 按 source_path 删除缓存（用于重新解析单个文件） */
export async function deleteExcelRowsByPath(sourcePath: string): Promise<number> {
  const db = getDb();
  const result = await db.execute("DELETE FROM excel_rows WHERE source_path = ?", [sourcePath]);
  return result.rowsAffected ?? 0;
}

/** 按 batch_id 删除整批缓存 */
export async function deleteExcelBatch(batchId: number): Promise<number> {
  const db = getDb();
  const result = await db.execute("DELETE FROM excel_rows WHERE batch_id = ?", [batchId]);
  return result.rowsAffected ?? 0;
}

/**
 * 按 (source_uid, source_type) 读取缓存的 Excel 行
 * 收藏/喜欢类型按 `uid__sourceType` 拼接作为 key（与作品匹配逻辑一致）
 */
export async function getExcelRowsByUid(
  sourceUid: string,
  sourceType?: string
): Promise<ExcelRowRecord[]> {
  const db = getDb();
  if (sourceType !== undefined) {
    return db.select<ExcelRowRecord[]>(
      "SELECT * FROM excel_rows WHERE source_uid = ? AND source_type = ? ORDER BY id ASC",
      [sourceUid, sourceType]
    );
  }
  return db.select<ExcelRowRecord[]>(
    "SELECT * FROM excel_rows WHERE source_uid = ? ORDER BY id ASC",
    [sourceUid]
  );
}

/**
 * Excel 缓存行的 source_uid 分组（轻量查询，用于按 uid 流式处理避免全量加载）
 */
export async function getExcelRowUidGroups(): Promise<Array<{ source_uid: string; cnt: number }>> {
  const db = getDb();
  return db.select<Array<{ source_uid: string; cnt: number }>>(
    "SELECT source_uid, COUNT(*) AS cnt FROM excel_rows GROUP BY source_uid ORDER BY source_uid ASC"
  );
}

/**
 * 按作者 uid 加载作品（含 `uid__收藏/喜欢` 变体作者），用于元数据补充的分组匹配
 * 注意用 GLOB 而非 LIKE：LIKE 中 `_` 是单字符通配符，会把 UID12345 误匹配到 UID123 的变体
 */
export async function getWorksForMatchingByUid(authorUid: string): Promise<
  Array<{
    id: number;
    work_id: string | null;
    author_id: number | null;
    title: string | null;
    publish_time: number | null;
    work_type: string | null;
    source_type: string | null;
    original_author: string | null;
    author_uid: string;
  }>
> {
  const db = getDb();
  return db.select<
    Array<{
      id: number;
      work_id: string | null;
      author_id: number | null;
      title: string | null;
      publish_time: number | null;
      work_type: string | null;
      source_type: string | null;
      original_author: string | null;
      author_uid: string;
    }>
  >(
    `SELECT w.id, w.work_id, w.author_id, w.title, w.publish_time, w.work_type,
            w.source_type, w.original_author, a.uid AS author_uid
     FROM works w JOIN authors a ON w.author_id = a.id
     WHERE a.uid = ? OR a.uid GLOB ? || '__*'`,
    [authorUid, authorUid]
  );
}

/** 列出所有缓存批次（GROUP BY batch_id） */
export async function getExcelBatches(): Promise<ExcelBatchRow[]> {
  const db = getDb();
  return db.select<ExcelBatchRow[]>(
    `SELECT
       batch_id,
       MIN(source_uid) AS source_uid,
       MIN(source_type) AS source_type,
       MIN(source_filename) AS source_filename,
       MIN(source_path) AS source_path,
       COUNT(*) AS row_count,
       MIN(imported_at) AS imported_at
     FROM excel_rows
     GROUP BY batch_id
     ORDER BY imported_at DESC`
  );
}

/** 清空全部 Excel 缓存 */
export async function clearAllExcelRows(): Promise<void> {
  const db = getDb();
  await db.execute("DELETE FROM excel_rows");
}

export interface DbStats {
  totalWorks: number;
  totalFiles: number;
  totalAuthors: number;
  totalThumbnails: number;
  dbSizeBytes: number;
  worksWithTopics: number;
  worksWithHiddenTags: number;
}

export async function getDbStats(): Promise<DbStats> {
  const db = getDb();
  const counts = await db.select<{ w: number; f: number; a: number; t: number; wt: number; wh: number }[]>(
    `SELECT
      (SELECT COUNT(*) FROM works) AS w,
      (SELECT COUNT(*) FROM files) AS f,
      (SELECT COUNT(*) FROM authors) AS a,
      (SELECT COUNT(*) FROM thumbnails) AS t,
      (SELECT COUNT(*) FROM works WHERE topics IS NOT NULL AND topics != '') AS wt,
      (SELECT COUNT(*) FROM works WHERE hidden_tags IS NOT NULL AND hidden_tags != '') AS wh`
  );
  return {
    totalWorks: counts[0]?.w ?? 0,
    totalFiles: counts[0]?.f ?? 0,
    totalAuthors: counts[0]?.a ?? 0,
    totalThumbnails: counts[0]?.t ?? 0,
    dbSizeBytes: 0,
    worksWithTopics: counts[0]?.wt ?? 0,
    worksWithHiddenTags: counts[0]?.wh ?? 0,
  };
}

export async function vacuum(): Promise<void> {
  const db = getDb();
  await db.execute("VACUUM;");
}

export async function getWorkCount(): Promise<number> {
  const db = getDb();
  const rows = await db.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM works");
  return rows[0]?.c ?? 0;
}

export async function getFileCount(): Promise<number> {
  const db = getDb();
  const rows = await db.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM files");
  return rows[0]?.c ?? 0;
}

export { parseDuration, parseDateTime };
