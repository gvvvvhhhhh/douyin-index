<script setup lang="ts">
import { NButton } from "naive-ui";

defineProps<{
  title?: string;
  desc?: string;
  actionText?: string;
}>();

const emit = defineEmits<{
  (e: "action"): void;
}>();
</script>

<template>
  <div class="empty-state">
    <div class="empty-icon">
      <svg width="80" height="80" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6zm3 0v.01M7 6h.01M11 13l1.5 2 2-3 3 4H7l3-4z"
          stroke="rgba(255,255,255,0.25)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </div>
    <h2 class="empty-title">{{ title ?? "尚未导入作品" }}</h2>
    <p class="empty-desc">{{ desc ?? "选择抖音作品根目录并开始导入" }}</p>
    <NButton v-if="actionText" type="primary" size="large" @click="emit('action')">
      {{ actionText }}
    </NButton>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
  padding: 40px;
  text-align: center;
  gap: 12px;
}
.empty-icon {
  opacity: 0.8;
}
.empty-title {
  margin: 8px 0 0;
  font-size: 20px;
  font-weight: 500;
  color: #e8e8e8;
}
.empty-desc {
  margin: 0 0 16px;
  color: #999;
  font-size: 14px;
}
</style>
