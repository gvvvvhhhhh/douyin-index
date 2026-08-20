import { invoke } from "@tauri-apps/api/core";
import type { ScanResult, ParsedFileMeta } from "@/types";

export async function scanRootDirectory(rootPath: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_root_directory", { rootPath });
}

/// 分阶段扫描 Phase 1：只扫描顶层目录（作者文件夹 + Excel），不扫描媒体文件
export async function scanRootDirectoryMeta(rootPath: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_root_directory_meta", { rootPath });
}

/// 分阶段扫描 Phase 2：扫描单个作者文件夹的媒体文件
export async function scanAuthorMediaFiles(folderPath: string): Promise<ParsedFileMeta[]> {
  return invoke<ParsedFileMeta[]>("scan_author_media_files", { folderPath });
}

/// 在 Rust 中解析 Excel 文件（calamine 库，比 SheetJS 快 10-50x）
export async function parseExcelFileRust(filePath: string): Promise<{ rows: Record<string, unknown>[]; sheetNames: string[] }> {
  return invoke<{ rows: Record<string, unknown>[]; sheetNames: string[] }>("parse_excel_file", { filePath });
}

export async function getAppDataDir(): Promise<string> {
  return invoke<string>("get_app_data_dir");
}

export async function readFileBytes(filePath: string): Promise<Uint8Array> {
  return invoke<Uint8Array>("read_file_bytes", { filePath });
}
