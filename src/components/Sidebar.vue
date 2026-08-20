<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import {
  NTag,
  NScrollbar,
  NButton,
  NBadge,
  NDivider,
  NInput,
} from "naive-ui";
import { useWorksStore, type CategoryFilter } from "@/stores/works";
import { useAppStore } from "@/stores/app";

const worksStore = useWorksStore();
const appStore = useAppStore();

// 三个滚动区各自的 NScrollbar 引用，用于各自的"返回顶部"按钮
const authorScrollbarRef = ref<InstanceType<typeof NScrollbar> | null>(null);
const tagScrollbarRef = ref<InstanceType<typeof NScrollbar> | null>(null);
const hiddenTagScrollbarRef = ref<InstanceType<typeof NScrollbar> | null>(null);

// 每个返回顶部按钮只滚动对应区自己的列表
function scrollAuthorTop(): void {
  authorScrollbarRef.value?.scrollTo({ top: 0, behavior: "smooth" });
}
function scrollTagTop(): void {
  tagScrollbarRef.value?.scrollTo({ top: 0, behavior: "smooth" });
}
function scrollHiddenTagTop(): void {
  hiddenTagScrollbarRef.value?.scrollTo({ top: 0, behavior: "smooth" });
}

const authorSearch = ref<string>("");
const tagSearch = ref<string>("");
const hiddenTagSearch = ref<string>("");
// 展开的集合作者 UID 集合
const expandedCollections = ref<Set<string>>(new Set());

const categories: { key: CategoryFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "视频", label: "视频" },
  { key: "图集", label: "图集" },
  { key: "实况", label: "实况" },
  { key: "favorite", label: "收藏" },
  { key: "watch-later", label: "稍后再看" },
];

const totalWorks = computed(() => appStore.workCount);

// 集合作者（UID 含 "__"）的分组结构，用于可展开显示
const collectionGroups = computed(() => {
  const groups = new Map<string, {
    uid: string;
    name: string;
    totalWorks: number;
    authorCount: number;
    children: { originalAuthor: string; sourceType: string; count: number }[];
  }>();
  for (const child of worksStore.collectionChildren) {
    const key = child.collectionAuthorUid;
    if (!groups.has(key)) {
      groups.set(key, {
        uid: child.collectionAuthorUid,
        name: child.collectionAuthorName,
        totalWorks: 0,
        authorCount: 0,
        children: [],
      });
    }
    const g = groups.get(key)!;
    g.children.push({
      originalAuthor: child.originalAuthor,
      sourceType: child.sourceType,
      count: child.count,
    });
    g.totalWorks += child.count;
    g.authorCount += 1;
  }
  return Array.from(groups.values());
});

// 普通作者（UID 不含 "__"）
const regularAuthors = computed(() => {
  const q = authorSearch.value.trim().toLowerCase();
  return worksStore.authors.filter((a) => {
    if (a.uid.includes("__")) return false;
    if (q && !a.name.toLowerCase().includes(q)) return false;
    return true;
  });
});

// 搜索时也过滤集合作者
const filteredCollectionGroups = computed(() => {
  const q = authorSearch.value.trim().toLowerCase();
  if (!q) return collectionGroups.value;
  return collectionGroups.value
    .map((g) => ({
      ...g,
      children: g.children.filter((c) =>
        c.originalAuthor.toLowerCase().includes(q)
      ),
    }))
    .filter((g) => g.children.length > 0 || g.name.toLowerCase().includes(q));
});

// 标签列表显示上限：标签数据已在 SQL 端按 LIMIT 截断（有界），
// 此处仅做渲染数量保护；搜索走 SQL 端 LIKE（可命中全量 20 万+ 标签，无需全量载入内存）
// "显示更多"逐步扩容（翻倍到 TAG_LOAD_MAX），20 万+ 标签全量渲染会撑爆 DOM，必须有界
// 作者 6000 个可全显；标签库 20 万+ 全量必崩（曾 OOM 白屏），上限提到 10000 与作者量级相当
const TAG_LOAD_MAX = 10000;
const tagDisplayLimit = ref(200);
const hiddenTagDisplayLimit = ref(200);
// 收藏夹子作者显示上限（同因）
const CHILD_DISPLAY_LIMIT = 100;

// 已加载的标签（服务端已按关键字过滤 + 高频排序），按当前显示上限切片渲染
const filteredTags = computed(() => worksStore.tags.slice(0, tagDisplayLimit.value));
const filteredHiddenTags = computed(() => worksStore.hiddenTags.slice(0, hiddenTagDisplayLimit.value));

/** 滚动自动加载普通标签：扩容渲染上限，已加载数不足时按新 limit 从 SQL 端补拉 */
let tagsFetchingMore = false;
function loadMoreTags(): void {
  if (tagsFetchingMore) return;
  // 已全部加载（无搜索时到 total，搜索时到 total 或 TAG_LOAD_MAX）则不再请求
  if (
    tagDisplayLimit.value >= TAG_LOAD_MAX &&
    worksStore.tags.length >= Math.min(worksStore.tagsTotal, TAG_LOAD_MAX)
  ) {
    return;
  }
  if (worksStore.tags.length >= worksStore.tagsTotal && worksStore.tags.length > 0) return;
  const next = Math.min(tagDisplayLimit.value * 2, TAG_LOAD_MAX);
  if (next > worksStore.tags.length) {
    tagsFetchingMore = true;
    worksStore
      .loadTags(tagSearch.value.trim() || undefined, next)
      .finally(() => {
        tagsFetchingMore = false;
      });
  }
  tagDisplayLimit.value = next;
}

/** 滚动自动加载隐藏标签（同 loadMoreTags） */
let hiddenTagsFetchingMore = false;
function loadMoreHiddenTags(): void {
  if (hiddenTagsFetchingMore) return;
  if (
    hiddenTagDisplayLimit.value >= TAG_LOAD_MAX &&
    worksStore.hiddenTags.length >= Math.min(worksStore.hiddenTagsTotal, TAG_LOAD_MAX)
  ) {
    return;
  }
  if (worksStore.hiddenTags.length >= worksStore.hiddenTagsTotal && worksStore.hiddenTags.length > 0)
    return;
  const next = Math.min(hiddenTagDisplayLimit.value * 2, TAG_LOAD_MAX);
  if (next > worksStore.hiddenTags.length) {
    hiddenTagsFetchingMore = true;
    worksStore
      .loadHiddenTags(hiddenTagSearch.value.trim() || undefined, next)
      .finally(() => {
        hiddenTagsFetchingMore = false;
      });
  }
  hiddenTagDisplayLimit.value = next;
}

// 标签列表滚动到底部附近（300px）时自动加载更多，无需点击。
// naive-ui NScrollbar 的 scroll 事件就是原生事件，e.target 即滚动容器
function onTagScroll(e: Event): void {
  const el = e.target as HTMLElement | null;
  if (!el || el.scrollTop === undefined) return;
  if (worksStore.tagsTotal <= filteredTags.value.length) return;
  if (el.scrollTop + el.clientHeight < el.scrollHeight - 300) return;
  loadMoreTags();
}

function onHiddenTagScroll(e: Event): void {
  const el = e.target as HTMLElement | null;
  if (!el || el.scrollTop === undefined) return;
  if (worksStore.hiddenTagsTotal <= filteredHiddenTags.value.length) return;
  if (el.scrollTop + el.clientHeight < el.scrollHeight - 300) return;
  loadMoreHiddenTags();
}

// ===== 哨兵 + IntersectionObserver 自动加载 =====
// NScrollbar 的 @scroll 对"拖动滚动条"场景不可靠（thumb 拖拽不触发容器原生 scroll），
// 改用列表尾部哨兵元素观察：滚轮/键盘/拖动滚动条接近底部时都会命中，root 必须是实际滚动容器
const tagSentinelRef = ref<HTMLElement | null>(null);
const hiddenTagSentinelRef = ref<HTMLElement | null>(null);
let tagObserver: IntersectionObserver | null = null;
let hiddenTagObserver: IntersectionObserver | null = null;

function setupTagObserver(
  sentinel: HTMLElement | null,
  scrollbar: InstanceType<typeof NScrollbar> | null,
  loadMore: () => void
): IntersectionObserver | null {
  if (!sentinel) return null;
  // 从 NScrollbar 组件根元素向下找实际滚动容器（.n-scrollbar-container）
  const container = (scrollbar?.$el as HTMLElement | undefined)?.querySelector<HTMLElement>(
    ".n-scrollbar-container"
  );
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((en) => en.isIntersecting)) loadMore();
    },
    { root: container ?? null, rootMargin: "400px 0px" }
  );
  observer.observe(sentinel);
  return observer;
}

onMounted(async () => {
  await nextTick();
  tagObserver = setupTagObserver(tagSentinelRef.value, tagScrollbarRef.value, loadMoreTags);
  hiddenTagObserver = setupTagObserver(
    hiddenTagSentinelRef.value,
    hiddenTagScrollbarRef.value,
    loadMoreHiddenTags
  );
});

// 标签搜索：防抖 300ms 后走 SQL 端 LIKE 匹配（全量标签库，仅回传前 N 条）
// 新搜索重置显示上限，从高频头部开始看
let tagSearchTimer: number | null = null;
let hiddenTagSearchTimer: number | null = null;
watch(tagSearch, (q) => {
  if (tagSearchTimer !== null) window.clearTimeout(tagSearchTimer);
  tagSearchTimer = window.setTimeout(() => {
    tagSearchTimer = null;
    tagDisplayLimit.value = 200;
    worksStore.loadTags(q.trim() || undefined, 200);
  }, 300);
});
watch(hiddenTagSearch, (q) => {
  if (hiddenTagSearchTimer !== null) window.clearTimeout(hiddenTagSearchTimer);
  hiddenTagSearchTimer = window.setTimeout(() => {
    hiddenTagSearchTimer = null;
    hiddenTagDisplayLimit.value = 200;
    worksStore.loadHiddenTags(q.trim() || undefined, 200);
  }, 300);
});
onBeforeUnmount(() => {
  if (tagSearchTimer !== null) window.clearTimeout(tagSearchTimer);
  if (hiddenTagSearchTimer !== null) window.clearTimeout(hiddenTagSearchTimer);
  tagObserver?.disconnect();
  hiddenTagObserver?.disconnect();
});

function isAuthorSelected(uid: string): boolean {
  return worksStore.filterAuthorUids.includes(uid);
}

function isCollectionExpanded(uid: string): boolean {
  return expandedCollections.value.has(uid);
}

function toggleCollectionExpand(uid: string): void {
  if (expandedCollections.value.has(uid)) {
    expandedCollections.value.delete(uid);
  } else {
    expandedCollections.value.add(uid);
  }
  // 触发响应式更新
  expandedCollections.value = new Set(expandedCollections.value);
}

function isCollectionChildSelected(collectionUid: string, originalAuthor: string): boolean {
  return (
    worksStore.filterAuthorUids.length === 1 &&
    worksStore.filterAuthorUids[0] === collectionUid &&
    worksStore.filterOriginalAuthor === originalAuthor
  );
}

// 筛选点击统一走防抖加载：大库筛选查询 ~1s，连续点击只发起最后一次查询（叠加查询会占满连接池导致越点越卡）
function selectCollectionChild(collectionUid: string, originalAuthor: string): void {
  worksStore.toggleCollectionChild(collectionUid, originalAuthor);
  worksStore.scheduleLoadWorks();
}

function isTagSelected(t: string): boolean {
  return worksStore.filterTags.includes(t);
}

function isHiddenTagSelected(t: string): boolean {
  return worksStore.filterHiddenTags.includes(t);
}

function selectAuthor(uid: string): void {
  worksStore.toggleAuthor(uid);
  worksStore.scheduleLoadWorks();
}

function selectCategory(c: CategoryFilter): void {
  worksStore.filterCategory = c;
  worksStore.scheduleLoadWorks();
}

function selectTag(t: string): void {
  worksStore.toggleTag(t);
  worksStore.scheduleLoadWorks();
}

function selectHiddenTag(t: string): void {
  worksStore.toggleHiddenTag(t);
  worksStore.scheduleLoadWorks();
}

function clearAll(): void {
  worksStore.clearFilters();
  worksStore.scheduleLoadWorks();
}

function clearTagFilter(): void {
  worksStore.clearTagFilter();
  worksStore.scheduleLoadWorks();
}

function clearHiddenTagFilter(): void {
  worksStore.clearHiddenTagFilter();
  worksStore.scheduleLoadWorks();
}
</script>

<template>
  <div class="sidebar">
    <div class="section">
      <div class="section-title">作品类型</div>
      <div class="cat-list">
        <button
          v-for="c in categories"
          :key="c.key"
          class="cat-item"
          :class="{ active: worksStore.filterCategory === c.key }"
          @click="selectCategory(c.key)"
        >
          {{ c.label }}
        </button>
      </div>
    </div>

    <NDivider style="margin: 8px 0" />

    <div class="section section-authors">
      <div class="section-title">
        <span>作者</span>
        <NBadge :value="worksStore.authors.length" type="info" />
        <button
          class="scroll-top-btn"
          title="返回顶部"
          @click="scrollAuthorTop"
        >
          <svg width="16" height="16" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M24.0083 14.1006V42.0001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 26L24 14L36 26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 6H36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <NButton
          v-if="worksStore.filterAuthorUids.length > 0"
          size="tiny"
          text
          type="primary"
          class="clear-btn"
          @click="selectAuthor('')"
        >
          清除
        </NButton>
      </div>
      <NInput
        v-model:value="authorSearch"
        placeholder="搜索作者..."
        size="small"
        clearable
        class="search-input"
      >
        <template #prefix>
          <span style="opacity: 0.5; font-size: 12px">🔍</span>
        </template>
      </NInput>
      <NScrollbar ref="authorScrollbarRef" class="scroll-area">
        <div class="author-list">
          <button
            class="author-item"
            :class="{ active: worksStore.filterAuthorUids.length === 0 && !worksStore.filterOriginalAuthor }"
            @click="selectAuthor('')"
          >
            <span class="author-name">全部作者</span>
            <span class="author-count">{{ totalWorks }}</span>
          </button>
          <!-- 集合作者：枫临的收藏 / 枫临的喜欢（可展开显示子项） -->
          <div
            v-for="g in filteredCollectionGroups"
            :key="'collection-' + g.uid"
            class="collection-group"
          >
            <button
              class="author-item collection-parent"
              :class="{ active: isAuthorSelected(g.uid) && !worksStore.filterOriginalAuthor, expanded: isCollectionExpanded(g.uid) }"
              @click="selectAuthor(g.uid)"
            >
              <span class="author-name" :title="g.name">{{ g.name }}</span>
              <span class="author-sub">作者{{ g.authorCount }}</span>
              <span class="author-count">{{ g.totalWorks }}</span>
              <span
                class="expand-icon"
                :class="{ expanded: isCollectionExpanded(g.uid) }"
                @click.stop="toggleCollectionExpand(g.uid)"
              >
                <svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M7.94971 11.9497H39.9497" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M7.94971 23.9497H39.9497" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M7.94971 35.9497H39.9497" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
            </button>
            <div v-if="isCollectionExpanded(g.uid)" class="collection-children">
              <button
                v-for="child in g.children.slice(0, CHILD_DISPLAY_LIMIT)"
                :key="'child-' + g.uid + '-' + child.originalAuthor"
                class="author-item collection-child"
                :class="{ active: isCollectionChildSelected(g.uid, child.originalAuthor) }"
                @click="selectCollectionChild(g.uid, child.originalAuthor)"
              >
                <span class="author-name" :title="child.originalAuthor + '-' + child.sourceType.replace(/作品$/, '')">
                  {{ child.originalAuthor }}-{{ child.sourceType.replace(/作品$/, "") }}
                </span>
                <span class="author-count">{{ child.count }}</span>
              </button>
              <div v-if="g.children.length > CHILD_DISPLAY_LIMIT" class="empty-hint">
                共 {{ g.children.length }} 位作者，仅显示前 {{ CHILD_DISPLAY_LIMIT }} 位，输入关键字筛选
              </div>
            </div>
          </div>
          <!-- 普通作者 -->
          <button
            v-for="a in regularAuthors"
            :key="a.uid"
            class="author-item"
            :class="{ active: isAuthorSelected(a.uid) }"
            @click="selectAuthor(a.uid)"
          >
            <span class="author-name" :title="a.name">{{ a.name }}</span>
            <span class="author-count">{{ a.work_count ?? 0 }}</span>
          </button>
          <div v-if="regularAuthors.length === 0 && filteredCollectionGroups.length === 0 && authorSearch" class="empty-hint">
            没有匹配的作者
          </div>
        </div>
      </NScrollbar>
    </div>

    <NDivider style="margin: 8px 0" />

    <div class="section section-tags">
      <div class="section-title">
        <span>标签</span>
        <NBadge :value="worksStore.tagsTotal" type="info" />
        <button
          class="scroll-top-btn"
          title="返回顶部"
          @click="scrollTagTop"
        >
          <svg width="16" height="16" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M24.0083 14.1006V42.0001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 26L24 14L36 26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 6H36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <NButton
          v-if="worksStore.filterTags.length > 0"
          size="tiny"
          text
          type="primary"
          class="clear-btn"
          @click="clearTagFilter"
        >
          清除
        </NButton>
      </div>
      <NInput
        v-model:value="tagSearch"
        placeholder="搜索标签..."
        size="small"
        clearable
        class="search-input"
      >
        <template #prefix>
          <span style="opacity: 0.5; font-size: 12px">🔍</span>
        </template>
      </NInput>
      <NScrollbar ref="tagScrollbarRef" class="scroll-area" @scroll="onTagScroll">
        <div class="tag-cloud">
          <NTag
            v-for="t in filteredTags"
            :key="t.name"
            :type="isTagSelected(t.name) ? 'primary' : 'default'"
            :bordered="isTagSelected(t.name)"
            round
            checkable
            :checked="isTagSelected(t.name)"
            size="small"
            @click="selectTag(t.name)"
          >
            #{{ t.name }}
            <span class="tag-count">{{ t.count }}</span>
          </NTag>
          <span v-if="worksStore.tags.length === 0" class="empty-hint">暂无标签</span>
          <span v-else-if="filteredTags.length === 0 && tagSearch" class="empty-hint">没有匹配的标签</span>
          <span v-else-if="worksStore.tagsTotal > filteredTags.length" class="empty-hint tag-more">
            共 {{ worksStore.tagsTotal }} 个标签{{ tagSearch ? `，匹配 ${worksStore.tags.length} 个` : "" }}，已显示高频前 {{ filteredTags.length }} 个
            <template v-if="tagDisplayLimit < TAG_LOAD_MAX || worksStore.tags.length > filteredTags.length">（向下滚动自动加载）</template>
            <template v-else>（可输入关键字精确查找）</template>
          </span>
          <!-- 尾部哨兵：拖动滚动条/滚轮接近底部时触发自动加载 -->
          <div ref="tagSentinelRef" class="tag-sentinel"></div>
        </div>
      </NScrollbar>
    </div>

    <NDivider style="margin: 8px 0" />

    <div class="section section-hidden-tags">
      <div class="section-title">
        <span>隐藏标签</span>
        <NBadge :value="worksStore.hiddenTagsTotal" type="info" />
        <button
          class="scroll-top-btn"
          title="返回顶部"
          @click="scrollHiddenTagTop"
        >
          <svg width="16" height="16" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M24.0083 14.1006V42.0001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 26L24 14L36 26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 6H36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <NButton
          v-if="worksStore.filterHiddenTags.length > 0"
          size="tiny"
          text
          type="primary"
          class="clear-btn"
          @click="clearHiddenTagFilter"
        >
          清除
        </NButton>
      </div>
      <NInput
        v-model:value="hiddenTagSearch"
        placeholder="搜索隐藏标签..."
        size="small"
        clearable
        class="search-input"
      >
        <template #prefix>
          <span style="opacity: 0.5; font-size: 12px">🔍</span>
        </template>
      </NInput>
      <NScrollbar ref="hiddenTagScrollbarRef" class="scroll-area" @scroll="onHiddenTagScroll">
        <div class="tag-cloud">
          <NTag
            v-for="t in filteredHiddenTags"
            :key="t.name"
            :type="isHiddenTagSelected(t.name) ? 'primary' : 'default'"
            :bordered="isHiddenTagSelected(t.name)"
            round
            checkable
            :checked="isHiddenTagSelected(t.name)"
            size="small"
            class="hidden-tag"
            :class="{ active: isHiddenTagSelected(t.name) }"
            @click="selectHiddenTag(t.name)"
          >
            #{{ t.name }}
            <span class="tag-count">{{ t.count }}</span>
          </NTag>
          <span v-if="worksStore.hiddenTags.length === 0" class="empty-hint">暂无隐藏标签</span>
          <span v-else-if="filteredHiddenTags.length === 0 && hiddenTagSearch" class="empty-hint">没有匹配的隐藏标签</span>
          <span v-else-if="worksStore.hiddenTagsTotal > filteredHiddenTags.length" class="empty-hint tag-more">
            共 {{ worksStore.hiddenTagsTotal }} 个{{ hiddenTagSearch ? `，匹配 ${worksStore.hiddenTags.length} 个` : "" }}，已显示高频前 {{ filteredHiddenTags.length }} 个
            <template v-if="hiddenTagDisplayLimit < TAG_LOAD_MAX || worksStore.hiddenTags.length > filteredHiddenTags.length">（向下滚动自动加载）</template>
            <template v-else>（可输入关键字精确查找）</template>
          </span>
          <!-- 尾部哨兵：拖动滚动条/滚轮接近底部时触发自动加载 -->
          <div ref="hiddenTagSentinelRef" class="tag-sentinel"></div>
        </div>
      </NScrollbar>
    </div>

    <div v-if="worksStore.hasFilter" class="clear-bar">
      <NButton size="small" block tertiary @click="clearAll">清除全部筛选</NButton>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  width: 240px;
  height: 100%;
  background: rgba(255, 255, 255, 0.02);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  padding: 14px 12px;
  gap: 4px;
  overflow: hidden;
}
.section {
  flex-shrink: 0;
}
.section-authors {
  flex: 2;
  min-height: 120px;
  display: flex;
  flex-direction: column;
}
.section-tags {
  flex: 1;
  min-height: 80px;
  display: flex;
  flex-direction: column;
}
.section-hidden-tags {
  flex: 1;
  min-height: 80px;
  display: flex;
  flex-direction: column;
}
.section-title {
  font-size: 12px;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.search-input {
  margin-bottom: 8px;
  flex-shrink: 0;
}
.scroll-area {
  flex: 1;
  min-height: 0;
}
.cat-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cat-item {
  padding: 5px 12px;
  font-size: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: transparent;
  color: #ccc;
  border-radius: 14px;
  cursor: pointer;
  transition: all 0.15s;
}
.cat-item:hover {
  border-color: rgba(255, 107, 53, 0.5);
  color: #fff;
}
.cat-item.active {
  background: #ff6b35;
  border-color: #ff6b35;
  color: #fff;
}
.author-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.author-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 10px;
  background: transparent;
  border: none;
  color: #ccc;
  cursor: pointer;
  border-radius: 6px;
  text-align: left;
  transition: background 0.15s;
  font-size: 13px;
}
.author-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.author-item.active {
  background: rgba(255, 107, 53, 0.18);
  color: #ff8559;
}
.collection-group {
  display: flex;
  flex-direction: column;
}
.collection-parent {
  /* 图标在右侧，不需要额外左 padding */
}
.collection-parent.expanded .expand-icon {
  color: #ff8559;
}
.expand-icon {
  color: #888;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 6px;
  transition: color 0.15s;
}
.expand-icon:hover {
  color: #ff8559;
}
.collection-children {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.collection-child {
  padding-left: 18px;
  font-size: 12px;
  color: #aaa;
}
.collection-child:hover {
  color: #ff8559;
}
.collection-child.active {
  background: rgba(255, 107, 53, 0.22);
  color: #ff8559;
}
.author-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.author-count,
.author-sub {
  font-size: 11px;
  color: #777;
  margin-left: 8px;
  flex-shrink: 0;
}
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 8px;
}
.tag-count {
  margin-left: 4px;
  font-size: 10px;
  opacity: 0.7;
}
.hidden-tag {
  opacity: 0.7;
  transition: opacity 0.15s;
}
.hidden-tag.active {
  opacity: 1;
}
.empty-hint {
  font-size: 12px;
  color: #666;
}
/* 自动加载哨兵：零高度占位，仅作 IntersectionObserver 观测目标 */
.tag-sentinel {
  width: 100%;
  height: 1px;
}
.clear-bar {
  margin-top: 8px;
  flex-shrink: 0;
}
.clear-btn {
  font-size: 11px;
}
.scroll-top-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: #999;
  cursor: pointer;
  border-radius: 4px;
  transition: color 0.2s, background 0.2s;
}
.scroll-top-btn:hover {
  color: #ff8559;
  background: rgba(255, 133, 89, 0.1);
}
</style>
