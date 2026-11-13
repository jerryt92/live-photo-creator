/**
 * 视频拍摄信息读取（对应 iOS 端 LivePhotoMetadataReader.videoMetadata）。
 * 优先 QuickTime mdta 元数据，缺失时回退 mvhd 创建时间。
 */
import { localOffsetMinutes, parseISO6709, parseISO8601 } from './capture'
import { MAC_EPOCH_OFFSET } from './bytes'
import type { MovieInfo } from './mp4'
import type { CaptureMetadata } from '../models'

export function videoMetadata(movie: MovieInfo): CaptureMetadata {
  const metadata: CaptureMetadata = {}

  const creation = movie.metadata.get('com.apple.quicktime.creationdate')
  if (typeof creation === 'string') {
    const parsed = parseISO8601(creation)
    if (parsed) metadata.creationDate = parsed
  }

  const location = movie.metadata.get('com.apple.quicktime.location.ISO6709')
  if (typeof location === 'string') {
    const parsed = parseISO6709(location)
    if (parsed) {
      metadata.coordinate = parsed.coordinate
      metadata.altitude = parsed.altitude
    }
  }

  // 回退：mvhd 创建时间（Mac 纪元，UTC），时区取本地（与 iOS 一致）。
  if (!metadata.creationDate && movie.creationTime && movie.creationTime > MAC_EPOCH_OFFSET) {
    metadata.creationDate = {
      epochMs: (movie.creationTime - MAC_EPOCH_OFFSET) * 1000,
      offsetMinutes: localOffsetMinutes(),
    }
  }

  return metadata
}
