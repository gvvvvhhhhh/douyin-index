<script setup lang="ts">
import { computed } from "vue";
import {
  NModal,
  NButton,
  NInput,
  NSpace,
  NProgress,
  NAlert,
  NSteps,
  NStep,
  NStatistic,
  NDivider,
  NCollapse,
  NCollapseItem,
  useMessage,
  useDialog,
} from "naive-ui";
import { useAppStore } from "@/stores/app";

const props = defineProps<{
  show: boolean;
}>();

const emit = defineEmits<{
  (e: "update:show", v: boolean): void;
  (e: "imported"): void;
}>();

const appStore = useAppStore();
const message = useMessage();
const dialog = useDialog();

const showRef = computed({
  get: () => props.show,
  set: (v) => emit("update:show", v),
});

const progress = computed(() => appStore.progress);
const importing = computed(() => appStore.importing);
const importPaused = computed(() => appStore.importPaused);

const currentStep = computed(() => {
  switch (progress.value.status) {
    case "scanning":
      return 1;
    case "parsing":
      return 2;
    case "matching":
    case "paused":
      return 3;
    case "thumbnails":
      return 4;
    case "done":
      return 5;
    case "error":
      return 5;
    default:
      return 0;
  }
});

async function chooseDir(): Promise<void> {
  const p = await appStore.chooseRootDirectory();
  if (p) message.success(`已选择: ${p}`);
}

async function startImport(): Promise<void> {
  console.log("[DEBUG] ImportPanel startImport clicked");
  try {
    await appStore.startImport();
    if (appStore.progress.status === "done") {
      message.success(appStore.progress.message);
      emit("imported");
      showRef.value = false;
    } else if (appStore.progress.status === "error") {
      message.error(appStore.progress.message);
    }
  } catch (e) {
    console.error("[ERROR] startImport failed:", e);
    message.error(`导入失败: ${e}`);
  }
}

/** 关闭窗口：导入中不中断，转入后台继续（进度为全局状态，重开窗口即可查看） */
function close(): void {
  if (importing.value) {
    showRef.value = false;
    message.info("导入已在后台继续，重新打开此窗口可查看进度");
    return;
  }
  showRef.value = false;
}

/** 暂停/恢复导入 */
function togglePause(): void {
  appStore.toggleImportPause();
}

/** 取消导入：二级确认（保留已匹配入库 / 不导入并回滚） */
function confirmCancel(): void {
  dialog.warning({
    title: "取消导入",
    content:
      "已匹配完成的作品已实时入库。选择如何处理本次导入：",
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
</script>

<template>
  <NModal
    v-model:show="showRef"
    preset="card"
    title="导入作品"
    style="width: 640px; max-width: 92vw"
    :bordered="false"
    @update:show="(v: boolean) => { if (!v && importing) message.info('导入已在后台继续，重新打开此窗口可查看进度'); }"
  >
    <NSpace vertical :size="18">
      <div>
        <div class="label">作品根目录</div>
        <NInput
          :value="appStore.rootPath"
          placeholder="请选择包含 Data/ 和作者文件夹的根目录"
          readonly
        >
          <template #suffix>
            <NButton size="small" type="primary" :disabled="importing" @click="chooseDir">
              选择目录
            </NButton>
          </template>
        </NInput>
      </div>

      <NSteps
        :current="currentStep"
        :status="progress.status === 'error' ? 'error' : progress.status === 'paused' ? 'wait' : 'process'"
        size="small"
      >
        <NStep title="扫描根目录" description="识别作者文件夹与媒体文件" />
        <NStep title="解析Excel" description="提取元数据" />
        <NStep title="匹配入库" description="作品分组并写入数据库" />
        <NStep title="生成缩略图" description="按需懒生成" />
        <NStep title="完成" />
      </NSteps>

      <div v-if="progress.message || importing">
        <NProgress
          type="line"
          :percentage="progress.percent"
          :status="progress.status === 'error' ? 'error' : progress.status === 'done' ? 'success' : 'default'"
          :indicator-placement="'inside'"
          processing
        />
        <div class="progress-msg">{{ progress.message }}</div>
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
      </div>

      <div v-if="progress.totalWorks > 0 || progress.totalFiles > 0" class="stats">
        <NStatistic label="作者" :value="progress.totalAuthors" />
        <NStatistic label="作品" :value="progress.totalWorks" />
        <NStatistic label="媒体文件" :value="progress.totalFiles" />
        <NStatistic label="跳过" :value="progress.skippedFiles" />
      </div>

      <NAlert
        v-if="appStore.lastError"
        type="error"
        title="错误"
        bordered
      >
        {{ appStore.lastError }}
      </NAlert>

      <NAlert
        v-if="!appStore.dbReady"
        type="warning"
        title="数据库未就绪"
        bordered
      >
        正在尝试初始化数据库...
      </NAlert>

      <NAlert
        v-if="progress.errors && progress.errors.length"
        type="warning"
        title="部分错误"
        bordered
      >
        <NCollapse>
          <NCollapseItem :title="`共 ${progress.errors.length} 条错误`">
            <div v-for="(e, i) in progress.errors" :key="i" class="err-line">{{ e }}</div>
          </NCollapseItem>
        </NCollapse>
      </NAlert>

      <NDivider />

      <div class="actions">
        <NSpace>
          <NButton v-if="importing" :disabled="progress.status === 'done'" @click="togglePause">
            {{ importPaused ? "恢复" : "暂停" }}
          </NButton>
          <NButton v-if="importing" type="error" ghost :disabled="progress.status === 'done'" @click="confirmCancel">
            取消导入
          </NButton>
          <NButton v-else @click="close">取消</NButton>
          <NButton
            type="primary"
            :loading="importing && !importPaused"
            :disabled="!appStore.rootPath || importing"
            @click="startImport"
          >
            开始导入
          </NButton>
        </NSpace>
      </div>
    </NSpace>
  </NModal>
</template>

<style scoped>
.label {
  font-size: 13px;
  color: #bbb;
  margin-bottom: 6px;
}
.progress-msg {
  margin-top: 8px;
  font-size: 12px;
  color: #999;
}
.progress-detail {
  margin-top: 4px;
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
.stats {
  display: flex;
  gap: 24px;
  justify-content: space-around;
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
}
.err-line {
  font-size: 12px;
  color: #e88080;
  padding: 2px 0;
  word-break: break-all;
}
.actions {
  display: flex;
  justify-content: flex-end;
}
</style>
