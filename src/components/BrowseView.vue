<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import VideoPlayer from "./VideoPlayer.vue";
import GalleryViewer from "./GalleryViewer.vue";
import LiveViewer from "./LiveViewer.vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  saveProgress,
  getProgress,
  type BrowseMode,
  type ContentType,
} from "@/services/progress";
import { toggleFavorite, isFavorite } from "@/services/favorites";
import { toggleWatchLater, isWatchLater } from "@/services/watch-later";
import { usePlaylistStore } from "@/stores/playlist";
import { useWorksStore } from "@/stores/works";
import type { WorkWithFiles } from "@/types";

export type PlayMode = 'off' | 'sequential' | 'reverse' | 'loop' | 'random';

const props = defineProps<{
  works: WorkWithFiles[];
  initialIndex?: number;
  mode?: BrowseMode;
  visible?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "index-change", index: number): void;
}>();

const mode = computed<BrowseMode>(() => props.mode ?? "click");
const playlistStore = usePlaylistStore();
const worksStore = useWorksStore();

// 当前播放列表：沉浸式模式使用 playlist store 管理的有序队列，点击模式使用 props.works
// 隐藏时冻结列表，避免主页筛选导致 videoSrc 变化触发隐藏的播放器加载/播放声音
const frozenWorks = ref<WorkWithFiles[]>([]);

watch(
  () => props.visible,
  (visible) => {
    if (visible && mode.value !== 'immersive') {
      frozenWorks.value = [...props.works];
    }
  },
  { immediate: true }
);

const playlist = computed<WorkWithFiles[]>(() => {
  if (mode.value === 'immersive') return playlistStore.playlist;
  if (props.visible === false) return frozenWorks.value;
  return props.works;
});

// 当前播放索引（本地 UI 状态，沉浸式模式下与 store 同步）
const currentIndex = ref<number>(0);

// 当前作品
const currentWork = computed<WorkWithFiles | null>(() => {
  if (currentIndex.value < 0 || currentIndex.value >= playlist.value.length) return null;
  return playlist.value[currentIndex.value];
});

function detectContentType(work: WorkWithFiles): ContentType {
  const hasImages = work.files.some((f) => IMAGE_EXTS.has((f.extension || "").toLowerCase()));
  const hasVideos = work.files.some((f) => VIDEO_EXTS.has((f.extension || "").toLowerCase()));

  if (hasImages && hasVideos) {
    return "gallery";
  }
  if (hasImages) {
    return "gallery";
  }
  if (hasVideos) {
    const wt = work.work.work_type;
    return wt === "实况" ? "live" : "video";
  }
  return "video";
}

const contentType = computed<ContentType | null>(() => {
  if (!currentWork.value) return null;
  return detectContentType(currentWork.value);
});

// 图片扩展名集合
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "jfif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v", "flv"]);

// 图集图片列表
const galleryImages = computed<string[]>(() => {
  if (!currentWork.value) return [];
  return currentWork.value.files
    .filter((f) => {
      const ext = (f.extension || "").toLowerCase();
      return IMAGE_EXTS.has(ext);
    })
    .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999))
    .map((f) => f.absolute_path);
});

// 视频/实况文件路径
const videoSrc = computed<string>(() => {
  if (!currentWork.value) return "";
  const files = currentWork.value.files;
  const v = files.find((f) => VIDEO_EXTS.has((f.extension || "").toLowerCase()));
  return v?.absolute_path ?? files[0]?.absolute_path ?? "";
});

// 初始进度（从存储中读取，沉浸式模式持久化，点击模式仅会话内）
const initialProgress = ref<number | undefined>(undefined);
const initialGalleryIndex = ref<number | undefined>(undefined);

// UI 状态
const isTransitioning = ref<boolean>(false);
// 初始化阶段标志：沉浸式模式重新进入时禁用 slide 过渡，避免从空状态滑入到恢复的作品
const isInitializing = ref<boolean>(true);
const isFavoriteWork = ref<boolean>(false); // 当前作品是否收藏
const isWatchLaterWork = ref<boolean>(false); // 当前作品是否稍后再看

// 播放器设置状态（跨视频保持）
const volume = ref<number>(1);
const isMuted = ref<boolean>(false);
const lastVolume = ref<number>(1);
const playbackRate = ref<number>(1.0);
const clearMode = ref<boolean>(false);
const playMode = ref<PlayMode>('loop');
const galleryViewerRef = ref<InstanceType<typeof GalleryViewer> | null>(null);

// 清屏模式下的UI悬停显示状态
const hoverShowTop = ref<boolean>(false);
const hoverShowRight = ref<boolean>(false);
// 初始为 true：首次打开时控制栏可见，鼠标移开后隐藏（靠近显示）
const hoverShowBottom = ref<boolean>(true);

// 详细信息面板展开状态（需在 clearStyle 计算属性之前声明，后者会引用此状态）
const showDetailPanel = ref<boolean>(false);
// 作品链接展开状态（太长时折叠，点击展开显示全部）
const workUrlExpanded = ref<boolean>(false);

// 最后记录的鼠标位置（用于切换作品后立即更新hover状态）
let lastMouseX = 0;
let lastMouseY = 0;

// 鼠标移动检测：清屏模式下靠近边缘显示对应模块
// 各模块独立的感应阈值（像素）
const topThreshold = 60;    // 顶部栏感应范围
const rightThreshold = 100; // 右侧操作栏感应范围
const bottomThreshold = 80; // 底部信息栏/控制栏感应范围

function onMouseMove(e: MouseEvent) {
  if (props.visible === false) return;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  // 始终更新 hover 状态：底部控制栏在所有模式下均使用靠近显示
  updateHoverShow();
}

function updateHoverShow(): void {
  hoverShowTop.value = lastMouseY < topThreshold;
  hoverShowRight.value = lastMouseX > window.innerWidth - rightThreshold;
  hoverShowBottom.value = lastMouseY > window.innerHeight - bottomThreshold;
}

// 清屏模式下使用内联样式直接控制 opacity/pointer-events/transform/transition
// 内联样式优先级最高（仅 !important 可覆盖），彻底绕过 CSS 类选择器特异性与 scoped 问题
const topBarClearStyle = computed<Record<string, string>>(() => {
  if (!clearMode.value) return {} as Record<string, string>;
  const show = hoverShowTop.value;
  return {
    opacity: show ? '1' : '0',
    pointerEvents: show ? 'auto' : 'none',
    transform: show ? 'translateY(0px)' : 'translateY(-8px)',
    transition: 'opacity 0.35s ease, transform 0.35s ease'
  };
});

const sideActionsClearStyle = computed<Record<string, string>>(() => {
  if (!clearMode.value) return {} as Record<string, string>;
  const show = hoverShowRight.value;
  return {
    opacity: show ? '1' : '0',
    pointerEvents: show ? 'auto' : 'none',
    transform: show ? 'translateX(0px)' : 'translateX(12px)',
    transition: 'opacity 0.35s ease, transform 0.35s ease'
  };
});

const bottomInfoClearStyle = computed<Record<string, string>>(() => {
  if (!clearMode.value) return {} as Record<string, string>;
  // 详细面板展开时强制保持显示，避免鼠标移开后底部信息栏隐藏导致按钮无法点击
  const show = hoverShowBottom.value || showDetailPanel.value;
  return {
    opacity: show ? '1' : '0',
    pointerEvents: show ? 'auto' : 'none',
    transform: show ? 'translateY(0px)' : 'translateY(10px)',
    transition: 'opacity 0.35s ease, transform 0.35s ease'
  };
});

let wheelLock = false;
let touchStartY = 0;
let touchStartX = 0;
let touchStartT = 0;

// 标题/作者信息
const workTitle = computed<string>(() => currentWork.value?.work.title || "(无标题)");
// 集合作者的作品（收藏/喜欢）显示原始作者名（如 "千寻-收藏"），而非集合作者名（如 "枫临的收藏"）
const authorName = computed<string>(() => {
  if (!currentWork.value) return "";
  const w = currentWork.value.work;
  if (w.original_author) {
    const shortType = w.source_type ? w.source_type.replace(/作品$/, "") : "";
    // 只有收藏/喜欢作品才显示 "作者-类型" 格式，发布作品直接显示作者名
    if (shortType === "收藏" || shortType === "喜欢") {
      return `${w.original_author}-${shortType}`;
    }
    return w.original_author;
  }
  return currentWork.value.author?.name ?? "";
});

// 标签
const tagsDisplay = computed<string>(() => {
  if (!currentWork.value) return "";
  const tags = [...(currentWork.value.tags || []), ...(currentWork.value.hiddenTags || [])];
  return tags.map((t) => `#${t}`).join(" ");
});

// 是否有上一个/下一个
const hasPrev = computed<boolean>(() => currentIndex.value > 0);
const hasNext = computed<boolean>(() => currentIndex.value < playlist.value.length - 1);

// 自动连播方向：1=向下（默认），-1=向上
const autoPlayDirection = ref<1 | -1>(1);

// ---- 详细信息面板：辅助函数 ----

function toggleDetailPanel(): void {
  showDetailPanel.value = !showDetailPanel.value;
}

/** 格式化 Unix 秒级时间戳为本地时间字符串 */
function formatTimestamp(ts: number | null | undefined): string {
  if (!ts || ts <= 0) return "-";
  try {
    return new Date(ts * 1000).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

/** 格式化视频时长（秒 → mm:ss 或 hh:mm:ss） */
function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !isFinite(seconds)) return "-";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 格式化数字（添加千位分隔符） */
function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n.toLocaleString("zh-CN");
}

/** 打开作品链接（Excel L 列 download_url） */
async function openWorkUrl(): Promise<void> {
  const w = currentWork.value?.work;
  if (!w?.download_url) return;
  try {
    await openUrl(w.download_url);
  } catch (e) {
    console.warn("[BrowseView] 打开作品链接失败:", e);
  }
}

/** 打开作者主页（https://www.douyin.com/user/{sec_uid}） */
async function openAuthorUrl(): Promise<void> {
  const w = currentWork.value?.work;
  if (!w?.sec_uid) return;
  try {
    await openUrl(`https://www.douyin.com/user/${w.sec_uid}`);
  } catch (e) {
    console.warn("[BrowseView] 打开作者主页失败:", e);
  }
}

/** 作品类型显示：根据媒体文件检测的实际类型（视频/图集/实况） */
const sourceTypeDisplay = computed<string>(() => {
  const ct = contentType.value;
  if (!ct) return "-";
  switch (ct) {
    case "video": return "视频";
    case "gallery": return "图集";
    case "live": return "实况";
    default: return "-";
  }
});

/** 详细面板用的作者名（不带"收藏/喜欢"后缀，纯显示原始作者名） */
const detailAuthorName = computed<string>(() => {
  if (!currentWork.value) return "-";
  const w = currentWork.value.work;
  // 优先使用 original_author（收藏/喜欢作品的原始作者；Excel O 列对应值）
  if (w.original_author) return w.original_author;
  // 退回到文件夹作者名（发布作品的 Excel O 列对应值）
  return currentWork.value.author?.name ?? "-";
});

/** 当前作品链接（Excel L 列 download_url） */
const workUrl = computed<string>(() => currentWork.value?.work.download_url ?? "");

/** 作品链接是否过长（超过 60 字符视为长链接，需要折叠） */
const workUrlLong = computed<boolean>(() => workUrl.value.length > 60);

/** 折叠状态下显示的截断链接 */
const workUrlTruncated = computed<string>(() => {
  const url = workUrl.value;
  if (url.length <= 60) return url;
  // 显示前 40 + ... + 后 15，保留首尾可识别信息
  return `${url.slice(0, 40)}...${url.slice(-15)}`;
});

// ---- 进度恢复 ----
async function loadProgressForCurrent(): Promise<void> {
  if (!currentWork.value || !contentType.value) {
    initialProgress.value = undefined;
    initialGalleryIndex.value = undefined;
    return;
  }
  // 沉浸式模式不加载内容播放进度（仅保存"看到了哪个作品"，不保存视频/图集/实况进度）
  if (mode.value === 'immersive') {
    initialProgress.value = undefined;
    initialGalleryIndex.value = undefined;
    return;
  }
  try {
    const rec = await getProgress(currentWork.value.work.id, contentType.value, mode.value);
    if (rec) {
      if (contentType.value === "gallery") {
        initialGalleryIndex.value = Math.max(0, Math.floor(rec.progress) - 1);
      } else {
        initialProgress.value = rec.progress;
      }
    } else {
      initialProgress.value = undefined;
      initialGalleryIndex.value = undefined;
    }
  } catch (e) {
    console.warn("[BrowseView] 读取进度失败:", e);
    initialProgress.value = undefined;
    initialGalleryIndex.value = undefined;
  }
}

async function loadFavoriteForCurrent(): Promise<void> {
  if (!currentWork.value) {
    isFavoriteWork.value = false;
    return;
  }
  try {
    isFavoriteWork.value = await isFavorite(currentWork.value.work.id);
  } catch (e) {
    console.warn("[BrowseView] 读取收藏状态失败:", e);
    isFavoriteWork.value = false;
  }
}

async function loadWatchLaterForCurrent(): Promise<void> {
  if (!currentWork.value) {
    isWatchLaterWork.value = false;
    return;
  }
  try {
    isWatchLaterWork.value = await isWatchLater(currentWork.value.work.id);
  } catch (e) {
    console.warn("[BrowseView] 读取稍后再看状态失败:", e);
    isWatchLaterWork.value = false;
  }
}

// ---- 进度保存 ----
let saveTimer: number | null = null;
function scheduleSaveProgress(progress: number, total: number): void {
  if (!currentWork.value || !contentType.value) return;
  // 沉浸式模式不保存内容播放进度（仅保存"看到了哪个作品"，不保存视频/图集/实况进度）
  if (mode.value === 'immersive') return;
  // 节流：500ms 内最多一次
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    if (!currentWork.value || !contentType.value) return;
    saveProgress(currentWork.value.work.id, contentType.value, mode.value, progress, total).catch(
      (e) => console.warn("[BrowseView] 保存进度失败:", e)
    );
    saveTimer = null;
  }, 500);
}

// ---- 导航 ----
async function goTo(index: number): Promise<void> {
  if (index < 0 || index >= playlist.value.length) return;
  if (index === currentIndex.value) return;
  // 取消上一个作品未完成的进度保存，避免将旧进度错误保存到新作品
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  // 触发过渡动画
  isTransitioning.value = true;
  currentIndex.value = index;
  // 沉浸式模式：同步到 playlist store（持久化 + 检查追加）
  if (mode.value === 'immersive') {
    playlistStore.setCurrentIndex(index);
  }
  emit("index-change", index);
  // 切换后立即根据当前鼠标位置更新 hover 状态
  updateHoverShow();
  // 等待过渡动画后恢复
  await nextTick();
  window.setTimeout(() => {
    isTransitioning.value = false;
    updateHoverShow();
  }, 300);
  // 加载新作品的进度
  await loadProgressForCurrent();
  await loadFavoriteForCurrent();
  await loadWatchLaterForCurrent();
}

function goPrev(): void {
  autoPlayDirection.value = -1;
  if (!hasPrev.value) return;
  goTo(currentIndex.value - 1);
}

function goNext(): void {
  autoPlayDirection.value = 1;
  if (!hasNext.value) return;
  goTo(currentIndex.value + 1);
}

// 当播放/浏览完成时
function onEnded(): void {
  const m = playMode.value;
  if (m === 'off') return;

  if (m === 'loop') {
    // 循环播放：由子组件自行重播，不切换作品
    return;
  }

  if (m === 'sequential') {
    autoPlayDirection.value = 1;
    goNext();
    return;
  }

  if (m === 'reverse') {
    autoPlayDirection.value = -1;
    goPrev();
    return;
  }
}

async function onCollectClick(): Promise<void> {
  if (!currentWork.value) return;
  try {
    isFavoriteWork.value = await toggleFavorite(currentWork.value.work.id);
  } catch (e) {
    console.warn("[BrowseView] 收藏操作失败:", e);
  }
}

async function onWatchLaterClick(): Promise<void> {
  if (!currentWork.value) return;
  try {
    isWatchLaterWork.value = await toggleWatchLater(currentWork.value.work.id);
  } catch (e) {
    console.warn("[BrowseView] 稍后再看操作失败:", e);
  }
}

// ---- 事件处理 ----
function onProgress(current: number, total: number): void {
  scheduleSaveProgress(current, total);
}

function onPlay(): void {
}

function onPause(): void {
}

function onVolumeChange(v: number, muted: boolean): void {
  volume.value = v;
  isMuted.value = muted;
  if (v > 0) lastVolume.value = v;
}

function onSpeedChange(speed: number): void {
  playbackRate.value = speed;
}

function onClearModeChange(enabled: boolean): void {
  clearMode.value = enabled;
  // 始终根据当前鼠标位置更新 hover 状态
  updateHoverShow();
}

function onAutoPlayChange(mode: PlayMode): void {
  playMode.value = mode;
}

// 关闭浏览视图
function onClose(): void {
  emit('close');
}



// ---- 键盘事件 ----
function onKeydown(e: KeyboardEvent): void {
  if (e.target instanceof HTMLInputElement) return;
  // v-show 隐藏时不响应键盘事件
  if (props.visible === false) return;
  
  const key = e.key.toLowerCase();
  const isVideo = contentType.value === "video";
  const isGallery = contentType.value === "gallery";
  const isLive = contentType.value === "live";

  switch (key) {
    case "w":
    case "arrowup":
      e.preventDefault();
      goPrev();
      break;
    case "s":
    case "arrowdown":
      e.preventDefault();
      goNext();
      break;
    case "a":
    case "arrowleft":
      if (isVideo || isLive) {
        break;
      } else if (isGallery) {
        e.preventDefault();
        galleryPrev();
      }
      break;
    case "d":
    case "arrowright":
      if (isVideo || isLive) {
        break;
      } else if (isGallery) {
        e.preventDefault();
        galleryNext();
      }
      break;
    case "escape":
      // 优先关闭详细信息面板，否则关闭整个浏览视图
      if (showDetailPanel.value) {
        e.preventDefault();
        showDetailPanel.value = false;
      } else {
        e.preventDefault();
        onClose();
      }
      break;
    case "r":
      // 调试用：重置沉浸式模式播放列表（清除 localStorage 并重新随机）
      if (mode.value === 'immersive') {
        e.preventDefault();
        playlistStore.clearState();
        void playlistStore.initPlaylist().then(() => {
          currentIndex.value = 0;
          console.log('[BrowseView] 已重置播放列表, 新 playlist.length =', playlistStore.playlist.length, ', 前3个作品ID =', playlistStore.playlist.slice(0, 3).map(w => w.work.id));
        });
      }
      break;
    case " ":
      break;
  }
}

// 图集导航方法
function galleryPrev(): void {
  if (contentType.value !== "gallery") return;
  if (galleryViewerRef.value) {
    galleryViewerRef.value.prev();
  }
}

function galleryNext(): void {
  if (contentType.value !== "gallery") return;
  if (galleryViewerRef.value) {
    galleryViewerRef.value.next();
  }
}

// ---- 鼠标滚轮（沉浸式模式上下切换）----
function onWheel(e: WheelEvent): void {
  if (isTransitioning.value) return;
  if (wheelLock) return;
  // 只处理纵向滚动
  if (Math.abs(e.deltaY) < 30) return;
  wheelLock = true;
  if (e.deltaY > 0) {
    goNext();
  } else {
    goPrev();
  }
  // 400ms 内只允许一次切换，避免滚动过快
  window.setTimeout(() => {
    wheelLock = false;
  }, 400);
}

// ---- 触摸滑动（沉浸式模式）----
function onTouchStart(e: TouchEvent): void {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchStartT = Date.now();
}

function onTouchEnd(e: TouchEvent): void {
  if (e.changedTouches.length !== 1) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  const dt = Date.now() - touchStartT;
  // 横向滑动交给图集处理
  if (Math.abs(dx) > Math.abs(dy)) return;
  // 垂直滑动距离阈值 50px，时间不超过 600ms
  if (Math.abs(dy) < 50 || dt > 600) return;
  if (dy < 0) {
    goNext();
  } else {
    goPrev();
  }
}

// ---- 生命周期 ----
onMounted(async () => {
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("mousemove", onMouseMove);
  lastMouseX = window.innerWidth / 2;
  lastMouseY = window.innerHeight / 2;

  console.log('[BrowseView] onMounted 开始, mode =', mode.value, ', props.works.length =', props.works.length);

  if (mode.value === 'immersive') {
    // 沉浸式模式：轻量 id 池作为随机抽取源（百万作品仅 ~8MB，避免全量加载 OOM），
    // 队列内作品详情按需从 DB 拉取（每次 10 个）
    playlistStore.setLoader((ids) => worksStore.getWorksByIdsForPlaylist(ids));
    const allIds = await worksStore.getWorkIdsForPlaylist();
    console.log('[BrowseView] 获取作品id池完成, allIds.length =', allIds.length);
    playlistStore.setAllIds(allIds);
    // 从 playlist store 恢复或初始化播放列表
    const restored = await playlistStore.restoreState();
    console.log('[BrowseView] restoreState 返回 =', restored);
    if (!restored) {
      console.log('[BrowseView] 调用 initPlaylist 重新生成随机列表...');
      await playlistStore.initPlaylist();
    }
    // 同步本地 currentIndex 到 store
    currentIndex.value = playlistStore.currentIndex;
    console.log('[BrowseView] 初始化完成, playlist.length =', playlistStore.playlist.length, ', currentIndex =', currentIndex.value, ', 前3个作品ID =', playlistStore.playlist.slice(0, 3).map(w => w.work.id));
    // 进入后立即检查是否需要追加（例如恢复后剩余已 ≤ 3）
    playlistStore.checkAndAppend();
  } else {
    // 点击模式：从传入的 initialIndex 开始
    console.log('[BrowseView] 点击模式, initialIndex =', props.initialIndex);
    currentIndex.value = Math.max(0, Math.min((props.initialIndex ?? 0), props.works.length - 1));
  }

  loadProgressForCurrent();
  loadFavoriteForCurrent();
  loadWatchLaterForCurrent();

  // 初始化完成后等待 DOM 渲染，再启用过渡动画
  // 避免沉浸式模式重新进入时从空状态滑入到恢复的作品
  await nextTick();
  isInitializing.value = false;
});

onBeforeUnmount(() => {
  // 沉浸式模式：playlist store 已在每次切换时自动保存状态，无需额外处理
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("mousemove", onMouseMove);
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
});

// 切换模式时重新加载进度
watch(mode, () => {
  loadProgressForCurrent();
});

// 切换作品时自动关闭详细信息面板并重置链接展开状态
watch(currentIndex, () => {
  if (showDetailPanel.value) showDetailPanel.value = false;
  workUrlExpanded.value = false;
});

// v-show 隐藏时：关闭详细信息面板、退出清屏模式，恢复初始 UI 状态
// 重新显示时：根据当前鼠标位置更新 hover 状态
watch(() => props.visible, (vis) => {
  if (vis === false) {
    showDetailPanel.value = false;
    if (clearMode.value) {
      clearMode.value = false;
    }
  } else if (vis === true) {
    updateHoverShow();
  }
});

// 点击模式下 initialIndex 变化时更新当前索引（v-show 保持挂载，onMounted 不会重新执行）
watch(() => props.initialIndex, (newIdx) => {
  if (mode.value !== 'immersive' && newIdx !== undefined && props.visible) {
    const clamped = Math.max(0, Math.min(newIdx, props.works.length - 1));
    if (clamped !== currentIndex.value) {
      currentIndex.value = clamped;
      loadProgressForCurrent();
      loadFavoriteForCurrent();
      loadWatchLaterForCurrent();
    }
  }
});
</script>

<template>
  <div
    class="browse-view"
    :class="{ 'is-immersive': mode === 'immersive', 'is-transitioning': isTransitioning, 'is-clear-mode': clearMode }"
    @wheel="onWheel"
    @touchstart="onTouchStart"
    @touchend="onTouchEnd"
  >
    <!-- 顶部栏（含感应区） -->
    <div class="top-wrapper">
      <!-- 顶部栏 -->
      <div class="top-bar"
        :class="{ 'clear-mode': clearMode, 'hover-show': hoverShowTop }"
        :style="topBarClearStyle"
      >
        <!-- 返回按钮 -->
        <button class="icon-btn" @click="onClose" title="返回">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15.5 4l-8 8 8 8 1.5-1.5L10.5 12l6.5-6.5z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 主内容区 -->
    <div class="content-area">
      <Transition :name="isInitializing ? 'no-transition' : 'slide'" mode="out-in">
        <!-- 视频播放器 -->
        <div
          v-if="currentWork && contentType === 'video'"
          :key="`v-${currentWork.work.id}`"
          class="viewer-wrap"
        >
          <VideoPlayer
            :src="videoSrc"
            :title="workTitle"
            :author="authorName"
            :initial-progress="initialProgress"
            :auto-play="true"
            :volume="volume"
            :is-muted="isMuted"
            :playback-rate="playbackRate"
            :clear-mode="clearMode"
            :controls-hover-show="hoverShowBottom"
            :play-mode="playMode"
            :paused="visible === false"
            @progress="onProgress"
            @ended="onEnded"
            @play="onPlay"
            @pause="onPause"
            @volume-change="onVolumeChange"
            @speed-change="onSpeedChange"
            @clear-mode-change="onClearModeChange"
            @auto-play-change="onAutoPlayChange"
          />
        </div>
        <!-- 图集浏览器 -->
        <div
          v-else-if="currentWork && contentType === 'gallery'"
          :key="`g-${currentWork.work.id}`"
          class="viewer-wrap"
        >
          <GalleryViewer
            ref="galleryViewerRef"
            :images="galleryImages"
            :title="workTitle"
            :author="authorName"
            :initial-index="initialGalleryIndex"
            :auto-play="true"
            :volume="volume"
            :is-muted="isMuted"
            :playback-rate="playbackRate"
            :clear-mode="clearMode"
            :controls-hover-show="hoverShowBottom"
            :play-mode="playMode"
            @progress="onProgress"
            @ended="onEnded"
            @volume-change="onVolumeChange"
            @speed-change="onSpeedChange"
            @clear-mode-change="onClearModeChange"
            @auto-play-change="onAutoPlayChange"
          />
        </div>
        <!-- 实况播放器 -->
        <div
          v-else-if="currentWork && contentType === 'live'"
          :key="`l-${currentWork.work.id}`"
          class="viewer-wrap"
        >
          <LiveViewer
            :src="videoSrc"
            :title="workTitle"
            :author="authorName"
            :initial-progress="initialProgress"
            :auto-play="true"
            :play-mode="playMode"
            :volume="volume"
            :is-muted="isMuted"
            :playback-rate="playbackRate"
            :clear-mode="clearMode"
            :controls-hover-show="hoverShowBottom"
            :paused="visible === false"
            @progress="onProgress"
            @ended="onEnded"
            @play="onPlay"
            @pause="onPause"
            @volume-change="onVolumeChange"
            @speed-change="onSpeedChange"
            @clear-mode-change="onClearModeChange"
            @auto-play-change="onAutoPlayChange"
          />
        </div>
        <!-- 空状态 -->
        <div v-else class="viewer-wrap empty" key="empty">
          <div class="empty-text">无可用内容</div>
        </div>
      </Transition>
    </div>

    <!-- 右侧操作栏（含感应区） -->
    <div class="side-wrapper">
      <!-- 右侧操作栏 -->
      <div class="side-actions"
        :class="{ 'clear-mode': clearMode, 'hover-show': hoverShowRight }"
        :style="sideActionsClearStyle"
      >
      <!-- 收藏按钮 -->
      <div class="side-item collect-item" :class="{ collected: isFavoriteWork }" title="收藏" @click="onCollectClick">
        <div class="collect-icon-wrapper">
          <div class="collect-icon">
            <svg v-if="!isFavoriteWork" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </div>
        </div>
      </div>

      <!-- 稍后再看按钮 -->
      <div class="side-item watch-later-item" :class="{ watched: isWatchLaterWork }" title="稍后再看" @click="onWatchLaterClick">
        <div class="watch-later-icon-wrapper">
          <div class="watch-later-icon">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="none">
              <path d="M2.909 3.364V7H6.546" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M2 12C2 17.523 6.477 22 12 22C17.523 22 22 17.523 22 12C22 6.477 17.523 2 12 2C8.299 2 5.068 4.011 3.338 6.999" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M12.002 6L12.004 12.004L16.242 16.244" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
    </div>



    <!-- 底部信息栏（含感应区） -->
    <div class="bottom-wrapper">
      <!-- 底部信息栏 -->
      <div class="bottom-info"
        :class="{ 'clear-mode': clearMode, 'hover-show': hoverShowBottom, 'panel-open': showDetailPanel }"
        :style="bottomInfoClearStyle"
      >
        <div class="info-text">
          <!-- 作者名 -->
          <div class="info-author" v-if="authorName">@{{ authorName }}</div>
          <!-- 作品标题 -->
          <div class="info-title" :title="workTitle">{{ workTitle }}</div>
          <!-- 标签 -->
          <div class="info-tags" v-if="tagsDisplay">{{ tagsDisplay }}</div>
        </div>
        <!-- 详细信息按钮（与信息栏同高，在右侧） -->
        <button class="detail-btn" @click.stop="toggleDetailPanel" title="作品详情">
          <svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M8 44V4H31L40 14.5V44H8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="15" y="28" width="6" height="7" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M14 35H34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="21" y="23" width="6" height="12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="27" y="18" width="6" height="17" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>

      <!-- 详细信息面板 -->
      <Transition name="detail-pop">
        <div v-if="showDetailPanel && currentWork" class="detail-panel" @click.stop @wheel.stop @touchmove.stop>
          <!-- 面板头部 -->
          <div class="detail-header">
            <span class="detail-title-label">作品详情</span>
            <button class="detail-close" @click.stop="toggleDetailPanel" title="关闭" aria-label="关闭">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <!-- 面板内容 -->
          <div class="detail-body">
            <!-- 作者名字（可点击，短值同行显示） -->
            <div class="detail-row">
              <span class="detail-label">作者</span>
              <button
                v-if="currentWork.work.sec_uid"
                class="detail-link"
                @click.stop="openAuthorUrl"
                title="点击在浏览器中打开作者主页"
              >
                {{ detailAuthorName }}
              </button>
              <span v-else class="detail-value">{{ detailAuthorName }}</span>
            </div>
            <!-- 作品标题（描述，长值换行显示） -->
            <div class="detail-row detail-row-block">
              <span class="detail-label">作品标题</span>
              <span class="detail-value">{{ currentWork.work.description || currentWork.work.title || '-' }}</span>
            </div>
            <!-- 作品ID（短值同行显示） -->
            <div class="detail-row">
              <span class="detail-label">作品ID</span>
              <span class="detail-value mono">{{ currentWork.work.work_id || '-' }}</span>
            </div>
            <!-- 作品标签（长值换行显示） -->
            <div class="detail-row detail-row-block">
              <span class="detail-label">作品标签</span>
              <span class="detail-value">{{ currentWork.work.topics || '-' }}</span>
            </div>
            <!-- 隐藏标签（长值换行显示） -->
            <div class="detail-row detail-row-block">
              <span class="detail-label">隐藏标签</span>
              <span class="detail-value">{{ currentWork.work.hidden_tags || '-' }}</span>
            </div>
            <!-- 视频信息（仅视频类型显示，内联多字段） -->
            <div v-if="contentType === 'video'" class="detail-row-inline">
              <div class="detail-cell">
                <span class="detail-label">时长</span>
                <span class="detail-value mono">{{ formatDuration(currentWork.work.duration) }}</span>
              </div>
              <div class="detail-cell">
                <span class="detail-label">高度</span>
                <span class="detail-value mono">{{ currentWork.work.height ?? '-' }}px</span>
              </div>
              <div class="detail-cell">
                <span class="detail-label">宽度</span>
                <span class="detail-value mono">{{ currentWork.work.width ?? '-' }}px</span>
              </div>
            </div>
            <!-- 互动数据（内联多字段） -->
            <div class="detail-row-inline">
              <div class="detail-cell">
                <span class="detail-label">点赞</span>
                <span class="detail-value mono">{{ formatNumber(currentWork.work.like_count) }}</span>
              </div>
              <div class="detail-cell">
                <span class="detail-label">评论</span>
                <span class="detail-value mono">{{ formatNumber(currentWork.work.comment_count) }}</span>
              </div>
              <div class="detail-cell">
                <span class="detail-label">收藏</span>
                <span class="detail-value mono">{{ formatNumber(currentWork.work.favorite_count) }}</span>
              </div>
              <div class="detail-cell">
                <span class="detail-label">分享</span>
                <span class="detail-value mono">{{ formatNumber(currentWork.work.share_count) }}</span>
              </div>
            </div>
            <!-- 作品链接（长值换行显示，过长截断+展开按钮） -->
            <div class="detail-row detail-row-block">
              <span class="detail-label">作品链接</span>
              <div v-if="workUrl" class="detail-url-wrap">
                <button
                  class="detail-link"
                  @click.stop="openWorkUrl"
                  title="点击在浏览器中打开"
                >{{ workUrlExpanded ? workUrl : workUrlTruncated }}</button>
                <!-- 展开/收起按钮：仅在长链接时显示 -->
                <button
                  v-if="workUrlLong"
                  class="detail-url-toggle"
                  @click.stop="workUrlExpanded = !workUrlExpanded"
                  :title="workUrlExpanded ? '收起' : '展开'"
                >{{ workUrlExpanded ? '收起' : '展开' }}</button>
              </div>
              <span v-else class="detail-value">-</span>
            </div>
            <!-- 时间信息（内联多字段） -->
            <div class="detail-row-inline">
              <div class="detail-cell">
                <span class="detail-label">发布时间</span>
                <span class="detail-value mono">{{ formatTimestamp(currentWork.work.publish_time) }}</span>
              </div>
              <div class="detail-cell">
                <span class="detail-label">采集时间</span>
                <span class="detail-value mono">{{ formatTimestamp(currentWork.work.collect_time) }}</span>
              </div>
            </div>
            <!-- 作品类型（短值同行显示） -->
            <div class="detail-row">
              <span class="detail-label">作品类型</span>
              <span class="detail-value">{{ sourceTypeDisplay }}</span>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 过渡期间的加载提示 -->
    <div v-if="isTransitioning" class="transition-overlay">
      <div class="spinner"></div>
    </div>
  </div>
</template>

<style scoped>
.browse-view {
  position: fixed;
  inset: 0;
  background: #000;
  color: #e8e8e8;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}

/* 包裹层（定位容器） */
.top-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 20;
  pointer-events: none;
}
.is-clear-mode .top-wrapper {
  height: 60px;
  pointer-events: none;
}
.is-clear-mode .side-wrapper {
  pointer-events: none;
}
.side-wrapper {
  position: absolute;
  right: 0;
  top: 70px;
  bottom: 140px;
  width: 90px;
  z-index: 20;
  pointer-events: none;
}

.bottom-wrapper {
  position: absolute;
  left: 20px;
  bottom: 70px;
  width: 360px;
  max-width: calc(100% - 160px);
  z-index: 20;
  pointer-events: none;
}
.is-clear-mode .bottom-wrapper {
  bottom: 70px;
  pointer-events: none;
}
/* 非清屏模式下也允许模块自身交互 */
.top-wrapper > .top-bar,
.side-wrapper > .side-actions,
.bottom-wrapper > .bottom-info {
  pointer-events: auto;
}

/* 顶部栏 */
.top-bar {
  position: relative;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: transparent;
  pointer-events: auto;
}
.icon-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: #e8e8e8;
  cursor: pointer;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}
.icon-btn svg {
  width: 22px;
  height: 22px;
}

/* 主内容区 */
.content-area {
  flex: 1 1 auto;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  overflow: hidden;
}
.viewer-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.viewer-wrap.empty {
  align-items: center;
  justify-content: center;
  color: #888;
}
.empty-text {
  font-size: 14px;
}

/* 右侧操作栏 */
.side-actions {
  position: absolute;
  right: 16px;
  /* 与底部信息栏同高（bottom-wrapper 也使用 bottom: 70px） */
  bottom: 70px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  pointer-events: auto;
}
.side-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: #e8e8e8;
  cursor: pointer;
  transition: all 0.2s ease;
}
.side-item:hover {
  color: #ff6b35;
  transform: scale(1.08);
}
.side-icon {
  width: 34px;
  height: 34px;
  filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.6));
}
.side-text {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
}

.collect-item {
  gap: 0;
}
.collect-icon-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
}
.collect-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.6));
}
.collect-icon svg {
  width: 100%;
  height: 100%;
  display: block;
}
.collect-item.collected {
  color: #ff6b35;
}
.collect-item.collected .collect-icon {
  filter: drop-shadow(0 0 8px rgba(255, 107, 53, 0.6));
}

.watch-later-item {
  gap: 0;
}
.watch-later-icon-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
}
.watch-later-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.6));
}
.watch-later-icon svg {
  width: 100%;
  height: 100%;
  display: block;
}
.watch-later-item.watched {
  color: #ffd700;
}
.watch-later-item.watched .watch-later-icon {
  filter: drop-shadow(0 0 8px rgba(255, 215, 0, 0.6));
}

/* 底部信息栏 */
.bottom-info {
  position: relative;
  pointer-events: none;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.9);
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.bottom-info .info-text {
  flex: 0 1 auto;
  min-width: 0;
  max-width: calc(100% - 50px);
}
.bottom-info .info-text .info-author,
.bottom-info .info-text .info-title,
.bottom-info .info-text .info-tags {
  pointer-events: auto;
  width: fit-content;
}
.info-author {
  font-size: 15px;
  font-weight: 600;
  color: #ff8559;
  margin-bottom: 6px;
}
.info-title {
  font-size: 14px;
  line-height: 1.5;
  color: #e8e8e8;
  max-height: 60px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  margin-bottom: 6px;
}
.info-tags {
  font-size: 12px;
  color: #b8b8b8;
  line-height: 1.5;
  max-height: 40px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* 过渡加载层 */
.transition-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 25;
  pointer-events: none;
}
.spinner {
  width: 36px;
  height: 36px;
  border: 3px solid rgba(255, 255, 255, 0.15);
  border-top-color: #ff6b35;
  border-radius: 50%;
  animation: bv-spin 0.8s linear infinite;
}
@keyframes bv-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 切换动画：0.3s 滑动+淡入 */
.slide-enter-active,
.slide-leave-active {
  transition: all 0.3s ease;
}
.slide-enter-from {
  opacity: 0;
  transform: translateY(20px);
}
.slide-leave-to {
  opacity: 0;
  transform: translateY(-20px);
}

/* 初始化阶段禁用过渡：沉浸式模式重新进入时直接显示恢复的作品 */
.no-transition-enter-active,
.no-transition-leave-active {
  transition: none;
}
.no-transition-enter-from,
.no-transition-leave-to {
  opacity: 1;
  transform: none;
}



/* 控制栏（图集和实况） */
.controls-right {
  position: absolute;
  right: 16px;
  bottom: 80px;
  display: flex;
  align-items: center;
  gap: 4px;
  z-index: 15;
  pointer-events: auto;
}
.ctrl-icon-btn {
  position: relative;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: color 0.15s ease;
}
.ctrl-icon-btn:hover {
  color: #fff;
}
.ctrl-icon-btn:active {
  color: rgba(255, 255, 255, 0.7);
}



/* 清屏模式下UI精简显示 - 使用元素级 clear-mode 类（与 VideoPlayer 一致，更可靠） */
.top-bar.clear-mode {
  background: transparent;
  height: 40px;
  padding: 0 10px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-8px);
  transition: opacity 0.35s ease, transform 0.35s ease;
  will-change: opacity, transform;
}
.top-bar.clear-mode.hover-show {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}
.top-bar.clear-mode .icon-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
.side-actions.clear-mode {
  opacity: 0;
  pointer-events: none;
  transform: translateX(12px);
  transition: opacity 0.35s ease, transform 0.35s ease;
  will-change: opacity, transform;
}
.side-actions.clear-mode.hover-show {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
}
.side-actions.clear-mode .side-item:hover {
  transform: scale(1.08);
  transition: transform 0.2s ease;
}
.bottom-info.clear-mode {
  opacity: 0;
  pointer-events: none;
  transform: translateY(10px);
  transition: opacity 0.35s ease, transform 0.35s ease;
  will-change: opacity, transform;
}
.bottom-info.clear-mode.hover-show {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}
.bottom-info.clear-mode .info-author,
.bottom-info.clear-mode .info-title,
.bottom-info.clear-mode .info-tags {
  pointer-events: auto;
}
.bottom-info.clear-mode .info-title {
  font-size: 14px;
  max-height: 44px;
  -webkit-line-clamp: 2;
}
.bottom-info.clear-mode .info-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.bottom-info.clear-mode .info-author {
  font-size: 14px;
  margin-bottom: 6px;
}

/* ============ 详细信息按钮 ============ */
.detail-btn {
  pointer-events: auto;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  /* 对齐到底部信息栏的最后一行（标签行）：bottom-info 使用 align-items: flex-end */
  border: none;
  background: transparent;
  color: #e8e8e8;
  cursor: pointer;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.85;
  transition: opacity 0.2s ease, background 0.2s ease, transform 0.2s ease;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.9);
}
.detail-btn:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.12);
  transform: scale(1.05);
}
.detail-btn:active {
  transform: scale(0.95);
}
.detail-btn svg {
  width: 22px;
  height: 22px;
  display: block;
}
.bottom-info.clear-mode .detail-btn {
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.9);
}
.bottom-info.clear-mode .detail-btn:hover {
  background: rgba(255, 255, 255, 0.18);
}
/* 面板展开时按钮高亮 */
.bottom-info.panel-open .detail-btn {
  opacity: 1;
  color: #ff8559;
  background: rgba(255, 133, 89, 0.12);
}

/* ============ 详细信息面板 ============ */
.detail-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  pointer-events: auto;
  background: rgba(20, 20, 24, 0.92);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  z-index: 22;
  min-width: 360px;
  max-width: 480px;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.03);
}
.detail-title-label {
  font-size: 13px;
  font-weight: 600;
  color: #e8e8e8;
  letter-spacing: 0.5px;
}
.detail-close {
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  background: transparent;
  color: #999;
  cursor: pointer;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
}
.detail-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.detail-body {
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 60vh;
  overflow-y: auto;
}
.detail-body::-webkit-scrollbar {
  width: 6px;
}
.detail-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}
.detail-body::-webkit-scrollbar-track {
  background: transparent;
}

/* 单行字段 */
.detail-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: 12px;
  line-height: 1.5;
}
/* 块级字段（标题/标签等长文本） */
.detail-row-block {
  flex-direction: column;
  gap: 4px;
}
/* 内联多字段（互动数据/时间） */
.detail-row-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
  line-height: 1.5;
}
.detail-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 70px;
}
.detail-label {
  color: #888;
  flex-shrink: 0;
  min-width: 60px;
}
.detail-row-block .detail-label {
  min-width: 0;
}
.detail-value {
  color: #e8e8e8;
  word-break: break-all;
  white-space: pre-wrap;
}
.detail-value.mono {
  font-family: "Cascadia Mono", "Consolas", "Menlo", monospace;
  font-variant-numeric: tabular-nums;
}

/* 可点击链接字段 */
.detail-link {
  background: none;
  border: none;
  padding: 0;
  color: #ff8559;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  word-break: break-all;
  text-decoration: none;
  transition: color 0.15s ease;
}
.detail-link:hover {
  color: #ffaa80;
  text-decoration: underline;
}

/* 作品链接容器：链接 + 展开/收起按钮 */
.detail-url-wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.detail-url-wrap .detail-link {
  flex: 1 1 auto;
  min-width: 0;
}
/* 展开/收起按钮：纯文字按钮 */
.detail-url-toggle {
  flex: 0 0 auto;
  padding: 0 6px;
  border: 1px solid rgba(255, 133, 89, 0.4);
  border-radius: 4px;
  background: rgba(255, 133, 89, 0.08);
  color: #ff8559;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.detail-url-toggle:hover {
  background: rgba(255, 133, 89, 0.2);
  color: #ffaa80;
  border-color: rgba(255, 170, 128, 0.6);
}
.detail-url-toggle:active {
  transform: scale(0.95);
}

/* ============ 详细面板过渡动画 ============ */
.detail-pop-enter-active,
.detail-pop-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.detail-pop-enter-from,
.detail-pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
