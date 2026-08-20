<script setup lang="ts">
import { ref, computed, onMounted, watch, h } from "vue";
import {
  NCard,
  NSpace,
  NButton,
  NDataTable,
  NStatistic,
  NTag,
  NPopconfirm,
  NProgress,
  NInput,
  NGrid,
  NGi,
  NTabs,
  NTabPane,
  NScrollbar,
  NCheckbox,
  useMessage,
  useDialog,
  type DataTableColumns,
} from "naive-ui";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/app";
import {
  getImportLogs,
  deleteImportLogCascade,
  getImportLogStats,
  deleteAuthorById,
  getAuthors,
  getDbStats,
  clearAllImportLogs,
  clearAllExcelRows,
  type ImportLogRow,
} from "@/api/db";
import {
  importExcelOnly,
  augmentWorksWithExcel,
  listExcelBatches,
  removeExcelBatch,
} from "@/services/importer";
import type { AuthorRow, ExcelBatchRow } from "@/types";

const appStore = useAppStore();
const message = useMessage();
const dialog = useDialog();

const emit = defineEmits<{
  (e: "back"): void;
}>();

interface StatsData {
  totalWorks: number;
  totalFiles: number;
  totalAuthors: number;
  totalThumbnails: number;
  worksWithTopics: number;
  worksWithHiddenTags: number;
}

const stats = ref<StatsData>({
  totalWorks: 0,
  totalFiles: 0,
  totalAuthors: 0,
  totalThumbnails: 0,
  worksWithTopics: 0,
  worksWithHiddenTags: 0,
});

const logs = ref<ImportLogRow[]>([]);
const logsLoading = ref(false);

type AuthorWithCount = AuthorRow & { work_count: number };
const authors = ref<AuthorWithCount[]>([]);
const authorsLoading = ref(false);
const authorSearch = ref("");
const checkedAuthorIds = ref<Set<number>>(new Set());
const batchMode = ref(false);

// Excel 元数据缓存管理
const excelBatches = ref<ExcelBatchRow[]>([]);
const excelBatchesLoading = ref(false);
const excelImporting = ref(false);
const augmenting = ref(false);
// Excel 批次搜索：按文件名/UID/路径前端过滤
const excelBatchSearch = ref("");
const filteredExcelBatches = computed(() => {
  const kw = excelBatchSearch.value.trim().toLowerCase();
  if (!kw) return excelBatches.value;
  return excelBatches.value.filter(
    (b) =>
      b.source_filename.toLowerCase().includes(kw) ||
      b.source_uid.toLowerCase().includes(kw) ||
      b.source_path.toLowerCase().includes(kw)
  );
});

const filteredAuthors = computed(() => {
  const kw = authorSearch.value.trim().toLowerCase();
  if (!kw) return authors.value;
  return authors.value.filter(
    (a) =>
      a.name.toLowerCase().includes(kw) ||
      (a.uid && a.uid.toLowerCase().includes(kw))
  );
});

const allFilteredChecked = computed({
  get: () => {
    const ids = filteredAuthors.value.map((a) => a.id).filter((id) => id != null) as number[];
    return ids.length > 0 && ids.every((id) => checkedAuthorIds.value.has(id));
  },
  set: (val: boolean) => {
    const ids = filteredAuthors.value.map((a) => a.id).filter((id) => id != null) as number[];
    if (val) {
      ids.forEach((id) => checkedAuthorIds.value.add(id));
    } else {
      ids.forEach((id) => checkedAuthorIds.value.delete(id));
    }
    checkedAuthorIds.value = new Set(checkedAuthorIds.value);
  },
});

const checkedCount = computed(() => checkedAuthorIds.value.size);

const progress = computed(() => appStore.progress);
const importing = computed(() => appStore.importing);
const importPaused = computed(() => appStore.importPaused);

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function statusTagType(status: string): "default" | "success" | "error" | "warning" | "info" {
  switch (status) {
    case "done":
      return "success";
    case "error":
      return "error";
    case "scanning":
    case "parsing":
    case "matching":
    case "thumbnails":
    case "paused":
      return "info";
    default:
      return "default";
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    idle: "空闲",
    scanning: "扫描中",
    parsing: "解析中",
    matching: "匹配中",
    thumbnails: "生成缩略图",
    paused: "已暂停",
    done: "完成",
    error: "错误",
  };
  return map[status] ?? status;
}

/** 取消导入：二级确认（保留已匹配入库 / 不导入并回滚） */
function confirmCancelImport(): void {
  dialog.warning({
    title: "取消导入",
    content: "已匹配完成的作品已实时入库。选择如何处理本次导入：",
    positiveText: "导入已匹配的作品",
    negativeText: "不导入",
    closable: true,
    onPositiveClick: () => {
      appStore.requestCancelImport("keep");
      message.info("正在收尾：保留已匹配入库的作品...");
    },
    onNegativeClick: () => {
      dialog.warning({
        title: "再次确认",
        content: "将删除本次导入新建的全部作品和文件记录（已存在的旧数据不受影响），操作不可恢复。",
        positiveText: "确认不导入",
        negativeText: "返回",
        onPositiveClick: () => {
          appStore.requestCancelImport("discard");
          message.info("正在回滚本次导入的内容...");
        },
      });
    },
  });
}

async function loadStats(): Promise<void> {
  try {
    const s = await getDbStats();
    stats.value = {
      totalWorks: s.totalWorks,
      totalFiles: s.totalFiles,
      totalAuthors: s.totalAuthors,
      totalThumbnails: s.totalThumbnails,
      worksWithTopics: s.worksWithTopics,
      worksWithHiddenTags: s.worksWithHiddenTags,
    };
  } catch (e) {
    console.error("loadStats error", e);
  }
}

async function loadLogs(): Promise<void> {
  logsLoading.value = true;
  try {
    logs.value = await getImportLogs();
  } catch (e) {
    console.error("loadLogs error", e);
  } finally {
    logsLoading.value = false;
  }
}

async function loadAuthors(): Promise<void> {
  authorsLoading.value = true;
  try {
    authors.value = await getAuthors();
  } catch (e) {
    console.error("loadAuthors error", e);
  } finally {
    authorsLoading.value = false;
  }
}

async function loadExcelBatches(): Promise<void> {
  excelBatchesLoading.value = true;
  try {
    excelBatches.value = await listExcelBatches();
  } catch (e) {
    console.error("loadExcelBatches error", e);
  } finally {
    excelBatchesLoading.value = false;
  }
}

async function loadAll(): Promise<void> {
  if (!appStore.dbReady) return;
  await Promise.all([loadStats(), loadLogs(), loadAuthors(), loadExcelBatches()]);
}

async function quickImport(): Promise<void> {
  const p = await appStore.chooseRootDirectory();
  if (!p) return;
  message.success(`已选择目录: ${p}`);
  try {
    await appStore.startImport();
    if (appStore.progress.status === "done") {
      message.success(appStore.progress.message);
      await loadAll();
      await appStore.refreshCounts();
    } else if (appStore.progress.status === "error") {
      message.error(appStore.progress.message);
    }
  } catch (e) {
    console.error("quickImport error", e);
    message.error(`导入失败: ${e}`);
  }
}

/**
 * 级联删除导入：删除该次导入关联的全部作者、作品、文件
 * 删除前预览将清理的数据量，避免误操作
 */
async function onDeleteImport(row: ImportLogRow): Promise<void> {
  let preview: { authorCount: number; workCount: number; fileCount: number } | null = null;
  try {
    preview = await getImportLogStats(row.id);
    console.log("[导入管理] 删除预览 importLogId=", row.id, "rootPath=", row.root_path, "preview=", preview);
  } catch (e) {
    console.warn("[导入管理] getImportLogStats failed", e);
  }
  dialog.warning({
    title: "删除导入记录",
    content:
      preview && (preview.authorCount > 0 || preview.workCount > 0)
        ? `此操作将永久删除该次导入的全部数据：${preview.authorCount} 个作者 / ${preview.workCount} 个作品 / ${preview.fileCount} 个文件。操作不可恢复。`
        : "确认删除此导入记录？该记录已无关联数据。",
    positiveText: "确认删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        console.log("[导入管理] 开始删除 importLogId=", row.id);
        await deleteImportLogCascade(row.id);
        console.log("[导入管理] 删除完成 importLogId=", row.id);
        message.success("已删除该次导入的全部数据");
        await Promise.all([loadLogs(), loadAuthors(), loadStats()]);
        await appStore.refreshCounts();
      } catch (e) {
        console.error("[导入管理] 删除失败 importLogId=", row.id, "error=", e);
        message.error(`删除失败: ${e}`);
        await loadLogs();
      }
    },
  });
}

/** 解析 import_logs.excel_files 字段（JSON 数组字符串）为文件名数组 */
function parseExcelFiles(row: ImportLogRow): string[] {
  if (!row.excel_files) return [];
  try {
    const arr = JSON.parse(row.excel_files);
    if (Array.isArray(arr)) return arr as string[];
  } catch {
    // ignore
  }
  return [];
}

async function onDeleteAuthor(authorId: number, name: string): Promise<void> {
  try {
    await deleteAuthorById(authorId);
    message.success(`已删除作者「${name}」及其作品`);
    await Promise.all([loadAuthors(), loadStats()]);
    await appStore.refreshCounts();
  } catch (e) {
    message.error(`删除失败: ${e}`);
  }
}

async function onClearAllHistory(): Promise<void> {
  dialog.warning({
    title: "清空导入历史",
    content: "确定要清空所有导入历史记录吗？此操作仅删除历史记录，不影响已导入的数据。",
    positiveText: "继续",
    negativeText: "取消",
    onPositiveClick: () => {
      dialog.warning({
        title: "再次确认",
        content: "此操作不可恢复！确定要清空全部导入历史吗？",
        positiveText: "确认清空",
        negativeText: "取消",
        onPositiveClick: async () => {
          try {
            await clearAllImportLogs();
            message.success("已清空全部导入历史");
            await loadLogs();
          } catch (e) {
            message.error(`清空失败: ${e}`);
          }
        },
      });
    },
  });
}

async function onBatchDeleteAuthors(): Promise<void> {
  const ids = Array.from(checkedAuthorIds.value);
  if (ids.length === 0) return;
  dialog.warning({
    title: "批量删除作者",
    content: `确认删除选中的 ${ids.length} 个作者？将同时删除其所有作品与文件，操作不可恢复。`,
    positiveText: "确认删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        for (const id of ids) {
          await deleteAuthorById(id);
        }
        message.success(`已删除 ${ids.length} 个作者`);
        checkedAuthorIds.value.clear();
        checkedAuthorIds.value = new Set(checkedAuthorIds.value);
        batchMode.value = false;
        await Promise.all([loadAuthors(), loadStats()]);
        await appStore.refreshCounts();
      } catch (e) {
        message.error(`批量删除失败: ${e}`);
        await Promise.all([loadAuthors(), loadStats()]);
      }
    },
  });
}

function toggleBatchMode(): void {
  batchMode.value = !batchMode.value;
  if (!batchMode.value) {
    checkedAuthorIds.value.clear();
    checkedAuthorIds.value = new Set(checkedAuthorIds.value);
  }
}

function toggleAuthorChecked(id: number, checked: boolean): void {
  if (checked) {
    checkedAuthorIds.value.add(id);
  } else {
    checkedAuthorIds.value.delete(id);
  }
  checkedAuthorIds.value = new Set(checkedAuthorIds.value);
}

// ============ Excel 元数据管理 ============

/** 选择并导入 xlsx 文件（仅缓存元数据，不创建作品） */
async function onImportExcelOnly(): Promise<void> {
  const selected = await open({
    multiple: true,
    filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }],
    title: "选择要导入的 Excel 文件",
  });
  if (!selected || (Array.isArray(selected) && selected.length === 0)) return;
  const paths = Array.isArray(selected) ? selected : [selected];

  excelImporting.value = true;
  appStore.setProgress({ status: "parsing", message: "正在导入 Excel...", percent: 0, errors: [] });
  try {
    const result = await importExcelOnly(paths, (p) => appStore.setProgress(p));
    if (result.errors.length > 0) {
      message.warning(`导入完成（${result.totalRows} 行），但有 ${result.errors.length} 个错误`);
    } else {
      message.success(`Excel 导入完成：${result.totalRows} 行 / 跳过 ${result.skippedFiles} 文件`);
    }
    await loadExcelBatches();
  } catch (e) {
    message.error(`Excel 导入失败: ${e}`);
  } finally {
    excelImporting.value = false;
    appStore.setProgress({ status: "idle", message: "", percent: 0 });
  }
}

/** 用 Excel 元数据补充已有作品（先选择 xlsx，或使用已缓存的全部行） */
async function onAugmentWorks(): Promise<void> {
  // 先选择 xlsx 文件（可选）
  const selected = await open({
    multiple: true,
    filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }],
    title: "选择 Excel 文件（可跳过使用已缓存的全部元数据）",
  });

  let paths: string[] | null = null;
  if (selected) {
    paths = Array.isArray(selected) ? selected : [selected];
  }

  // 二次确认
  dialog.warning({
    title: "补充作品元数据",
    content: paths && paths.length > 0
      ? `将使用 ${paths.length} 个 Excel 文件（及已缓存的全部行）匹配并更新已有作品的元数据（话题/标签/链接等）。不会修改作者和文件数。是否继续？`
      : `将使用已缓存的全部 Excel 元数据匹配并更新已有作品。不会修改作者和文件数。是否继续？`,
    positiveText: "开始补充",
    negativeText: "取消",
    onPositiveClick: async () => {
      augmenting.value = true;
      appStore.setProgress({ status: "matching", message: "正在补充元数据...", percent: 0, errors: [] });
      try {
        const result = await augmentWorksWithExcel(paths, (p) => appStore.setProgress(p));
        if (result.errors.length > 0) {
          message.warning(`补充完成（匹配 ${result.matchedCount}/${result.totalExcelRows} 行，更新 ${result.updatedCount} 个作品），但有 ${result.errors.length} 个错误`);
        } else {
          message.success(`元数据补充完成：匹配 ${result.matchedCount}/${result.totalExcelRows} 行，更新 ${result.updatedCount} 个作品`);
        }
        await loadStats();
        await appStore.refreshCounts();
      } catch (e) {
        message.error(`元数据补充失败: ${e}`);
      } finally {
        augmenting.value = false;
        appStore.setProgress({ status: "idle", message: "", percent: 0 });
      }
    },
  });
}

/** 删除单个 Excel 缓存批次 */
async function onDeleteExcelBatch(batchId: number): Promise<void> {
  try {
    const deleted = await removeExcelBatch(batchId);
    message.success(`已删除 ${deleted} 行 Excel 缓存`);
    await loadExcelBatches();
  } catch (e) {
    message.error(`删除失败: ${e}`);
  }
}

/** 清空全部 Excel 缓存（二次确认） */
async function onClearAllExcel(): Promise<void> {
  dialog.warning({
    title: "清空 Excel 缓存",
    content: "确定要清空全部 Excel 元数据缓存吗？此操作不影响已导入的作品数据。",
    positiveText: "继续",
    negativeText: "取消",
    onPositiveClick: () => {
      dialog.warning({
        title: "再次确认",
        content: "此操作不可恢复！确定要清空全部 Excel 缓存吗？",
        positiveText: "确认清空",
        negativeText: "取消",
        onPositiveClick: async () => {
          try {
            await clearAllExcelRows();
            message.success("已清空全部 Excel 缓存");
            await loadExcelBatches();
          } catch (e) {
            message.error(`清空失败: ${e}`);
          }
        },
      });
    },
  });
}

// 导入历史列：只读，不提供删除按钮，展示更多信息（xlsx 文件、跳过/未匹配数）
const logColumns = computed<DataTableColumns<ImportLogRow>>(() => [
  {
    title: "时间",
    key: "started_at",
    width: 180,
    render: (row) => formatTimestamp(row.started_at),
  },
  {
    title: "根路径",
    key: "root_path",
    minWidth: 220,
    ellipsis: { tooltip: true },
    render: (row) => row.root_path || "-",
  },
  {
    title: "Excel 文件",
    key: "excel_files",
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (row) => {
      const files = parseExcelFiles(row);
      if (files.length === 0) return "-";
      // 只显示文件名，多个用逗号分隔
      const names = files.map((f) => f.split(/[\\/]/).pop() ?? f);
      return names.join(", ");
    },
  },
  { title: "作者", key: "total_authors", width: 70 },
  { title: "作品", key: "total_works", width: 70 },
  { title: "文件", key: "total_files", width: 70 },
  {
    title: "跳过",
    key: "skipped_files",
    width: 70,
    render: (row) => String(row.skipped_files ?? 0),
  },
  {
    title: "未匹配",
    key: "unmatched_files",
    width: 70,
    render: (row) => String(row.unmatched_files ?? 0),
  },
  {
    title: "状态",
    key: "status",
    width: 100,
    render: (row) =>
      h(
        NTag,
        { type: statusTagType(row.status), size: "small" },
        { default: () => statusLabel(row.status) }
      ),
  },
]);

// 导入管理列：可删除（级联清理该次导入的全部作者和作品）
const manageColumns = computed<DataTableColumns<ImportLogRow>>(() => [
  {
    title: "时间",
    key: "started_at",
    width: 180,
    render: (row) => formatTimestamp(row.started_at),
  },
  {
    title: "根路径",
    key: "root_path",
    minWidth: 220,
    ellipsis: { tooltip: true },
    render: (row) => row.root_path || "-",
  },
  {
    title: "Excel 文件",
    key: "excel_files",
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (row) => {
      const files = parseExcelFiles(row);
      if (files.length === 0) return "-";
      const names = files.map((f) => f.split(/[\\/]/).pop() ?? f);
      return names.join(", ");
    },
  },
  { title: "作者", key: "total_authors", width: 70 },
  { title: "作品", key: "total_works", width: 70 },
  { title: "文件", key: "total_files", width: 70 },
  {
    title: "状态",
    key: "status",
    width: 100,
    render: (row) =>
      h(
        NTag,
        { type: statusTagType(row.status), size: "small" },
        { default: () => statusLabel(row.status) }
      ),
  },
  {
    title: "操作",
    key: "actions",
    width: 100,
    render: (row) =>
      h(
        NButton,
        {
          size: "small",
          type: "error",
          ghost: true,
          onClick: () => onDeleteImport(row),
        },
        { default: () => "删除" }
      ),
  },
]);

const authorColumns = computed<DataTableColumns<AuthorWithCount>>(() => {
  const cols: DataTableColumns<AuthorWithCount> = [];

  if (batchMode.value) {
    cols.push({
      title: () =>
        h(NCheckbox, {
          checked: allFilteredChecked.value,
          "onUpdate:checked": (v: boolean) => {
            allFilteredChecked.value = v;
          },
        }),
      key: "checked",
      width: 50,
      render: (row) =>
        h(NCheckbox, {
          checked: row.id != null && checkedAuthorIds.value.has(row.id),
          "onUpdate:checked": (v: boolean) => {
            if (row.id != null) toggleAuthorChecked(row.id, v);
          },
        }),
    });
  }

  cols.push(
    {
      title: "名称",
      key: "name",
      width: 160,
      ellipsis: { tooltip: true },
    },
    {
      title: "UID",
      key: "uid",
      width: 160,
      ellipsis: { tooltip: true },
    },
    {
      title: "签名",
      key: "signature",
      ellipsis: { tooltip: true },
      render: (row) => row.signature || "-",
    },
    { title: "作品数", key: "work_count", width: 90 },
    {
      title: "文件夹路径",
      key: "folder_path",
      ellipsis: { tooltip: true },
      render: (row) => row.folder_path || "-",
    },
    {
      title: "创建时间",
      key: "created_at",
      width: 180,
      render: (row) => formatTimestamp(row.created_at),
    }
  );

  if (!batchMode.value) {
    cols.push({
      title: "操作",
      key: "actions",
      width: 90,
      render: (row) =>
        h(
          NPopconfirm,
          {
            onPositiveClick: () => onDeleteAuthor(row.id!, row.name),
          },
          {
            default: () => `确认删除作者「${row.name}」？将同时删除其所有作品与文件。`,
            trigger: () =>
              h(
                NButton,
                { size: "small", type: "error", ghost: true },
                { default: () => "删除" }
              ),
          }
        ),
    });
  }

  return cols;
});

// Excel 缓存批次列：展示已导入的 xlsx 元数据批次，支持单批删除
const excelBatchColumns = computed<DataTableColumns<ExcelBatchRow>>(() => [
  {
    title: "导入时间",
    key: "imported_at",
    width: 180,
    render: (row) => formatTimestamp(row.imported_at),
  },
  {
    title: "Excel 文件",
    key: "source_filename",
    minWidth: 200,
    ellipsis: { tooltip: true },
  },
  {
    title: "UID",
    key: "source_uid",
    width: 140,
    ellipsis: { tooltip: true },
  },
  {
    title: "来源类型",
    key: "source_type",
    width: 120,
    render: (row) => row.source_type || "-",
  },
  { title: "行数", key: "row_count", width: 80 },
  {
    title: "文件路径",
    key: "source_path",
    minWidth: 220,
    ellipsis: { tooltip: true },
  },
  {
    title: "操作",
    key: "actions",
    width: 90,
    render: (row) =>
      h(
        NButton,
        {
          size: "small",
          type: "error",
          ghost: true,
          onClick: () => onDeleteExcelBatch(row.batch_id),
        },
        { default: () => "删除" }
      ),
  },
]);

watch(
  () => importing.value,
  (cur, prev) => {
    if (prev && !cur) {
      loadAll();
      appStore.refreshCounts();
    }
  }
);

watch(
  () => appStore.dbReady,
  (ready) => {
    if (ready) loadAll();
  }
);

onMounted(() => {
  loadAll();
});

// 拖放导入（在任意页面触发）完成后自动刷新本页统计/日志/作者/Excel 批次，
// 否则停留在导入管理页时看不到最新数据（侧边栏由 HomeView 的 loadData 刷新）
watch(
  () => appStore.importing,
  (busy, wasBusy) => {
    if (wasBusy && !busy) {
      void loadAll();
    }
  }
);
</script>

<template>
  <div class="import-manager">
    <NScrollbar>
      <div class="page">
        <div class="header">
          <NButton quaternary @click="emit('back')">
            <template #icon>←</template>
            返回
          </NButton>
          <h2 class="title">导入管理</h2>
        </div>

        <NTabs type="line" animated>
          <!-- 导入概览 -->
          <NTabPane name="overview" tab="导入概览">
            <NSpace vertical :size="16">
              <NCard title="数据统计" :bordered="false">
                <NGrid cols="1 m:2 l:4" :x-gap="16" :y-gap="16" responsive="screen">
                  <NGi>
                    <NStatistic label="作品总数" :value="stats.totalWorks" />
                  </NGi>
                  <NGi>
                    <NStatistic label="文件总数" :value="stats.totalFiles" />
                  </NGi>
                  <NGi>
                    <NStatistic label="作者总数" :value="stats.totalAuthors" />
                  </NGi>
                  <NGi>
                    <NStatistic label="缩略图" :value="stats.totalThumbnails" />
                  </NGi>
                </NGrid>
              </NCard>

              <NCard title="快速导入" :bordered="false">
                <NSpace vertical :size="12">
                  <div class="root-path">
                    <span class="label">当前根目录：</span>
                    <span class="value" :title="appStore.rootPath">{{ appStore.rootPath || "未选择" }}</span>
                  </div>
                  <NSpace>
                    <NButton type="primary" :loading="importing" @click="quickImport">
                      <template #icon>📥</template>
                      快速导入
                    </NButton>
                  </NSpace>
                </NSpace>
              </NCard>

              <NCard
                v-if="importing || progress.status !== 'idle'"
                title="导入进度"
                :bordered="false"
              >
                <NSpace vertical :size="10">
                  <NProgress
                    type="line"
                    :percentage="progress.percent"
                    :status="
                      progress.status === 'error'
                        ? 'error'
                        : progress.status === 'done'
                        ? 'success'
                        : 'default'
                    "
                    indicator-placement="inside"
                    :processing="!importPaused"
                  />
                  <NSpace v-if="importing" justify="end">
                    <NButton size="small" :disabled="progress.status === 'done'" @click="appStore.toggleImportPause()">
                      {{ appStore.importPaused ? "恢复" : "暂停" }}
                    </NButton>
                    <NButton size="small" type="error" ghost :disabled="progress.status === 'done'" @click="confirmCancelImport">
                      取消导入
                    </NButton>
                  </NSpace>
                  <div class="progress-msg">{{ progress.message || statusLabel(progress.status) }}</div>
                  <div v-if="progress.currentStepDetail" class="progress-detail">
                    <span class="detail-label">当前步骤：</span>
                    <span class="detail-value">{{ progress.currentStepDetail }}</span>
                  </div>
                  <div v-if="progress.currentAuthor" class="progress-detail">
                    <span class="detail-label">当前作者：</span>
                    <span class="detail-value">{{ progress.currentAuthor }}</span>
                  </div>
                  <div v-if="progress.currentFile" class="progress-detail progress-file">
                    <span class="detail-label">当前文件：</span>
                    <span class="detail-value" :title="progress.currentFile">{{ progress.currentFile }}</span>
                  </div>
                  <div
                    v-if="progress.totalWorks > 0 || progress.totalFiles > 0"
                    class="progress-stats"
                  >
                    <NStatistic label="作者" :value="progress.totalAuthors" />
                    <NStatistic label="作品" :value="progress.totalWorks" />
                    <NStatistic label="文件" :value="progress.totalFiles" />
                    <NStatistic label="跳过" :value="progress.skippedFiles" />
                  </div>
                </NSpace>
              </NCard>
            </NSpace>
          </NTabPane>

          <!-- 导入历史（只读，展示更多导入信息，支持清空记录） -->
          <NTabPane name="history" tab="导入历史">
            <NCard :bordered="false">
              <NSpace vertical :size="12">
                <NSpace justify="end">
                  <NButton
                    type="error"
                    ghost
                    size="small"
                    :disabled="logs.length === 0"
                    @click="onClearAllHistory"
                  >
                    清空记录
                  </NButton>
                </NSpace>
                <NDataTable
                  :columns="logColumns"
                  :data="logs"
                  :loading="logsLoading"
                  :bordered="false"
                  :single-line="false"
                  size="small"
                  :pagination="{ pageSize: 20 }"
                />
              </NSpace>
            </NCard>
          </NTabPane>

          <!-- 导入管理（可删除，级联清理该次导入的全部作者和作品） -->
          <NTabPane name="manage" tab="导入管理">
            <NSpace vertical :size="12">
              <div class="tab-hint">
                删除某次导入将同时清理该次导入关联的全部作者、作品和文件记录，操作不可恢复。
              </div>
              <NCard :bordered="false">
                <NDataTable
                  :columns="manageColumns"
                  :data="logs"
                  :loading="logsLoading"
                  :bordered="false"
                  :single-line="false"
                  size="small"
                  :pagination="{ pageSize: 20 }"
                />
              </NCard>
            </NSpace>
          </NTabPane>

          <!-- Excel 管理（单独导入 xlsx 元数据，补充已有作品元数据） -->
          <NTabPane name="excel" tab="Excel 管理">
            <NSpace vertical :size="12">
              <NCard title="Excel 元数据操作" :bordered="false">
                <NSpace vertical :size="12">
                  <div class="tab-hint">
                    单独导入 xlsx 仅缓存元数据，不创建作品；后续导入作品时自动匹配复用。
                    也可用已缓存的元数据补充已有作品的元数据（话题/标签/链接等）。
                  </div>
                  <NSpace>
                    <NButton
                      type="primary"
                      :loading="excelImporting"
                      @click="onImportExcelOnly"
                    >
                      <template #icon>📊</template>
                      导入 Excel 元数据
                    </NButton>
                    <NButton
                      type="info"
                      :loading="augmenting"
                      @click="onAugmentWorks"
                    >
                      <template #icon>🔄</template>
                      补充作品元数据
                    </NButton>
                    <NButton
                      type="error"
                      ghost
                      size="small"
                      :disabled="excelBatches.length === 0"
                      @click="onClearAllExcel"
                    >
                      清空缓存
                    </NButton>
                  </NSpace>
                  <div v-if="excelImporting || augmenting || progress.status !== 'idle'" class="progress-msg">
                    {{ progress.message }}
                    <NProgress
                      v-if="excelImporting || augmenting"
                      type="line"
                      :percentage="progress.percent"
                      :status="progress.status === 'error' ? 'error' : 'default'"
                      style="margin-top: 8px"
                    />
                  </div>
                </NSpace>
              </NCard>

              <NCard title="已缓存的 Excel 批次" :bordered="false">
                <!-- Excel 批次搜索：按文件名/UID/路径前端过滤 -->
                <NSpace align="center" style="margin-bottom: 12px">
                  <NInput
                    v-model:value="excelBatchSearch"
                    placeholder="搜索 Excel 批次：文件名 / UID / 路径"
                    clearable
                    style="width: 320px"
                  />
                  <span v-if="excelBatchSearch" class="tab-hint">
                    {{ filteredExcelBatches.length }} / {{ excelBatches.length }} 个批次
                  </span>
                </NSpace>
                <NDataTable
                  :columns="excelBatchColumns"
                  :data="filteredExcelBatches"
                  :loading="excelBatchesLoading"
                  :bordered="false"
                  :single-line="false"
                  size="small"
                  :pagination="{ pageSize: 20 }"
                />
              </NCard>
            </NSpace>
          </NTabPane>

          <!-- 作者管理 -->
          <NTabPane name="authors" tab="作者管理">
            <NSpace vertical :size="12">
              <div class="author-toolbar">
                <NInput
                  v-model:value="authorSearch"
                  placeholder="按名称或 UID 搜索作者..."
                  clearable
                  style="flex: 1"
                >
                  <template #prefix>
                    <span style="opacity: 0.5">🔍</span>
                  </template>
                </NInput>
                <NButton
                  :type="batchMode ? 'primary' : 'default'"
                  @click="toggleBatchMode"
                >
                  {{ batchMode ? '退出批量' : '批量管理' }}
                </NButton>
                <NPopconfirm
                  v-if="batchMode && checkedCount > 0"
                  @positive-click="onBatchDeleteAuthors"
                >
                  <template #trigger>
                    <NButton type="error" :disabled="checkedCount === 0">
                      删除选中 ({{ checkedCount }})
                    </NButton>
                  </template>
                  确认删除选中的 {{ checkedCount }} 个作者？
                </NPopconfirm>
              </div>
              <NCard :bordered="false">
                <NDataTable
                  :columns="authorColumns"
                  :data="filteredAuthors"
                  :loading="authorsLoading"
                  :bordered="false"
                  :single-line="false"
                  size="small"
                  :pagination="{ pageSize: 20 }"
                  :row-key="(row: AuthorWithCount) => row.id!"
                />
              </NCard>
            </NSpace>
          </NTabPane>
        </NTabs>
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.import-manager {
  height: 100%;
  width: 100%;
  background: #18181c;
  color: #e8e8e8;
}
.import-manager :deep(.n-card) {
  background-color: rgba(255, 255, 255, 0.04);
}
.page {
  padding: 16px 18px 32px;
  max-width: 1200px;
  margin: 0 auto;
}
.header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #e8e8e8;
}
.root-path {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.root-path .label {
  color: #999;
  flex-shrink: 0;
}
.root-path .value {
  color: #e8e8e8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.progress-msg {
  font-size: 13px;
  color: #ccc;
}
.progress-detail {
  font-size: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.detail-label {
  color: #777;
  flex-shrink: 0;
}
.detail-value {
  color: #bbb;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.progress-file .detail-value {
  color: #ff8559;
  font-family: monospace;
  font-size: 11px;
}
.progress-stats {
  display: flex;
  gap: 32px;
  justify-content: space-around;
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  margin-top: 4px;
}
.author-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
}
.tab-hint {
  font-size: 12px;
  color: #ff8559;
  background: rgba(255, 107, 53, 0.08);
  border: 1px solid rgba(255, 107, 53, 0.2);
  padding: 8px 12px;
  border-radius: 6px;
}
</style>
