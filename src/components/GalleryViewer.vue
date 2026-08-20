<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";

type PlayMode = 'off' | 'sequential' | 'reverse' | 'loop' | 'random';

const props = defineProps<{
  images: string[];
  title?: string;
  author?: string;
  initialIndex?: number;
  autoPlay?: boolean;
  volume?: number;
  isMuted?: boolean;
  playbackRate?: number;
  clearMode?: boolean;
  controlsHoverShow?: boolean;
  playMode?: PlayMode;
}>();

const emit = defineEmits<{
  (e: "progress", current: number, total: number): void;
  (e: "ended"): void;
  (e: "prev"): void;
  (e: "next"): void;
  (e: "volumeChange", volume: number, muted: boolean): void;
  (e: "speedChange", speed: number): void;
  (e: "clearModeChange", enabled: boolean): void;
  (e: "autoPlayChange", mode: PlayMode): void;
}>();

// 当前播放模式（默认为 'off'）
const currentMode = computed<PlayMode>(() => props.playMode ?? 'off');

function isMode(mode: PlayMode): boolean {
  return currentMode.value === mode;
}

// 当前页码（从 0 开始）
const currentIndex = ref<number>(0);
// 缩放比例
const scale = ref<number>(1);
// 平移偏移（放大状态下拖动）
const panX = ref<number>(0);
const panY = ref<number>(0);
// 加载完成 / 加载失败的图片索引集合
const loadedSet = ref<Set<number>>(new Set());
const errorSet = ref<Set<number>>(new Set());
// 自动轮播定时器
let autoPlayTimer: number | null = null;

// 控制栏相关
const volumePanelOpen = ref<boolean>(false);
const speedPanelOpen = ref<boolean>(false);
const playModePanelOpen = ref<boolean>(false);
const isFullscreen = ref<boolean>(false);
const isPlaying = ref<boolean>(true);

// 二级面板延迟计时器（鼠标在按钮与面板间移动时避免误关闭）
let volumePanelTimer: ReturnType<typeof setTimeout> | null = null;
let speedPanelTimer: ReturnType<typeof setTimeout> | null = null;
let playModePanelTimer: ReturnType<typeof setTimeout> | null = null;

// 进度条相关
const progressBarRef = ref<HTMLDivElement | null>(null);
const isDragging = ref<boolean>(false);

// 拖动平移状态
const isPanning = ref<boolean>(false);
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;
let panMoved = false;

// 单击/双击区分定时器
let clickTimer: number | null = null;
// 滚轮切换页面的节流锁
let wheelLock = false;

const imageAreaRef = ref<HTMLElement | null>(null);

const total = computed<number>(() => props.images.length);

// 将本地图片路径转换为可显示的 URL
const imageUrls = computed<string[]>(() =>
  props.images.map((p) => {
    if (!p) return "";
    try {
      return convertFileSrc(p);
    } catch (e) {
      console.error("convertFileSrc 失败:", p, e);
      return "";
    }
  })
);

// 轨道平移：根据当前页码滑动
const trackStyle = computed(() => ({
  transform: `translateX(${-currentIndex.value * 100}%)`,
  transition: "transform 0.3s ease",
}));

// 当前图片的缩放/平移变换
const currentImageStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
  transition: isPanning.value ? "none" : "transform 0.2s ease",
}));

function emitProgress(): void {
  if (total.value === 0) {
    emit("progress", 0, 0);
  } else {
    emit("progress", currentIndex.value + 1, total.value);
  }
}

function seekToClientX(clientX: number): void {
  const bar = progressBarRef.value;
  if (!bar || total.value === 0) return;
  const rect = bar.getBoundingClientRect();
  let percent = (clientX - rect.left) / rect.width;
  percent = Math.max(0, Math.min(1, percent));
  const newIndex = Math.floor(percent * total.value);
  goTo(newIndex);
}

function onProgressMouseDown(e: MouseEvent): void {
  isDragging.value = true;
  seekToClientX(e.clientX);
  document.addEventListener("mousemove", onProgressDrag);
  document.addEventListener("mouseup", onProgressDragEnd);
}

function onProgressDrag(e: MouseEvent): void {
  if (!isDragging.value) return;
  seekToClientX(e.clientX);
}

function onProgressDragEnd(): void {
  if (!isDragging.value) return;
  isDragging.value = false;
  document.removeEventListener("mousemove", onProgressDrag);
  document.removeEventListener("mouseup", onProgressDragEnd);
}

function onProgressHover(_e: MouseEvent): void {
}

function onProgressLeave(): void {
}

function resetZoom(): void {
  scale.value = 1;
  panX.value = 0;
  panY.value = 0;
}

function goTo(index: number): void {
  if (total.value === 0) return;
  if (index < 0) return;
  if (index >= total.value) {
    // 越过最后一页，通知父组件切换到下一个作品
    emit("ended");
    return;
  }
  if (index === currentIndex.value) return;
  // 切换时重置缩放
  resetZoom();
  currentIndex.value = index;
  emitProgress();
  restartAutoPlay();
}

function next(): void {
  goTo(currentIndex.value + 1);
}

function prev(): void {
  goTo(currentIndex.value - 1);
}

function handlePrev(): void {
  if (currentIndex.value > 0) {
    prev();
  }
}

function handleNext(): void {
  if (currentIndex.value < total.value - 1) {
    next();
  }
}

function startAutoPlay(): void {
  if (!props.autoPlay || !isPlaying.value) return;
  if (autoPlayTimer !== null) {
    window.clearTimeout(autoPlayTimer);
  }
  const speed = props.playbackRate ?? 1;
  const interval = 3000 / speed;

  // 单图作品：sequential/reverse 模式下延时后通知父组件切换到下一个作品
  // off/loop 模式下保持原行为（停留不切换）
  if (total.value <= 1) {
    const mode = props.playMode ?? 'off';
    if (mode === 'off' || mode === 'loop') return;
    autoPlayTimer = window.setTimeout(() => {
      emit("ended");
    }, interval);
    return;
  }

  // 多图作品：按页码顺序自动连播
  autoPlayTimer = window.setTimeout(() => {
    if (currentIndex.value < total.value - 1) {
      next();
    } else {
      const mode = props.playMode ?? 'off';
      if (mode === 'loop') {
        currentIndex.value = 0;
        resetZoom();
        emitProgress();
        startAutoPlay();
      } else if (mode === 'off') {
        stopAutoPlay();
      } else {
        emit("ended");
      }
    }
  }, interval);
}

function restartAutoPlay(): void {
  startAutoPlay();
}

function stopAutoPlay(): void {
  if (autoPlayTimer !== null) {
    window.clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
  }
}

function togglePlay(): void {
  isPlaying.value = !isPlaying.value;
  if (isPlaying.value) {
    startAutoPlay();
  } else {
    stopAutoPlay();
  }
}

function toggleMute(): void {
  emit("volumeChange", props.volume ?? 1, !(props.isMuted ?? false));
}

function onVolumeInput(e: Event): void {
  const target = e.target as HTMLInputElement;
  const volume = parseFloat(target.value);
  emit("volumeChange", volume, volume === 0);
}

function onSpeedClick(speed: number): void {
  emit("speedChange", speed);
}

function onClearModeChange(): void {
  emit("clearModeChange", !(props.clearMode ?? false));
}

function onAutoPlayChange(mode: PlayMode): void {
  emit("autoPlayChange", mode);
}

// ---- 二级面板靠近显示/离开关闭（带延迟计时器，避免按钮与面板间隙误触发） ----
function onVolumePanelEnter(): void {
  if (volumePanelTimer) { clearTimeout(volumePanelTimer); volumePanelTimer = null; }
  volumePanelOpen.value = true;
}
function onVolumePanelLeave(): void {
  volumePanelTimer = setTimeout(() => { volumePanelOpen.value = false; }, 200);
}
function onSpeedPanelEnter(): void {
  if (speedPanelTimer) { clearTimeout(speedPanelTimer); speedPanelTimer = null; }
  speedPanelOpen.value = true;
}
function onSpeedPanelLeave(): void {
  speedPanelTimer = setTimeout(() => { speedPanelOpen.value = false; }, 200);
}
function onPlayModePanelEnter(): void {
  if (playModePanelTimer) { clearTimeout(playModePanelTimer); playModePanelTimer = null; }
  playModePanelOpen.value = true;
}
function onPlayModePanelLeave(): void {
  playModePanelTimer = setTimeout(() => { playModePanelOpen.value = false; }, 200);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.();
  }
}

function onFullscreenChange(): void {
  isFullscreen.value = !!document.fullscreenElement;
}

onMounted(() => {
  document.addEventListener("fullscreenchange", onFullscreenChange);
});

onUnmounted(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange);
});

defineExpose({
  prev: handlePrev,
  next: handleNext,
  hasPrev: () => currentIndex.value > 0,
  hasNext: () => currentIndex.value < total.value - 1,
  startAutoPlay,
  stopAutoPlay,
});

function onImageLoad(index: number): void {
  loadedSet.value.add(index);
}

function onImageError(index: number): void {
  errorSet.value.add(index);
}

function isLoaded(index: number): boolean {
  return loadedSet.value.has(index);
}

function hasError(index: number): boolean {
  return errorSet.value.has(index);
}

// 单击与双击区分：250ms 内未收到第二次点击则视为单击
function onAreaClick(e: MouseEvent): void {
  // 拖动平移后的 mouseup 会触发 click，需忽略
  if (panMoved) {
    panMoved = false;
    return;
  }
  if (clickTimer !== null) {
    window.clearTimeout(clickTimer);
    clickTimer = null;
    onDoubleClick(e);
  } else {
    clickTimer = window.setTimeout(() => {
      clickTimer = null;
      onSingleClick(e);
    }, 250);
  }
}

function onSingleClick(_e: MouseEvent): void {
  togglePlay();
}

function onDoubleClick(_e: MouseEvent): void {
  // 双击在 1x 与 2x 之间切换
  if (scale.value > 1) {
    resetZoom();
  } else {
    scale.value = 2;
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  if (scale.value > 1) {
    // 放大状态下：滚轮调整缩放比例（1x ~ 5x）
    const delta = -e.deltaY * 0.002;
    let nextScale = scale.value + delta;
    nextScale = Math.max(1, Math.min(5, nextScale));
    scale.value = nextScale;
    if (nextScale === 1) {
      panX.value = 0;
      panY.value = 0;
    }
  } else {
    // 未放大状态下：滚轮切换上下页（带节流）
    if (wheelLock) return;
    wheelLock = true;
    window.setTimeout(() => {
      wheelLock = false;
    }, 350);
    if (e.deltaY > 0) {
      next();
    } else if (e.deltaY < 0) {
      prev();
    }
  }
}

// 放大状态下拖动平移
function onImageMouseDown(e: MouseEvent): void {
  if (scale.value <= 1) return;
  e.preventDefault();
  e.stopPropagation();
  isPanning.value = true;
  panMoved = false;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panOriginX = panX.value;
  panOriginY = panY.value;
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
}

function onWindowMouseMove(e: MouseEvent): void {
  if (!isPanning.value) return;
  const dx = e.clientX - panStartX;
  const dy = e.clientY - panStartY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    panMoved = true;
  }
  panX.value = panOriginX + dx;
  panY.value = panOriginY + dy;
}

function onWindowMouseUp(): void {
  isPanning.value = false;
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
}

function init(): void {
  const initIdx = props.initialIndex ?? 0;
  currentIndex.value =
    total.value === 0 ? 0 : Math.max(0, Math.min(total.value - 1, initIdx));
  emitProgress();
  startAutoPlay();
}

watch(
  () => props.images,
  () => {
    loadedSet.value.clear();
    errorSet.value.clear();
    resetZoom();
    init();
  }
);

watch(
  () => props.initialIndex,
  (n) => {
    if (n !== undefined && total.value > 0) {
      const idx = Math.max(0, Math.min(total.value - 1, n));
      if (idx !== currentIndex.value) {
        resetZoom();
        currentIndex.value = idx;
        emitProgress();
      }
    }
  }
);

// 注意：不再通过 controlsHoverShow watcher 关闭二级面板
// 二级面板（音量/倍速/播放方式）由各自的 mouseenter/mouseleave + 延迟计时器管理
// controlsHoverShow 仅控制整个控制栏的可见性（通过 hover-show class 绑定）
// 当任一面板打开时，控制栏通过 hover-show class 自动保持可见

onMounted(() => {
  init();
  // 使用非 passive 监听器以确保 preventDefault 生效
  if (imageAreaRef.value) {
    imageAreaRef.value.addEventListener("wheel", onWheel, { passive: false });
  }
});

onUnmounted(() => {
  if (imageAreaRef.value) {
    imageAreaRef.value.removeEventListener("wheel", onWheel);
  }
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  if (clickTimer !== null) {
    window.clearTimeout(clickTimer);
  }
  if (volumePanelTimer) clearTimeout(volumePanelTimer);
  if (speedPanelTimer) clearTimeout(speedPanelTimer);
  if (playModePanelTimer) clearTimeout(playModePanelTimer);
  stopAutoPlay();
});
</script>

<template>
  <div class="gallery-viewer">
    <!-- 图片显示区域 -->
    <div
      ref="imageAreaRef"
      class="image-area"
      @click="onAreaClick"
    >
      <div class="track" :style="trackStyle">
        <div
          v-for="(url, i) in imageUrls"
          :key="i"
          class="slide"
        >
          <!-- 加载中 spinner -->
          <div v-if="!isLoaded(i) && !hasError(i)" class="loading-wrap">
            <div class="spinner"></div>
          </div>
          <!-- 加载失败提示 -->
          <div v-if="hasError(i)" class="error-wrap">图片加载失败</div>
          <img
            v-if="url"
            :src="url"
            class="slide-img"
            :class="{ current: i === currentIndex }"
            :style="i === currentIndex ? currentImageStyle : null"
            draggable="false"
            loading="lazy"
            alt=""
            @load="onImageLoad(i)"
            @error="onImageError(i)"
            @mousedown="onImageMouseDown"
          />
        </div>
      </div>
    </div>

    <!-- 底部控制栏 -->
    <div class="bottom-bar" :class="{ 'clear-mode': clearMode, 'hover-show': (controlsHoverShow ?? false) || volumePanelOpen || speedPanelOpen || playModePanelOpen }">
      <div
        class="progress-bar"
        @mousedown="onProgressMouseDown"
        @mousemove="onProgressHover"
        @mouseleave="onProgressLeave"
      >
        <div class="progress-outer">
          <div class="progress-list">
            <div
              v-for="(_url, i) in imageUrls"
              :key="i"
              class="progress-segment"
              :class="{ active: i === currentIndex, played: i < currentIndex }"
              @click.stop="goTo(i)"
            >
              <div class="segment-fill"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="controls-row">
        <div class="controls-left">
          <button class="ctrl-icon-btn" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
            <svg v-if="!isPlaying" class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M23.5 15.134C24.1667 15.5189 24.1667 16.4811 23.5 16.866L12.25 23.3612C11.5833 23.7461 10.75 23.265 10.75 22.4952L10.75 9.50481C10.75 8.73501 11.5833 8.25388 12.25 8.63878L23.5 15.134Z" fill="currentColor" />
            </svg>
            <svg v-else class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 8C9.44772 8 9 8.44772 9 9V23C9 23.5523 9.44772 24 10 24H13C13.5523 24 14 23.5523 14 23V9C14 8.44772 13.5523 8 13 8H10Z" fill="currentColor" />
              <path d="M19 8C18.4477 8 18 8.44772 18 9V23C18 23.5523 18.4477 24 19 24H22C22.5523 24 23 23.5523 23 23V9C23 8.44772 22.5523 8 22 8H19Z" fill="currentColor" />
            </svg>
          </button>
          <div class="time-display">
            <span class="time-current">{{ total > 0 ? currentIndex + 1 : 0 }}</span>
            <span class="time-separator">/</span>
            <span class="time-duration">{{ total }}</span>
          </div>
        </div>

        <div class="controls-right">
          <div class="volume-control" @mouseenter="onVolumePanelEnter" @mouseleave="onVolumePanelLeave">
            <button class="ctrl-icon-btn" @click="toggleMute" :title="isMuted ? '取消静音' : '静音'">
              <svg v-if="(props.isMuted ?? false) || (props.volume ?? 1) === 0" class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M11.4525 8.11043L10.7454 7.40332L9.33115 8.81753L10.0383 9.52464L23.4733 22.9597L24.1804 23.6668L25.5946 22.2526L24.8875 21.5455L22.4054 19.0634V10.6468C22.4054 8.31652 19.8647 6.87595 17.8651 8.0724L13.8292 10.4872L11.4525 8.11043ZM15.2874 11.9454L20.4054 17.0634V10.6468C20.4054 9.87002 19.5585 9.38983 18.8919 9.78865L15.2874 11.9454ZM20.0501 22.357L21.4669 23.7738C20.5453 24.6377 19.1017 24.9064 17.8651 24.1664L11.6291 20.4352H9.4054C7.74854 20.4352 6.4054 19.0921 6.4054 17.4352V14.8036C6.4054 13.1468 7.74854 11.8036 9.4054 11.8036H9.49674L11.4967 13.8036H9.4054C8.85311 13.8036 8.4054 14.2513 8.4054 14.8036V17.4352C8.4054 17.9875 8.85311 18.4352 9.4054 18.4352H11.6291C11.9907 18.4352 12.3456 18.5333 12.656 18.719L18.8919 22.4502C19.2856 22.6857 19.7422 22.6147 20.0501 22.357Z" fill="currentColor" />
              </svg>
              <svg v-else-if="(props.volume ?? 1) < 0.5" class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M19.0367 10.4467C19.0367 7.98933 16.2441 6.57427 14.2625 8.02748L10.4733 10.8064C10.3018 10.9322 10.0946 11 9.88192 11H9.03668C7.37983 11 6.03668 12.3431 6.03668 14V18C6.03668 19.6568 7.37983 21 9.03668 21H9.88194C10.0946 21 10.3018 21.0678 10.4733 21.1936L14.2626 23.9724C16.2442 25.4256 19.0367 24.0105 19.0367 21.5532V10.4467ZM15.4453 9.64027C16.1058 9.15586 17.0367 9.62755 17.0367 10.4467V21.5532C17.0367 22.3723 16.1058 22.844 15.4453 22.3596L11.656 19.5808C11.1415 19.2034 10.52 19 9.88194 19H9.03668C8.4844 19 8.03668 18.5523 8.03668 18V14C8.03668 13.4477 8.4844 13 9.03668 13H9.88192C10.52 13 11.1415 12.7965 11.6561 12.4192L15.4453 9.64027ZM23.6663 11.6777L22.844 11.1086L21.7059 12.7532L22.5282 13.3223C23.4087 13.9317 23.9633 14.9105 23.9633 16C23.9633 17.0895 23.4087 18.0683 22.5282 18.6777L21.7059 19.2468L22.844 20.8914L23.6663 20.3223C25.0461 19.3674 25.9633 17.7937 25.9633 16C25.9633 14.2063 25.0461 12.6326 23.6663 11.6777Z" fill="currentColor" />
              </svg>
              <svg v-else class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M13.6523 8.02754C15.6339 6.57433 18.4265 7.98939 18.4265 10.4467V21.5532C18.4265 24.0105 15.6339 25.4256 13.6524 23.9725L9.86308 21.1936C9.69156 21.0679 9.4844 21.0001 9.27171 21.0001H8.42645C6.7696 21.0001 5.42645 19.6569 5.42645 18.0001V14.0001C5.42645 12.3432 6.7696 11.0001 8.42645 11.0001H9.27169C9.48439 11.0001 9.69155 10.9322 9.86307 10.8064L13.6523 8.02754ZM16.4265 10.4467C16.4265 9.62761 15.4956 9.15592 14.8351 9.64033L11.0458 12.4192C10.5313 12.7966 9.90979 13.0001 9.27169 13.0001H8.42645C7.87417 13.0001 7.42645 13.4478 7.42645 14.0001V18.0001C7.42645 18.5523 7.87417 19.0001 8.42645 19.0001H9.27171C9.90979 19.0001 10.5313 19.2035 11.0458 19.5808L14.8351 22.3596C15.4956 22.844 16.4265 22.3723 16.4265 21.5532V10.4467ZM21.2263 11.8253L21.8066 12.6397C22.4855 13.5924 22.8857 14.7511 22.8857 16.0001C22.8857 17.249 22.4855 18.4078 21.8066 19.3605L21.2263 20.1749L19.5975 19.0143L20.1778 18.1999C20.6263 17.5704 20.8857 16.8142 20.8857 16.0001C20.8857 15.1859 20.6263 14.4297 20.1778 13.8003L19.5975 12.9859L21.2263 11.8253ZM24.8066 10.4994L24.2263 9.68498L22.5975 10.8456L23.1778 11.66C24.0603 12.8986 24.5736 14.392 24.5736 16.0004C24.5736 17.6089 24.0603 19.1023 23.1778 20.3408L22.5975 21.1552L24.2263 22.3158L24.8066 21.5014C25.9195 19.9396 26.5736 18.0436 26.5736 16.0004C26.5736 13.9572 25.9195 12.0612 24.8066 10.4994Z" fill="currentColor" />
              </svg>
            </button>
            <div class="volume-slider-panel" :class="{ open: volumePanelOpen }">
              <div class="volume-value">{{ Math.round(((props.isMuted ?? false) ? 0 : (props.volume ?? 1)) * 100) }}</div>
              <div class="volume-bar">
                <div class="volume-drag" :style="{ height: (((props.isMuted ?? false) ? 0 : (props.volume ?? 1)) * 100) + '%' }"></div>
              </div>
              <input
                class="volume-input"
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="(props.isMuted ?? false) ? 0 : (props.volume ?? 1)"
                @input="onVolumeInput"
                @click.stop
                :title="'音量' + Math.round(((props.isMuted ?? false) ? 0 : (props.volume ?? 1)) * 100) + '%'"
              />
            </div>
          </div>

          <div class="speed-control" @mouseenter="onSpeedPanelEnter" @mouseleave="onSpeedPanelLeave">
            <div class="speed-display">{{ props.playbackRate ?? 1 }}x</div>
            <div class="speed-panel" :class="{ open: speedPanelOpen }">
              <div class="speed-content">
                <div class="speed-title">倍速</div>
                <div class="speed-list">
                  <div class="speed-item" :class="{ select: props.playbackRate === 0.75 }" @click="onSpeedClick(0.75); speedPanelOpen = false">0.75x</div>
                  <div class="speed-item" :class="{ select: props.playbackRate === 1 }" @click="onSpeedClick(1); speedPanelOpen = false">1x</div>
                  <div class="speed-item" :class="{ select: props.playbackRate === 1.25 }" @click="onSpeedClick(1.25); speedPanelOpen = false">1.25x</div>
                  <div class="speed-item" :class="{ select: props.playbackRate === 1.5 }" @click="onSpeedClick(1.5); speedPanelOpen = false">1.5x</div>
                  <div class="speed-item" :class="{ select: props.playbackRate === 1.75 }" @click="onSpeedClick(1.75); speedPanelOpen = false">1.75x</div>
                  <div class="speed-item" :class="{ select: props.playbackRate === 2 }" @click="onSpeedClick(2); speedPanelOpen = false">2x</div>
                  <div class="speed-item" :class="{ select: props.playbackRate === 3 }" @click="onSpeedClick(3); speedPanelOpen = false">3x</div>
                </div>
              </div>
            </div>
          </div>

          <button class="ctrl-switch-btn" @click="onClearModeChange" :title="(props.clearMode ?? false) ? '退出清屏' : '清屏'">
            <div class="setting-label">
              <button type="button" class="xg-switch" :class="{ 'is-checked': props.clearMode ?? false }" tabindex="0" :aria-checked="props.clearMode ?? false">
                <span class="xg-switch-inner"></span>
              </button>
              <span class="setting-title">清屏</span>
            </div>
            <div class="ctrl-tips">清屏<span class="shortcut-key">J</span></div>
          </button>

          <div class="play-mode-control" @mouseenter="onPlayModePanelEnter" @mouseleave="onPlayModePanelLeave">
            <div class="play-mode-display" :class="{ active: currentMode !== 'off' }">
              <svg v-show="isMode('off')" class="icon-24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="5" y="6" width="8" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".9" />
                <rect x="5" y="16" width="7" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                <path fill-rule="evenodd" clip-rule="evenodd" d="M16.293 17.793a1 1 0 0 0 1.414 0l2.586-2.586c.63-.63.184-1.707-.707-1.707H18V7a1 1 0 1 0-2 0v6.5h-1.586c-.89 0-1.337 1.077-.707 1.707l2.586 2.586z" fill="currentColor" fill-opacity=".9" />
              </svg>
              <svg v-show="isMode('sequential')" class="icon-24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="5" y="6" width="8" height="2" rx="1" fill="currentColor" />
                <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" />
                <rect x="5" y="16" width="7" height="2" rx="1" fill="currentColor" />
                <path fill-rule="evenodd" clip-rule="evenodd" d="M16.293 17.793a1 1 0 0 0 1.414 0l2.586-2.586c.63-.63.184-1.707-.707-1.707H18V7a1 1 0 1 0-2 0v6.5h-1.586c-.89 0-1.337 1.077-.707 1.707l2.586 2.586z" fill="currentColor" />
              </svg>
              <svg v-show="isMode('reverse')" class="icon-24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="5" y="6" width="7" height="2" rx="1" fill="currentColor" />
                <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" />
                <rect x="5" y="16" width="8.125" height="2" rx="1" fill="currentColor" />
                <path fill-rule="evenodd" clip-rule="evenodd" d="M17.707 6.207a1 1 0 0 0-1.414 0l-2.586 2.586c-.63.63-.184 1.707.707 1.707H16V17a1 1 0 1 0 2 0v-6.5h1.586c.89 0 1.337-1.077.707-1.707l-2.586-2.586z" fill="currentColor" />
              </svg>
              <svg v-show="isMode('loop')" class="icon-24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M5.476 6.22a1 1 0 0 0 0 1.561l2.4 1.92A1 1 0 0 0 9.5 8.918V8H14a4 4 0 0 1 4 4v1a1 1 0 1 0 2 0v-1a6 6 0 0 0-6-6H9.5v-.92a1 1 0 0 0-1.625-.78L5.476 6.22zm12.548 10l-2.4-1.92a1 1 0 0 0-1.624.78V16h-4a4 4 0 0 1-4-4v-1a1 1 0 1 0-2 0v1a6 6 0 0 0 6 6h4v.92a1 1 0 0 0 1.625.78l2.399-1.919a1 1 0 0 0 0-1.562z" fill="currentColor" />
              </svg>
            </div>
            <div class="play-mode-panel" :class="{ open: playModePanelOpen }">
              <div class="play-mode-content">
                <div class="play-mode-title">播放模式</div>
                <div class="play-mode-list">
                  <div class="play-mode-item" :class="{ select: (props.playMode ?? 'off') === 'off' }" @click="onAutoPlayChange('off'); playModePanelOpen = false">
                    <svg class="icon-20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="5" y="6" width="8" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".9" />
                      <rect x="5" y="16" width="7" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M16.293 17.793a1 1 0 0 0 1.414 0l2.586-2.586c.63-.63.184-1.707-.707-1.707H18V7a1 1 0 1 0-2 0v6.5h-1.586c-.89 0-1.337 1.077-.707 1.707l2.586 2.586z" fill="currentColor" fill-opacity=".9" />
                    </svg>
                    <span>不连播</span>
                  </div>
                  <div class="play-mode-item" :class="{ select: props.playMode === 'sequential' }" @click="onAutoPlayChange('sequential'); playModePanelOpen = false">
                    <svg class="icon-20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="5" y="6" width="8" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".9" />
                      <rect x="5" y="16" width="7" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M16.293 17.793a1 1 0 0 0 1.414 0l2.586-2.586c.63-.63.184-1.707-.707-1.707H18V7a1 1 0 1 0-2 0v6.5h-1.586c-.89 0-1.337 1.077-.707 1.707l2.586 2.586z" fill="currentColor" fill-opacity=".9" />
                    </svg>
                    <span>顺序连播</span>
                  </div>
                  <div class="play-mode-item" :class="{ select: props.playMode === 'reverse' }" @click="onAutoPlayChange('reverse'); playModePanelOpen = false">
                    <svg class="icon-20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="5" y="6" width="7" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".9" />
                      <rect x="5" y="16" width="8.125" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M17.707 6.207a1 1 0 0 0-1.414 0l-2.586 2.586c-.63.63-.184 1.707.707 1.707H16V17a1 1 0 1 0 2 0v-6.5h1.586c.89 0 1.337-1.077.707-1.707l-2.586-2.586z" fill="currentColor" fill-opacity=".9" />
                    </svg>
                    <span>倒序连播</span>
                  </div>
                  <div class="play-mode-item" :class="{ select: props.playMode === 'loop' }" @click="onAutoPlayChange('loop'); playModePanelOpen = false">
                    <svg class="icon-20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M5.476 6.22a1 1 0 0 0 0 1.561l2.4 1.92A1 1 0 0 0 9.5 8.918V8H14a4 4 0 0 1 4 4v1a1 1 0 1 0 2 0v-1a6 6 0 0 0-6-6H9.5v-.92a1 1 0 0 0-1.625-.78L5.476 6.22zm12.548 10l-2.4-1.92a1 1 0 0 0-1.624.78V16h-4a4 4 0 0 1-4-4v-1a1 1 0 1 0-2 0v1a6 6 0 0 0 6 6h4v.92a1 1 0 0 0 1.625.78l2.399-1.919a1 1 0 0 0 0-1.562z" fill="currentColor" fill-opacity=".9" />
                    </svg>
                    <span>循环播放</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="ctrl-tips">播放模式<span class="shortcut-key">K</span></div>
          </div>

          <button class="ctrl-icon-btn" @click="toggleFullscreen" :title="isFullscreen ? '退出全屏' : '进入全屏'">
            <svg v-if="!isFullscreen" class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 8.25C9.54086 8.25 7.75 10.0409 7.75 12.25V12.75V13.75H9.75V12.75V12.25C9.75 11.1454 10.6454 10.25 11.75 10.25H12.25H13.25V8.25H12.25H11.75ZM20.25 8.25C22.4591 8.25 24.25 10.0409 24.25 12.25V12.75V13.75H22.25V12.75V12.25C22.25 11.1454 21.3546 10.25 20.25 10.25H19.75H18.75V8.25H19.75H20.25ZM7.75 19.75C7.75 21.9591 9.54086 23.75 11.75 23.75H12.25H13.25V21.75H12.25H11.75C10.6454 21.75 9.75 20.8546 9.75 19.75V19.25V18.25H7.75V19.25V19.75ZM20.25 23.75C22.4591 23.75 24.25 21.9591 24.25 19.75V19.25V18.25H22.25V19.25V19.75C22.25 20.8546 21.3546 21.75 20.25 21.75H19.75H18.75V23.75H19.75H20.25Z" fill="currentColor" />
            </svg>
            <svg v-else class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M9.25 13.75C11.4591 13.75 13.25 11.9591 13.25 9.75V9.25V8.25H11.25V9.25V9.75C11.25 10.8546 10.3546 11.75 9.25 11.75H8.75H7.75V13.75H8.75H9.25ZM22.75 13.75C20.5409 13.75 18.75 11.9591 18.75 9.75V9.25V8.25H20.75V9.25V9.75C20.75 10.8546 21.6454 11.75 22.75 11.75H23.25H24.25V13.75H23.25H22.75ZM13.25 22.25C13.25 20.0409 11.4591 18.25 9.25 18.25H8.75H7.75V20.25H8.75H9.25C10.3546 20.25 11.25 21.1454 11.25 22.25V22.75V23.75H13.25V22.75V22.25ZM22.75 18.25C20.5409 18.25 18.75 20.0409 18.75 22.25V22.75V23.75H20.75V22.75V22.25C20.75 21.1454 21.6454 20.25 22.75 20.25H23.25H24.25V18.25H23.25H22.75Z" fill="currentColor" />
            </svg>
            <div class="ctrl-tips">进入全屏<span class="shortcut-key">H</span></div>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gallery-viewer {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #18181c;
  color: #e8e8e8;
  position: relative;
  overflow: hidden;
}

/* 顶部信息栏 */
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: rgba(0, 0, 0, 0.7);
  transition: opacity 0.3s ease, transform 0.3s ease;
  flex-shrink: 0;
  z-index: 2;
}
.top-bar.hidden {
  opacity: 0;
  transform: translateY(-100%);
  pointer-events: none;
}
.info-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.title {
  font-size: 15px;
  font-weight: 500;
  color: #e8e8e8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.author {
  font-size: 13px;
  color: #ff8559;
}

/* 图片显示区域 */
.image-area {
  flex: 1;
  background: #000;
  position: relative;
  overflow: hidden;
  cursor: pointer;
}
.track {
  display: flex;
  width: 100%;
  height: 100%;
  will-change: transform;
}
.slide {
  flex: 0 0 100%;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}
.slide-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
  transform-origin: center center;
  pointer-events: auto;
}
.slide-img.current {
  cursor: grab;
}
.slide-img.current:active {
  cursor: grabbing;
}

/* 加载中 spinner */
.loading-wrap {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1;
  pointer-events: none;
}
.spinner {
  width: 36px;
  height: 36px;
  border: 3px solid rgba(255, 255, 255, 0.15);
  border-top-color: #ff6b35;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-wrap {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #888;
  font-size: 14px;
  z-index: 1;
  pointer-events: none;
}

/* 底部控制栏 */
.bottom-bar {
  flex: 0 0 auto;
  background: transparent;
  padding: 0 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 0;
  z-index: 5;
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.bottom-bar.clear-mode {
  opacity: 0;
  transform: translateY(10px);
  pointer-events: none;
}
.bottom-bar.clear-mode.hover-show {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

/* 右侧按钮组始终可见，二级面板靠近显示 */

.progress-bar {
  position: relative;
  width: 100%;
  height: 24px;
  display: flex;
  align-items: center;
  cursor: pointer;
}
.progress-outer {
  position: relative;
  width: 100%;
  height: 4px;
}
.progress-list {
  display: flex;
  width: 100%;
  height: 100%;
  gap: 3px;
}
.progress-segment {
  flex: 1;
  height: 100%;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 2px;
  position: relative;
  cursor: pointer;
  transition: all 0.2s ease;
}
.progress-segment:hover {
  background: rgba(255, 255, 255, 0.3);
}
.progress-segment.played {
  background: #ff6b35;
}
.progress-segment.active {
  background: #ff6b35;
}
.progress-segment.active .segment-dot {
  display: block;
}
.segment-fill {
  width: 100%;
  height: 100%;
}
.segment-dot {
  display: none;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 8px;
  height: 8px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 0 6px rgba(255, 107, 53, 0.6);
}

.controls-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 40px;
  margin-top: 4px;
}

.controls-left,
.controls-right {
  display: flex;
  align-items: center;
  gap: 4px;
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

.icon-32 {
  width: 32px;
  height: 32px;
  display: block;
}

.ctrl-switch-btn {
  position: relative;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  height: 32px;
  padding: 0 4px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease;
}
.setting-label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.setting-title {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.9);
}

.xg-switch {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.2);
  cursor: pointer;
  transition: background 0.2s ease;
  vertical-align: middle;
}
.xg-switch.is-checked {
  background: #ff6b35;
}
.xg-switch-inner {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s ease;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}
.xg-switch.is-checked .xg-switch-inner {
  transform: translateX(14px);
}

.ctrl-tips {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.85);
  color: #fff;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: all 0.2s ease;
  pointer-events: none;
  z-index: 100;
}
.ctrl-icon-btn:hover .ctrl-tips,
.ctrl-switch-btn:hover .ctrl-tips {
  opacity: 1;
  visibility: visible;
}
.shortcut-key {
  margin-left: 4px;
  opacity: 0.6;
  font-size: 11px;
}

.time-display {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  font-variant-numeric: tabular-nums;
  user-select: none;
  white-space: nowrap;
  margin-left: 4px;
}
.time-current {
  color: rgba(255, 255, 255, 0.9);
}
.time-separator {
  color: rgba(255, 255, 255, 0.6);
  margin: 0 2px;
}
.time-duration {
  color: rgba(255, 255, 255, 0.6);
}

.volume-control {
  position: relative;
  display: flex;
  align-items: center;
}
.volume-slider-panel {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  width: 32px;
  height: 0;
  opacity: 0;
  visibility: hidden;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  background: rgba(24, 24, 28, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
}
/* 透明桥接：消除按钮与面板之间的 4px 间隙，避免 mouseleave 误触发 */
.volume-slider-panel::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: 4px;
}
.volume-slider-panel.open {
  height: 100px;
  opacity: 1;
  visibility: visible;
}
.volume-value {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.9);
  margin-bottom: 6px;
  font-variant-numeric: tabular-nums;
}
.volume-bar {
  position: relative;
  width: 4px;
  flex: 1;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  overflow: hidden;
}
.volume-drag {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  background: #ff6b35;
  border-radius: 2px;
}
.volume-input {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%) rotate(-90deg);
  transform-origin: center center;
  width: 100px;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.play-mode-control {
  position: relative;
  display: flex;
  align-items: center;
  height: 32px;
  cursor: pointer;
}
.play-mode-display {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  color: rgba(255, 255, 255, 0.6);
  transition: color 0.15s ease;
}
.play-mode-display.active {
  color: #ff6b35;
}
.play-mode-control:hover .play-mode-display {
  color: #fff;
}
.play-mode-control:hover .play-mode-display.active {
  color: #ff8559;
}
.play-mode-panel {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  transition: all 0.2s ease;
  background: rgba(24, 24, 28, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 8px;
  z-index: 50;
}
/* 透明桥接：消除按钮与面板之间的 4px 间隙，避免 mouseleave 误触发 */
.play-mode-panel::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: 4px;
}
.play-mode-panel.open {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}
.play-mode-content {
  display: flex;
  flex-direction: column;
}
.play-mode-title {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  padding: 0 6px 8px;
  text-align: center;
}
.play-mode-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.play-mode-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  border-radius: 4px;
}
.play-mode-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.play-mode-item.select {
  background: rgba(255, 107, 53, 0.15);
  color: #ff6b35;
  font-weight: 600;
}
.icon-24 {
  width: 24px;
  height: 24px;
}
.icon-20 {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.speed-control {
  position: relative;
  display: flex;
  align-items: center;
  height: 32px;
  cursor: pointer;
}
.speed-display {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  padding: 0 4px;
  font-variant-numeric: tabular-nums;
  transition: color 0.15s ease;
}
.speed-control:hover .speed-display {
  color: #fff;
}
.speed-panel {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  transition: all 0.2s ease;
  background: rgba(24, 24, 28, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 8px;
  z-index: 50;
}
/* 透明桥接：消除按钮与面板之间的 4px 间隙，避免 mouseleave 误触发 */
.speed-panel::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: 4px;
}
.speed-panel.open {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}
.speed-content {
  display: flex;
  flex-direction: column;
}
.speed-title {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  padding: 0 6px 8px;
  text-align: center;
}
.speed-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.speed-item {
  padding: 6px 12px;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  text-align: center;
  border-radius: 4px;
}
.speed-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.speed-item.select {
  background: rgba(255, 107, 53, 0.15);
  color: #ff6b35;
  font-weight: 600;
}
.page-indicator {
  font-size: 14px;
  color: #e8e8e8;
  font-variant-numeric: tabular-nums;
  min-width: 80px;
  text-align: center;
}
</style>
