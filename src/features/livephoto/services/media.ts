/**
 * 素材导入：读取预览图、尺寸、时长与拍摄信息（对应 iOS 端 LivePhotoMediaImporter）。
 */
import { decodePhoto, type DecodedPhoto } from './jpeg'
import { videoMetadata } from './metadata'
import { ByteReader, concatBytes } from './bytes'
import { parseMovie, type MovieInfo } from './mp4'
import { encodeStill, hdrColorInfo, type HevcStill } from './heic'
import { LivePhotoMakerError, MAX_VIDEO_DURATION, type CaptureMetadata, type MediaItem } from '../models'
export type { DecodedPhoto }

/** 可比特级搬运的视频编码（含 Dolby Vision dvh1/dvhe，HDR 原样保留）。 */
export const REMUXABLE_VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'dvh1', 'dvhe'])

export interface VideoAnalysis {
  file: File
  duration: number
  width: number
  height: number
  metadata: CaptureMetadata
  previewUrl?: string
  /** 可直接重封装（H.264/HEVC + AAC 的 MP4/MOV）。 */
  remuxable: boolean
  /** 视频轨可比特级搬运（音频可能仍需转码）；HDR 保真的关键判定。 */
  videoCopyable: boolean
  movie?: MovieInfo
  /** WebM 等需要走 WebCodecs 转码。 */
  webm: boolean
}

export async function importPhoto(file: File): Promise<{ item: MediaItem; decoded: DecodedPhoto }> {
  const decoded = await decodePhoto(file)
  const item: MediaItem = {
    kind: 'photo',
    file,
    previewUrl: decoded.previewUrl,
    metadata: decoded.metadata,
    pixelSize: { width: decoded.width, height: decoded.height },
  }
  return { item, decoded }
}

export async function importVideo(file: File): Promise<{ item: MediaItem; analysis: VideoAnalysis }> {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const isWebM = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  const isIsobmff = bytes.byteLength > 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp'

  let analysis: VideoAnalysis
  if (isIsobmff) {
    analysis = await analyzeIsobmff(file)
  } else if (isWebM) {
    analysis = await analyzeWithElement(file, true)
  } else {
    throw new LivePhotoMakerError('videoUnreadable')
  }

  if (analysis.duration <= 0) throw new LivePhotoMakerError('videoUnreadable')
  if (analysis.duration > MAX_VIDEO_DURATION) throw new LivePhotoMakerError('videoTooLong')

  const item: MediaItem = {
    kind: 'video',
    file,
    previewUrl: analysis.previewUrl,
    metadata: analysis.metadata,
    pixelSize:
      analysis.width > 0 && analysis.height > 0
        ? { width: Math.round(analysis.width), height: Math.round(analysis.height) }
        : undefined,
    duration: analysis.duration,
  }
  return { item, analysis }
}

async function readMovieMetadata(file: File): Promise<MovieInfo> {
  const metadata: Uint8Array[] = []
  let fragmented = false
  for (let offset = 0; offset + 8 <= file.size;) {
    const reader = new ByteReader(new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer()))
    const sizeField = reader.u32()
    const type = reader.fourCC()
    const headerSize = sizeField === 1 ? 16 : 8
    const size = sizeField === 1 ? reader.u64() : sizeField || file.size - offset
    if (!Number.isSafeInteger(size) || size < headerSize || size > file.size - offset) break
    if (type === 'ftyp' || type === 'moov') {
      metadata.push(new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()))
    }
    if (type === 'moof') fragmented = true
    offset += size
  }
  const movie = parseMovie(concatBytes(metadata))
  movie.fragmented ||= fragmented
  return movie
}

async function analyzeIsobmff(file: File): Promise<VideoAnalysis> {
  let movie: MovieInfo
  try {
    movie = await readMovieMetadata(file)
  } catch {
    throw new LivePhotoMakerError('videoUnreadable')
  }
  const videoTrack = movie.tracks.find((t) => t.handler === 'vide')
  if (!videoTrack) throw new LivePhotoMakerError('videoUnreadable')

  const duration = movie.duration / movie.timescale
  const videoFormat = videoTrack.stsdEntries[0]?.format ?? ''
  const audioTracks = movie.tracks.filter((t) => t.handler === 'soun')
  // iPhone HDR 视频常带多条音轨（AAC + APAC 空间音频）：只要存在一条 AAC
  // 即可直接重封装；其余音轨交给混合路径转码，绝不因此把 HDR 视频降级 SDR。
  const audioOk = audioTracks.length === 0 || audioTracks.some((t) => t.stsdEntries[0]?.format === 'mp4a')

  const videoCopyable =
    !movie.fragmented &&
    REMUXABLE_VIDEO_CODECS.has(videoFormat) &&
    videoTrack.sampleSizes.length > 0 && videoTrack.stts.length > 0 && videoTrack.chunkOffsets.length > 0

  return {
    file,
    duration,
    width: videoTrack.width,
    height: videoTrack.height,
    metadata: videoMetadata(movie),
    remuxable: videoCopyable && audioOk,
    videoCopyable,
    movie,
    webm: false,
  }
}

/** 用 <video> 元素读取时长/尺寸（WebM 或解析失败时的兜底）。 */
async function analyzeWithElement(file: File, webm: boolean): Promise<VideoAnalysis> {
  const url = URL.createObjectURL(file)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new LivePhotoMakerError('videoUnreadable'))
      video.src = url
    })
    const duration = video.duration
    if (!Number.isFinite(duration)) throw new LivePhotoMakerError('videoUnreadable')
    return {
      file,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      metadata: {},
      remuxable: false,
      videoCopyable: false,
      webm,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 抓取视频缩略图（时刻与 iOS 一致：duration * 0.1）。 */
export async function captureVideoThumbnail(file: File, duration: number): Promise<string | undefined> {
  const url = URL.createObjectURL(file)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('load failed'))
      video.src = url
    })
    const time = Math.min(Math.max(duration * 0.1, 0), Math.max(duration - 0.05, 0))
    await new Promise<void>((resolve, reject) => {
      video.onseeked = () => resolve()
      video.onerror = () => reject(new Error('seek failed'))
      video.currentTime = time
    })
    return drawPreview(video, video.videoWidth, video.videoHeight, 1200)
  } catch {
    return undefined
  } finally {
    URL.revokeObjectURL(url)
  }
}

function drawPreview(source: CanvasImageSource, width: number, height: number, maxDim: number): string | undefined {
  if (!width || !height) return undefined
  const scale = Math.min(1, maxDim / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    canvas.width = canvas.height = 0
  }
}

/**
 * HDR 封面：VideoFrame(video) 取原生色彩空间帧（不经 sRGB 画布色调映射），
 * 用 HEVC Main10 直接编码单帧并记录 nclx。源为 SDR、编码器不支持或失败时
 * 返回 undefined，调用方回退 SDR JPEG 管线。
 * irotAngle：视频 tkhd 矩阵的显示旋转（逆时针 90° 倍数），写入 HEIC 的 irot，
 * 保证封面方向与视频一致（iPhone 视频横向编码 + 90° 矩阵）。
 */
async function captureHdrCoverStill(video: HTMLVideoElement, irotAngle: number): Promise<HevcStill | undefined> {
  if (typeof VideoFrame === 'undefined' || typeof VideoEncoder === 'undefined') return undefined
  let frame: VideoFrame | undefined
  try {
    frame = new VideoFrame(video, { timestamp: 0 })
    const colr = hdrColorInfo(frame.colorSpace)
    if (!colr) return undefined
    const width = frame.codedWidth
    const height = frame.codedHeight
    // HEVC 4:2:0 要求偶数尺寸。
    if (!width || !height || width % 2 !== 0 || height % 2 !== 0) return undefined
    // 编码尺寸必须与显示尺寸一致或恰好转置（旋转），且与矩阵声明吻合。
    const same = width === video.videoWidth && height === video.videoHeight
    const swapped = width === video.videoHeight && height === video.videoWidth
    if (!same && !swapped) return undefined
    const rotated = irotAngle === 1 || irotAngle === 3
    if (swapped !== rotated) return undefined
    const config: VideoEncoderConfig = {
      codec: 'hvc1.2.4.L153.B0',
      width,
      height,
      bitrate: 24_000_000,
      framerate: 30,
      latencyMode: 'realtime',
    }
    if (!(await VideoEncoder.isConfigSupported(config)).supported) return undefined
    // colr 仅用作 HDR 判定；不写入 HEIC（ImageIO 拒绝带 nclx 属性的单帧，见 hevc-still.ts）。
    return await encodeStill(frame, config, undefined, 10, irotAngle)
  } catch {
    return undefined
  } finally {
    frame?.close()
  }
}

export async function captureVideoCover(
  video: HTMLVideoElement,
  metadata: CaptureMetadata,
  irotAngle = 0,
  prebuiltStill?: HevcStill,
): Promise<{ item: MediaItem; decoded: DecodedPhoto }> {
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height || video.readyState < 2) throw new Error('Video frame unavailable')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas unavailable')
  context.drawImage(video, 0, 0)
  try {
    const jpeg = new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((image) => image ? resolve(image) : reject(new Error('Cover encoding failed')), 'image/jpeg', 0.95)
    })
    const [blob, hevcStill] = await Promise.all([jpeg, prebuiltStill ?? captureHdrCoverStill(video, irotAngle)])
    const previewUrl = drawPreview(canvas, width, height, 512)
    return {
      item: { kind: 'photo', file: new File([blob], 'Cover.jpg', { type: blob.type }), metadata, pixelSize: { width, height }, previewUrl },
      decoded: { blob, width, height, metadata, orientation: 1, previewUrl, hevcStill },
    }
  } finally {
    canvas.width = canvas.height = 0
  }
}

export async function captureFirstVideoCover(file: File, metadata: CaptureMetadata, irotAngle = 0, prebuiltStill?: HevcStill) {
  const video = document.createElement('video')
  const url = URL.createObjectURL(file)
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      // 4K HEVC 在移动端首帧「解码+draw+JPEG 编码」可达 15-25 秒，10 秒过紧会误判超时。
      const timeout = window.setTimeout(() => reject(new Error('Video frame timed out')), 30000)
      video.onloadeddata = () => { window.clearTimeout(timeout); resolve() }
      video.onerror = () => { window.clearTimeout(timeout); reject(new Error('Video frame unavailable')) }
      video.src = url
    })
    return await captureVideoCover(video, metadata, irotAngle, prebuiltStill)
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
