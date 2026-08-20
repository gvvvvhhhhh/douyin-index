<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";

type PlayMode = 'off' | 'sequential' | 'reverse' | 'loop' | 'random';

const props = defineProps<{
  src: string;
  title?: string;
  author?: string;
  chapterTitle?: string;
  initialProgress?: number;
  autoPlay?: boolean;
  volume?: number;
  isMuted?: boolean;
  playbackRate?: number;
  clearMode?: boolean;
  controlsHoverShow?: boolean;
  playMode?: PlayMode;
  paused?: boolean;
}>();

const emit = defineEmits<{
  (e: "progress", current: number, total: number): void;
  (e: "ended"): void;
  (e: "play"): void;
  (e: "pause"): void;
  (e: "watchLater"): void;
  (e: "nextChapter"): void;
  (e: "volume-change", volume: number, muted: boolean): void;
  (e: "speed-change", speed: number): void;
  (e: "clear-mode-change", enabled: boolean): void;
  (e: "auto-play-change", mode: PlayMode): void;
}>();

const speedOptions: number[] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0];

// 当前播放模式（默认为 'off'）
const currentMode = computed<PlayMode>(() => props.playMode ?? 'off');

function isMode(mode: PlayMode): boolean {
  return currentMode.value === mode;
}

const containerRef = ref<HTMLDivElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const progressBarRef = ref<HTMLDivElement | null>(null);

const isPlaying = ref<boolean>(false);
const currentTime = ref<number>(0);
const duration = ref<number>(0);
const waiting = ref<boolean>(false);

const volume = ref<number>(props.volume ?? 1);
const isMuted = ref<boolean>(props.isMuted ?? false);
const lastVolume = ref<number>(props.volume ?? 1);
const volumePanelOpen = ref<boolean>(false);

const playbackRate = ref<number>(props.playbackRate ?? 1.0);
const isFullscreen = ref<boolean>(false);
const clearMode = ref<boolean>(props.clearMode ?? false);
const controlsHoverShow = computed<boolean>(() => props.controlsHoverShow ?? false);
const autoPlayNext = ref<boolean>((props.playMode ?? 'off') !== 'off');
const playModePanelOpen = ref<boolean>(false);
const speedPanelOpen = ref<boolean>(false);

const isDragging = ref<boolean>(false);
const hoverPercent = ref<number | null>(null);
const hoverTime = ref<number | null>(null);

let lastProgressEmitTs = 0;
let volumePanelTimer: ReturnType<typeof setTimeout> | null = null;
let speedPanelTimer: ReturnType<typeof setTimeout> | null = null;
let playModePanelTimer: ReturnType<typeof setTimeout> | null = null;

const videoUrl = computed<string>(() => {
  if (!props.src) return "";
  try {
    return convertFileSrc(props.src);
  } catch {
    return props.src;
  }
});

const progressPercent = computed<number>(() => {
  if (!duration.value || !isFinite(duration.value)) return 0;
  return Math.min(100, (currentTime.value / duration.value) * 100);
});

const bufferedPercent = computed<number>(() => {
  const video = videoRef.value;
  if (!video || !duration.value || !isFinite(duration.value)) return 0;
  try {
    if (video.buffered.length === 0) return 0;
    const end = video.buffered.end(video.buffered.length - 1);
    return Math.min(100, (end / duration.value) * 100);
  } catch {
    return 0;
  }
});

const volumePercent = computed<number>(() => {
  if (isMuted.value) return 0;
  return Math.round(volume.value * 100);
});

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const currentTimeText = computed<string>(() => formatTime(currentTime.value));
const durationText = computed<string>(() => formatTime(duration.value));

function togglePlay(): void {
  const video = videoRef.value;
  if (!video) return;
  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function onVideoAreaClick(): void {
  togglePlay();
}

function onLoadedMetadata(): void {
  const video = videoRef.value;
  if (!video) return;
  duration.value = video.duration || 0;

  if (props.volume !== undefined) {
    video.volume = props.volume;
    volume.value = props.volume;
  }
  if (props.isMuted !== undefined) {
    video.muted = props.isMuted;
    isMuted.value = props.isMuted;
  }
  if (props.playbackRate !== undefined) {
    video.playbackRate = props.playbackRate;
    playbackRate.value = props.playbackRate;
  }

  if (
    props.initialProgress !== undefined &&
    props.initialProgress > 0 &&
    isFinite(duration.value) &&
    props.initialProgress < duration.value
  ) {
    try {
      video.currentTime = props.initialProgress;
      currentTime.value = props.initialProgress;
    } catch {
      /* ignore */
    }
  }
  if (props.autoPlay && !props.paused) {
    video.play().catch(() => {});
  }
}

/**
 * 视频首帧解码成功（loadeddata 事件，保留事件绑定用于未来扩展）
 */
function onLoadedData(): void {
  // 目前无额外处理
}

function onTimeUpdate(): void {
  if (isDragging.value) return;
  const video = videoRef.value;
  if (!video) return;
  currentTime.value = video.currentTime;
  const now = Date.now();
  if (now - lastProgressEmitTs >= 1000) {
    lastProgressEmitTs = now;
    emit("progress", currentTime.value, duration.value);
  }
}

function onDurationChange(): void {
  const video = videoRef.value;
  if (video) duration.value = video.duration || 0;
}

function onPlay(): void {
  isPlaying.value = true;
  emit("play");
}

function onPause(): void {
  isPlaying.value = false;
  emit("pause");
}

function onEnded(): void {
  isPlaying.value = false;
  const mode = props.playMode ?? 'off';
  if (mode === 'loop') {
    const video = videoRef.value;
    if (video) {
      video.currentTime = 0;
      // 隐藏时不自动重播（避免 v-show 隐藏的播放器发出声音）
      if (!props.paused) {
        video.play().catch(() => {});
      }
    }
  } else {
    emit("ended");
  }
}

function onWaiting(): void {
  waiting.value = true;
}

function onPlaying(): void {
  waiting.value = false;
}

function onVolumeChange(): void {
  const video = videoRef.value;
  if (!video) return;
  volume.value = video.volume;
  isMuted.value = video.muted;
  emit("volume-change", video.volume, video.muted);
}

function toggleMute(): void {
  const video = videoRef.value;
  if (!video) return;
  if (video.muted) {
    video.muted = false;
    if (video.volume === 0) {
      video.volume = lastVolume.value || 1;
    }
  } else {
    lastVolume.value = video.volume > 0 ? video.volume : 1;
    video.muted = true;
  }
  emit("volume-change", video.volume, video.muted);
}

function onVolumeInput(e: Event): void {
  const video = videoRef.value;
  if (!video) return;
  const target = e.target as HTMLInputElement;
  const v = parseFloat(target.value);
  video.volume = v;
  video.muted = v === 0;
  lastVolume.value = v > 0 ? v : lastVolume.value;
  emit("volume-change", v, v === 0);
}

function onVolumePanelEnter(): void {
  if (volumePanelTimer) {
    clearTimeout(volumePanelTimer);
    volumePanelTimer = null;
  }
  volumePanelOpen.value = true;
}

function onVolumePanelLeave(): void {
  volumePanelTimer = setTimeout(() => {
    volumePanelOpen.value = false;
  }, 200);
}

function onSpeedPanelEnter(): void {
  if (speedPanelTimer) {
    clearTimeout(speedPanelTimer);
    speedPanelTimer = null;
  }
  speedPanelOpen.value = true;
}

function onSpeedPanelLeave(): void {
  speedPanelTimer = setTimeout(() => {
    speedPanelOpen.value = false;
  }, 200);
}

function onPlayModePanelEnter(): void {
  if (playModePanelTimer) {
    clearTimeout(playModePanelTimer);
    playModePanelTimer = null;
  }
  playModePanelOpen.value = true;
}

function onPlayModePanelLeave(): void {
  playModePanelTimer = setTimeout(() => {
    playModePanelOpen.value = false;
  }, 200);
}

function seekToClientX(clientX: number): void {
  const bar = progressBarRef.value;
  const video = videoRef.value;
  if (!bar || !video || !duration.value || !isFinite(duration.value)) return;
  const rect = bar.getBoundingClientRect();
  let percent = (clientX - rect.left) / rect.width;
  percent = Math.max(0, Math.min(1, percent));
  const newTime = percent * duration.value;
  video.currentTime = newTime;
  currentTime.value = newTime;
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
  emit("progress", currentTime.value, duration.value);
}

function onProgressHover(e: MouseEvent): void {
  const bar = progressBarRef.value;
  if (!bar || !duration.value || !isFinite(duration.value)) return;
  const rect = bar.getBoundingClientRect();
  let percent = (e.clientX - rect.left) / rect.width;
  percent = Math.max(0, Math.min(1, percent));
  hoverPercent.value = percent * 100;
  hoverTime.value = percent * duration.value;
}

function onProgressLeave(): void {
  hoverPercent.value = null;
  hoverTime.value = null;
}

function selectSpeed(speed: number): void {
  playbackRate.value = speed;
  emit("speed-change", speed);
}

function toggleFullscreen(): void {
  const container = containerRef.value;
  if (!container) return;
  if (!document.fullscreenElement) {
    container
      .requestFullscreen()
      .then(() => {
        isFullscreen.value = true;
      })
      .catch(() => {});
  } else {
    document
      .exitFullscreen()
      .then(() => {
        isFullscreen.value = false;
      })
      .catch(() => {});
  }
}

function onFullscreenChange(): void {
  isFullscreen.value = !!document.fullscreenElement;
}

function toggleClearMode(): void {
  clearMode.value = !clearMode.value;
  emit("clear-mode-change", clearMode.value);
}

function toggleAutoPlay(): void {
  const modes: PlayMode[] = ['off', 'sequential', 'reverse', 'loop'];
  const current = props.playMode ?? 'off';
  const idx = modes.indexOf(current);
  const nextMode = modes[(idx + 1) % modes.length];
  emit("auto-play-change", nextMode);
}

function onPlayModeSelect(mode: PlayMode): void {
  emit("auto-play-change", mode);
}

function handleNextChapter(): void {
  emit("nextChapter");
}

watch(playbackRate, (val: number) => {
  if (videoRef.value) videoRef.value.playbackRate = val;
});

watch(
  () => props.volume,
  (val) => {
    if (val !== undefined && videoRef.value) {
      videoRef.value.volume = val;
      volume.value = val;
    }
  }
);

watch(
  () => props.isMuted,
  (val) => {
    if (val !== undefined && videoRef.value) {
      videoRef.value.muted = val;
      isMuted.value = val;
    }
  }
);

watch(
  () => props.playbackRate,
  (val) => {
    if (val !== undefined) {
      playbackRate.value = val;
      if (videoRef.value) videoRef.value.playbackRate = val;
    }
  }
);

watch(
  () => props.clearMode,
  (val) => {
    if (val !== undefined) {
      clearMode.value = val;
    }
  },
  { immediate: true }
);

watch(
  () => props.playMode,
  (val) => {
    autoPlayNext.value = (val ?? 'off') !== 'off';
  }
);

watch(
  () => props.src,
  () => {
    currentTime.value = 0;
    duration.value = 0;
    isPlaying.value = false;
    lastProgressEmitTs = 0;
  },
  { immediate: true }
);

// v-show 隐藏时暂停播放，显示时恢复（保持视频状态不丢失）
watch(
  () => props.paused,
  (isPaused) => {
    const video = videoRef.value;
    if (!video) return;
    if (isPaused) {
      video.pause();
    } else if (props.autoPlay) {
      video.play().catch(() => {});
    }
  }
);

// 注意：不再通过 controlsHoverShow watcher 关闭二级面板
// 二级面板（音量/倍速/播放方式）由各自的 mouseenter/mouseleave + 延迟计时器管理
// controlsHoverShow 仅控制整个控制栏的可见性（通过 hover-show class 绑定）
// 当任一面板打开时，控制栏通过 hover-show class 自动保持可见

function onKeyDown(e: KeyboardEvent): void {
  if (e.target instanceof HTMLInputElement) return;
  switch (e.key.toLowerCase()) {
    case " ":
      e.preventDefault();
      togglePlay();
      break;
    case "h":
      toggleFullscreen();
      break;
    case "j":
      toggleClearMode();
      break;
    case "k":
      toggleAutoPlay();
      break;
    case "arrowleft":
      if (videoRef.value) {
        videoRef.value.currentTime = Math.max(0, videoRef.value.currentTime - 5);
      }
      break;
    case "arrowright":
      if (videoRef.value) {
        videoRef.value.currentTime = Math.min(duration.value, videoRef.value.currentTime + 5);
      }
      break;
    case "arrowup":
      e.preventDefault();
      if (videoRef.value) {
        videoRef.value.volume = Math.min(1, videoRef.value.volume + 0.1);
        videoRef.value.muted = false;
      }
      break;
    case "arrowdown":
      e.preventDefault();
      if (videoRef.value) {
        videoRef.value.volume = Math.max(0, videoRef.value.volume - 0.1);
      }
      break;
    case "m":
      toggleMute();
      break;
  }
}

onMounted(() => {
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("keydown", onKeyDown);
});

onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("mousemove", onProgressDrag);
  document.removeEventListener("mouseup", onProgressDragEnd);
  if (volumePanelTimer) clearTimeout(volumePanelTimer);
  if (speedPanelTimer) clearTimeout(speedPanelTimer);
  if (playModePanelTimer) clearTimeout(playModePanelTimer);
});
</script>

<template>
  <div class="video-player" ref="containerRef" :class="{ 'is-clear-mode': clearMode }">
    <!-- 视频播放区 -->
    <div class="video-area" @click="onVideoAreaClick">
      <!-- 视频元素 -->
      <video
        ref="videoRef"
        class="video-el"
        :src="videoUrl"
        playsinline
        preload="metadata"
        @loadedmetadata="onLoadedMetadata"
        @loadeddata="onLoadedData"
        @durationchange="onDurationChange"
        @timeupdate="onTimeUpdate"
        @play="onPlay"
        @pause="onPause"
        @ended="onEnded"
        @waiting="onWaiting"
        @playing="onPlaying"
        @volumechange="onVolumeChange"
      ></video>

      <!-- 缓冲加载指示器 -->
      <div v-if="waiting" class="buffering">
        <div class="spinner"></div>
      </div>

    </div>

    <!-- 底部控制栏 -->
    <div class="controls-bar" :class="{ 'clear-mode': clearMode, 'hover-show': controlsHoverShow || volumePanelOpen || speedPanelOpen || playModePanelOpen }">
      <!-- 进度条 -->
      <div
        class="progress-bar"
        ref="progressBarRef"
        @mousedown="onProgressMouseDown"
        @mousemove="onProgressHover"
        @mouseleave="onProgressLeave"
      >
        <div class="progress-outer">
          <div class="progress-inner">
            <div class="progress-cache" :style="{ width: bufferedPercent + '%' }"></div>
            <div class="progress-played" :style="{ width: progressPercent + '%' }"></div>
          </div>
          <div class="progress-btn" :style="{ left: progressPercent + '%' }"></div>
        </div>
        <div
          v-if="hoverTime !== null && hoverPercent !== null"
          class="progress-tooltip"
          :style="{ left: hoverPercent + '%' }"
        >
          {{ formatTime(hoverTime) }}
        </div>
      </div>

      <!-- 控制按钮行 -->
      <div class="controls-row">
        <!-- 左侧控制：播放/时间 -->
        <div class="controls-left">
          <!-- 播放/暂停按钮 -->
          <button class="ctrl-icon-btn" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
            <svg v-if="!isPlaying" class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M23.5 15.134C24.1667 15.5189 24.1667 16.4811 23.5 16.866L12.25 23.3612C11.5833 23.7461 10.75 23.265 10.75 22.4952L10.75 9.50481C10.75 8.73501 11.5833 8.25388 12.25 8.63878L23.5 15.134Z" fill="currentColor" />
            </svg>
            <svg v-else class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 8C9.44772 8 9 8.44772 9 9V23C9 23.5523 9.44772 24 10 24H13C13.5523 24 14 23.5523 14 23V9C14 8.44772 13.5523 8 13 8H10Z" fill="currentColor" />
              <path d="M19 8C18.4477 8 18 8.44772 18 9V23C18 23.5523 18.4477 24 19 24H22C22.5523 24 23 23.5523 23 23V9C23 8.44772 22.5523 8 22 8H19Z" fill="currentColor" />
            </svg>
          </button>

          <!-- 时间显示 -->
          <div class="time-display">
            <span class="time-current">{{ currentTimeText }}</span>
            <span class="time-separator">/</span>
            <span class="time-duration">{{ durationText }}</span>
          </div>

          <!-- 章节信息 -->
          <div v-if="chapterTitle" class="chapter-container">
            <div class="chapter-content">
              <div class="chapter-title">{{ chapterTitle }}</div>
            </div>
            <div class="chapter-divider"></div>
            <div class="chapter-next" @click="handleNextChapter">
              <span>下一章</span>
              <svg class="icon-12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 1l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
          </div>
        </div>

        <!-- 右侧控制：音量/倍速/清屏/播放模式 -->
        <div class="controls-right">
          <!-- 音量控制 -->
          <div class="volume-control" @mouseenter="onVolumePanelEnter" @mouseleave="onVolumePanelLeave">
            <button class="ctrl-icon-btn" @click="toggleMute" :title="isMuted ? '取消静音' : '静音'">
              <svg v-if="isMuted || volume === 0" class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M11.4525 8.11043L10.7454 7.40332L9.33115 8.81753L10.0383 9.52464L23.4733 22.9597L24.1804 23.6668L25.5946 22.2526L24.8875 21.5455L22.4054 19.0634V10.6468C22.4054 8.31652 19.8647 6.87595 17.8651 8.0724L13.8292 10.4872L11.4525 8.11043ZM15.2874 11.9454L20.4054 17.0634V10.6468C20.4054 9.87002 19.5585 9.38983 18.8919 9.78865L15.2874 11.9454ZM20.0501 22.357L21.4669 23.7738C20.5453 24.6377 19.1017 24.9064 17.8651 24.1664L11.6291 20.4352H9.4054C7.74854 20.4352 6.4054 19.0921 6.4054 17.4352V14.8036C6.4054 13.1468 7.74854 11.8036 9.4054 11.8036H9.49674L11.4967 13.8036H9.4054C8.85311 13.8036 8.4054 14.2513 8.4054 14.8036V17.4352C8.4054 17.9875 8.85311 18.4352 9.4054 18.4352H11.6291C11.9907 18.4352 12.3456 18.5333 12.656 18.719L18.8919 22.4502C19.2856 22.6857 19.7422 22.6147 20.0501 22.357Z" fill="currentColor" />
              </svg>
              <svg v-else-if="volume < 0.5" class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M19.0367 10.4467C19.0367 7.98933 16.2441 6.57427 14.2625 8.02748L10.4733 10.8064C10.3018 10.9322 10.0946 11 9.88192 11H9.03668C7.37983 11 6.03668 12.3431 6.03668 14V18C6.03668 19.6568 7.37983 21 9.03668 21H9.88194C10.0946 21 10.3018 21.0678 10.4733 21.1936L14.2626 23.9724C16.2442 25.4256 19.0367 24.0105 19.0367 21.5532V10.4467ZM15.4453 9.64027C16.1058 9.15586 17.0367 9.62755 17.0367 10.4467V21.5532C17.0367 22.3723 16.1058 22.844 15.4453 22.3596L11.656 19.5808C11.1415 19.2034 10.52 19 9.88194 19H9.03668C8.4844 19 8.03668 18.5523 8.03668 18V14C8.03668 13.4477 8.4844 13 9.03668 13H9.88192C10.52 13 11.1415 12.7965 11.6561 12.4192L15.4453 9.64027ZM23.6663 11.6777L22.844 11.1086L21.7059 12.7532L22.5282 13.3223C23.4087 13.9317 23.9633 14.9105 23.9633 16C23.9633 17.0895 23.4087 18.0683 22.5282 18.6777L21.7059 19.2468L22.844 20.8914L23.6663 20.3223C25.0461 19.3674 25.9633 17.7937 25.9633 16C25.9633 14.2063 25.0461 12.6326 23.6663 11.6777Z" fill="currentColor" />
              </svg>
              <svg v-else class="icon-32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M13.6523 8.02754C15.6339 6.57433 18.4265 7.98939 18.4265 10.4467V21.5532C18.4265 24.0105 15.6339 25.4256 13.6524 23.9725L9.86308 21.1936C9.69156 21.0679 9.4844 21.0001 9.27171 21.0001H8.42645C6.7696 21.0001 5.42645 19.6569 5.42645 18.0001V14.0001C5.42645 12.3432 6.7696 11.0001 8.42645 11.0001H9.27169C9.48439 11.0001 9.69155 10.9322 9.86307 10.8064L13.6523 8.02754ZM16.4265 10.4467C16.4265 9.62761 15.4956 9.15592 14.8351 9.64033L11.0458 12.4192C10.5313 12.7966 9.90979 13.0001 9.27169 13.0001H8.42645C7.87417 13.0001 7.42645 13.4478 7.42645 14.0001V18.0001C7.42645 18.5523 7.87417 19.0001 8.42645 19.0001H9.27171C9.90979 19.0001 10.5313 19.2035 11.0458 19.5808L14.8351 22.3596C15.4956 22.844 16.4265 22.3723 16.4265 21.5532V10.4467ZM21.2263 11.8253L21.8066 12.6397C22.4855 13.5924 22.8857 14.7511 22.8857 16.0001C22.8857 17.249 22.4855 18.4078 21.8066 19.3605L21.2263 20.1749L19.5975 19.0143L20.1778 18.1999C20.6263 17.5704 20.8857 16.8142 20.8857 16.0001C20.8857 15.1859 20.6263 14.4297 20.1778 13.8003L19.5975 12.9859L21.2263 11.8253ZM24.8066 10.4994L24.2263 9.68498L22.5975 10.8456L23.1778 11.66C24.0603 12.8986 24.5736 14.392 24.5736 16.0004C24.5736 17.6089 24.0603 19.1023 23.1778 20.3408L22.5975 21.1552L24.2263 22.3158L24.8066 21.5014C25.9195 19.9396 26.5736 18.0436 26.5736 16.0004C26.5736 13.9572 25.9195 12.0612 24.8066 10.4994Z" fill="currentColor" />
              </svg>
            </button>
            <div class="volume-slider-panel" :class="{ open: volumePanelOpen }">
              <div class="volume-value">{{ volumePercent }}</div>
              <div class="volume-bar">
                <div class="volume-drag" :style="{ height: volumePercent + '%' }"></div>
              </div>
              <input
                class="volume-input"
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="isMuted ? 0 : volume"
                @input="onVolumeInput"
                @click.stop
                :title="'音量' + volumePercent + '%'"
              />
            </div>
          </div>

          <!-- 倍速控制 -->
          <div class="speed-control" @mouseenter="onSpeedPanelEnter" @mouseleave="onSpeedPanelLeave">
            <div class="speed-display">{{ playbackRate }}x</div>
            <div class="speed-panel" :class="{ open: speedPanelOpen }">
              <div class="speed-list">
                <div
                  v-for="opt in speedOptions"
                  :key="opt"
                  class="speed-item"
                  :class="{ select: playbackRate === opt }"
                  @click="selectSpeed(opt)"
                >
                  {{ opt }}x
                </div>
              </div>
            </div>
          </div>

          <!-- 清屏开关 -->
          <button class="ctrl-switch-btn" @click="toggleClearMode" :title="clearMode ? '退出清屏' : '清屏'">
            <div class="setting-label">
              <button type="button" class="xg-switch" :class="{ 'is-checked': clearMode }" tabindex="0" :aria-checked="clearMode">
                <span class="xg-switch-inner"></span>
              </button>
              <span class="setting-title">清屏</span>
            </div>
            <div class="ctrl-tips">清屏<span class="shortcut-key">J</span></div>
          </button>

          <!-- 播放模式控制 -->
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
                  <div class="play-mode-item" :class="{ select: (props.playMode ?? 'off') === 'off' }" @click="onPlayModeSelect('off')">
                    <svg class="icon-20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="5" y="6" width="8" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".9" />
                      <rect x="5" y="16" width="7" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M16.293 17.793a1 1 0 0 0 1.414 0l2.586-2.586c.63-.63.184-1.707-.707-1.707H18V7a1 1 0 1 0-2 0v6.5h-1.586c-.89 0-1.337 1.077-.707 1.707l2.586 2.586z" fill="currentColor" fill-opacity=".9" />
                    </svg>
                    <span>不连播</span>
                  </div>
                  <div class="play-mode-item" :class="{ select: props.playMode === 'sequential' }" @click="onPlayModeSelect('sequential')">
                    <svg class="icon-20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="5" y="6" width="8" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".9" />
                      <rect x="5" y="16" width="7" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M16.293 17.793a1 1 0 0 0 1.414 0l2.586-2.586c.63-.63.184-1.707-.707-1.707H18V7a1 1 0 1 0-2 0v6.5h-1.586c-.89 0-1.337 1.077-.707 1.707l2.586 2.586z" fill="currentColor" fill-opacity=".9" />
                    </svg>
                    <span>顺序连播</span>
                  </div>
                  <div class="play-mode-item" :class="{ select: props.playMode === 'reverse' }" @click="onPlayModeSelect('reverse')">
                    <svg class="icon-20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="5" y="6" width="7" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path d="M5 12a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".9" />
                      <rect x="5" y="16" width="8.125" height="2" rx="1" fill="currentColor" fill-opacity=".9" />
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M17.707 6.207a1 1 0 0 0-1.414 0l-2.586 2.586c-.63.63-.184 1.707.707 1.707H16V17a1 1 0 1 0 2 0v-6.5h1.586c.89 0 1.337-1.077.707-1.707l-2.586-2.586z" fill="currentColor" fill-opacity=".9" />
                    </svg>
                    <span>倒序连播</span>
                  </div>
                  <div class="play-mode-item" :class="{ select: props.playMode === 'loop' }" @click="onPlayModeSelect('loop')">
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
.video-player {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: #18181c;
  color: #e8e8e8;
  position: relative;
  overflow: hidden;
}

.video-area {
  flex: 1 1 auto;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  min-height: 0;
  cursor: pointer;
}
.video-el {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  display: block;
}

.buffering {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.spinner {
  width: 38px;
  height: 38px;
  border: 3px solid rgba(255, 255, 255, 0.15);
  border-top-color: #ff6b35;
  border-radius: 50%;
  animation: vp-spin 0.8s linear infinite;
}
@keyframes vp-spin {
  to {
    transform: rotate(360deg);
  }
}

.controls-bar {
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
.controls-bar.clear-mode {
  opacity: 0;
  pointer-events: none;
  transform: translateY(10px);
}
.controls-bar.clear-mode.hover-show {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

/* 右侧按钮组始终可见，二级面板（音量滑块/倍速选项/播放方式选项）靠近显示 */

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
  transition: height 0.2s ease;
}
.progress-bar:hover .progress-outer {
  height: 6px;
}
.progress-inner {
  position: relative;
  width: 100%;
  height: 100%;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 2px;
  overflow: hidden;
}
.progress-cache {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 2px;
}
.progress-played {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: #ff6b35;
  border-radius: 2px;
}
.progress-btn {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ff6b35;
  transform: translate(-50%, -50%) scale(0);
  transition: transform 0.2s ease;
  box-shadow: 0 0 6px rgba(255, 107, 53, 0.6);
}
.progress-bar:hover .progress-btn,
.is-dragging .progress-btn {
  transform: translate(-50%, -50%) scale(1);
}
.progress-tooltip {
  position: absolute;
  bottom: 24px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.85);
  color: #e8e8e8;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  pointer-events: none;
  white-space: nowrap;
}

.controls-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
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

.icon-12 {
  width: 12px;
  height: 12px;
  display: block;
}

.ctrl-text-btn {
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
  font-size: 14px;
  font-weight: 400;
  transition: color 0.15s ease;
}
.ctrl-text-btn:hover {
  color: #fff;
}
.ctrl-text-btn:active {
  color: rgba(255, 255, 255, 0.7);
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

.chapter-container {
  display: flex;
  align-items: center;
  margin-left: 12px;
  flex-grow: 1;
  max-width: 400px;
}
.chapter-content {
  flex: 0 1 auto;
}
.chapter-title {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chapter-divider {
  flex: 1 1 auto;
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0 12px;
}
.chapter-next {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  transition: color 0.15s ease;
}
.chapter-next:hover {
  color: #fff;
}
.chapter-next svg {
  color: rgba(255, 255, 255, 0.9);
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
  min-width: 100px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  transition: all 0.2s ease;
  background: rgba(24, 24, 28, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 4px 0;
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
.speed-list {
  display: flex;
  flex-direction: column;
}
.speed-item {
  padding: 5px 12px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.speed-item:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.speed-item.select {
  color: #ff6b35;
  font-weight: 600;
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

.video-player:fullscreen {
  background: #000;
}
.video-player:fullscreen .video-area {
  flex: 1 1 auto;
}
</style>
