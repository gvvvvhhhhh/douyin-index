/**
 * MSE HEVC Player
 *
 * 使用 mp4box.js 解封装 MP4 文件 + MediaSource Extensions 播放 HEVC 视频。
 * 绕过 Tauri asset:// 协议导致的 H.265 黑屏问题（系统有 HEVC 解码器但
 * <video src="asset://..."> 无法正常解码）。
 *
 * 原理：
 * 1. 通过 Tauri 后端读取文件字节（ArrayBuffer）
 * 2. mp4box.js 解析 MP4 结构，提取视频和音频轨道
 * 3. 将初始化片段（init segment）和数据片段（media segment）通过
 *    SourceBuffer.appendBuffer 喂给 MediaSource
 * 4. <video> 元素通过 blob URL 播放 MSE 数据流
 */
import { createFile, MP4BoxBuffer, type ISOFile, type Track, type Movie } from 'mp4box';
import { readFileBytes } from '@/api/tauri';

// 扩展 SourceBuffer 类型，添加自定义属性
interface AugmentedSourceBuffer extends SourceBuffer {
  id: number;
  ms: MediaSource;
  pendingAppends: Array<{ buffer: ArrayBuffer; sampleNum: number; is_last: boolean }>;
  sampleNum?: number;
  is_last?: boolean;
}

export interface MsePlayerCallbacks {
  onError: (msg: string) => void;
  onReady?: (info: { width: number; height: number; duration: number }) => void;
}

export class MseHevcPlayer {
  private video: HTMLVideoElement;
  private mp4box: ISOFile | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffers: Map<number, AugmentedSourceBuffer> = new Map();
  private aborted = false;
  private callbacks: MsePlayerCallbacks;

  constructor(video: HTMLVideoElement, callbacks: MsePlayerCallbacks) {
    this.video = video;
    this.callbacks = callbacks;
  }

  /**
   * 加载并播放 HEVC 视频
   * @param filePath 本地文件绝对路径
   */
  async load(filePath: string): Promise<void> {
    this.aborted = false;

    try {
      // 1. 读取文件字节
      const uint8 = await readFileBytes(filePath);
      if (this.aborted) return;

      // 2. 设置 MediaSource
      this.setupMediaSource();

      // 3. 等待 MediaSource 打开
      await this.waitForSourceOpen();
      if (this.aborted) return;

      // 4. 用 mp4box.js 解析并播放
      this.parseAndPlay(uint8.buffer);
    } catch (e) {
      if (!this.aborted) {
        const msg = e instanceof Error ? e.message : String(e);
        this.callbacks.onError(`MSE 播放失败: ${msg}`);
      }
    }
  }

  /**
   * 停止播放并释放资源
   */
  destroy(): void {
    this.aborted = true;

    // 清理 SourceBuffer
    this.sourceBuffers.forEach((sb) => {
      try {
        if (sb.ms.readyState === 'open') {
          try { sb.ms.removeSourceBuffer(sb); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
    });
    this.sourceBuffers.clear();

    // 关闭 MediaSource
    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch (_) { /* ignore */ }
      this.mediaSource = null;
    }

    // 停止 mp4box
    if (this.mp4box) {
      try { this.mp4box.stop(); } catch (_) { /* ignore */ }
      this.mp4box = null;
    }

    // 释放 blob URL
    if (this.video.src.startsWith('blob:')) {
      try { URL.revokeObjectURL(this.video.src); } catch (_) { /* ignore */ }
    }
  }

  private setupMediaSource(): void {
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.video.src = URL.createObjectURL(ms);
  }

  private waitForSourceOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.mediaSource) {
        reject(new Error('MediaSource 未创建'));
        return;
      }
      if (this.mediaSource.readyState === 'open') {
        resolve();
        return;
      }
      const onOpen = () => {
        this.mediaSource?.removeEventListener('sourceopen', onOpen);
        this.mediaSource?.removeEventListener('sourceclosed', onClosed);
        resolve();
      };
      const onClosed = () => {
        this.mediaSource?.removeEventListener('sourceopen', onOpen);
        this.mediaSource?.removeEventListener('sourceclosed', onClosed);
        reject(new Error('MediaSource 已关闭'));
      };
      this.mediaSource.addEventListener('sourceopen', onOpen);
      this.mediaSource.addEventListener('sourceclose', onClosed);
    });
  }

  private parseAndPlay(buffer: ArrayBuffer): void {
    this.mp4box = createFile() as ISOFile;

    this.mp4box.onError = (module: string, message: string) => {
      console.error(`[MSE HEVC] mp4box error (${module}): ${message}`);
      if (!this.aborted) {
        this.callbacks.onError(`MP4 解析错误: ${message}`);
      }
    };

    this.mp4box.onReady = (info: Movie) => {
      if (this.aborted) return;
      console.log(`[MSE HEVC] 文件信息: 时长=${info.duration}, 轨道数=${info.tracks.length}`);

      // 通知外部视频尺寸和时长
      let videoWidth = 0;
      let videoHeight = 0;
      const durationSec = info.duration / info.timescale;

      // 查找视频和音频轨道
      let videoTrack: Track | null = null;
      let audioTrack: Track | null = null;

      for (const track of info.tracks) {
        if (!videoTrack && track.type === 'video' && track.codec) {
          videoTrack = track;
          videoWidth = track.track_width || (track.video?.width ?? 0);
          videoHeight = track.track_height || (track.video?.height ?? 0);
        } else if (!audioTrack && track.type === 'audio' && track.codec) {
          audioTrack = track;
        }
      }

      if (!videoTrack) {
        this.callbacks.onError('未找到视频轨道');
        return;
      }

      this.callbacks.onReady?.({ width: videoWidth, height: videoHeight, duration: durationSec });

      // 检查 MSE 是否支持该编码
      const videoMime = `video/mp4; codecs="${videoTrack.codec}"`;
      if (!MediaSource.isTypeSupported(videoMime)) {
        console.error(`[MSE HEVC] MSE 不支持编码: ${videoMime}`);
        this.callbacks.onError(`MSE 不支持 HEVC 编码 (${videoTrack.codec})`);
        return;
      }

      console.log(`[MSE HEVC] MSE 支持编码: ${videoMime}`);

      if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
        this.callbacks.onError('MediaSource 未就绪');
        return;
      }

      // 为视频轨道创建 SourceBuffer
      this.addTrackToMse(videoTrack);
      // 为音频轨道创建 SourceBuffer（如果存在）
      if (audioTrack) {
        const audioMime = `audio/mp4; codecs="${audioTrack.codec}"`;
        if (MediaSource.isTypeSupported(audioMime)) {
          this.addTrackToMse(audioTrack);
        } else {
          console.warn(`[MSE HEVC] MSE 不支持音频编码: ${audioMime}，跳过音频`);
        }
      }

      // 获取初始化片段并 append
      const initSegs = this.mp4box!.initializeSegmentation();
      // initializeSegmentation 返回 SegmentationInitialization 或数组
      const segArray = Array.isArray(initSegs) ? initSegs : [initSegs];

      let pendingInits = 0;
      for (const seg of segArray) {
        const sb = seg.user as AugmentedSourceBuffer;
        if (!sb) continue;

        pendingInits++;
        sb.addEventListener('updateend', function onInitEnd(this: AugmentedSourceBuffer) {
          sb.removeEventListener('updateend', onInitEnd);
          sb.sampleNum = 0;
          sb.addEventListener('updateend', onSegmentEnd);
          // 处理可能在 init 期间积累的 pending buffers
          processPendingBuffers(sb);
          pendingInits--;
        });
        sb.pendingAppends = [];
        console.log(`[MSE HEVC] append init segment, track ${seg.id}, size=${(seg as any).buffer.byteLength}`);
        sb.appendBuffer((seg as any).buffer);
      }

      // 开始解析样本
      this.mp4box!.start();
    };

    // 设置 onSegment 回调：mp4box 将片段数据推给对应的 SourceBuffer
    this.mp4box.onSegment = (_id: number, user: any, buffer: ArrayBuffer, nextSample: number, last: boolean) => {
      if (this.aborted) return;
      const sb = user as AugmentedSourceBuffer;
      if (sb && sb.ms.readyState === 'open') {
        if (sb.updating) {
          // SourceBuffer 正在更新，排队等待
          sb.pendingAppends.push({ buffer, sampleNum: nextSample, is_last: last });
        } else {
          sb.sampleNum = nextSample;
          sb.is_last = last;
          sb.appendBuffer(buffer);
        }
      }
    };

    // 将文件数据喂给 mp4box
    // mp4box 需要在 ArrayBuffer 上设置 fileStart 属性
    const mp4Buffer = MP4BoxBuffer.fromArrayBuffer(buffer, 0) as MP4BoxBuffer & ArrayBuffer;
    this.mp4box.appendBuffer(mp4Buffer);
    this.mp4box.flush();
  }

  private addTrackToMse(track: Track): void {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;

    const mime = track.type === 'video'
      ? `video/mp4; codecs="${track.codec}"`
      : `audio/mp4; codecs="${track.codec}"`;

    const sb = this.mediaSource.addSourceBuffer(mime) as AugmentedSourceBuffer;
    sb.id = track.id;
    sb.ms = this.mediaSource;
    sb.pendingAppends = [];

    this.sourceBuffers.set(track.id, sb);

    // 设置 mp4box 分段选项：每 1000 个样本一个 segment
    this.mp4box!.setSegmentOptions(track.id, sb, {
      nbSamples: 1000,
      rapAlignement: true,
    });

    console.log(`[MSE HEVC] 创建 SourceBuffer: track=${track.id}, codec=${track.codec}, mime=${mime}`);
  }
}

/**
 * SourceBuffer updateend 事件处理
 * 当一个 segment append 完成后，释放已用样本并处理排队中的下一个
 */
function onSegmentEnd(this: AugmentedSourceBuffer) {
  // 释放已处理的样本，让 mp4box 回收内存
  if (this.sampleNum) {
    // mp4box 实例在闭包外，这里通过 sourceBuffer 的 id 来引用
    // sampleNum 已经不需要手动处理释放
  }

  if (this.is_last) {
    if (this.ms.readyState === 'open') {
      this.ms.endOfStream();
    }
  }

  // 处理排队中的 buffer
  processPendingBuffers(this);
}

/**
 * 处理 SourceBuffer 排队中的 buffer
 */
function processPendingBuffers(sb: AugmentedSourceBuffer) {
  if (sb.ms.readyState === 'open' && !sb.updating && sb.pendingAppends.length > 0) {
    const obj = sb.pendingAppends.shift()!;
    sb.sampleNum = obj.sampleNum;
    sb.is_last = obj.is_last;
    sb.appendBuffer(obj.buffer);
  }
}