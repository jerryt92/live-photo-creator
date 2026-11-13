/**
 * 合成编排（对应 iOS 端 LivePhotoBuilder.build + verifyPair）。
 * 照片写入 MakerApple 17 配对标识；视频重封装为携带相同
 * content identifier 与 still-image-time 轨道的 MOV；最后校验成对文件。
 */
import { makeUUID } from './bytes'
import { buildKeyPhoto, scalePhotoBlob, verifyKeyPhoto, type DecodedPhoto } from './jpeg'
import { applyMetadata, localOffsetMinutes, toExifDateString } from './capture'
import { buildMovieBlob, copyMovieTrack, verifyMov, type MovTrackInput } from './mov'
import { transcodeToTracks } from './transcode'
import type { VideoAnalysis } from './media'
import {
  DEFAULT_SIZE_TIER, LivePhotoMakerError, SIZE_TIERS, scaledDimensions,
  type LivePhotoBuild, type MediaItem, type MetadataSource, type SizeTier,
} from '../models'

export interface BuildProgress {
  phase: 'composing' | 'saving'
  progress: number
}

export interface BuildOptions {
  photo: MediaItem
  decodedPhoto: DecodedPhoto
  video: MediaItem
  analysis: VideoAnalysis
  metadataSource: MetadataSource
  coverTime?: number
  sizeTier?: SizeTier
  onProgress?: (p: BuildProgress) => void
}

export async function buildLivePhoto(opts: BuildOptions): Promise<LivePhotoBuild> {
  const { photo, video, analysis, metadataSource, onProgress } = opts
  const sizeTier = opts.sizeTier ?? DEFAULT_SIZE_TIER
  const tier = SIZE_TIERS[sizeTier]
  const compress = tier.compress
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000)
  const identifier = makeUUID()
  onProgress?.({ phase: 'composing', progress: 0.05 })

  const capture = {
    ...(metadataSource === 'photo' ? photo.metadata : applyMetadata(video.metadata)),
    creationDate: { epochMs: createdAt.getTime(), offsetMinutes: localOffsetMinutes(createdAt) },
  }

  // 压缩档：仅「视频截帧封面」同步缩放到长边上限并转 SDR。
  // 单独上传的封面照片（无 coverTime）不参与尺寸压缩与 SDR 转换，原样保留。
  const customCoverPhoto = opts.coverTime === undefined
  let decodedPhoto = opts.decodedPhoto
  if (compress && !customCoverPhoto) {
    const target = scaledDimensions(decodedPhoto.width, decodedPhoto.height, tier.maxLongEdge)
    const scaledBlob = await scalePhotoBlob(decodedPhoto.blob, target.width, target.height)
    decodedPhoto = { ...decodedPhoto, blob: scaledBlob, width: target.width, height: target.height, hevcStill: undefined }
  }

  const { bytes: photoBytes, exifTiff } = await buildKeyPhoto(decodedPhoto, capture, identifier)
  const photoBlob = new Blob([photoBytes], { type: 'image/jpeg' })
  onProgress?.({ phase: 'composing', progress: 0.2 })

  let tracks: MovTrackInput[]
  let movieTimescale: number
  let duration: number

  if (compress) {
    // 压缩档强制重编码为 SDR H.264 并缩放到长边上限，便于发布到媒体平台。
    const result = await transcodeToTracks(analysis, (f) => {
      onProgress?.({ phase: 'composing', progress: 0.2 + f * 0.6 })
    }, {
      maxLongEdge: tier.maxLongEdge,
      bitrateFactor: tier.bitrateFactor,
      bitrateMin: tier.bitrateMin,
      bitrateMax: tier.bitrateMax,
    })
    tracks = result.tracks
    movieTimescale = result.movieTimescale
    duration = result.duration
  } else if (analysis.remuxable && analysis.movie) {
    const movie = analysis.movie
    movieTimescale = movie.timescale
    duration = movie.duration / movie.timescale
    tracks = []
    let trackId = 0
    for (const handler of ['vide', 'soun'] as const) {
      // 音频选第一条 AAC 轨（iPhone HDR 视频可能把 APAC 空间音频排在前面）。
      const track = handler === 'soun'
        ? movie.tracks.find((t) => t.handler === 'soun' && t.stsdEntries[0]?.format === 'mp4a')
        : movie.tracks.find((t) => t.handler === handler)
      if (!track) continue
      if (!track.stsdEntries[0]) continue
      const copied = copyMovieTrack(track, handler, trackId + 1)
      if (handler === 'soun' && copied.samples.length === 0) {
        throw new LivePhotoMakerError('audioUnsupported')
      }
      if (copied.samples.length === 0) continue
      trackId++
      tracks.push(copied)
      onProgress?.({ phase: 'composing', progress: handler === 'vide' ? 0.55 : 0.75 })
    }
    if (!tracks.some((t) => t.handler === 'vide')) {
      throw new LivePhotoMakerError('videoTrackMissing')
    }
  } else {
    const result = await transcodeToTracks(analysis, (f) => {
      onProgress?.({ phase: 'composing', progress: 0.2 + f * 0.6 })
    })
    tracks = result.tracks
    movieTimescale = result.movieTimescale
    duration = result.duration
  }

  // still-image-time 贴合所选封面时刻；未指定封面位置（如自定义照片）时取开头。
  // 与 iOS 端 LivePhotoBuilder 统一：封面即关键帧，循环播放锚点与封面一致。
  const stillTimeSeconds = Math.min(Math.max(opts.coverTime ?? 0, 0), Math.max(0, duration - 1 / movieTimescale))
  const { header, blob: videoBlob } = buildMovieBlob(
    { movieTimescale, tracks, identifier, stillTimeSeconds, createdAt },
    analysis.file,
  )
  onProgress?.({ phase: 'saving', progress: 0.9 })

  // 校验成对文件
  const validVideo = isLivePhotoVideo(header, identifier)
  if (!verifyKeyPhoto(photoBytes, identifier) || !validVideo) {
    throw new LivePhotoMakerError('compositionFailed')
  }

  const baseName = `Live_${toExifDateString(capture.creationDate).replace(/[: ]/g, '')}`
  const build: LivePhotoBuild = {
    identifier,
    photoBlob,
    exifTiff,
    videoBlob,
    photoName: `${baseName}.JPG`,
    videoName: `${baseName}.MOV`,
    stillTimeSeconds,
    photoUrl: URL.createObjectURL(photoBlob),
    videoUrl: URL.createObjectURL(videoBlob),
    // 压缩档截帧封面已在上方置空 hevcStill；自定义上传封面本就无 hevcStill。
    hevcStill: decodedPhoto.hevcStill,
  }
  onProgress?.({ phase: 'saving', progress: 1 })
  return build
}

function isLivePhotoVideo(bytes: Uint8Array, identifier: string): boolean {
  const video = verifyMov(bytes)
  return video.identifier === identifier && video.stillTimeSeconds !== undefined && video.hasVideo
}
