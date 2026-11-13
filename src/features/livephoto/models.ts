/** 实况照片制作的数据模型（对应 iOS 端 LivePhotoModels）。 */

export type MediaKind = 'photo' | 'video'
export type MetadataSource = 'photo' | 'video'
export type Phase = 'idle' | 'composing' | 'saving'

/** 拍摄时间：绝对时刻 + 原始时区偏移（分钟），保留墙上时钟信息。 */
export interface CaptureDate {
  epochMs: number
  offsetMinutes?: number
}

export interface Coordinate {
  latitude: number
  longitude: number
}

/** 从照片 EXIF 或视频 QuickTime 元数据解析出的拍摄信息。 */
export interface CaptureMetadata {
  creationDate?: CaptureDate
  coordinate?: Coordinate
  altitude?: number
}

export function isMetadataEmpty(m: CaptureMetadata): boolean {
  return !m.creationDate && !m.coordinate
}

/** 用户选中的一项素材。 */
export interface MediaItem {
  kind: MediaKind
  file: File
  /** 预览图（dataURL）。 */
  previewUrl?: string
  metadata: CaptureMetadata
  pixelSize?: { width: number; height: number }
  /** 视频时长（秒）。 */
  duration?: number
}

/** HEIF `colr`/nclx 色彩标注（ISO/IEC 23001-8）。 */
export interface HevcColorInfo {
  /** colour_primaries：9 = BT.2020。 */
  primaries: number
  /** transfer_characteristics：16 = PQ (ST 2084)，18 = HLG。 */
  transfer: number
  /** matrix_coefficients：9 = BT.2020 NCL，10 = CL。 */
  matrix: number
  fullRange: boolean
}

/** WebCodecs 编码出的单帧 HEVC 图像（HEIC 主图项）。 */
export interface HevcStill {
  width: number
  height: number
  /** hvcC 解码配置。 */
  config: Uint8Array
  /** hvc1 样本（IDR）。 */
  sample: Uint8Array
  /** 位深（默认 8；HDR 为 10）。 */
  bitDepth?: number
  /** HEIF irot：对编码图像逆时针旋转的 90° 倍数（iPhone 旋转矩阵）。 */
  irot?: number
  /** 有则写入 HEIC 的 colr nclx（HDR 封面保留源色彩）。 */
  colr?: HevcColorInfo
  /** 该帧在视频中的实际呈现时刻（秒）；比特级抽取的关键帧用于对齐 still-image-time。 */
  timeSeconds?: number
}

/** 合成结果。 */
export interface LivePhotoBuild {
  identifier: string
  photoBlob: Blob
  exifTiff: Uint8Array
  videoBlob: Blob
  photoName: string
  videoName: string
  stillTimeSeconds: number
  /** 结果预览用的 objectURL。 */
  photoUrl: string
  videoUrl: string
  /** HDR 视频截帧的原生 HEVC 封面；PVT 直接封装，不经 sRGB 画布调色。 */
  hevcStill?: HevcStill
}

/** 素材限制：视频最长 3 分钟。 */
export const MAX_VIDEO_DURATION = 180

export type MakerErrorCode =
  | 'photoUnreadable'
  | 'videoUnreadable'
  | 'videoTrackMissing'
  | 'videoTooLong'
  | 'videoUnsupported'
  | 'audioUnsupported'
  | 'compositionFailed'

export class LivePhotoMakerError extends Error {
  constructor(readonly code: MakerErrorCode) {
    super(code)
    this.name = 'LivePhotoMakerError'
  }
}
