import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { getAppDataDir, scanRootDirectory } from "@/api/tauri";
import { initDatabase, getWorkCount, getFileCount } from "@/api/db";
import { runImportPipeline, importExcelOnly } from "@/services/importer";
import type { ImportControl } from "@/services/importer";

export type ImportStatus = "idle" | "scanning" | "parsing" | "matching" | "thumbnails" | "paused" | "done" | "error";

export interface ImportProgress {
  status: ImportStatus;
  message: string;
  percent: number; // 0-100
  totalFiles: number;
  skippedFiles: number;
  totalWorks: number;
  totalAuthors: number;
  errors: string[];
  currentFile: string;
  currentAuthor: string;
  currentStepDetail: string;
}

const initialProgress: ImportProgress = {
  status: "idle",
  message: "",
  percent: 0,
  totalFiles: 0,
  skippedFiles: 0,
  totalWorks: 0,
  totalAuthors: 0,
  errors: [],
  currentFile: "",
  currentAuthor: "",
  currentStepDetail: "",
};

export const useAppStore = defineStore("app", () => {
  const rootPath = ref<string>("");
  const appDataDir = ref<string>("");
  const dbPath = ref<string>("");
  const dbReady = ref<boolean>(false);
  const importing = ref<boolean>(false);
  const importPaused = ref<boolean>(false);
  const progress = ref<ImportProgress>({ ...initialProgress });
  const lastError = ref<string>("");

  // 导入控制信号（取消模式："keep"=保留已匹配入库的；"discard"=回滚本次导入全部新建作品）
  let cancelMode: "keep" | "discard" | null = null;
  const importControl: ImportControl = {
    isPaused: () => importPaused.value,
    isCancelled: () => cancelMode !== null,
    getCancelMode: () => cancelMode ?? "keep",
  };

  const workCount = ref<number>(0);
  const mediaFileCount = ref<number>(0);

  const hasData = computed(() => workCount.value > 0);

  async function initApp(): Promise<void> {
    try {
      const dir = await getAppDataDir();
      appDataDir.value = dir;
      dbPath.value = `${dir}/douyin-index.sqlite`;
      await initDatabase(dbPath.value);
      dbReady.value = true;
      await refreshCounts();
    } catch (e) {
      lastError.value = String(e);
      console.error("initApp error", e);
    }
  }

  async function refreshCounts(): Promise<void> {
    if (!dbReady.value) return;
    try {
      workCount.value = await getWorkCount();
      mediaFileCount.value = await getFileCount();
    } catch (e) {
      console.error("refreshCounts error", e);
    }
  }

  async function chooseRootDirectory(): Promise<string | null> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择抖音作品根目录",
    });
    if (selected && typeof selected === "string") {
      rootPath.value = selected;
      if (!dbReady.value) {
        try {
          console.log("[DEBUG] Auto-init database after selecting directory");
          const dir = await getAppDataDir();
          appDataDir.value = dir;
          dbPath.value = `${dir}/douyin-index.sqlite`;
          await initDatabase(dbPath.value);
          dbReady.value = true;
          console.log("[DEBUG] Database auto-init succeeded");
        } catch (e) {
          console.error("[ERROR] Auto-init database failed:", e);
          lastError.value = `数据库初始化失败: ${e}`;
        }
      }
      return selected;
    }
    return null;
  }

  function setProgress(p: Partial<ImportProgress>): void {
    progress.value = { ...progress.value, ...p };
  }

  async function startImport(): Promise<void> {
    console.log("[DEBUG] startImport called, rootPath:", rootPath.value, "dbReady:", dbReady.value);
    if (!rootPath.value) {
      lastError.value = "请先选择根目录";
      return;
    }
    if (importing.value) return;
    if (!dbReady.value) {
      try {
        console.log("[DEBUG] Initializing database...");
        const dir = await getAppDataDir();
        appDataDir.value = dir;
        dbPath.value = `${dir}/douyin-index.sqlite`;
        await initDatabase(dbPath.value);
        dbReady.value = true;
        console.log("[DEBUG] Database initialized successfully");
      } catch (e) {
        lastError.value = `数据库初始化失败: ${e}`;
        console.error("[ERROR] Database init failed:", e);
        return;
      }
    }
    importing.value = true;
    importPaused.value = false;
    cancelMode = null;
    lastError.value = "";
    progress.value = { ...initialProgress, status: "scanning", message: "正在扫描根目录..." };
    try {
      console.log("[DEBUG] Starting import pipeline...");
      const result = await runImportPipeline(rootPath.value, appDataDir.value, (p) => {
        setProgress(p);
      }, importControl);
      console.log("[DEBUG] Import completed:", result);
      setProgress({
        status: "done",
        message: result.cancelled
          ? result.totalWorks > 0
            ? `已取消导入：保留已入库的 ${result.totalWorks} 个作品 / ${result.totalFiles} 个文件`
            : "已取消导入：本次导入的内容未保留"
          : `导入完成：${result.totalWorks} 个作品 / ${result.totalFiles} 个文件`,
        percent: 100,
        totalFiles: result.totalFiles,
        skippedFiles: result.skippedFiles,
        totalWorks: result.totalWorks,
        totalAuthors: result.totalAuthors,
        errors: result.errors,
      });
      await refreshCounts();
    } catch (e) {
      lastError.value = String(e);
      console.error("[ERROR] Import failed:", e);
      setProgress({ status: "error", message: String(e), errors: [String(e)] });
    } finally {
      importing.value = false;
      importPaused.value = false;
      cancelMode = null;
    }
  }

  /** 暂停/恢复导入（作者循环/Excel 循环的迭代边界处生效，正在处理的作者会先完成落库） */
  function toggleImportPause(): void {
    if (!importing.value) return;
    importPaused.value = !importPaused.value;
    if (!importPaused.value) {
      setProgress({ status: "matching", message: "已恢复导入，继续处理..." });
    }
  }

  /**
   * 请求取消导入：
   * - "keep"：保留已匹配入库的作品（已完成作者均已落库），正常收尾
   * - "discard"：回滚本次导入新建的全部作品（按 id 精确删除，文件级联清理）
   */
  function requestCancelImport(mode: "keep" | "discard"): void {
    if (!importing.value) return;
    cancelMode = mode;
    importPaused.value = false;
  }

  async function scanOnly(): Promise<void> {
    if (!rootPath.value) return;
    const r = await scanRootDirectory(rootPath.value);
    setProgress({
      totalFiles: r.total_files,
      skippedFiles: r.skipped_files,
      totalAuthors: r.authors.length,
      message: `扫描完成：${r.authors.length} 作者 / ${r.total_files} 文件`,
    });
  }

  /**
   * 拖放导入（支持批量）：.xlsx/.xls 文件走 Excel 元数据导入，
   * 其余路径（Volume 根目录 / 单个 UID 作者文件夹）合并为一次导入管线——
   * 单条导入日志、全部作者合计进度 (i/N)，与导入 Volume 根目录的显示一致。
   * 返回结果摘要供调用方提示。
   */
  async function importDroppedPaths(paths: string[]): Promise<string> {
    if (importing.value) {
      lastError.value = "正在导入中，请等待完成后再拖放";
      return "";
    }
    if (!paths.length) return "";

    const excelPaths = paths.filter((p) => /\.(xlsx|xls)$/i.test(p));
    const folderPaths = paths.filter((p) => !/\.(xlsx|xls)$/i.test(p));
    if (!excelPaths.length && !folderPaths.length) return "";

    if (!dbReady.value) {
      try {
        const dir = await getAppDataDir();
        appDataDir.value = dir;
        dbPath.value = `${dir}/douyin-index.sqlite`;
        await initDatabase(dbPath.value);
        dbReady.value = true;
      } catch (e) {
        lastError.value = `数据库初始化失败: ${e}`;
        return "";
      }
    }

    importing.value = true;
    importPaused.value = false;
    cancelMode = null;
    lastError.value = "";
    progress.value = { ...initialProgress, status: "scanning", message: "正在处理拖放导入..." };

    const summaries: string[] = [];
    let hasError = false;

    try {
      // 1. 文件夹合并为一次导入管线（多目录作者汇总，进度合计显示）
      if (folderPaths.length) {
        rootPath.value = folderPaths[0];
        try {
          const result = await runImportPipeline(folderPaths, appDataDir.value, (p) => {
            setProgress(p);
          }, importControl);
          if (result.errors.length) hasError = true;
          summaries.push(
            result.cancelled
              ? "文件夹导入已取消"
              : `${folderPaths.length} 个文件夹：${result.totalWorks} 作品 / ${result.totalFiles} 文件`
          );
        } catch (e) {
          hasError = true;
          summaries.push(`文件夹导入失败: ${e}`);
          console.error("[拖放导入] 文件夹导入失败:", e);
        }
      }

      // 2. Excel 批量导入
      if (excelPaths.length) {
        progress.value = {
          ...initialProgress,
          status: "parsing",
          message: `拖放导入 Excel 元数据 (${excelPaths.length} 个文件)...`,
        };
        try {
          const result = await importExcelOnly(excelPaths, (p) => {
            setProgress(p);
          });
          if (result.errors.length) hasError = true;
          summaries.push(`Excel 元数据 ${result.totalRows} 行（${excelPaths.length} 个文件）`);
        } catch (e) {
          hasError = true;
          summaries.push(`Excel 导入失败: ${e}`);
          console.error("[拖放导入] Excel 导入失败:", e);
        }
      }

      setProgress({
        status: hasError ? "error" : "done",
        message: `拖放导入完成：${summaries.join("；")}`,
        percent: 100,
      });
      await refreshCounts();
      return summaries.join("；");
    } finally {
      importing.value = false;
      importPaused.value = false;
      cancelMode = null;
    }
  }

  return {
    rootPath,
    appDataDir,
    dbPath,
    dbReady,
    importing,
    importPaused,
    progress,
    lastError,
    workCount,
    mediaFileCount,
    hasData,
    initApp,
    refreshCounts,
    chooseRootDirectory,
    startImport,
    toggleImportPause,
    requestCancelImport,
    scanOnly,
    importDroppedPaths,
    setProgress,
  };
});
