<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from "vue";
import { NSpin } from "naive-ui";
import type { WorkWithFiles } from "@/types";
import WorkCard from "./WorkCard.vue";

const props = defineProps<{
  works: WorkWithFiles[];
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  total?: number;
}>();

const emit = defineEmits<{
  (e: "click", work: WorkWithFiles): void;
  (e: "load-more"): void;
}>();

const sentinelRef = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let scrollRootEl: HTMLElement | null = null;
let scrollListener: ((e: Event) => void) | null = null;

function tryLoadMore(): void {
  if (props.loadingMore || props.loading) return;
  if (!props.hasMore) return;
  emit("load-more");
}

/** 向上查找最近的可滚动父元素 */
function findScrollRoot(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** 兜底：scroll 事件监听 */
function onScrollEvent(): void {
  if (!scrollRootEl) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollRootEl;
  if (scrollHeight - scrollTop - clientHeight < 400) {
    tryLoadMore();
  }
}

function setupObserver(): void {
  // 清理旧的
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (scrollRootEl && scrollListener) {
    scrollRootEl.removeEventListener("scroll", scrollListener);
    scrollListener = null;
  }

  if (!sentinelRef.value) return;

  // 查找真实的滚动容器作为 root
  scrollRootEl = findScrollRoot(sentinelRef.value);

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          tryLoadMore();
        }
      }
    },
    {
      root: scrollRootEl,
      rootMargin: "400px 0px 400px 0px",
      threshold: 0,
    }
  );
  observer.observe(sentinelRef.value);

  // 兜底：同时监听 scroll 事件
  if (scrollRootEl) {
    scrollListener = onScrollEvent;
    scrollRootEl.addEventListener("scroll", onScrollEvent, { passive: true });
  }
}

onMounted(() => {
  nextTick(() => setupObserver());
});

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
  if (scrollRootEl && scrollListener) {
    scrollRootEl.removeEventListener("scroll", scrollListener);
    scrollListener = null;
  }
});

// works 变化后重新观察哨兵
watch(
  () => props.works.length,
  () => {
    nextTick(() => setupObserver());
  }
);

// hasMore 变化时也重新检查
watch(
  () => props.hasMore,
  () => {
    nextTick(() => setupObserver());
  }
);
</script>

<template>
  <div class="work-grid-wrap" :class="{ 'is-refreshing': loading && works.length > 0 }">
    <!-- 首次加载（无内容可显示）才用整屏转圈；切换筛选时保留旧网格淡显，避免销毁重建卡片 -->
    <div v-if="loading && works.length === 0" class="grid-loading">
      <NSpin size="large" />
    </div>
    <div v-else-if="works.length === 0" class="grid-empty">
      <slot name="empty">
        <div class="empty-default">
          <div class="empty-icon">📷</div>
          <div class="empty-text">暂无作品</div>
        </div>
      </slot>
    </div>
    <template v-else>
      <div class="work-grid">
        <WorkCard
          v-for="w in works"
          :key="w.work.id"
          :work="w"
          @click="(work) => emit('click', work)"
        />
      </div>
      <!-- 底部哨兵：进入视口时触发加载 -->
      <div ref="sentinelRef" class="sentinel"></div>
      <div v-if="loadingMore" class="load-more">
        <NSpin size="small" />
        <span class="load-more-text">加载中...</span>
      </div>
      <div v-else-if="!hasMore && works.length > 0" class="load-more no-more">
        — 已加载全部 {{ total }} 个作品 —
      </div>
    </template>
  </div>
</template>

<style scoped>
.work-grid-wrap {
  width: 100%;
  height: 100%;
}
.grid-loading {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
}
.grid-empty {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 300px;
  color: #888;
}
.empty-default {
  text-align: center;
}
.empty-icon {
  font-size: 48px;
  opacity: 0.4;
}
.empty-text {
  margin-top: 12px;
  font-size: 14px;
}
.work-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
  padding: 4px;
  /* 优化：隔离网格布局，避免滚动时整页重排 */
  contain: layout;
  transition: opacity 0.25s ease;
}
/* 切换筛选时保留旧网格淡显，避免卡片销毁重建 + 封面重载 */
.work-grid-wrap.is-refreshing .work-grid {
  opacity: 0.45;
  pointer-events: none;
}
.sentinel {
  height: 1px;
  width: 100%;
}
.load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 0;
  color: #888;
  font-size: 13px;
}
.load-more.no-more {
  color: #555;
  font-size: 12px;
}
</style>
