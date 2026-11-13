/**
 * 制作页状态与流程编排（对应 iOS 端 LivePhotoMakerViewModel）。
 */
import { computed, reactive } from 'vue'
import {
  DEFAULT_SIZE_TIER,
  LivePhotoMakerError,
  type LivePhotoBuild,
  type MakerErrorCode,
  type MediaItem,
  type MediaKind,
  type MetadataSource,
  type Phase,
  type SizeTier,
} from './models'
import { importPhoto, importVideo, captureVideoThumbnail, captureVideoCover, captureFirstVideoCover, type DecodedPhoto, type VideoAnalysis } from './services/media'
import { buildLivePhoto } from './services/builder'
import { irotAngleFromMatrix } from './services/mov'
import { extractHevcKeyframe } from './services/hevc-still'
import type { HevcStill } from './models'

export interface MakerState {
  photo: MediaItem | null
  video: MediaItem | null
  metadataSource: MetadataSource
  importingKind: MediaKind | null
  phase: Phase
  progress: number
  errorCode: MakerErrorCode | null
  /** 原始异常细节（诊断用）：LivePhotoMakerError 之外的真实报错文本。 */
  errorDetail: string | null
  result: LivePhotoBuild | null
  /** 封面在视频中的锚点时刻（秒）；自定义照片为 undefined。预览播放与 still-image-time 共用。 */
  coverTime: number | undefined
  /** 导出尺寸档位：原画 / 较大 / 合适 / 较小。 */
  sizeTier: SizeTier
}

const state = reactive<MakerState>({
  photo: null,
  video: null,
  metadataSource: 'photo',
  importingKind: null,
  phase: 'idle',
  progress: 0,
  errorCode: null,
  errorDetail: null,
  result: null,
  coverTime: undefined,
  sizeTier: DEFAULT_SIZE_TIER,
})

let decodedPhoto: DecodedPhoto | null = null
let videoAnalysis: VideoAnalysis | null = null
/** 自动封面在途记录：同一视频去重；换视频后旧结果自动作废（见 setVideoCover）。 */
let autoCoverFile: File | null = null

/** 原始异常简短描述：错误名 + 消息（截断），供错误弹框诊断展示。 */
function describeError(e: unknown): string | null {
  if (e instanceof LivePhotoMakerError) return null
  const name = e instanceof Error ? e.name : ''
  const msg = e instanceof Error ? e.message : String(e)
  const text = [name, msg].filter(Boolean).join(': ')
  return text.length > 300 ? text.slice(0, 300) + '…' : text || null
}

export function useMaker() {
  const isWorking = computed(() => state.phase !== 'idle' || state.importingKind !== null)
  const canCompose = computed(
    () => state.photo !== null && state.video !== null && state.phase === 'idle' && state.importingKind === null,
  )
  const selectedMetadata = computed(() => {
    const source = state.metadataSource === 'photo' ? state.photo : state.video
    return source?.metadata ?? {}
  })

  function clearResult(): void {
    if (state.result) {
      URL.revokeObjectURL(state.result.photoUrl)
      URL.revokeObjectURL(state.result.videoUrl)
      state.result = null
    }
  }

  async function selectPhoto(file: File): Promise<void> {
    if (state.importingKind || isWorking.value) return
    state.importingKind = 'photo'
    try {
      const { item, decoded } = await importPhoto(file)
      clearResult()
      state.photo = item
      decodedPhoto = decoded
      state.coverTime = undefined
    } catch (e) {
      state.errorCode = e instanceof LivePhotoMakerError ? e.code : 'photoUnreadable'
      state.errorDetail = describeError(e)
    } finally {
      state.importingKind = null
    }
  }

  async function setVideoCover(video?: HTMLVideoElement, automatic = false): Promise<void> {
    if (!state.video) return
    // 全程使用进入时捕获的素材引用，避免 await 期间换视频导致新旧混用。
    const sourceFile = state.video.file
    const sourceMetadata = state.video.metadata
    const analysis = videoAnalysis
    const time = video?.currentTime ?? 0
    try {
      // 可重封装的 hvc1 HDR 源：比特级抽取目标时刻的 IDR 关键帧（零转码保 HDR）。
      // 无条件抽取：抽取本身很便宜，且档位可在封面生成之后才切换——
      // 若在压缩档跳过抽取，切回「原画」时 HDR 静帧已缺失，成片会没 HDR。
      // 是否使用由 builder 按合成时的档位决定（压缩档舍弃、回落 SDR）。
      const videoTrack = analysis?.movie?.tracks.find((t) => t.handler === 'vide')
      let prebuilt: HevcStill | undefined
      if (analysis?.remuxable && analysis.movie && videoTrack) {
        prebuilt = await extractHevcKeyframe(
          sourceFile,
          videoTrack,
          time,
          irotAngleFromMatrix(videoTrack.matrix),
        )
      }
      const irot = irotAngleFromMatrix(videoTrack?.matrix)
      const { item, decoded } = video
        ? await captureVideoCover(video, sourceMetadata, irot, prebuilt)
        : await captureFirstVideoCover(sourceFile, sourceMetadata, irot, prebuilt)
      // 自动封面让位/作废：期间用户已有照片，或视频已更换。
      if (automatic && (state.photo || state.video?.file !== sourceFile)) return
      clearResult()
      decodedPhoto = decoded
      // 比特级抽取的关键帧可能吸附到邻近 IDR：用其真实时刻作锚点，
      // 保证封面帧与 still-image-time / 播放锚点严格一致；否则用所选时刻。
      state.coverTime = prebuilt?.timeSeconds ?? time
      state.photo = item
    } catch (e) {
      if (!automatic) { state.errorCode = 'photoUnreadable'; state.errorDetail = describeError(e) }
    }
  }

  async function selectCoverFrame(video?: HTMLVideoElement, automatic = false): Promise<void> {
    if (isWorking.value) return
    // 自动封面不占用导入态（不显示「正在导入…」转圈）：它是系统后台行为，
    // 且高清源需新建元素冷解码，耗时明显；手动选帧复用已加载元素、瞬时完成才值得转圈反馈。
    if (automatic) {
      const file = state.video?.file
      if (!file || file === autoCoverFile) return
      autoCoverFile = file
      try {
        await setVideoCover(video, true)
      } finally {
        if (autoCoverFile === file) autoCoverFile = null
      }
      return
    }
    state.importingKind = 'photo'
    try {
      await setVideoCover(video, false)
    } finally {
      state.importingKind = null
    }
  }

  async function selectVideo(file: File): Promise<void> {
    if (state.importingKind || isWorking.value) return
    state.importingKind = 'video'
    try {
      const { item, analysis } = await importVideo(file)
      clearResult()
      state.video = item
      videoAnalysis = analysis
      if (!state.photo || state.coverTime !== undefined) {
        state.photo = null
        decodedPhoto = null
        state.coverTime = undefined
      }
      // 缩略图异步抓取，不阻塞导入（HEVC 在部分浏览器无法解码时静默降级）
      void captureVideoThumbnail(file, analysis.duration).then((url) => {
        if (url && state.video?.file === file) state.video.previewUrl = url
      })
    } catch (e) {
      state.errorCode = e instanceof LivePhotoMakerError ? e.code : 'videoUnreadable'
      state.errorDetail = describeError(e)
    } finally {
      state.importingKind = null
    }
  }

  function removePhoto(): void {
    if (isWorking.value) return
    state.photo = null
    decodedPhoto = null
    state.coverTime = undefined
    clearResult()
  }

  function removeVideo(): void {
    if (isWorking.value) return
    state.video = null
    videoAnalysis = null
    if (state.coverTime !== undefined) removePhoto()
    clearResult()
  }

  async function compose(): Promise<void> {
    if (!canCompose.value || !decodedPhoto || !videoAnalysis || !state.photo || !state.video) return
    state.phase = 'composing'
    state.progress = 0
    try {
      const build = await buildLivePhoto({
        photo: state.photo,
        decodedPhoto,
        video: state.video,
        analysis: videoAnalysis,
        metadataSource: state.metadataSource,
        coverTime: state.coverTime,
        sizeTier: state.sizeTier,
        onProgress: ({ phase, progress }) => {
          state.phase = phase
          state.progress = progress
        },
      })
      state.result = build
      state.phase = 'idle'
      state.progress = 0
    } catch (e) {
      state.phase = 'idle'
      state.progress = 0
      state.errorCode = e instanceof LivePhotoMakerError ? e.code : 'compositionFailed'
      state.errorDetail = describeError(e)
    }
  }

  function reset(): void {
    if (isWorking.value) return
    removePhoto()
    removeVideo()
    state.metadataSource = 'photo'
  }

  function dismissError(): void {
    state.errorCode = null
    state.errorDetail = null
  }

  return {
    state,
    isWorking,
    canCompose,
    selectedMetadata,
    selectPhoto,
    selectCoverFrame,
    selectVideo,
    removePhoto,
    removeVideo,
    compose,
    reset,
    dismissError,
  }
}
