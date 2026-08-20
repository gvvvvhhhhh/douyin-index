<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { WorkWithFiles } from "@/types";

// 图片扩展名：直接用原图显示，零 IPC 调用
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "jfif"]);
// 视频扩展名：用 <video> 元素显示首帧
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "flv", "webm", "m4v"]);

const props = defineProps<{
  work: WorkWithFiles;
}>();

const emit = defineEmits<{
  (e: "click", work: WorkWithFiles): void;
}>();

const thumbDataUrl = ref<string>("");
const loadingThumb = ref<boolean>(false);
const error = ref<string>("");
const isPlaceholder = ref<boolean>(false);
const cardRef = ref<HTMLElement | null>(null);
const isInView = ref<boolean>(false);
let retryCount = ref<number>(0);

// 视频首帧显示相关状态
const videoSrc = ref<string>("");
const videoReady = ref<boolean>(false);
const videoLoadedOnce = ref<boolean>(false);

const fileCount = computed(() => props.work.files.length);

// 是否为视频封面（首个文件是视频）
const isVideoCover = computed<boolean>(() => {
  const f = props.work.files[0];
  if (!f) return false;
  const ext = (f.extension || "").toLowerCase();
  return VIDEO_EXTS.has(ext);
});

const publishTimeText = computed(() => {
  const t = props.work.work.publish_time;
  if (!t) return "";
  try {
    const d = new Date(t * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
});

const titleText = computed(() => props.work.work.title || "(无标题)");
// 集合作者的作品（收藏/喜欢）显示 "千寻-收藏" 格式，而非"枫临的收藏"
const authorName = computed(() => {
  const w = props.work.work;
  if (w.original_author) {
    const shortType = w.source_type ? w.source_type.replace(/作品$/, "") : "";
    // 只有收藏/喜欢作品才显示 "作者-类型" 格式，发布作品直接显示作者名
    if (shortType === "收藏" || shortType === "喜欢") {
      return `${w.original_author}-${shortType}`;
    }
    return w.original_author;
  }
  return props.work.author?.name ?? "";
});

const likeCount = computed(() => props.work.work.like_count ?? 0);

async function loadThumbnail(force: boolean = false): Promise<void> {
  const coverFile = props.work.files[0];
  if (!coverFile) {
    isPlaceholder.value = true;
    console.warn("作品无文件:", props.work.work.title, props.work.work.id);
    return;
  }
  if (loadingThumb.value) return;
  if (!isInView.value && !force) return;

  const ext = (coverFile.extension || "").toLowerCase();

  // 图片文件：直接用原图，零 IPC 调用，浏览器原生异步解码
  if (IMAGE_EXTS.has(ext)) {
    if (!force && thumbDataUrl.value && !isPlaceholder.value) return;
    try {
      const url = convertFileSrc(coverFile.absolute_path);
      // force 刷新时加时间戳避免浏览器缓存
      thumbDataUrl.value = force ? `${url}?t=${Date.now()}` : url;
      isPlaceholder.value = false;
      retryCount.value = 0;
    } catch (e) {
      error.value = String(e);
      isPlaceholder.value = true;
    }
    return;
  }

  // 视频文件：用 <video> 元素显示首帧
  if (VIDEO_EXTS.has(ext)) {
    // 已加载过 video 首帧 → 保持显示，无需重载（回溯零开销，与图片一致）
    if (!force && videoLoadedOnce.value && videoSrc.value) return;
    loadVideoFirstFrame(coverFile.absolute_path, force);
    return;
  }

  // 其他类型：占位
  isPlaceholder.value = true;
}

/**
 * 用 <video> 元素显示视频首帧
 * 直接用 convertFileSrc 原路径 + #t=0.1 锚点让浏览器 seek 到首帧渲染（避开纯黑片头）。
 * preload="metadata" 只加载元数据 + 首帧，不解码整段视频。
 */
function loadVideoFirstFrame(path: string, force: boolean = false): void {
  loadingThumb.value = true;
  error.value = "";
  if (force) {
    videoReady.value = false;
    videoLoadedOnce.value = false;
  }
  videoSrc.value = convertFileSrc(path) + "#t=0.1";
  // 等待 @loadeddata/@error 事件回调，loadingThumb 在事件中重置
}

/** video 元素首帧渲染就绪（@loadeddata 触发） */
function onVideoFrameReady(): void {
  videoReady.value = true;
  videoLoadedOnce.value = true;
  loadingThumb.value = false;
  retryCount.value = 0;
}

/** video 元素加载失败（@error 触发）→ 显示占位图（损坏视频或不支持编码） */
function onVideoError(): void {
  console.warn("video 首帧渲染失败:", videoSrc.value);
  videoSrc.value = "";
  videoReady.value = false;
  isPlaceholder.value = true;
  loadingThumb.value = false;
}

let observer: IntersectionObserver | null = null;

onMounted(() => {
  if (cardRef.value) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          isInView.value = entry.isIntersecting;
          if (entry.isIntersecting) {
            loadThumbnail();
          }
          // 离开视口：video 首帧加载不主动取消（metadata 模式加载量小，保留已加载首帧供回溯）
        }
      },
      {
        rootMargin: "200px",
        threshold: 0,
      }
    );
    observer.observe(cardRef.value);
  }
});

onUnmounted(() => {
  observer?.disconnect();
});

function onClick(): void {
  emit("click", props.work);
}
</script>

<template>
  <div class="work-card" ref="cardRef" :data-work-id="work.work.id" @click="onClick">
    <div class="thumb-wrap">
      <!-- 加载中：video 等待首帧渲染 或 ffmpeg 生成中（绝对定位盖在内容上） -->
      <div v-if="loadingThumb && !videoReady" class="thumb-loading">
        <div class="spinner"></div>
      </div>
      <!-- 视频首帧：videoSrc 设置后即挂载，加载完成前透明，就绪后淡入 -->
      <video
        v-if="isVideoCover && videoSrc"
        :src="videoSrc"
        preload="metadata"
        muted
        playsinline
        class="thumb"
        :style="{ opacity: videoReady ? 1 : 0, transition: 'opacity 0.2s' }"
        @loadeddata="onVideoFrameReady"
        @error="onVideoError"
      />
      <!-- 图片 / ffmpeg 兜底取帧 -->
      <img
        v-else-if="thumbDataUrl"
        :src="thumbDataUrl"
        class="thumb"
        :class="{ placeholder: isPlaceholder }"
        loading="lazy"
        alt=""
      />
      <!-- 占位 -->
      <div v-else-if="!loadingThumb" class="thumb-fallback">
        <div class="fallback-icon">🎬</div>
      </div>
      <div v-if="fileCount > 1" class="badge-count">{{ fileCount }} 张</div>
      <div v-if="likeCount > 0" class="badge-like">
        <span class="like-icon">♥</span>
        {{ likeCount >= 10000 ? (likeCount / 10000).toFixed(1) + "w" : likeCount }}
      </div>
    </div>
    <div class="info">
      <div class="title" :title="titleText">{{ titleText }}</div>
      <div class="meta">
        <span v-if="authorName" class="author">{{ authorName }}</span>
        <span v-if="publishTimeText" class="time">{{ publishTimeText }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.work-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  /* 优化：仅 transition 触发 GPU 合成的属性，避免 all 导致 background 等触发 repaint */
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
  display: flex;
  flex-direction: column;
  /* 优化：离屏卡片跳过渲染，配合 contain-intrinsic-size 占位避免滚动条跳动 */
  content-visibility: auto;
  contain-intrinsic-size: 220px 280px;
  /* 优化：隔离卡片渲染，避免影响兄弟元素的重排/重绘 */
  contain: layout style paint;
}
.work-card:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 107, 53, 0.5);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: #1a1a1a;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}
.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(255, 255, 255, 0.15);
  border-top-color: #ff6b35;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.thumb-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #555;
  font-size: 14px;
  width: 100%;
  height: 100%;
}
.fallback-icon {
  font-size: 36px;
  opacity: 0.4;
}
.badge-count {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
}
.badge-like {
  position: absolute;
  bottom: 6px;
  right: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #ff6b6b;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 3px;
}
.like-icon {
  font-size: 10px;
}
.info {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.title {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  color: #e8e8e8;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  min-height: 2.8em;
}
.meta {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: #999;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.author {
  color: #ff8559;
}
</style>
