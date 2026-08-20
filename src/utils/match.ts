import type { ExcelMetaRow, ParsedFileMeta } from "@/types";

/** 作品分组键：作者名 + 标题 + 发布时间 */
export interface WorkGroupKey {
  authorName: string;
  title: string;
  publishTime: string | null;
}

/** 由媒体文件分组得到的作品单元 */
export interface WorkGroup {
  key: WorkGroupKey;
  files: ParsedFileMeta[];
  /** 主分类（取自第一个文件） */
  category: string;
  /** 合并所有标签 */
  tags: string[];
}

function makeKey(meta: ParsedFileMeta): WorkGroupKey {
  return {
    authorName: meta.author_name,
    title: meta.title,
    publishTime: meta.publish_time_iso || null,
  };
}

function keyToString(k: WorkGroupKey): string {
  return `${k.authorName}||${k.title}||${k.publishTime ?? ""}`;
}

/** 将媒体文件按作者+标题+发布时间分组 */
export function groupMediaFilesIntoWorks(files: ParsedFileMeta[]): WorkGroup[] {
  const map = new Map<string, WorkGroup>();
  for (const f of files) {
    const key = makeKey(f);
    const k = keyToString(key);
    if (!map.has(k)) {
      map.set(k, {
        key,
        files: [],
        category: f.category,
        tags: [],
      });
    }
    const g = map.get(k)!;
    g.files.push(f);
    // 主分类：优先视频 > 图集 > 实况
    if (priority(f.category) > priority(g.category)) {
      g.category = f.category;
    }
    for (const t of f.tags) {
      if (!g.tags.includes(t)) g.tags.push(t);
    }
  }
  // 每组内按 sequence 排序
  for (const g of map.values()) {
    g.files.sort((a, b) => {
      const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
      const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return a.file_name.localeCompare(b.file_name);
    });
  }
  return Array.from(map.values());
}

function priority(category: string): number {
  if (category.includes("视频")) return 3;
  if (category.includes("图集")) return 2;
  if (category.includes("实况")) return 1;
  return 0;
}

/** 时间归一化：把各种格式转为 YYYY-MM-DDTHH:MM:SS 或返回 null */
export function normalizeTime(input: string | undefined | null): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  // 已是 ISO
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T${isoMatch[4]}:${isoMatch[5]}:${isoMatch[6]}`;
  }
  // YYYY-MM-DD HH.MM.SS
  const dotMatch = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})/);
  if (dotMatch) {
    return `${dotMatch[1]}-${dotMatch[2]}-${dotMatch[3]}T${dotMatch[4]}:${dotMatch[5]}:${dotMatch[6]}`;
  }
  // YYYY-MM-DD HH:MM:SS
  const colonMatch = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (colonMatch) {
    return `${colonMatch[1]}-${colonMatch[2]}-${colonMatch[3]}T${colonMatch[4]}:${colonMatch[5]}:${colonMatch[6]}`;
  }
  // YYYY/MM/DD HH:MM:SS
  const slashMatch = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})/);
  if (slashMatch) {
    const pad = (x: string) => x.padStart(2, "0");
    return `${slashMatch[1]}-${pad(slashMatch[2])}-${pad(slashMatch[3])}T${pad(slashMatch[4])}:${slashMatch[5]}:${slashMatch[6]}`;
  }
  // 仅日期 YYYY-MM-DD
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00`;
  }
  // 尝试 Date 解析
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().replace(/\.\d+Z$/, "");
  }
  return null;
}

/** 在 Excel 行中查找与作品分组匹配的元数据 */
export function matchExcelRow(
  group: WorkGroup,
  excelRows: ExcelMetaRow[],
  authorName: string
): ExcelMetaRow | null {
  const targetTitle = group.key.title.trim();
  const targetTime = group.key.publishTime;
  // 标题完全匹配 + 作者匹配
  let best: { row: ExcelMetaRow; score: number } | null = null;
  for (const row of excelRows) {
    const rowTitle = (row.description ?? "").trim();
    if (!rowTitle) continue;
    let score = 0;
    if (rowTitle === targetTitle) score += 10;
    else if (rowTitle.includes(targetTitle) || targetTitle.includes(rowTitle)) score += 6;
    else continue;
    // 作者匹配（Excel 行可能没有作者字段，依赖文件名）
    // 此处 authorName 来自 Excel 文件名
    if (authorName && String(row.authorName ?? "").trim() === authorName) score += 2;
    // 时间匹配
    const rowTime = normalizeTime(row.publishTime);
    if (targetTime && rowTime && rowTime === targetTime) score += 5;
    else if (targetTime && rowTime && rowTime.slice(0, 10) === targetTime.slice(0, 10)) score += 3;
    if (!best || score > best.score) best = { row, score };
  }
  return best?.row ?? null;
}

/** 解析 Excel 标签字段（可能是 "#tag1 #tag2" 或 "tag1,tag2" 等） */
export function parseTagsField(tagsField: string | undefined): string[] {
  if (!tagsField) return [];
  const s = String(tagsField).trim();
  if (!s) return [];
  // 优先按 # 分隔
  if (s.includes("#")) {
    return s
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter(Boolean);
  }
  // 按逗号/分号分隔
  return s
    .split(/[,;，；]/)
    .map((t) => t.trim())
    .filter(Boolean);
}
