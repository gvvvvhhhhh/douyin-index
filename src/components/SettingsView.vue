<script setup lang="ts">
import { ref, onMounted } from "vue";
import {
  NCard,
  NSpace,
  NInputNumber,
  NButton,
  NDivider,
  NStatistic,
  NPopconfirm,
  NGrid,
  NGi,
  NText,
  NScrollbar,
  useMessage,
} from "naive-ui";
import { useSettingsStore } from "@/stores/settings";
import { useAppStore } from "@/stores/app";
import { clearAllData, vacuum, getDbStats, type DbStats } from "@/api/db";

const emit = defineEmits<{
  (e: "back"): void;
}>();

const settingsStore = useSettingsStore();
const appStore = useAppStore();
const message = useMessage();

const stats = ref<DbStats | null>(null);
const clearingData = ref<boolean>(false);
const vacuuming = ref<boolean>(false);
const resetting = ref<boolean>(false);

const APP_VERSION = "0.1.0";

async function loadStats(): Promise<void> {
  if (!appStore.dbReady) return;
  try {
    stats.value = await getDbStats();
  } catch (e) {
    console.error("loadStats error", e);
  }
}

onMounted(() => {
  loadStats();
});

async function onClearAllData(): Promise<void> {
  clearingData.value = true;
  try {
    // 数据库可能未初始化（initApp 启动时失败），先尝试初始化
    if (!appStore.dbReady) {
      await appStore.initApp();
    }
    if (!appStore.dbReady) {
      message.error("数据库未初始化，无法清空数据。请重启应用后重试。");
      return;
    }
    await clearAllData();
    await appStore.refreshCounts();
    await loadStats();
    message.success("已清空全部数据");
  } catch (e) {
    message.error(`清空数据失败: ${e}`);
  } finally {
    clearingData.value = false;
  }
}

async function onVacuum(): Promise<void> {
  vacuuming.value = true;
  try {
    if (!appStore.dbReady) {
      await appStore.initApp();
    }
    if (!appStore.dbReady) {
      message.error("数据库未初始化，无法压缩。请重启应用后重试。");
      return;
    }
    await vacuum();
    await loadStats();
    message.success("数据库已压缩");
  } catch (e) {
    message.error(`压缩失败: ${e}`);
  } finally {
    vacuuming.value = false;
  }
}

async function onResetSettings(): Promise<void> {
  resetting.value = true;
  try {
    settingsStore.reset();
    message.success("设置已恢复默认");
  } finally {
    resetting.value = false;
  }
}

function onBack(): void {
  emit("back");
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}
</script>

<template>
  <div class="settings-view">
    <div class="settings-header">
      <NButton quaternary @click="onBack">← 返回</NButton>
      <span class="title">设置</span>
    </div>
    <NScrollbar>
      <div class="settings-content">
        <NSpace vertical :size="16">
          <!-- 应用信息 -->
          <NCard title="应用信息" :bordered="false" class="section-card">
            <NSpace vertical :size="12">
              <div class="row">
                <span class="row-label">应用数据目录</span>
                <NText depth="3" class="row-value">{{ appStore.appDataDir || "未初始化" }}</NText>
              </div>
              <div class="row">
                <span class="row-label">数据库路径</span>
                <NText depth="3" class="row-value">{{ appStore.dbPath || "未初始化" }}</NText>
              </div>
              <div class="row">
                <span class="row-label">数据库状态</span>
                <NText :type="appStore.dbReady ? 'success' : 'warning'">
                  {{ appStore.dbReady ? "已就绪" : "未就绪" }}
                </NText>
              </div>
              <NDivider style="margin: 8px 0" />
              <NGrid :cols="4" :x-gap="12" :y-gap="12" responsive="screen">
                <NGi>
                  <NStatistic label="作品" :value="stats?.totalWorks ?? 0" />
                </NGi>
                <NGi>
                  <NStatistic label="媒体文件" :value="stats?.totalFiles ?? 0" />
                </NGi>
                <NGi>
                  <NStatistic label="作者" :value="stats?.totalAuthors ?? 0" />
                </NGi>
                <NGi>
                  <NStatistic label="数据库大小" :value="formatBytes(stats?.dbSizeBytes ?? 0)" />
                </NGi>
              </NGrid>
              <NGrid :cols="2" :x-gap="12" :y-gap="12" responsive="screen">
                <NGi>
                  <NStatistic label="含话题作品" :value="stats?.worksWithTopics ?? 0" />
                </NGi>
                <NGi>
                  <NStatistic label="含隐藏标签" :value="stats?.worksWithHiddenTags ?? 0" />
                </NGi>
              </NGrid>
            </NSpace>
          </NCard>

          <!-- 显示设置 -->
          <NCard title="显示设置" :bordered="false" class="section-card">
            <div>
              <div class="field-label">每页加载作品数</div>
              <NInputNumber
                :value="settingsStore.pageSize"
                :min="10"
                :max="1000"
                :step="10"
                style="width: 100%"
                @update:value="(v: number | null) => settingsStore.update({ pageSize: v ?? 100 })"
              />
              <div class="field-hint">控制作品列表每次加载的数量，影响滚动加载性能</div>
            </div>
          </NCard>

          <!-- 数据管理 -->
          <NCard title="数据管理" :bordered="false" class="section-card">
            <NSpace vertical :size="14">
              <div class="switch-row">
                <div>
                  <div class="field-label">压缩数据库</div>
                  <div class="field-hint">执行 VACUUM 重建数据库文件，回收未使用空间</div>
                </div>
                <NButton :loading="vacuuming" @click="onVacuum">压缩数据库</NButton>
              </div>
              <NDivider style="margin: 4px 0" />
              <div class="switch-row">
                <div>
                  <div class="field-label danger">清空全部数据</div>
                  <div class="field-hint">删除所有作者、作品、文件和缩略图记录，操作不可恢复</div>
                </div>
                <NPopconfirm @positive-click="onClearAllData">
                  <template #trigger>
                    <NButton :loading="clearingData" type="error" ghost>清空全部数据</NButton>
                  </template>
                  此操作将删除所有数据且不可恢复，确定继续吗？
                </NPopconfirm>
              </div>
            </NSpace>
          </NCard>

          <!-- 关于 -->
          <NCard title="关于" :bordered="false" class="section-card">
            <NSpace vertical :size="10">
              <div class="row">
                <span class="row-label">应用名称</span>
                <NText>抖音索引</NText>
              </div>
              <div class="row">
                <span class="row-label">版本</span>
                <NText>{{ APP_VERSION }}</NText>
              </div>
              <div class="row">
                <span class="row-label">描述</span>
                <NText depth="3">抖音作品离线索引与媒体管理桌面应用，支持本地导入、缩略图生成与全文检索</NText>
              </div>
              <NDivider style="margin: 8px 0" />
              <div class="switch-row">
                <div>
                  <div class="field-label">恢复默认设置</div>
                  <div class="field-hint">将所有设置项重置为默认值</div>
                </div>
                <NButton :loading="resetting" @click="onResetSettings">恢复默认</NButton>
              </div>
            </NSpace>
          </NCard>
        </NSpace>
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: #18181c;
  color: #e8e8e8;
  overflow: hidden;
}
.settings-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.settings-header .title {
  font-size: 16px;
  font-weight: 600;
}
.settings-content {
  padding: 16px 18px 32px;
  max-width: 880px;
  margin: 0 auto;
}
.section-card {
  background: rgba(255, 255, 255, 0.04);
  border-radius: 10px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.row-label {
  color: #999;
  min-width: 110px;
  flex-shrink: 0;
}
.row-value {
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
}
.field-label {
  font-size: 13px;
  color: #e8e8e8;
  margin-bottom: 6px;
}
.field-label.danger {
  color: #e88080;
}
.field-hint {
  font-size: 12px;
  color: #777;
  margin-top: 4px;
}
.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.switch-row > div:first-child {
  flex: 1;
}
:deep(.n-card) {
  background: rgba(255, 255, 255, 0.04);
}
:deep(.n-card-header__title) {
  color: #e8e8e8;
  font-weight: 600;
}
:deep(.n-statistic .n-statistic-value__content) {
  color: #ff8559;
}
:deep(.n-statistic .n-statistic__label) {
  color: #999;
}
</style>
