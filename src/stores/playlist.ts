import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { WorkWithFiles } from "@/types";

const STORAGE_KEY = "immersive-playlist-state";

interface PersistedState {
  /** 当前播放队列的作品 id（量小：约 10-20 个，随播放滚动更新） */
  playlistWorkIds: number[];
  currentIndex: number;
}

/** 按需从作品 id 拉取详情（含文件）的加载器，由 BrowseView 注入（避免 store 直接依赖 works store） */
type WorkLoader = (ids: number[]) => Promise<WorkWithFiles[]>;

/**
 * 刷抖音模式播放列表状态管理（内存有界版）
 *
 * 核心逻辑：
 * - 抽取源是轻量 id 池（百万作品仅 ~8MB 的 number 数组，非响应式存储）
 * - 进入模式时对 id 池洗牌一次，按游标顺序取 10 个并从 DB 按需拉取作品详情
 * - 向下滑动按列表顺序播放下一项，剩余 ≤ 3 时自动追加 10 个（游标推进，天然不重复）
 * - 退出时仅持久化当前队列 id + 进度（量小），再次进入时恢复并从池中剔除已入队 id
 *
 * 历史版本把全部作品+文件对象加载进内存作为抽取源，百万作品时 WebView 直接 OOM。
 */
export const usePlaylistStore = defineStore("playlist", () => {
  // 播放队列（有序列表，仅包含当前窗口内 ~10-20 个作品对象）
  const playlist = ref<WorkWithFiles[]>([]);
  const currentIndex = ref<number>(0);
  // 是否已抽完所有作品（停止后续追加）
  const noMoreToAppend = ref<boolean>(false);

  // ---- 非响应式状态：百万级 id 数组避免 Vue 深度代理的内存放大 ----
  // 原始 id 池快照（restoreState 重新洗牌时使用）
  let allIdsSnapshot: number[] = [];
  // 洗牌后的 id 顺序 + 游标（下一个待抽取位置）
  let shuffledIds: number[] = [];
  let cursor = 0;
  // 详情加载器（initPlaylist 前由 setLoader 注入）
  let workLoader: WorkLoader | null = null;
  // 追加防重入
  let appending = false;

  // 当前作品
  const currentWork = computed<WorkWithFiles | null>(
    () => playlist.value[currentIndex.value] ?? null
  );
  // 剩余未播放数量（当前索引到列表末尾）
  const remaining = computed<number>(() =>
    Math.max(0, playlist.value.length - currentIndex.value - 1)
  );

  /** 注入作品详情加载器 */
  function setLoader(loader: WorkLoader): void {
    workLoader = loader;
  }

  /** Fisher-Yates 洗牌 */
  function shuffle<T>(arr: T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * 设置抽取源 id 池并洗牌（排除 excludeIds，用于恢复状态后避免队列内作品重复出现）
   */
  function setSourceIds(ids: number[], excludeIds?: Set<number>): void {
    const source =
      excludeIds && excludeIds.size > 0 ? ids.filter((id) => !excludeIds.has(id)) : ids;
    shuffledIds = shuffle(source);
    cursor = 0;
    noMoreToAppend.value = false;
  }

  /** 从洗牌池取下一批 count 个 id（游标推进） */
  function takeNextIds(count: number): number[] {
    if (cursor >= shuffledIds.length) return [];
    const ids = shuffledIds.slice(cursor, cursor + count);
    cursor += ids.length;
    return ids;
  }

  /** 按需加载作品详情并追加到队列末尾 */
  async function appendMore(): Promise<void> {
    if (noMoreToAppend.value || appending || !workLoader) return;
    appending = true;
    try {
      const ids = takeNextIds(10);
      if (ids.length === 0) {
        noMoreToAppend.value = true;
        return;
      }
      const works = await workLoader(ids);
      if (works.length === 0) {
        noMoreToAppend.value = true;
        return;
      }
      playlist.value = [...playlist.value, ...works];
      saveState();
    } finally {
      appending = false;
    }
  }

  /** 检查剩余数量，不足 3 个时自动追加（fire-and-forget，内部防重入） */
  function checkAndAppend(): void {
    if (noMoreToAppend.value) return;
    if (remaining.value <= 3) {
      void appendMore();
    }
  }

  /** 初始化播放列表：重新洗牌抽取 10 个作品，清空历史状态 */
  async function initPlaylist(): Promise<void> {
    shuffledIds = shuffle(shuffledIds);
    cursor = 0;
    playlist.value = [];
    currentIndex.value = 0;
    noMoreToAppend.value = false;
    await appendMore();
  }

  /** 设置当前索引并保存状态、检查追加 */
  function setCurrentIndex(val: number): void {
    if (val < 0 || val >= playlist.value.length) return;
    currentIndex.value = val;
    saveState();
    checkAndAppend();
  }

  /** 向后移动（向下滑动） */
  function goNext(): boolean {
    if (currentIndex.value >= playlist.value.length - 1) return false;
    setCurrentIndex(currentIndex.value + 1);
    return true;
  }

  /** 向前移动（向上滑动） */
  function goPrev(): boolean {
    if (currentIndex.value <= 0) return false;
    setCurrentIndex(currentIndex.value - 1);
    return true;
  }

  /** 保存状态到 localStorage（仅队列 id + 进度，量小不超配额） */
  function saveState(): void {
    try {
      const state: PersistedState = {
        playlistWorkIds: playlist.value.map((w) => w.work.id),
        currentIndex: currentIndex.value,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("[playlist] 保存状态失败:", e);
    }
  }

  /**
   * 从 localStorage 恢复状态：拉取队列作品详情重建 playlist，
   * 并把已入队 id 从抽取池剔除（保证本次会话内不重复出现）
   * @returns 是否成功恢复（playlist 非空才算成功）
   */
  async function restoreState(): Promise<boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw || !workLoader) return false;
      const state = JSON.parse(raw) as PersistedState;
      if (!Array.isArray(state.playlistWorkIds) || state.playlistWorkIds.length === 0) {
        return false;
      }

      const works = await workLoader(state.playlistWorkIds);
      if (works.length === 0) return false;
      // 按持久化顺序重建（loader 返回顺序可能不同）
      const workMap = new Map(works.map((w) => [w.work.id, w]));
      const restored: WorkWithFiles[] = [];
      for (const id of state.playlistWorkIds) {
        const w = workMap.get(id);
        if (w) restored.push(w);
      }
      if (restored.length === 0) return false;

      playlist.value = restored;
      currentIndex.value = Math.min(state.currentIndex, restored.length - 1);
      // 已入队的 id 从抽取池剔除（本次会话不重复）
      setSourceIds(allIdsSnapshot, new Set(state.playlistWorkIds));
      return true;
    } catch (e) {
      console.warn("[playlist] 恢复状态失败:", e);
      return false;
    }
  }

  /** 设置抽取源（对外主入口）：同时保留原始快照供恢复时重新洗牌 */
  function setAllIds(ids: number[]): void {
    allIdsSnapshot = ids;
    setSourceIds(ids);
  }

  /** 清除状态（重置播放列表） */
  function clearState(): void {
    playlist.value = [];
    currentIndex.value = 0;
    noMoreToAppend.value = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  return {
    playlist,
    currentIndex,
    currentWork,
    remaining,
    noMoreToAppend,
    setLoader,
    setAllIds,
    initPlaylist,
    appendMore,
    checkAndAppend,
    setCurrentIndex,
    goNext,
    goPrev,
    saveState,
    restoreState,
    clearState,
  };
});
