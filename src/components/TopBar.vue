<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { NInput, NButton } from "naive-ui";
import { useWorksStore } from "@/stores/works";

const worksStore = useWorksStore();

const searchText = ref<string>("");
const emit = defineEmits<{
  (e: "open-import"): void;
  (e: "navigate", view: string): void;
  (e: "open-immersive"): void;
}>();

onMounted(() => {
  searchText.value = worksStore.keyword || "";
});

let debounceTimer: number | null = null;
watch(searchText, (v) => {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    worksStore.keyword = v.trim();
    worksStore.loadWorks();
  }, 200);
});

function onSearch(): void {
  worksStore.keyword = searchText.value.trim();
  worksStore.loadWorks();
}

function onClear(): void {
  searchText.value = "";
  worksStore.keyword = "";
  worksStore.loadWorks();
}

function onImport(): void {
  emit("open-import");
}

async function onRefresh(): Promise<void> {
  await worksStore.refreshAll();
}
</script>

<template>
  <div class="topbar">
    <div class="left">
      <div class="brand">
        <span class="brand-icon">◎</span>
        <span class="brand-text">抖音索引</span>
      </div>
      <div class="search-container">
        <NInput
          v-model:value="searchText"
          placeholder="搜索标题、描述、作者..."
          size="medium"
          style="width: 100%"
          @keyup.enter="onSearch"
        >
          <template #prefix>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="opacity: 0.6">
              <path d="M10.5 19C15.194 19 19 15.194 19 10.5C19 5.806 15.194 2 10.5 2C5.806 2 2 5.806 2 10.5C2 15.194 5.806 19 10.5 19Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
              <path d="M13.328 7.172C12.605 6.448 11.605 6 10.5 6C9.395 6 8.395 6.448 7.672 7.172" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M16.611 16.611L20.853 20.853" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </template>
          <template #suffix>
            <button
              v-if="searchText"
              class="search-clear-btn"
              @click="onClear"
              title="清除搜索"
            >
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </template>
        </NInput>
      </div>
    </div>
    <div class="right">
      <div class="stats">
        <div class="stat-item">
          <div class="stat-value">{{ worksStore.total }}</div>
          <div class="stat-label">作品</div>
        </div>
      </div>
      <NButton
        :loading="worksStore.refreshing"
        :disabled="worksStore.refreshing"
        @click="onRefresh"
        title="刷新全部封面和作品数量"
      >
        <template #icon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M21 4V12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3 12L3 20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M21 12C21 7.029 16.971 3 12 3C9.457 3 7.161 4.054 5.524 5.75" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3 12C3 16.971 7.029 21 12 21C14.428 21 16.631 20.039 18.25 18.476" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </template>
        刷新
      </NButton>
      <NButton quaternary @click="emit('navigate', 'import-manager')" title="导入管理">
        <template #icon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 6H21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M3 12H21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M3 18H15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M18 15L21 18L18 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </template>
        导入管理
      </NButton>
      <NButton quaternary @click="emit('navigate', 'settings')" title="设置">
        ⚙ 设置
      </NButton>
      <NButton quaternary @click="emit('open-immersive')" title="刷抖音模式">
        ▶ 刷抖音
      </NButton>
      <NButton type="primary" @click="onImport">导入作品</NButton>
    </div>
  </div>
</template>

<style scoped>
.topbar {
  height: 56px;
  padding: 0 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.left {
  display: flex;
  align-items: center;
  gap: 18px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 16px;
  font-weight: 600;
  color: #ff8559;
  user-select: none;
}
.brand-icon {
  font-size: 18px;
}
.search-container {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 400px;
}
.search-clear-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.15s ease;
}
.search-clear-btn:hover {
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.1);
}
.search-btn {
  flex-shrink: 0;
}
.right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.stats {
  display: flex;
  gap: 16px;
  margin-right: 8px;
}
.stat-item {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.2;
}
.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: #e8e8e8;
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 11px;
  color: #888;
}
</style>
