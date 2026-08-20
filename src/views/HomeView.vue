<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import { NScrollbar, useMessage } from "naive-ui";
import { useAppStore } from "@/stores/app";
import { useWorksStore } from "@/stores/works";
import TopBar from "@/components/TopBar.vue";
import Sidebar from "@/components/Sidebar.vue";
import WorkGrid from "@/components/WorkGrid.vue";
import EmptyState from "@/components/EmptyState.vue";
import ImportPanel from "@/components/ImportPanel.vue";
import ImportManager from "@/components/ImportManager.vue";
import SettingsView from "@/components/SettingsView.vue";
import BrowseView from "@/components/BrowseView.vue";
import type { WorkWithFiles } from "@/types";
import type { BrowseMode } from "@/services/progress";

type ViewName = "home" | "import-manager" | "settings";

const appStore = useAppStore();
const worksStore = useWorksStore();
const message = useMessage();

const showImport = ref<boolean>(false);
const currentView = ref<ViewName>("home");

const contentRef = ref<HTMLElement | null>(null);
const savedScrollTop = ref<number>(0);
// 滚动父元素引用（NScrollbar 的内部滚动容器）
const scrollParentRef = ref<HTMLElement | null>(null);
// 是否正在滚动（滚动时隐藏返回顶部按钮）
const isScrolling = ref<boolean>(false);
// 是否在顶部（在顶部时隐藏返回顶部按钮）
const isAtTop = ref<boolean>(true);
let scrollTimer: number | null = null;

const showBrowse = ref<boolean>(false);
const browseMode = ref<BrowseMode>("click");
const browseInitialIndex = ref<number>(0);
// BrowseView 是否已挂载（首次打开后保持 true，用 v-show 控制显隐以保留状态）
const browseMounted = ref<boolean>(false);

function getScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** 滚动事件处理：滚动时隐藏返回顶部按钮，停止后显示 */
function onContentScroll(): void {
  if (scrollParentRef.value) {
    isAtTop.value = scrollParentRef.value.scrollTop < 10;
  }
  if (!isScrolling.value) {
    isScrolling.value = true;
  }
  if (scrollTimer !== null) {
    window.clearTimeout(scrollTimer);
  }
  scrollTimer = window.setTimeout(() => {
    isScrolling.value = false;
  }, 600);
}

async function loadData(): Promise<void> {
  if (!appStore.dbReady) return;
  await Promise.all([worksStore.loadAuthors(), worksStore.loadTags(), worksStore.loadHiddenTags(), worksStore.loadCollectionChildren()]);
  await worksStore.loadWorks();
}

watch(
  () => appStore.dbReady,
  (ready) => {
    if (ready) loadData();
  }
);

watch(
  () => appStore.workCount,
  () => {
    worksStore.loadAuthors();
    worksStore.loadTags();
    worksStore.loadHiddenTags();
    worksStore.loadCollectionChildren();
  }
);

watch(
  () => showBrowse.value,
  async (isShowing) => {
    if (!isShowing && savedScrollTop.value > 0) {
      // v-show 不会销毁 DOM，nextTick 后 display 已恢复，可立即还原滚动位置
      await nextTick();
      if (contentRef.value) {
        const scrollParent = getScrollParent(contentRef.value);
        if (scrollParent) {
          scrollParent.scrollTop = savedScrollTop.value;
        }
      }
    }
  }
);

function onWorkClick(work: WorkWithFiles): void {
  if (contentRef.value) {
    const scrollParent = getScrollParent(contentRef.value);
    if (scrollParent) {
      savedScrollTop.value = scrollParent.scrollTop;
    }
  }
  
  const idx = worksStore.works.findIndex((w) => w.work.id === work.work.id);
  browseInitialIndex.value = Math.max(0, idx);
  browseMode.value = "click";
  browseMounted.value = true;
  showBrowse.value = true;
}

function onOpenImmersive(): void {
  if (worksStore.works.length === 0) {
    message.warning("暂无可浏览的作品，请先导入");
    return;
  }

  if (contentRef.value) {
    const scrollParent = getScrollParent(contentRef.value);
    if (scrollParent) {
      savedScrollTop.value = scrollParent.scrollTop;
    }
  }

  // 沉浸式模式的播放列表与当前索引由 playlist store 自行管理（持久化到 localStorage）
  browseInitialIndex.value = 0;
  browseMode.value = "immersive";
  browseMounted.value = true;
  showBrowse.value = true;
}

function onCloseBrowse(): void {
  showBrowse.value = false;
}

// 返回顶部：滚动主内容区到顶部
function scrollToTop(): void {
  if (contentRef.value) {
    const scrollParent = getScrollParent(contentRef.value);
    if (scrollParent) {
      scrollParent.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
}

function openImport(): void {
  showImport.value = true;
}

async function onImported(): Promise<void> {
  await loadData();
}

function onLoadMore(): void {
  worksStore.loadMoreWorks();
}

function goBack(): void {
  currentView.value = "home";
}

// ===== 拖放导入：拖入文件夹或 xlsx 自动开始识别和匹配（支持批量） =====
const dragOverlay = ref<boolean>(false);
let unlistenDragDrop: (() => void) | null = null;

async function onDropPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  if (appStore.importing) {
    message.warning("正在导入中，请等待完成后再拖放");
    return;
  }
  const excelCount = paths.filter((p) => /\.(xlsx|xls)$/i.test(p)).length;
  const folderCount = paths.length - excelCount;
  const parts: string[] = [];
  if (folderCount) parts.push(`${folderCount} 个文件夹`);
  if (excelCount) parts.push(`${excelCount} 个 Excel`);
  message.info(`开始拖放导入：${parts.join(" + ")}，重复作品将自动更新`, { duration: 4000 });
  try {
    const summary = await appStore.importDroppedPaths(paths);
    if (summary) {
      // 完成摘要停留久一些，多文件夹结果较长避免一闪而过
      message.success(`导入完成：${summary}`, { duration: 6000 });
    } else if (appStore.lastError) {
      message.error(appStore.lastError, { duration: 6000 });
    }
    // 导入后刷新侧边栏与作品列表（workCount watch 也会触发作者/标签刷新）
    await loadData();
  } catch (e) {
    console.error("[拖放导入] 失败:", e);
    message.error(`拖放导入失败: ${e}`);
  }
}

onMounted(async () => {
  await nextTick();
  // 绑定滚动监听（NScrollbar 的内部滚动容器）
  if (contentRef.value) {
    const sp = getScrollParent(contentRef.value);
    if (sp) {
      scrollParentRef.value = sp;
      sp.addEventListener('scroll', onContentScroll, { passive: true });
    }
  }
  // 窗口级拖放事件：enter/over 显示遮罩，drop 触发自动导入
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    unlistenDragDrop = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        dragOverlay.value = true;
      } else if (event.payload.type === "leave") {
        dragOverlay.value = false;
      } else if (event.payload.type === "drop") {
        dragOverlay.value = false;
        void onDropPaths(event.payload.paths);
      }
    });
  } catch (e) {
    console.warn("[拖放导入] 拖放事件监听不可用:", e);
  }
});

onUnmounted(() => {
  if (scrollTimer !== null) {
    window.clearTimeout(scrollTimer);
  }
  if (scrollParentRef.value) {
    scrollParentRef.value.removeEventListener('scroll', onContentScroll);
  }
  if (unlistenDragDrop) {
    unlistenDragDrop();
    unlistenDragDrop = null;
  }
});
</script>

<template>
  <div class="home">
    <!-- BrowseView 全屏覆盖层（v-if 首次挂载后用 v-show 保持状态，避免退出重进时重新加载） -->
    <BrowseView
      v-if="browseMounted"
      v-show="showBrowse"
      :key="browseMode"
      :works="worksStore.works"
      :initial-index="browseInitialIndex"
      :mode="browseMode"
      :visible="showBrowse"
      @close="onCloseBrowse"
    />

    <!-- 主页内容（常驻 DOM，用 v-show 控制显隐，避免返回时重复加载和滚动位置丢失） -->
    <div v-show="currentView === 'home' && !showBrowse" class="home-main">
      <TopBar
        @open-import="openImport"
        @navigate="currentView = $event as ViewName"
        @open-immersive="onOpenImmersive"
      />
      <div class="body">
        <Sidebar />
        <div class="main">
          <NScrollbar>
            <div class="content" ref="contentRef">
              <EmptyState
                v-if="!appStore.hasData && !worksStore.loading"
                title="尚未导入作品"
                desc="选择抖音作品根目录并开始导入"
                action-text="开始导入"
                @action="openImport"
              />
              <WorkGrid
                v-else
                :works="worksStore.works"
                :loading="worksStore.loading"
                :loading-more="worksStore.loadingMore"
                :has-more="worksStore.hasMore"
                :total="worksStore.total"
                @click="onWorkClick"
                @load-more="onLoadMore"
              />
            </div>
          </NScrollbar>
          <!-- 右下角返回顶部按钮 -->
          <button
            class="back-to-top"
            :class="{ 'is-hidden': isScrolling }"
            title="返回顶部"
            @click="scrollToTop"
          >
            <svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M24.0083 14.1006V42.0001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M12 26L24 14L36 26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M12 6H36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
      <ImportPanel v-model:show="showImport" @imported="onImported" />
    </div>

    <ImportManager v-if="currentView === 'import-manager' && !showBrowse" @back="goBack" />

    <SettingsView v-if="currentView === 'settings' && !showBrowse" @back="goBack" />

    <!-- 拖放导入遮罩：拖入文件/文件夹时提示松开即自动导入 -->
    <div v-if="dragOverlay" class="drag-overlay">
      <div class="drag-overlay-card">
        <div class="drag-overlay-icon">📥</div>
        <div class="drag-overlay-title">松开鼠标开始导入</div>
        <div class="drag-overlay-desc">支持作品文件夹（含单个作者文件夹）/ 根目录 / xlsx 文件，可批量</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: #18181c;
  color: #e8e8e8;
}

/* 拖放导入遮罩：不拦截鼠标事件，拖放事件由系统窗口层接收 */
.drag-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.drag-overlay-card {
  border: 2px dashed #ff6b35;
  border-radius: 16px;
  padding: 40px 64px;
  text-align: center;
  background: rgba(30, 30, 34, 0.9);
}
.drag-overlay-icon {
  font-size: 48px;
}
.drag-overlay-title {
  margin-top: 12px;
  font-size: 22px;
  font-weight: 600;
  color: #ff8559;
}
.drag-overlay-desc {
  margin-top: 8px;
  font-size: 13px;
  color: #999;
}
.home-main {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}
.body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.content {
  padding: 16px 18px 24px;
  min-height: 100%;
}
.back-to-top {
  position: absolute;
  bottom: 24px;
  right: 24px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(255, 133, 89, 0.9);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  transition: background 0.2s, transform 0.2s, opacity 0.3s ease, visibility 0.3s ease;
  z-index: 10;
  opacity: 1;
  visibility: visible;
}
.back-to-top:hover {
  background: rgba(255, 133, 89, 1);
  transform: translateY(-2px);
}
.back-to-top.is-hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: scale(0.8);
}
</style>
