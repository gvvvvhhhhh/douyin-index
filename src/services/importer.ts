import { scanRootDirectoryMeta, scanAuthorMediaFiles } from "@/api/tauri";
import { parseExcelFile, parseExcelFileName } from "@/api/excel";
import {
  upsertAuthor,
  updateWorkMetadata,
  insertFilesBatch,
  insertWorksBatch,
  createImportLog,
  finishImportLog,
  parseDuration,
  parseDateTime,
  getExistingFilePathsByAuthor,
  getExistingWorkIdMap,
  getMaxWorkId,
  getWorksByAuthorForMatching,
  isExcelCached,
  insertExcelRows,
  getExcelBatches,
  deleteExcelBatch,
  getExcelRowsByUid,
  getExcelRowUidGroups,
  getWorksForMatchingByUid,
  deleteWorksByIds,
  rebuildTagCounts,
} from "@/api/db";
import type { ExistingWorkInfo, WorkInsertMeta } from "@/api/db";
import type { ExcelMetaRow, ParsedFileMeta, ScanResult, FileRow, ExcelRowRecord } from "@/types";
import type { ImportProgress } from "@/stores/app";

export interface ImportOutcome {
  totalAuthors: number;
  totalWorks: number;
  totalFiles: number;
  skippedFiles: number;
  unmatchedFiles: number;
  errors: string[];
  /** 用户主动取消（true = 未跑完全部作者） */
  cancelled?: boolean;
}

type ProgressCb = (p: Partial<ImportProgress>) => void;

async function yieldToUI(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 时间片管理：每 16ms 让出一次 UI 线程（保持 60fps 响应）
let lastYieldTime = Date.now();
const YIELD_INTERVAL_MS = 16;

async function yieldIfNeeded(): Promise<void> {
  if (Date.now() - lastYieldTime >= YIELD_INTERVAL_MS) {
    await yieldToUI();
    lastYieldTime = Date.now();
  }
}

// 未匹配文件采样日志计数：百万级文件时逐条 warn 会拖垮控制台/日志文件，只采样输出
let unmatchedLogCount = 0;

// 进度节流：避免高频进度回调阻塞 UI
let lastProgressTime = 0;
const PROGRESS_INTERVAL_MS = 200;

function throttledProgress(onProgress: ProgressCb | undefined, p: Partial<ImportProgress>): void {
  if (!onProgress) return;
  const now = Date.now();
  if (now - lastProgressTime >= PROGRESS_INTERVAL_MS || p.status === "done" || p.status === "error") {
    lastProgressTime = now;
    onProgress(p);
  }
}

// ===== 导入诊断日志（排查卡顿/无响应）=====
// 设计要点：
// - 每个阶段/作者输出一行带时间戳的日志，相邻两条日志的时间差即"无输出空窗"，
//   空窗越长说明该节点越可疑（磁盘扫描慢 / IPC 阻塞 / CPU 同步计算过长）
// - 单节点超过阈值额外输出 [慢] 告警，无需人工对时间戳
// - 作者级为最小日志粒度（6543 作者 ≈ 数千行，可接受）；文件级仅采样告警
const SLOW_PHASE_MS = 3000;  // 单阶段 > 3s 记 warn
const SLOW_IPC_MS = 1500;    // 单次批量 IPC > 1.5s 记 warn
const SLOW_AUTHOR_MS = 8000; // 单作者全流程 > 8s 记 warn

function tsNow(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function dlog(msg: string): void {
  console.log(`[导入][${tsNow()}] ${msg}`);
}

function dwarn(msg: string): void {
  console.warn(`[导入][${tsNow()}][慢] ${msg}`);
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    // 移除 emoji 和特殊 Unicode 符号（解决标题含表情包导致匹配失败的问题）
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")    // Emoji & pictographs
    .replace(/[\u{2600}-\u{27BF}]/gu, "")       // Misc symbols & dingbats
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")        // Variation selectors
    .replace(/[\u{200D}]/gu, "")                  // Zero Width Joiner
    .replace(/[\u{2190}-\u{21FF}]/gu, "")        // Arrows
    .replace(/[\s\-_，。、！？：；""''（）\[\]【】《》·~!@#$%^&*()+={}|\\:;'",.<>?\/`~]/g, "")
    .trim();
}

/**
 * 归一化作品类型：将文件名中的 "类型" 和 Excel 中的 "作品类型" 映射到统一类别。
 * 文件名常见值：视频/图集/实况/livephoto
 * Excel 常见值：视频/图文/直播/livephoto
 *
 * 返回值：video / image / livephoto / live / 原值(小写)
 */
function normalizeWorkType(type: string | null | undefined): string {
  if (!type) return "";
  const t = type.toLowerCase().trim();
  if (t.includes("视频") || t.includes("video")) return "video";
  if (t.includes("实况") || t.includes("livephoto") || t.includes("live photo")) return "livephoto";
  if (t.includes("直播") || t.includes("live")) return "live";
  if (t.includes("图") || t.includes("image") || t.includes("gallery")) return "image";
  return t;
}

function getLocalDayStart(ts: number): number {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

type ExcelRowWithSource = ExcelMetaRow & { _sourceType: string };

/**
 * 判断 source_type 是否为收藏/喜欢类集合文件夹。
 * 这类文件夹内的媒体文件 author_name（来自文件名）是原始作者，
 * 与文件夹名中的作者（收藏者）不同，需要特殊处理。
 */
function isCollectionSourceType(sourceType: string): boolean {
  return sourceType.includes("收藏") || sourceType.includes("喜欢");
}

/** 集合文件夹的作者 UID：原 UID + sourceType 后缀，保证 收藏/喜欢 互不冲突 */
function deriveCollectionAuthorUid(uid: string, sourceType: string): string {
  return `${uid}__${sourceType}`;
}

/** 集合文件夹的作者显示名：如 "枫临" + "喜欢作品" → "枫临的喜欢" */
function deriveCollectionAuthorName(authorName: string, sourceType: string): string {
  const shortName = sourceType.replace(/作品$/, "");
  return `${authorName}的${shortName}`;
}

/**
 * 已有作品的内存索引，用于替代逐条 findWorkByAuthorAndTitle/findWorkByAuthorAndDate IPC 查询。
 *
 * 构建两个 Map 实现 O(1) 平均查找：
 * - byTitle：按精确标题分组（标题可能重复，每组是数组）
 * - byPublishTime：按精确发布时间戳分组（同时间戳可能有多条，每组是数组）
 *
 * 匹配规则与 db.ts 中对应的 SQL 查询完全一致：
 * - 标题匹配：title = ? AND publish_time = ? AND original_author = ?
 *   （originalAuthor 为 null 时不过滤 original_author，与 SQL 行为一致）
 * - 日期匹配：publish_time = ? AND original_author = ?
 */
class ExistingWorkIndex {
  private byTitle = new Map<string, ExistingWorkInfo[]>();
  private byPublishTime = new Map<number, ExistingWorkInfo[]>();
  private byId = new Map<number, ExistingWorkInfo>();

  constructor(works: ExistingWorkInfo[]) {
    for (const w of works) {
      this.addToIndex(w);
    }
  }

  private addToIndex(w: ExistingWorkInfo): void {
    this.byId.set(w.id, w);
    if (w.title) {
      const arr = this.byTitle.get(w.title);
      if (arr) arr.push(w);
      else this.byTitle.set(w.title, [w]);
    }
    if (w.publishTime !== null && w.publishTime > 0) {
      const arr = this.byPublishTime.get(w.publishTime);
      if (arr) arr.push(w);
      else this.byPublishTime.set(w.publishTime, [w]);
    }
  }

  /** 按 id 查找（用于 workId 快路径判断是否需要更新元数据） */
  getById(id: number): ExistingWorkInfo | null {
    return this.byId.get(id) ?? null;
  }

  /** 注册新创建的作品到索引，保证同作者后续迭代能正确去重 */
  addNew(w: ExistingWorkInfo): void {
    this.addToIndex(w);
  }

  /**
   * 按 title + publishTime + originalAuthor 查找（替代 findWorkByAuthorAndTitle）
   * publishTime 为 null 时匹配 NULL 或 0（与 SQL 的 `IS NULL OR = 0` 行为一致）
   */
  findByTitle(
    title: string,
    publishTime: number | null,
    originalAuthor: string | null
  ): ExistingWorkInfo | null {
    const candidates = this.byTitle.get(title);
    if (!candidates) return null;
    for (const w of candidates) {
      if (publishTime !== null) {
        if (w.publishTime !== publishTime) continue;
      } else {
        if (w.publishTime !== null && w.publishTime !== 0) continue;
      }
      if (originalAuthor !== null && w.originalAuthor !== originalAuthor) continue;
      return w;
    }
    return null;
  }

  /**
   * 按 publishTime + originalAuthor 查找（替代 findWorkByAuthorAndDate）
   * publishTime 为 null 或 <=0 时直接返回 null（与 SQL 行为一致）
   */
  findByDate(
    publishTime: number | null,
    originalAuthor: string | null
  ): ExistingWorkInfo | null {
    if (publishTime === null || publishTime <= 0) return null;
    const candidates = this.byPublishTime.get(publishTime);
    if (!candidates) return null;
    for (const w of candidates) {
      if (originalAuthor !== null && w.originalAuthor !== originalAuthor) continue;
      return w;
    }
    return null;
  }
}

/**
 * 每作者 Excel 行预索引：日期解析/类型/作者/标题归一化只做一次，按天分桶。
 *
 * 之前 matchFileToWork 对每个 (文件, 行) 配对都重新执行 parseDateTime（正则+Date 解析）
 * 和 normalizeForMatch（6 个正则替换），复杂度 O(文件数×行数×4 轮规则)。
 * 大作者（3709 行 × 3709 文件）单作者就要数分钟，且纯同步计算阻塞主线程导致界面无响应。
 * 预索引后按天查桶，匹配降为 O(同日候选数)，整体从小时级降到秒级。
 */
interface IndexedExcelRow {
  row: ExcelRowWithSource;
  idx: number;
  dayStart: number | null;
  typeNorm: string;
  authorNorm: string;
  titleNorm: string;
}

class AuthorExcelIndex {
  readonly all: IndexedExcelRow[];
  private byDay = new Map<number, IndexedExcelRow[]>();

  constructor(rows: ExcelRowWithSource[]) {
    this.all = rows.map((row, idx) => {
      const ts = parseDateTime(String(row.publishTime ?? ""));
      const title = String(row.description ?? row.workId ?? "");
      return {
        row,
        idx,
        dayStart: ts !== null ? getLocalDayStart(ts) : null,
        typeNorm: normalizeWorkType(row.workType),
        authorNorm: normalizeForMatch(String(row.authorName ?? "")),
        titleNorm: normalizeForMatch(title),
      };
    });
    for (const r of this.all) {
      if (r.dayStart === null) continue;
      const arr = this.byDay.get(r.dayStart);
      if (arr) arr.push(r);
      else this.byDay.set(r.dayStart, [r]);
    }
  }

  byDayBucket(dayStart: number): IndexedExcelRow[] {
    return this.byDay.get(dayStart) ?? [];
  }
}

/**
 * 文件 → Excel 行匹配（导入作品时使用，基于 AuthorExcelIndex 预索引）
 *
 * 匹配规则（按优先级）：
 * 1. 日期 + 类型 + 作者 匹配（最高优先级，收藏夹内不同原始作者的作品不会误匹配）
 * 2. 日期 + 类型 匹配（主要规则，不依赖标题，避免表情包导致匹配失败）
 * 3. 仅日期 匹配（降级，同日只有一条 Excel 行时直接匹配）
 * 4. 标题匹配（兜底，处理日期缺失或同日多同类作品，标题已去除 emoji）
 *
 * 注意：收藏文件夹的 excelRows 按收藏者 UID+sourceType 从 DB 加载，组内可能包含
 * 多个原始作者的作品，因此需要用 file.author_name（原始作者）与 row.authorName 比较来区分。
 */
function matchFileToWork(
  file: ParsedFileMeta,
  excelIndex: AuthorExcelIndex,
  usedRowIndices: Set<number>
): { matchedRow: ExcelRowWithSource | null; matchedRowIndex: number } {
  const fileDateTs = parseDateTime(file.publish_time_iso);
  const fileDayStart = fileDateTs !== null ? getLocalDayStart(fileDateTs) : null;
  const fileType = normalizeWorkType(file.category);
  const fileAuthorNorm = normalizeForMatch(file.author_name);

  if (fileDayStart !== null) {
    const bucket = excelIndex.byDayBucket(fileDayStart);

    // 1. 日期 + 类型 + 作者 匹配（最高优先级）
    if (fileAuthorNorm) {
      for (const r of bucket) {
        if (usedRowIndices.has(r.idx)) continue;
        if (!r.typeNorm || r.typeNorm !== fileType) continue;
        if (r.authorNorm && r.authorNorm === fileAuthorNorm) {
          return { matchedRow: r.row, matchedRowIndex: r.idx };
        }
      }
    }

    // 2. 日期 + 类型 匹配（主要规则，作者不匹配时降级）
    for (const r of bucket) {
      if (usedRowIndices.has(r.idx)) continue;
      if (r.typeNorm && r.typeNorm === fileType) {
        return { matchedRow: r.row, matchedRowIndex: r.idx };
      }
    }

    // 3. 仅日期匹配（降级：同日只有一条未用 Excel 行时直接匹配，避免类型差异漏匹配）
    let candidate: IndexedExcelRow | null = null;
    let candidateCount = 0;
    for (const r of bucket) {
      if (usedRowIndices.has(r.idx)) continue;
      candidateCount++;
      if (candidateCount > 1) break;
      candidate = r;
    }
    if (candidateCount === 1 && candidate) {
      return { matchedRow: candidate.row, matchedRowIndex: candidate.idx };
    }
  }

  // 4. 标题匹配（兜底：日期缺失或同日多同类作品时，用去 emoji 后的标题匹配）
  const fileTitleNorm = normalizeForMatch(file.title);
  if (fileTitleNorm) {
    for (const r of excelIndex.all) {
      if (usedRowIndices.has(r.idx)) continue;
      if (r.titleNorm && (r.titleNorm.includes(fileTitleNorm) || fileTitleNorm.includes(r.titleNorm))) {
        return { matchedRow: r.row, matchedRowIndex: r.idx };
      }
    }
  }

  // 采样输出：前 20 条逐条记录，之后每 500 条记录一次（总量信息见导入结果汇总）
  if (unmatchedLogCount < 20 || unmatchedLogCount % 500 === 0) {
    console.warn("[导入] 文件未匹配到Excel (第" + (unmatchedLogCount + 1) + "条):", file.file_name, "| fileDate:", file.publish_time_iso, "| fileType:", fileType, "| fileAuthor:", file.author_name, "| fileDayStart:", fileDayStart, "| excelRowsCount:", excelIndex.all.length, "| usedRows:", usedRowIndices.size);
  }
  unmatchedLogCount++;
  return { matchedRow: null, matchedRowIndex: -1 };
}

function excelRowToWorkMeta(row: ExcelRowWithSource, originalAuthor?: string | null) {
  return {
    workId: row.workId ?? null,
    title: row.description ? String(row.description).slice(0, 200) : null,
    description: row.description ? String(row.description) : null,
    workType: row.workType ?? null,
    topics: row.topics ?? null,
    publishTime: parseDateTime(String(row.publishTime ?? "")),
    duration: row.duration ? parseDuration(String(row.duration)) : null,
    width: typeof row.width === "number" ? row.width : null,
    height: typeof row.height === "number" ? row.height : null,
    likeCount: typeof row.likeCount === "number" ? row.likeCount : null,
    commentCount: typeof row.commentCount === "number" ? row.commentCount : null,
    favoriteCount: typeof row.favoriteCount === "number" ? row.favoriteCount : null,
    shareCount: typeof row.shareCount === "number" ? row.shareCount : null,
    playCount: typeof row.playCount === "number" ? row.playCount : null,
    coverStatic: row.coverStatic ?? null,
    coverDynamic: row.coverDynamic ?? null,
    videoUri: row.videoUri ?? null,
    downloadUrl: row.downloadUrl ?? null,
    musicAuthor: row.musicAuthor ?? null,
    musicTitle: row.musicTitle ?? null,
    hiddenTags: row.hiddenTags ?? null,
    extraInfo: row.extraInfo ?? null,
    sourceType: row._sourceType || null,
    originalAuthor: originalAuthor ?? null,
    collectTime: parseDateTime(String(row.collectTime ?? "")),
    secUid: row.secUid ? String(row.secUid) : null,
  };
}

/**
 * 将 excel_rows 表的数据库记录转换回 ExcelMetaRow 格式（用于缓存复用）
 * ExcelRowRecord 是 snake_case，ExcelMetaRow 是 camelCase
 */
function excelRowRecordToMetaRow(rec: ExcelRowRecord): ExcelMetaRow {
  return {
    workType: rec.work_type ?? undefined,
    uid: rec.source_uid ?? undefined,
    secUid: rec.sec_uid ?? undefined,
    workId: rec.work_id ?? undefined,
    description: rec.description ?? undefined,
    topics: rec.topics ?? undefined,
    duration: rec.duration ?? undefined,
    height: rec.height ?? undefined,
    width: rec.width ?? undefined,
    publishTime: rec.publish_time ?? undefined,
    collectTime: rec.collect_time ?? undefined,
    videoUri: rec.video_uri ?? undefined,
    authorName: rec.author_name ?? undefined,
    authorSignature: rec.author_signature ?? undefined,
    downloadUrl: rec.download_url ?? undefined,
    musicAuthor: rec.music_author ?? undefined,
    musicTitle: rec.music_title ?? undefined,
    coverStatic: rec.cover_static ?? undefined,
    coverDynamic: rec.cover_dynamic ?? undefined,
    hiddenTags: rec.hidden_tags ?? undefined,
    likeCount: rec.like_count ?? undefined,
    commentCount: rec.comment_count ?? undefined,
    favoriteCount: rec.favorite_count ?? undefined,
    shareCount: rec.share_count ?? undefined,
    playCount: rec.play_count ?? undefined,
    extraInfo: rec.extra_info ?? undefined,
  };
}

/**
 * 导入控制信号：由 UI 层（app store）注入，支持暂停/恢复/取消。
 * - isPaused：作者循环/Excel 循环的每次迭代开始处等待，恢复后继续
 * - isCancelled + getCancelMode：取消收尾方式
 *   - "keep"：保留已入库数据（每作者处理完即已落库），正常收尾 finishImportLog
 *   - "discard"：回滚本次导入新建的全部作品（按记录的 newWorkIds 精确删除，files 级联）
 */
export interface ImportControl {
  isPaused(): boolean;
  isCancelled(): boolean;
  getCancelMode(): "keep" | "discard";
}

export async function runImportPipeline(
  rootPaths: string | string[],
  _appDataDir: string,
  onProgress?: ProgressCb,
  control?: ImportControl
): Promise<ImportOutcome> {
  const roots = (Array.isArray(rootPaths) ? rootPaths : [rootPaths]).filter(Boolean);
  const errors: string[] = [];
  const pipelineStart = Date.now();
  dlog(`===== 导入管道开始 ===== 根目录(${roots.length}): ${roots.join(" | ")}`);

  // 多根目录（拖放批量导入）时合并为一次导入：单条 import_log、全部作者合计进度 (i/N)
  const logRootPath = roots.length === 1 ? roots[0] : roots.join("；");
  // 创建导入日志（状态 running），后续 upsertAuthor/upsertWorkByWorkId 会带上这个 ID
  const importLogId = await createImportLog(logRootPath);
  dlog(`导入日志已创建 (id=${importLogId})`);

  try {
    const outcome = await runImportPipelineInner(roots, logRootPath, importLogId, errors, onProgress, control);
    dlog(
      `===== 导入管道结束 ===== ${outcome.cancelled ? "已取消" : "正常完成"} | ` +
        `作品 ${outcome.totalWorks} / 文件 ${outcome.totalFiles} / 跳过文件 ${outcome.skippedFiles} / ` +
        `未匹配文件 ${outcome.unmatchedFiles} / 错误 ${outcome.errors.length} | 总耗时 ${fmtMs(Date.now() - pipelineStart)}`
    );
    return outcome;
  } catch (e) {
    // 导入过程中抛出异常：标记导入日志为 error 状态
    const errMsg = String(e);
    errors.push(errMsg);
    console.error(`[导入][${tsNow()}] 导入管道异常终止（耗时 ${fmtMs(Date.now() - pipelineStart)}）:`, e);
    try {
      await finishImportLog(importLogId, {
        totalAuthors: 0,
        totalWorks: 0,
        totalFiles: 0,
        skippedFiles: 0,
        unmatchedFiles: 0,
        excelFiles: [],
        errors,
        status: "error",
      });
    } catch {
      // ignore log update error
    }
    throw e;
  }
}

/** 暂停等待：每 250ms 轮询一次控制信号，期间让出主线程保持 UI 响应 */
async function waitWhilePaused(
  control: ImportControl | undefined,
  onProgress?: ProgressCb,
  pausedMessage?: string
): Promise<void> {
  if (!control) return;
  let notified = false;
  let pauseLogged = false;
  let pausedAt = 0;
  while (control.isPaused() && !control.isCancelled()) {
    if (!pauseLogged) {
      pauseLogged = true;
      pausedAt = Date.now();
      dlog(`已进入暂停状态（阶段：${pausedMessage ?? "未标注"}），等待恢复...`);
    }
    if (!notified && pausedMessage) {
      onProgress?.({ status: "paused", message: pausedMessage });
      notified = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (pauseLogged && !control.isCancelled()) {
    dlog(`已恢复导入，本次暂停持续 ${fmtMs(Date.now() - pausedAt)}`);
  }
}

async function runImportPipelineInner(
  rootPaths: string[],
  logRootPath: string,
  importLogId: number,
  errors: string[],
  onProgress?: ProgressCb,
  control?: ImportControl
): Promise<ImportOutcome> {
  // 本次导入新建的作品 id（取消且"不导入"时精确回滚；百万 id ≈ 8MB 内存可接受）
  const newWorkIds: number[] = [];

  // 进度计数（提前声明：Excel 解析阶段取消时 finishCancelled 也要引用，避免 TDZ）
  let authorCount = 0;
  let processed = 0;

  // 统一的取消收尾：keep = 正常完成（已处理作者均已落库）；discard = 删除本次新建作品
  const finishCancelled = async (
    totals: { totalWorks: number; totalFiles: number; skippedFiles: number; unmatchedFiles: number },
    excelFiles: string[]
  ): Promise<ImportOutcome> => {
    const mode = control?.getCancelMode() ?? "keep";
    dlog(`收到取消信号（模式: ${mode === "keep" ? "保留已匹配作品" : "回滚本次导入"}，当前进度: ${processed}/${authorCount} 作者）`);
    if (mode === "discard") {
      onProgress?.({ status: "matching", message: `正在回滚本次导入（${newWorkIds.length} 个作品）...` });
      const rollbackStart = Date.now();
      try {
        await deleteWorksByIds(newWorkIds);
        dlog(`回滚完成：已删除 ${newWorkIds.length} 个新建作品，耗时 ${fmtMs(Date.now() - rollbackStart)}`);
        totals.totalWorks = 0;
        totals.totalFiles = 0;
      } catch (e) {
        errors.push(`回滚删除作品失败: ${e}`);
        console.error(`[导入][${tsNow()}] 回滚失败（耗时 ${fmtMs(Date.now() - rollbackStart)}）:`, e);
      }
    }
    // 重建标签计数物化表（keep/discard 两种取消模式均可能改变 works 的标签数据）
    try {
      onProgress?.({ status: "matching", message: "正在更新标签统计..." });
      await rebuildTagCounts();
    } catch (e) {
      errors.push(`重建标签计数失败: ${e}`);
    }
    await finishImportLog(importLogId, {
      totalAuthors: 0,
      totalWorks: totals.totalWorks,
      totalFiles: totals.totalFiles,
      skippedFiles: totals.skippedFiles,
      unmatchedFiles: totals.unmatchedFiles,
      excelFiles,
      errors,
      status: "done",
    });
    onProgress?.({
      status: "done",
      message:
        mode === "keep"
          ? `已取消导入：保留已匹配入库的 ${totals.totalWorks} 个作品 / ${totals.totalFiles} 个文件`
          : "已取消导入：本次导入的内容未保留",
      percent: 100,
    });
    return {
      totalAuthors: 0,
      totalWorks: totals.totalWorks,
      totalFiles: totals.totalFiles,
      skippedFiles: totals.skippedFiles,
      unmatchedFiles: totals.unmatchedFiles,
      errors,
      cancelled: true,
    };
  };

  onProgress?.({
    status: "scanning",
    message: rootPaths.length > 1 ? `正在扫描 ${rootPaths.length} 个拖入目录...` : "正在扫描根目录...",
    percent: 5,
    currentStepDetail: "扫描文件系统中...",
    currentAuthor: "",
    currentFile: "",
  });
  // 分阶段扫描 Phase 1：只扫描顶层目录（作者文件夹 + Excel），不加载媒体文件
  // 避免百万文件一次性加载到内存导致 OOM/IPC 阻塞
  // 多根目录（拖放批量导入）：逐个扫描后合并 authors/excel_files（按 folder_path / 文件路径去重），
  // 后续 Excel 解析与匹配入库阶段全部作者合计进度（与导入 Volume 根目录的显示一致）
  const scanStart = Date.now();
  const authorsAll: ScanResult["authors"] = [];
  const excelAll: string[] = [];
  const seenFolders = new Set<string>();
  const seenExcel = new Set<string>();
  for (const rp of rootPaths) {
    const r = await scanRootDirectoryMeta(rp);
    for (const a of r.authors) {
      if (!seenFolders.has(a.folder_path)) {
        seenFolders.add(a.folder_path);
        authorsAll.push(a);
      }
    }
    for (const ef of r.excel_files) {
      if (!seenExcel.has(ef)) {
        seenExcel.add(ef);
        excelAll.push(ef);
      }
    }
  }
  const scan: ScanResult = {
    root_path: logRootPath,
    authors: authorsAll,
    excel_files: excelAll,
    media_files: [],
    total_files: 0,
    skipped_files: 0,
    skipped_samples: [],
  };
  const scanMs = Date.now() - scanStart;
  if (scanMs >= SLOW_PHASE_MS) {
    dwarn(`根目录扫描耗时 ${fmtMs(scanMs)}（${rootPaths.length} 目录 → 作者 ${scan.authors.length} / Excel ${scan.excel_files.length}）`);
  } else {
    dlog(`根目录扫描完成：${rootPaths.length} 个目录 → ${scan.authors.length} 作者 / ${scan.excel_files.length} Excel文件，耗时 ${fmtMs(scanMs)}`);
  }
  authorCount = scan.authors.length;
  onProgress?.({
    status: "scanning",
    message: `扫描完成：${scan.authors.length} 作者 / ${scan.excel_files.length} Excel文件`,
    percent: 15,
    totalAuthors: scan.authors.length,
    currentStepDetail: "扫描完成，准备解析",
  });

  const excelCount = scan.excel_files.length;
  let excelProcessed = 0;
  let excelCached = 0;
  const excelPhaseStart = Date.now();
  dlog(`Excel解析阶段开始：共 ${excelCount} 个文件`);
  onProgress?.({ status: "parsing", message: `正在解析Excel元数据 0/${excelCount}...`, percent: 25, currentStepDetail: "读取Excel文件..." });
  // 流式解析：每个 Excel 解析后立即写入 DB 缓存（excel_rows 表），行数据随迭代结束释放。
  // 之前把全部行累积到内存 Map（excelRowsByKey），6000+ 个 xlsx 的百万级行数据
  // 会把 WebView 内存撑爆导致界面崩溃；现在匹配阶段改为按作者从 DB 流式加载（内存有界）。
  for (const excelPath of scan.excel_files) {
    await waitWhilePaused(control, onProgress, "已暂停（Excel解析阶段），点击恢复继续");
    if (control?.isCancelled()) {
      dlog(`Excel解析阶段取消（已完成 ${excelProcessed}/${excelCount}，其中命中缓存 ${excelCached}）`);
      return finishCancelled(
        { totalWorks: 0, totalFiles: 0, skippedFiles: 0, unmatchedFiles: 0 },
        scan.excel_files
      );
    }
    excelProcessed++;
    throttledProgress(onProgress, {
      status: "parsing",
      message: `正在解析Excel ${excelProcessed}/${excelCount}...`,
      currentStepDetail: excelPath.split(/[\\/]/).pop() ?? excelPath,
    });
    try {
      const fileName = excelPath.split(/[\\/]/).pop() ?? excelPath;
      const parsed = parseExcelFileName(fileName);
      const fileStart = Date.now();

      // 已缓存 → 数据已在 excel_rows 表中，跳过解析（匹配阶段直接从 DB 加载）
      const cached = await isExcelCached(excelPath);
      if (cached) {
        excelCached++;
        continue;
      }

      const parsedResult = await parseExcelFile(excelPath);
      const rows = parsedResult.rows;

      // 写入 DB 缓存供匹配阶段/后续导入复用，rows 随本迭代结束释放
      if (parsed) {
        try {
          await insertExcelRows(rows, excelPath, fileName, parsed.uid, parsed.sourceType ?? "");
        } catch (cacheErr) {
          console.warn("[导入] Excel缓存写入失败（该文件元数据将不参与匹配）:", fileName, cacheErr);
        }
      }
      const fileMs = Date.now() - fileStart;
      if (fileMs >= SLOW_PHASE_MS) {
        dwarn(`Excel解析慢文件: ${fileName}（${rows.length} 行）耗时 ${fmtMs(fileMs)} [${excelProcessed}/${excelCount}]`);
      }
    } catch (e) {
      console.error("[导入] Excel解析异常:", excelPath, e);
      errors.push(`Excel解析失败 ${excelPath}: ${e}`);
    }
  }
  dlog(
    `Excel解析阶段完成：解析 ${excelProcessed - excelCached} / 命中缓存跳过 ${excelCached} / 错误 ${errors.length}，耗时 ${fmtMs(Date.now() - excelPhaseStart)}`
  );

  onProgress?.({ status: "matching", message: "正在登记作者...", percent: 35 });
  let totalWorks = 0;
  let totalFiles = 0;
  let unmatchedFiles = 0;
  let skippedWorks = 0;
  let skippedFiles = 0;

  // 预加载已有 work_id → id 映射（Excel去重 + 免 SELECT 定位已有作品）
  // 文件路径改为循环内按作者加载（见 getExistingFilePathsByAuthor），避免百万级路径全量驻留内存
  onProgress?.({ currentStepDetail: "检查已导入数据...", currentFile: "" });
  const preloadStart = Date.now();
  const existingWorkIdMap = await getExistingWorkIdMap();
  // 批量插入新作品的预分配 id 起点（显式插入 AUTOINCREMENT 表会自动推进 sqlite_sequence）
  let nextWorkId = (await getMaxWorkId()) + 1;
  dlog(
    `已有数据预加载完成：work_id 映射 ${existingWorkIdMap.size} 条，下一个作品 id=${nextWorkId}，耗时 ${fmtMs(Date.now() - preloadStart)}`
  );
  if (existingWorkIdMap.size >= 100000 && Date.now() - preloadStart >= SLOW_PHASE_MS) {
    dwarn(`预加载耗时偏长（${fmtMs(Date.now() - preloadStart)}），大库 work_id 映射构建是已知瓶颈`);
  }

  let opsSinceYield = 0;
  const YIELD_EVERY = 20;
  // 重置时间片计时器
  lastYieldTime = Date.now();
  lastProgressTime = 0;

  // ===== 并行预取：提前扫描后续作者的文件夹 + 预查该作者的 Excel 缓存行 =====
  // scan_author_media_files 是同步 Rust 命令，Tauri 在阻塞线程池执行，并发 invoke 真正并行；
  // Excel 行查询在 SQL 插件的 Rust 侧执行，同样与磁盘扫描并行。
  // 窗口 4：内存最多驻留 ~5 个作者的文件列表 + Excel 行（有界），吞吐提升数倍
  const SCAN_AHEAD = 4;
  const scanPrefetch = new Map<number, Promise<ParsedFileMeta[]>>();
  const excelPrefetch = new Map<number, Promise<ExcelRowRecord[]>>();
  const prefetchAuthorScan = (idx: number): void => {
    if (idx < 0 || idx >= authorCount || scanPrefetch.has(idx)) return;
    const a = scan.authors[idx];
    const p = scanAuthorMediaFiles(a.folder_path);
    // 预取结果可能延迟消费：先挂一个空 catch 避免 "unhandled rejection" 告警，
    // 消费方的 try/catch 仍会正常捕获 rejection（同一 promise 可挂多个 handler）
    p.catch(() => {});
    scanPrefetch.set(idx, p);
    // Excel 行预查询（失败降级为空数组，该作者按无 Excel 数据处理）
    const isCol = isCollectionSourceType(a.source_type);
    const ep = getExcelRowsByUid(a.uid, isCol ? a.source_type : undefined).catch(
      (e): ExcelRowRecord[] => {
        console.warn("[导入] 预取Excel缓存行失败:", a.uid, e);
        return [];
      }
    );
    excelPrefetch.set(idx, ep);
  };

  const matchPhaseStart = Date.now();
  dlog(`匹配入库阶段开始：${authorCount} 作者（并行预取窗口 ${SCAN_AHEAD}）`);

  for (let authorIdx = 0; authorIdx < authorCount; authorIdx++) {
    await waitWhilePaused(control, onProgress, "已暂停，点击恢复继续导入");
    if (control?.isCancelled()) {
      dlog(`匹配阶段取消：已完成 ${processed}/${authorCount} 作者（累计新作品 ${totalWorks} / 新文件 ${totalFiles}）`);
      return finishCancelled(
        { totalWorks, totalFiles, skippedFiles, unmatchedFiles },
        scan.excel_files
      );
    }
    const author = scan.authors[authorIdx];
    processed++;
    const tAuthorStart = Date.now();
    // 收藏/喜欢类文件夹：创建虚拟作者（如"枫临的喜欢"），按文件夹路径匹配媒体文件
    // 普通文件夹：按文件名中的 author_name 匹配
    const isCollection = isCollectionSourceType(author.source_type);
    const authorUid = isCollection
      ? deriveCollectionAuthorUid(author.uid, author.source_type)
      : author.uid;
    const authorDisplayName = isCollection
      ? deriveCollectionAuthorName(author.author_name, author.source_type)
      : author.author_name;

    // 单一一致的进度更新：所有字段同一批设置，避免"作者/步骤/文件"来自不同时刻的错位显示
    // （不再显示当前文件——收藏夹内文件名是原始作者名，与文件夹作者不一致，显示反而困惑）
    throttledProgress(onProgress, {
      status: "matching",
      message: `匹配入库: ${authorDisplayName} (${processed}/${authorCount})`,
      currentAuthor: authorDisplayName,
      currentStepDetail: `匹配入库 ${processed}/${authorCount}`,
      percent: 35 + Math.floor((processed / Math.max(authorCount, 1)) * 50),
      currentFile: "",
      totalWorks,
      skippedFiles,
    });

    // 确保当前作者已开始扫描，并预取后续 SCAN_AHEAD 个作者（与本作者的匹配/入库并行）
    prefetchAuthorScan(authorIdx);
    for (let k = 1; k <= SCAN_AHEAD; k++) prefetchAuthorScan(authorIdx + k);

    // ===== 分阶段扫描 Phase 2：按作者逐个扫描媒体文件 =====
    // 处理完即释放内存，避免百万文件同时驻留内存
    let authorFiles: ParsedFileMeta[];
    try {
      authorFiles = await (scanPrefetch.get(authorIdx) as Promise<ParsedFileMeta[]>);
    } catch (e) {
      errors.push(`扫描作者文件夹失败: ${author.folder_path} - ${e}`);
      scanPrefetch.delete(authorIdx);
      excelPrefetch.delete(authorIdx);
      continue;
    }
    scanPrefetch.delete(authorIdx);
    const tScanDone = Date.now();

    // 普通文件夹：额外按 author_name 过滤（安全检查，通常同文件夹内 author_name 一致）
    if (!isCollection && authorFiles.length > 0) {
      authorFiles = authorFiles.filter((f) => f.author_name === author.author_name);
    }

    const authorId = await upsertAuthor({
      uid: authorUid,
      name: authorDisplayName,
      folder_path: author.folder_path,
      importLogId,
    });
    const tUpsertDone = Date.now();

    // ===== 并行加载该作者的数据（Excel 行已在预取窗口发起，与磁盘扫描重叠执行）=====
    const [records, existingWorks, existingFilePaths] = await Promise.all([
      excelPrefetch.get(authorIdx) ?? Promise.resolve([] as ExcelRowRecord[]),
      getWorksByAuthorForMatching(authorId).catch((e): ExistingWorkInfo[] => {
        console.warn("[导入] 加载已有作品失败，将按新建处理:", e);
        return [];
      }),
      getExistingFilePathsByAuthor(authorId),
    ]);
    excelPrefetch.delete(authorIdx);
    const tLoadDone = Date.now();
    // 收藏/喜欢作者：精确按 (uid, sourceType) 加载；普通作者：过滤掉收藏/喜欢类型的行
    const excelRows: ExcelRowWithSource[] = records
      .filter((r) => (isCollection ? true : !isCollectionSourceType(r.source_type ?? "")))
      .map((rec) => ({ ...excelRowRecordToMetaRow(rec), _sourceType: rec.source_type ?? "" }));
    // 已有作品内存索引，用于 O(1) 去重匹配
    const workIndex = new ExistingWorkIndex(existingWorks);

    const filesByWork = new Map<string, ParsedFileMeta[]>();
    for (const f of authorFiles) {
      // 分组键：发布时间 + 作品类型 + 原始作者名 + 标题
      const key = `${f.publish_time_iso}||${f.category}||${f.author_name}||${f.title}`;
      const arr = filesByWork.get(key) ?? [];
      arr.push(f);
      filesByWork.set(key, arr);
    }

    // 按发布时间排序作品，确保按顺序匹配Excel行（时间戳预解析，避免比较器内重复 parseDateTime）
    const workGroups = Array.from(filesByWork.values());
    const groupTs = new Map<ParsedFileMeta[], number>();
    for (const g of workGroups) {
      groupTs.set(g, parseDateTime(g[0]?.publish_time_iso ?? "") ?? 0);
    }
    workGroups.sort((a, b) => (groupTs.get(a) ?? 0) - (groupTs.get(b) ?? 0));

    // Excel 行预索引：日期/类型/作者/标题每行只归一化一次，按天分桶后匹配为 O(同日候选数)
    const excelIndex = new AuthorExcelIndex(excelRows);

    // 已匹配的Excel行索引
    const usedRowIndices = new Set<number>();

    // 本作者的新作品与文件批量收集（作者处理完后一次性落库，
    // 替代每作品 2 次 upsert IPC + 每作品组 1 次文件插入 IPC）
    const pendingNewWorks: Array<WorkInsertMeta & { id: number }> = [];
    const pendingFiles: Array<Omit<FileRow, "id" | "created_at">> = [];
    const skippedWorksBefore = skippedWorks;

    for (const files of workGroups) {
      const firstFile = files[0];
      if (!firstFile) continue;

      let workDbId: number | null = null;
      let isSkipped = false;

      // 集合文件夹：媒体文件名中的 author_name 是原始作者（如"千寻"），存入 original_author 供搜索
      // 普通文件夹：original_author 为 null（作者即文件夹作者）
      const originalAuthor = isCollection ? firstFile.author_name : null;

      const { matchedRow, matchedRowIndex } = matchFileToWork(firstFile, excelIndex, usedRowIndices);

      if (matchedRow) {
        if (matchedRowIndex >= 0) {
          usedRowIndices.add(matchedRowIndex);
        }
        // Excel 匹配的作品：检查 work_id 是否已存在（Map 免 SELECT 直接定位）
        if (matchedRow.workId && existingWorkIdMap.has(matchedRow.workId)) {
          workDbId = existingWorkIdMap.get(matchedRow.workId)!;
          // 仅在有意义时更新：文件数变化 / 缺话题元数据 / 缺 workId（重复导入时跳过无变化更新，几乎零 IPC）
          const existingInfo = workIndex.getById(workDbId);
          const needsUpdate =
            !existingInfo ||
            existingInfo.fileCount !== files.length ||
            (!existingInfo.hasTopics && Boolean(matchedRow.topics)) ||
            (!existingInfo.workId && Boolean(matchedRow.workId));
          if (needsUpdate) {
            const meta = excelRowToWorkMeta(matchedRow, originalAuthor);
            await updateWorkMetadata(workDbId, { ...meta, authorId, fileCount: files.length, importLogId });
          }
          isSkipped = true;
        } else {
          const publishTs = parseDateTime(firstFile.publish_time_iso);
          const title = matchedRow.description
            ? String(matchedRow.description).slice(0, 200) || firstFile.title || "(无标题)"
            : firstFile.title || "(无标题)";
          // 内存中去重匹配（替代逐条 IPC 查询，O(1) 平均查找）
          let existing = workIndex.findByTitle(title, publishTs, originalAuthor);
          if (!existing && firstFile.title) {
            existing = workIndex.findByTitle(firstFile.title, publishTs, originalAuthor);
          }
          if (!existing) {
            existing = workIndex.findByDate(publishTs, originalAuthor);
          }
          if (existing) {
            const metaIncomplete = !existing.hasTopics && Boolean(matchedRow.topics);
            if (existing.fileCount !== files.length || metaIncomplete) {
              const meta = excelRowToWorkMeta(matchedRow, originalAuthor);
              await updateWorkMetadata(existing.id, { ...meta, authorId, fileCount: files.length, importLogId });
            }
            workDbId = existing.id;
            isSkipped = true;
            if (matchedRow.workId) existingWorkIdMap.set(matchedRow.workId, existing.id);
          } else {
            // 新作品：预分配 id，批量收集待插入
            const meta = excelRowToWorkMeta(matchedRow, originalAuthor);
            workDbId = nextWorkId++;
            pendingNewWorks.push({ ...meta, id: workDbId, authorId, fileCount: files.length, importLogId });
            if (matchedRow.workId) existingWorkIdMap.set(matchedRow.workId, workDbId);
            // 同步内存索引，避免同作者后续迭代重复创建
            workIndex.addNew({
              id: workDbId,
              workId: meta.workId ?? null,
              title: meta.title ?? null,
              publishTime: meta.publishTime ?? null,
              originalAuthor,
              fileCount: files.length,
              hasTopics: meta.topics ? 1 : 0,
            });
          }
        }
      } else {
        const publishTs = parseDateTime(firstFile.publish_time_iso);
        const title = firstFile.title || firstFile.full_title || "(无标题)";
        // 内存中去重匹配（替代逐条 IPC 查询，O(1) 平均查找）
        let existing = workIndex.findByTitle(title, publishTs, originalAuthor);
        if (!existing) {
          existing = workIndex.findByDate(publishTs, originalAuthor);
        }
        if (existing) {
          workDbId = existing.id;
          isSkipped = true;
        } else {
          // 新作品：预分配 id，批量收集待插入
          workDbId = nextWorkId++;
          pendingNewWorks.push({
            id: workDbId,
            authorId,
            title,
            workType: firstFile.category,
            publishTime: publishTs,
            fileCount: files.length,
            importLogId,
            originalAuthor,
          });
          // 同步内存索引，避免同作者后续迭代重复创建
          workIndex.addNew({
            id: workDbId,
            workId: null,
            title,
            publishTime: publishTs,
            originalAuthor,
            fileCount: files.length,
            hasTopics: 0,
          });
        }
        unmatchedFiles += files.length;
      }

      if (isSkipped) skippedWorks++;

      if (workDbId) {
        const sortedFiles = [...files].sort((a, b) => {
          const sa = a.sequence ?? 0;
          const sb = b.sequence ?? 0;
          if (sa !== sb) return sa - sb;
          return a.file_name.localeCompare(b.file_name);
        });

        for (let i = 0; i < sortedFiles.length; i++) {
          const f = sortedFiles[i];
          // 跳过已存在的文件
          if (existingFilePaths.has(f.file_path)) {
            skippedFiles++;
            continue;
          }
          pendingFiles.push({
            work_id: workDbId,
            absolute_path: f.file_path,
            filename: f.file_name,
            extension: f.extension,
            media_type: f.media_kind === "video" ? "video" : "image",
            seq: f.sequence ?? (i + 1),
            size_bytes: f.file_size,
            mtime: null,
          });
          existingFilePaths.add(f.file_path);
        }
        if (!isSkipped) totalWorks++;
      }
      opsSinceYield++;
      if (opsSinceYield >= YIELD_EVERY) {
        opsSinceYield = 0;
        await yieldIfNeeded();
      }
    }

    const tMatchDone = Date.now();

    // ===== 本作者批次落库：作品 + 文件一次性批量写入 =====
    // 新作品批量插入（每 30 条一批 IPC）；失败则放弃本批（errors 可见，文件一并跳过避免悬挂引用）
    if (pendingNewWorks.length > 0) {
      try {
        await insertWorksBatch(pendingNewWorks);
        // 记录新建作品 id（取消且"不导入"时精确回滚）
        for (const w of pendingNewWorks) newWorkIds.push(w.id);
      } catch (e) {
        errors.push(`批量插入作品失败: ${author.author_name} (${pendingNewWorks.length} 个作品): ${e}`);
        pendingNewWorks.length = 0;
        pendingFiles.length = 0;
      }
    }
    // 文件批量插入（每 100 条一批 IPC，整作者合并调用）
    if (pendingFiles.length > 0) {
      try {
        await insertFilesBatch(pendingFiles);
        totalFiles += pendingFiles.length;
      } catch (e) {
        errors.push(`批量插入文件失败: ${author.author_name} (${pendingFiles.length} 个文件): ${e}`);
      }
    }
    const tWriteDone = Date.now();

    // ===== 作者级诊断日志：分项耗时定位卡顿源 =====
    // 扫描=等待磁盘扫描（预取未命中时含扫描本身）；数据=upsert+并行加载；匹配=内存匹配+元数据更新；落库=批量 INSERT
    const scanWaitMs = tScanDone - tAuthorStart;
    const loadMs = tLoadDone - tUpsertDone;
    const matchMs = tMatchDone - tLoadDone;
    const writeMs = tWriteDone - tMatchDone;
    const authorTotalMs = tWriteDone - tAuthorStart;
    dlog(
      `作者 ${processed}/${authorCount} "${authorDisplayName}" | 文件${authorFiles.length} Excel行${excelRows.length} 作品组${workGroups.length} | ` +
        `新作品${pendingNewWorks.length} 跳过${skippedWorks - skippedWorksBefore} | ` +
        `累计: 作品${totalWorks} 文件${totalFiles} | ${fmtMs(authorTotalMs)}（扫描${fmtMs(scanWaitMs)}/数据${fmtMs(loadMs)}/匹配${fmtMs(matchMs)}/落库${fmtMs(writeMs)}）`
    );
    if (scanWaitMs >= SLOW_PHASE_MS) {
      dwarn(`作者 "${authorDisplayName}" 磁盘扫描等待 ${fmtMs(scanWaitMs)}（文件${authorFiles.length}，预取窗口未覆盖或磁盘慢）`);
    }
    if (loadMs >= SLOW_IPC_MS) {
      dwarn(`作者 "${authorDisplayName}" 数据加载 ${fmtMs(loadMs)}（upsert+Excel行+已有作品+已有路径 IPC）`);
    }
    if (matchMs >= SLOW_PHASE_MS) {
      dwarn(`作者 "${authorDisplayName}" 内存匹配 ${fmtMs(matchMs)}（文件${authorFiles.length} / Excel行${excelRows.length}，可能存在同日大候选桶）`);
    }
    if (writeMs >= SLOW_IPC_MS) {
      dwarn(`作者 "${authorDisplayName}" 批量落库 ${fmtMs(writeMs)}（新作品${pendingNewWorks.length} / 新文件${pendingFiles.length}）`);
    }
    if (authorTotalMs >= SLOW_AUTHOR_MS) {
      dwarn(`作者 "${authorDisplayName}" 全流程 ${fmtMs(authorTotalMs)}，超过单作者阈值`);
    }
    // 速率心跳：每 200 作者输出吞吐与预计剩余时间
    if (processed % 200 === 0) {
      const elapsed = Date.now() - matchPhaseStart;
      const rate = processed / (elapsed / 1000);
      const eta = rate > 0 ? (authorCount - processed) / rate : 0;
      dlog(
        `[心跳] 已处理 ${processed}/${authorCount} 作者 | 速率 ${rate.toFixed(1)} 作者/s | ` +
          `预计剩余 ${eta >= 60 ? `${Math.floor(eta / 60)}分${Math.round(eta % 60)}秒` : `${Math.ceil(eta)}秒`} | ` +
          `累计: 新作品${totalWorks} 新文件${totalFiles} 跳过作品${skippedWorks} 错误${errors.length}`
      );
    }

    // 计数更新由下一作者开始时的统一进度上报（200ms 节流），此处仅让出 UI 时间片
    await yieldIfNeeded();
  }

  dlog(
    `匹配入库阶段完成：${authorCount} 作者 | 新作品 ${totalWorks} / 新文件 ${totalFiles} / 跳过作品 ${skippedWorks} / 跳过文件 ${skippedFiles} / 未匹配文件 ${unmatchedFiles} / 错误 ${errors.length} | 耗时 ${fmtMs(Date.now() - matchPhaseStart)}`
  );

  // 重建标签计数物化表：导入新增/更新了 works 的标签数据，保证侧边栏标签统计准确
  const rebuildStart = Date.now();
  try {
    await rebuildTagCounts();
  } catch (e) {
    errors.push(`重建标签计数失败: ${e}`);
  }
  dlog(`标签计数物化表重建耗时 ${fmtMs(Date.now() - rebuildStart)}`);

  const finishLogStart = Date.now();
  await finishImportLog(importLogId, {
    totalAuthors: scan.authors.length,
    totalWorks,
    totalFiles,
    skippedFiles: skippedFiles,
    unmatchedFiles,
    excelFiles: scan.excel_files,
    errors,
    status: "done",
  });
  dlog(`导入日志落库完成（id=${importLogId}），耗时 ${fmtMs(Date.now() - finishLogStart)}`);

  onProgress?.({
    status: "done",
    message: `导入完成：${totalWorks} 新作品 / ${totalFiles} 新文件 / 跳过 ${skippedWorks} 作品 ${skippedFiles} 文件`,
    percent: 100,
    totalWorks,
    totalAuthors: scan.authors.length,
    errors,
    currentStepDetail: "全部完成",
    currentFile: "",
    currentAuthor: "",
  });

  return {
    totalAuthors: scan.authors.length,
    totalWorks,
    totalFiles,
    skippedFiles: skippedFiles,
    unmatchedFiles,
    errors,
  };
}

// ============ 单独导入 Excel 元数据（不创建作品） ============

export interface ExcelOnlyOutcome {
  totalFiles: number;
  totalRows: number;
  skippedFiles: number;
  errors: string[];
}

/**
 * 单独导入 xlsx 文件，仅缓存元数据到 excel_rows 表，不创建 works 记录。
 * 用于"先导入 Excel 元数据，后续导入作品时自动匹配复用"的场景。
 *
 * @param paths xlsx 文件绝对路径数组
 * @param onProgress 进度回调
 */
export async function importExcelOnly(
  paths: string[],
  onProgress?: ProgressCb
): Promise<ExcelOnlyOutcome> {
  const errors: string[] = [];
  let totalRows = 0;
  let skippedFiles = 0;
  const startTs = Date.now();
  dlog(`===== Excel单独导入开始 ===== ${paths.length} 个文件`);

  onProgress?.({
    status: "parsing",
    message: `正在导入 ${paths.length} 个 Excel 文件...`,
    percent: 0,
    totalFiles: paths.length,
    currentStepDetail: "解析 Excel 文件",
    currentFile: "",
    currentAuthor: "",
  });

  for (let i = 0; i < paths.length; i++) {
    const excelPath = paths[i];
    const fileName = excelPath.split(/[\\/]/).pop() ?? excelPath;
    onProgress?.({
      currentFile: fileName,
      message: `解析中 (${i + 1}/${paths.length}): ${fileName}`,
      percent: Math.floor((i / paths.length) * 100),
    });

    try {
      const parsed = parseExcelFileName(fileName);
      if (!parsed) {
        console.warn("[Excel导入] 文件名无法解析 UID，跳过:", fileName);
        errors.push(`文件名格式不正确（需 UIDxxx_作者名_类型.xlsx）: ${fileName}`);
        skippedFiles++;
        continue;
      }

      // 已缓存则跳过（按 source_path 去重）
      const cached = await isExcelCached(excelPath);
      if (cached) {
        console.log("[Excel导入] 已缓存，跳过:", fileName);
        skippedFiles++;
        continue;
      }

      const { rows } = await parseExcelFile(excelPath);
      const inserted = await insertExcelRows(
        rows,
        excelPath,
        fileName,
        parsed.uid,
        parsed.sourceType ?? ""
      );
      totalRows += inserted;
    } catch (e) {
      console.error("[Excel导入] 解析失败:", excelPath, e);
      errors.push(`Excel解析失败 ${excelPath}: ${e}`);
    }

    await yieldToUI();
  }

  dlog(`===== Excel单独导入结束 ===== 缓存 ${totalRows} 行 / 跳过 ${skippedFiles} 文件 / 错误 ${errors.length} | 总耗时 ${fmtMs(Date.now() - startTs)}`);

  onProgress?.({
    status: "done",
    message: `Excel 导入完成：${totalRows} 行 / 跳过 ${skippedFiles} 文件`,
    percent: 100,
    currentStepDetail: "全部完成",
    currentFile: "",
  });

  return {
    totalFiles: paths.length,
    totalRows,
    skippedFiles,
    errors,
  };
}

// ============ 补充已有作品元数据 ============

export interface AugmentOutcome {
  totalExcelRows: number;
  matchedCount: number;
  updatedCount: number;
  errors: string[];
}

/**
 * 元数据补充用的作品预索引（按 uid 分组加载后构建）。
 * 与 AuthorExcelIndex 同理：日期/类型/标题归一化只做一次，按天分桶 + work_id Map，
 * 替代每 (行, 作品) 配对重复 parseDateTime/normalizeForMatch 的 O(n²) 扫描。
 */
interface IndexedAugmentWork {
  id: number;
  workId: string | null;
  authorUid: string | null;
  dayStart: number | null;
  typeNorm: string;
  titleNorm: string;
}

class AugmentWorkIndex {
  readonly all: IndexedAugmentWork[];
  private byWorkId = new Map<string, IndexedAugmentWork>();
  private byDay = new Map<number, IndexedAugmentWork[]>();

  constructor(
    works: Array<{
      id: number;
      work_id: string | null;
      author_id: number | null;
      title: string | null;
      publish_time: number | null;
      work_type: string | null;
      author_uid: string;
    }>
  ) {
    this.all = works.map((w) => ({
      id: w.id,
      workId: w.work_id,
      authorUid: w.author_id !== null ? w.author_uid : null,
      dayStart: w.publish_time !== null ? getLocalDayStart(w.publish_time) : null,
      typeNorm: normalizeWorkType(w.work_type),
      titleNorm: w.title ? normalizeForMatch(w.title) : "",
    }));
    for (const item of this.all) {
      if (item.workId) this.byWorkId.set(item.workId, item);
      if (item.dayStart === null) continue;
      const arr = this.byDay.get(item.dayStart);
      if (arr) arr.push(item);
      else this.byDay.set(item.dayStart, [item]);
    }
  }

  byDayBucket(dayStart: number): IndexedAugmentWork[] {
    return this.byDay.get(dayStart) ?? [];
  }

  getByWorkId(workId: string): IndexedAugmentWork | undefined {
    return this.byWorkId.get(workId);
  }
}

/**
 * 将 Excel 行匹配到已有作品（用于 augmentWorksWithExcel，基于 AugmentWorkIndex 预索引）
 *
 * 匹配规则（按优先级）：
 * 1. work_id 精确匹配
 * 2. 日期 + 作者 + 类型 匹配（主要规则，不依赖标题，避免表情包导致匹配失败）
 * 3. 日期 + 作者 匹配（降级：类型不匹配时，同日同作者仅一条候选即匹配）
 * 4. 日期 + 类型 匹配（兜底：作者 uid 不匹配时，按日期+类型跨作者匹配）
 * 5. 标题匹配（最后兜底：标题已去除 emoji）
 */
function matchExcelRowToWork(
  row: ExcelRowRecord,
  index: AugmentWorkIndex,
  usedWorkIds: Set<number>
): { workId: number | null } {
  // 1. work_id 精确匹配（works.work_id 全局唯一，Map O(1)）
  if (row.work_id) {
    const hit = index.getByWorkId(row.work_id);
    if (hit && !usedWorkIds.has(hit.id)) {
      return { workId: hit.id };
    }
  }

  const rowTs = parseDateTime(row.publish_time ?? "");
  const rowDayStart = rowTs !== null ? getLocalDayStart(rowTs) : null;
  const rowType = normalizeWorkType(row.work_type);
  // 推导期望的 author uid：收藏/喜欢类型需要加后缀
  const expectedAuthorUid = isCollectionSourceType(row.source_type)
    ? deriveCollectionAuthorUid(row.source_uid, row.source_type)
    : row.source_uid;

  if (rowDayStart !== null) {
    const bucket = index.byDayBucket(rowDayStart);

    // 2. 日期 + 作者 + 类型 匹配
    for (const w of bucket) {
      if (usedWorkIds.has(w.id)) continue;
      if (w.authorUid !== expectedAuthorUid) continue;
      if (rowType && w.typeNorm && w.typeNorm === rowType) {
        return { workId: w.id };
      }
    }

    // 3. 日期 + 作者 匹配（降级：类型不匹配时，同日同作者仅一条候选即匹配）
    let candidate: IndexedAugmentWork | null = null;
    let candidateCount = 0;
    for (const w of bucket) {
      if (usedWorkIds.has(w.id)) continue;
      if (w.authorUid !== expectedAuthorUid) continue;
      candidateCount++;
      if (candidateCount > 1) break;
      candidate = w;
    }
    if (candidateCount === 1 && candidate) {
      return { workId: candidate.id };
    }

    // 4. 日期 + 类型 匹配（兜底：跨作者按日期+类型匹配，唯一候选）
    if (rowType) {
      let candidate2: IndexedAugmentWork | null = null;
      let candidateCount2 = 0;
      for (const w of bucket) {
        if (usedWorkIds.has(w.id)) continue;
        if (w.typeNorm !== rowType) continue;
        candidateCount2++;
        if (candidateCount2 > 1) break;
        candidate2 = w;
      }
      if (candidateCount2 === 1 && candidate2) {
        return { workId: candidate2.id };
      }
    }
  }

  // 5. 标题匹配（最后兜底：标题已去除 emoji）
  const rowTitle = row.description ? normalizeForMatch(row.description) : "";
  if (rowTitle) {
    for (const w of index.all) {
      if (usedWorkIds.has(w.id)) continue;
      if (w.titleNorm && (w.titleNorm.includes(rowTitle) || rowTitle.includes(w.titleNorm))) {
        return { workId: w.id };
      }
    }
  }

  return { workId: null };
}

/**
 * 用 Excel 元数据补充已有作品的元数据（不修改 author_id 和 file_count）
 * 场景：先导入了作品（只有文件名信息），后续导入 xlsx 补充话题/标签/链接等
 *
 * @param paths xlsx 文件路径数组（可选，不传则使用已缓存的全部 Excel 行）
 * @param onProgress 进度回调
 */
export async function augmentWorksWithExcel(
  paths: string[] | null,
  onProgress?: ProgressCb
): Promise<AugmentOutcome> {
  const errors: string[] = [];
  let matchedCount = 0;
  let updatedCount = 0;
  const startTs = Date.now();
  dlog(`===== 元数据补充开始 ===== ${paths ? `${paths.length} 个文件` : "使用全部缓存行"}`);

  onProgress?.({
    status: "parsing",
    message: "正在加载 Excel 元数据...",
    percent: 0,
    currentStepDetail: "加载缓存或解析文件",
    currentFile: "",
    currentAuthor: "",
  });

  // 加载 Excel 行：优先使用传入的文件，未传入则使用已缓存的全部行
  if (paths && paths.length > 0) {
    // 先缓存传入的文件（跳过已缓存的）
    for (const p of paths) {
      const fileName = p.split(/[\\/]/).pop() ?? p;
      const parsed = parseExcelFileName(fileName);
      if (!parsed) {
        errors.push(`文件名格式不正确: ${fileName}`);
        continue;
      }
      const cached = await isExcelCached(p);
      if (cached) continue;
      try {
        const { rows } = await parseExcelFile(p);
        await insertExcelRows(rows, p, fileName, parsed.uid, parsed.sourceType ?? "");
      } catch (e) {
        errors.push(`Excel解析失败 ${p}: ${e}`);
      }
    }
  }

  // ===== 按 source_uid 分组流式处理（内存有界）=====
  // 之前 getAllExcelRows + getWorksForMatching 全量加载：百万级行/作品会把内存撑爆，
  // 且逐行线性扫描全部作品的 O(行数×作品数) 复杂度在大型库上不可行。
  // 现在逐 uid 加载该作者的行 + 作品（含 uid__收藏/喜欢 变体作者），处理完释放。
  const uidGroups = await getExcelRowUidGroups();
  const totalRows = uidGroups.reduce((sum, g) => sum + g.cnt, 0);

  onProgress?.({
    status: "matching",
    message: `加载 ${totalRows} 行 Excel 元数据（${uidGroups.length} 个作者），正在匹配作品...`,
    percent: 20,
    currentStepDetail: "加载作品列表",
  });

  if (totalRows === 0) {
    onProgress?.({
      status: "done",
      message: "没有可用的 Excel 元数据",
      percent: 100,
      currentStepDetail: "完成",
    });
    return { totalExcelRows: 0, matchedCount: 0, updatedCount: 0, errors };
  }

  const usedWorkIds = new Set<number>();
  let processed = 0;

  onProgress?.({
    status: "matching",
    message: `匹配中：${totalRows} 行 Excel 元数据`,
    percent: 30,
    currentStepDetail: "逐行匹配",
  });

  for (const group of uidGroups) {
    const groupStart = Date.now();
    // 该 uid 的 Excel 行（含收藏/喜欢变体）+ 该 uid 作者（含变体）的作品
    const rows = await getExcelRowsByUid(group.source_uid);
    const works = await getWorksForMatchingByUid(group.source_uid);
    // 作品预索引：归一化一次 + 按天分桶 + workId Map
    const workIndex = new AugmentWorkIndex(works);

    for (const row of rows) {
      processed++;
      const { workId } = matchExcelRowToWork(row, workIndex, usedWorkIds);
      if (workId !== null) {
        matchedCount++;
        usedWorkIds.add(workId);

        // 转换 ExcelRowRecord → WorkInsertMeta（不覆盖 author_id 和 file_count）
        const metaRow = excelRowRecordToMetaRow(row);
        const meta = excelRowToWorkMeta({ ...metaRow, _sourceType: row.source_type });
        try {
          // authorId 和 fileCount 传 undefined，COALESCE 保留原值
          await updateWorkMetadata(workId, {
            ...meta,
            authorId: undefined,
            fileCount: undefined,
          });
          updatedCount++;
        } catch (e) {
          errors.push(`更新作品 ${workId} 失败: ${e}`);
        }
      }

      if (processed % 50 === 0) {
        onProgress?.({
          percent: 30 + Math.floor((processed / totalRows) * 65),
          message: `匹配中: ${processed}/${totalRows}（已匹配 ${matchedCount}）`,
        });
        await yieldToUI();
      }
    }
    // 迭代结束，rows/works 随下一轮覆盖释放
    const groupMs = Date.now() - groupStart;
    if (groupMs >= SLOW_PHASE_MS) {
      dwarn(`元数据补充 uid=${group.source_uid} 慢：${rows.length} 行 / ${works.length} 作品，耗时 ${fmtMs(groupMs)}`);
    }
    await yieldToUI();
  }

  // 元数据补充会更新已有作品的 topics/hidden_tags（works 行数不变，启动校验无法感知），需主动重建
  if (updatedCount > 0) {
    try {
      onProgress?.({ message: "正在更新标签统计..." });
      await rebuildTagCounts();
    } catch (e) {
      errors.push(`重建标签计数失败: ${e}`);
    }
  }

  dlog(`===== 元数据补充结束 ===== 匹配 ${matchedCount}/${totalRows} 行，更新 ${updatedCount} 个作品 / 错误 ${errors.length} | 总耗时 ${fmtMs(Date.now() - startTs)}`);

  onProgress?.({
    status: "done",
    message: `元数据补充完成：匹配 ${matchedCount}/${totalRows} 行，更新 ${updatedCount} 个作品`,
    percent: 100,
    currentStepDetail: "完成",
    currentFile: "",
  });

  return {
    totalExcelRows: totalRows,
    matchedCount,
    updatedCount,
    errors,
  };
}

/** 删除 Excel 缓存批次（供 UI 调用，封装错误处理） */
export async function removeExcelBatch(batchId: number): Promise<number> {
  return deleteExcelBatch(batchId);
}

/** 获取 Excel 缓存批次列表（供 UI 调用） */
export async function listExcelBatches() {
  return getExcelBatches();
}
