import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  getWorks,
  getFilesByWorks,
  getAuthors,
  getTopics,
  getHiddenTags,
  getCollectionChildren,
  getWorkIdsForPlaylist as getWorkIdsForPlaylistDb,
  getWorksDataGeneration,
} from "@/api/db";
import { getFavoriteWorkIds } from "@/services/favorites";
import { getWatchLaterWorkIds } from "@/services/watch-later";
import type { AuthorRow, WorkWithFiles, FileRow } from "@/types";

export type CategoryFilter = "all" | "视频" | "图集" | "实况" | "favorite" | "watch-later";

export const useWorksStore = defineStore("works", () => {
  const works = ref<WorkWithFiles[]>([]);
  const total = ref<number>(0);
  const loading = ref<boolean>(false);
  const loadingMore = ref<boolean>(false);
  const limit = ref<number>(100);
  const offset = ref<number>(0);

  const authors = ref<AuthorRow[]>([]);
  const tags = ref<{ name: string; count: number }[]>([]);
  const hiddenTags = ref<{ name: string; count: number }[]>([]);
  // 标签总数（含未载入的低频标签，用于侧边栏徽标；tags/hiddenTags 仅保留有界的高频子集）
  const tagsTotal = ref<number>(0);
  const hiddenTagsTotal = ref<number>(0);
  // 集合作者（枫临的收藏/枫临的喜欢）下的原始作者列表，用于侧边栏展开显示子项
  const collectionChildren = ref<
    {
      collectionAuthorId: number;
      collectionAuthorUid: string;
      collectionAuthorName: string;
      originalAuthor: string;
      sourceType: string;
      count: number;
    }[]
  >([]);

  const filterAuthorUids = ref<string[]>([]);
  const filterCategory = ref<CategoryFilter>("all");
  const keyword = ref<string>("");
  const filterTags = ref<string[]>([]);
  const filterHiddenTags = ref<string[]>([]);
  // 按 original_author 筛选（用于集合作者展开后点击子项精确筛选某原始作者的作品）
  const filterOriginalAuthor = ref<string>("");

  const hasFilter = computed(
    () =>
      filterAuthorUids.value.length > 0 ||
      filterCategory.value !== "all" ||
      !!keyword.value ||
      filterTags.value.length > 0 ||
      filterHiddenTags.value.length > 0 ||
      !!filterOriginalAuthor.value
  );

  const hasMore = computed(() => works.value.length < total.value);

  function clearFilters(): void {
    filterAuthorUids.value = [];
    filterCategory.value = "all";
    keyword.value = "";
    filterTags.value = [];
    filterHiddenTags.value = [];
    filterOriginalAuthor.value = "";
  }

  function clearTagFilter(): void {
    filterTags.value = [];
  }

  function clearHiddenTagFilter(): void {
    filterHiddenTags.value = [];
  }

  function toggleAuthor(uid: string): void {
    if (uid === "") {
      filterAuthorUids.value = [];
      filterOriginalAuthor.value = "";
      return;
    }
    const idx = filterAuthorUids.value.indexOf(uid);
    if (idx >= 0) {
      filterAuthorUids.value.splice(idx, 1);
    } else {
      filterAuthorUids.value.push(uid);
    }
    // 切换作者时清除 original_author 筛选
    filterOriginalAuthor.value = "";
  }

  /**
   * 点击集合作者的子项（如"千寻-收藏"）：
   * 设置筛选为指定集合作者 + 指定原始作者。
   * 再次点击同一子项时取消筛选。
   */
  function toggleCollectionChild(collectionUid: string, originalAuthor: string): void {
    if (filterAuthorUids.value.length === 1 &&
        filterAuthorUids.value[0] === collectionUid &&
        filterOriginalAuthor.value === originalAuthor) {
      // 取消筛选
      filterAuthorUids.value = [];
      filterOriginalAuthor.value = "";
    } else {
      filterAuthorUids.value = [collectionUid];
      filterOriginalAuthor.value = originalAuthor;
    }
  }

  function toggleTag(t: string): void {
    const idx = filterTags.value.indexOf(t);
    if (idx >= 0) {
      filterTags.value.splice(idx, 1);
    } else {
      filterTags.value.push(t);
    }
  }

  function toggleHiddenTag(t: string): void {
    const idx = filterHiddenTags.value.indexOf(t);
    if (idx >= 0) {
      filterHiddenTags.value.splice(idx, 1);
    } else {
      filterHiddenTags.value.push(t);
    }
  }

  async function loadAuthors(): Promise<void> {
    authors.value = await getAuthors();
  }

  /**
   * 加载普通标签（高频前 N，keyword 时为 SQL 端全量匹配的前 N）。
   * 返回行数有界：走 tag_counts 物化表，不再把 20 万+ 标签全量放进响应式数组。
   */
  async function loadTags(keyword?: string, limit?: number): Promise<void> {
    const { items, total } = await getTopics({ keyword, limit });
    tags.value = items;
    tagsTotal.value = total;
  }

  /** 加载隐藏标签（同 loadTags） */
  async function loadHiddenTags(keyword?: string, limit?: number): Promise<void> {
    const { items, total } = await getHiddenTags({ keyword, limit });
    hiddenTags.value = items;
    hiddenTagsTotal.value = total;
  }

  async function loadCollectionChildren(): Promise<void> {
    collectionChildren.value = await getCollectionChildren();
  }

  function buildWorkWithFiles(
    rows: any[],
    allFiles: FileRow[]
  ): WorkWithFiles[] {
    const filesByWorkId = new Map<number, FileRow[]>();
    for (const f of allFiles) {
      const arr = filesByWorkId.get(f.work_id) ?? [];
      arr.push(f);
      filesByWorkId.set(f.work_id, arr);
    }
    // 作者按 id 建 Map：旧版每作品 authors.find() 线性扫 6543 作者 × 100 作品 = 65 万次迭代
    const authorById = new Map<number, AuthorRow>();
    for (const a of authors.value) {
      if (a.id != null) authorById.set(a.id, a);
    }
    const result: WorkWithFiles[] = [];
    for (const w of rows) {
      const files = filesByWorkId.get(w.id) ?? [];
      const topicTags: string[] = [];
      if (w.topics) {
        w.topics.split(/\s+/).forEach((t: string) => {
          const tag = t.replace(/^#/, "").trim();
          if (tag) topicTags.push(tag);
        });
      }
      const hiddenTagList: string[] = [];
      if (w.hidden_tags) {
        w.hidden_tags.split(/\s+/).forEach((t: string) => {
          const tag = t.replace(/^#/, "").trim();
          if (tag) hiddenTagList.push(tag);
        });
      }
      const author = authorById.get(w.author_id);
      // 集合作者的作品（收藏/喜欢）若 original_author 为空，从文件名中提取原始作者名
      // 文件名格式: YYYY-MM-DD HH.MM.SS-类型-作者名-标题#标签_序号.扩展名
      if (!w.original_author && w.source_type && files.length > 0) {
        const m = files[0].filename.match(/^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}-[^-]+-([^-]+)-/);
        if (m && m[1]) {
          w.original_author = m[1];
        }
      }
      result.push({
        work: w,
        author,
        files,
        tags: topicTags,
        hiddenTags: hiddenTagList,
      });
    }
    return result;
  }

  // 查询版本守卫：筛选条件快速连续变化时，旧查询结果返回后不得覆盖新结果
  // （大库上筛选查询需 ~1s，连点作者/标签会叠多个在途查询，晚归的旧结果会闪回错误内容）
  let querySeq = 0;
  // 防抖定时器：侧边栏连续点击合并为一次查询
  let loadWorksTimer: number | null = null;

  // ===== 筛选列表快照缓存 =====
  // 全部作者 ↔ 作者/标签 来回切换时即时恢复已加载列表：WorkCard 按 work.id 复用组件，
  // 封面（含视频首帧）不再重载；标签等选择性筛选的 NOT INDEXED 查询（~1s）也一并跳过。
  // 快照携带数据代数（works 增删改时 +1），过期自动失效；收藏/稍后再看依赖可变 id 集合，不缓存。
  const LIST_CACHE_MAX = 6;
  const listCache = new Map<string, { gen: number; works: WorkWithFiles[]; total: number }>();

  function filterCacheKey(): string | null {
    if (filterCategory.value === "favorite" || filterCategory.value === "watch-later") return null;
    return JSON.stringify([
      filterAuthorUids.value,
      filterCategory.value,
      keyword.value,
      filterTags.value,
      filterHiddenTags.value,
      filterOriginalAuthor.value,
    ]);
  }

  function stashListSnapshot(key: string | null): void {
    if (!key) return;
    if (listCache.size >= LIST_CACHE_MAX) {
      const oldest = listCache.keys().next().value;
      if (oldest !== undefined) listCache.delete(oldest);
    }
    listCache.set(key, { gen: getWorksDataGeneration(), works: works.value, total: total.value });
  }

  /** 防抖版 loadWorks：侧边栏筛选点击用（连续切换作者/标签时只发起最后一次查询） */
  function scheduleLoadWorks(delayMs = 150): void {
    if (loadWorksTimer !== null) window.clearTimeout(loadWorksTimer);
    loadWorksTimer = window.setTimeout(() => {
      loadWorksTimer = null;
      void loadWorks();
    }, delayMs);
  }

  async function loadWorks(): Promise<void> {
    const seq = ++querySeq;
    loading.value = true;
    offset.value = 0;
    const t0 = Date.now();
    try {
      // 快照缓存命中：同一筛选条件且数据未变更 → 即时恢复（跳过查询/文件加载/卡片重建）
      const cacheKey = filterCacheKey();
      if (cacheKey) {
        const snap = listCache.get(cacheKey);
        if (snap && snap.gen === getWorksDataGeneration()) {
          works.value = snap.works;
          total.value = snap.total;
          offset.value = snap.works.length;
          console.log(`[作品查询] ${Date.now() - t0}ms（快照缓存）| ${snap.works.length}行/共${snap.total}`);
          return;
        }
      }

      let filterWorkIds: number[] | undefined;
      const isSpecialCategory = filterCategory.value === "favorite" || filterCategory.value === "watch-later";

      if (filterCategory.value === "favorite") {
        filterWorkIds = await getFavoriteWorkIds();
      } else if (filterCategory.value === "watch-later") {
        filterWorkIds = await getWatchLaterWorkIds();
      }

      const workType =
        filterCategory.value === "all" || isSpecialCategory
          ? undefined
          : filterCategory.value;

      if (isSpecialCategory && (!filterWorkIds || filterWorkIds.length === 0)) {
        total.value = 0;
        works.value = [];
        offset.value = 0;
        return;
      }

      // 作者 uid → id 解析（内存 Map）：让 getWorks 走 idx_works_author 索引（毫秒级），
      // 解析不到的 uid 走 authorUids 兜底路径（EXISTS，罕见）
      const uidToId = new Map<string, number>();
      for (const a of authors.value) {
        if (a.id != null) uidToId.set(a.uid, a.id);
      }
      const authorIds: number[] = [];
      const authorUidsFallback: string[] = [];
      for (const uid of filterAuthorUids.value) {
        const id = uidToId.get(uid);
        if (id != null) authorIds.push(id);
        else authorUidsFallback.push(uid);
      }

      const { rows, total: t } = await getWorks({
        authorIds: authorIds.length ? authorIds : undefined,
        authorUids: authorUidsFallback.length ? authorUidsFallback : undefined,
        workType,
        keyword: keyword.value || undefined,
        tags: filterTags.value.length ? filterTags.value : undefined,
        hiddenTags: filterHiddenTags.value.length ? filterHiddenTags.value : undefined,
        workIds: isSpecialCategory ? filterWorkIds : undefined,
        originalAuthor: filterOriginalAuthor.value || undefined,
        limit: limit.value,
        offset: 0,
      });
      if (seq !== querySeq) return; // 已有更新的筛选，丢弃过期结果
      total.value = t;

      const tFiles = Date.now();
      const workIds = rows.map((w) => w.id);
      const allFiles = await getFilesByWorks(workIds);
      if (seq !== querySeq) return;
      const tBuild = Date.now();
      works.value = buildWorkWithFiles(rows, allFiles);
      offset.value = works.value.length;
      stashListSnapshot(cacheKey);
      // 耗时日志：定位筛选点击卡顿（查询=DB检索IPC，文件=files查询IPC，构建=内存组装）
      console.log(
        `[作品查询] ${Date.now() - t0}ms（查询${tFiles - t0}/文件${tBuild - tFiles}/构建${Date.now() - tBuild}）` +
          `| 作者${authorIds.length || authorUidsFallback.length} 标签${filterTags.value.length}/${filterHiddenTags.value.length}` +
          ` 类型${workType ?? "-"} 关键字${keyword.value || "-"} | ${rows.length}行/共${t}`
      );
    } finally {
      if (seq === querySeq) loading.value = false;
    }
  }

  async function loadMoreWorks(): Promise<void> {
    if (loadingMore.value || loading.value) return;
    if (!hasMore.value) return;
    const isSpecialCategory = filterCategory.value === "favorite" || filterCategory.value === "watch-later";
    if (isSpecialCategory) return;
    const seq = querySeq;
    loadingMore.value = true;
    try {
      const workType =
        filterCategory.value === "all" ? undefined : filterCategory.value;
      // 与 loadWorks 相同的 uid→id 解析，保证翻页查询与首页查询走同样的索引路径
      const uidToId = new Map<string, number>();
      for (const a of authors.value) {
        if (a.id != null) uidToId.set(a.uid, a.id);
      }
      const authorIds: number[] = [];
      const authorUidsFallback: string[] = [];
      for (const uid of filterAuthorUids.value) {
        const id = uidToId.get(uid);
        if (id != null) authorIds.push(id);
        else authorUidsFallback.push(uid);
      }
      const { rows } = await getWorks({
        authorIds: authorIds.length ? authorIds : undefined,
        authorUids: authorUidsFallback.length ? authorUidsFallback : undefined,
        workType,
        keyword: keyword.value || undefined,
        tags: filterTags.value.length ? filterTags.value : undefined,
        hiddenTags: filterHiddenTags.value.length ? filterHiddenTags.value : undefined,
        originalAuthor: filterOriginalAuthor.value || undefined,
        limit: limit.value,
        offset: offset.value,
      });
      if (seq !== querySeq) return; // 期间发生了新的 loadWorks，丢弃本次追加
      const workIds = rows.map((w) => w.id);
      const allFiles = await getFilesByWorks(workIds);
      if (seq !== querySeq) return;
      const moreWorks = buildWorkWithFiles(rows, allFiles);
      works.value = [...works.value, ...moreWorks];
      offset.value = works.value.length;
      // 翻页后刷新当前筛选的快照（保持缓存与已加载列表一致，切回时恢复全部已加载页）
      stashListSnapshot(filterCacheKey());
    } finally {
      if (seq === querySeq) loadingMore.value = false;
    }
  }

  const refreshing = ref<boolean>(false);

  async function refreshAll(): Promise<void> {
    if (refreshing.value) return;
    refreshing.value = true;
    try {
      await Promise.all([loadAuthors(), loadTags(), loadHiddenTags(), loadCollectionChildren()]);
      await loadWorks();
    } finally {
      refreshing.value = false;
    }
  }

  /**
   * 轻量作品 id 池（沉浸式模式的随机抽取源）：仅 id 数组，百万作品 ~8MB。
   * 替代旧的全量加载（limit 999999 拉全部作品+文件对象导致 WebView OOM）。
   */
  async function getWorkIdsForPlaylist(): Promise<number[]> {
    return getWorkIdsForPlaylistDb();
  }

  /**
   * 按 id 拉取作品详情（含文件），用于沉浸式模式按需加载队列中的作品。
   * ids 为 10-20 个的批量（内存有界），按 publish_time 倒序返回。
   */
  async function getWorksByIdsForPlaylist(ids: number[]): Promise<WorkWithFiles[]> {
    if (ids.length === 0) return [];
    const { rows } = await getWorks({ workIds: ids, limit: ids.length });
    if (rows.length === 0) return [];
    const allFiles = await getFilesByWorks(rows.map((w) => w.id));
    return buildWorkWithFiles(rows, allFiles);
  }

  return {
    works,
    total,
    loading,
    loadingMore,
    refreshing,
    limit,
    offset,
    hasMore,
    authors,
    tags,
    hiddenTags,
    tagsTotal,
    hiddenTagsTotal,
    collectionChildren,
    filterAuthorUids,
    filterCategory,
    keyword,
    filterTags,
    filterHiddenTags,
    filterOriginalAuthor,
    hasFilter,
    clearFilters,
    clearTagFilter,
    clearHiddenTagFilter,
    toggleAuthor,
    toggleCollectionChild,
    toggleTag,
    toggleHiddenTag,
    loadAuthors,
    loadTags,
    loadHiddenTags,
    loadCollectionChildren,
    loadWorks,
    scheduleLoadWorks,
    loadMoreWorks,
    refreshAll,
    getWorkIdsForPlaylist,
    getWorksByIdsForPlaylist,
  };
});
