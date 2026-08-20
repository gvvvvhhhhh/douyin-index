import { parseExcelFileRust } from "@/api/tauri";
import type { ExcelMetaRow } from "@/types";

export function parseExcelFileName(
  fileName: string
): { uid: string; authorName: string; sourceType: string } | null {
  const base = fileName.replace(/\.(xlsx|xls)$/i, "");
  const m = base.match(/^(UID\d+)_(.+)_(.+)$/);
  if (!m) return null;
  return {
    uid: m[1],
    authorName: m[2],
    sourceType: m[3],
  };
}

export async function parseExcelFile(
  filePath: string
): Promise<{ rows: ExcelMetaRow[]; sheetNames: string[] }> {
  // Rust calamine 解析（比 SheetJS 快 10-50x）
  // 表头映射（HEADER_MAP）、中文数字格式化（万/亿）、千位分隔符处理均已在 Rust 完成
  const result = await parseExcelFileRust(filePath);
  return {
    rows: result.rows as ExcelMetaRow[],
    sheetNames: result.sheetNames,
  };
}
