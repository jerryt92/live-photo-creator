/**
 * 关键照片管线：解码 → 按 EXIF 方向摆正 → JPEG 重编码 → 注入配对 EXIF。
 * 对应 iOS 端 LivePhotoBuilder.writeKeyPhoto。
 */
import { buildExifApp1, findExifTiff, injectExif, readPhotoExif } from './exif'
import type { CaptureMetadata, HevcStill } from '../models'
import { LivePhotoMakerError } from '../models'

export interface DecodedPhoto {
  blob: Blob
  width: number
  height: number
  metadata: CaptureMetadata
  orientation: number
  previewUrl?: string
  /** HDR 视频截帧的原生 HEVC 单帧；存在时 PVT 封面直接用它封装。 */
  hevcStill?: HevcStill
}

/** 解码图片文件（HEIC 仅 Safari 支持；失败抛出 photoUnreadable）。 */
export async function decodePhoto(file: File): Promise<DecodedPhoto> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { metadata, orientation } = readPhotoExif(bytes)

  let bitmap: ImageBitmap | undefined
  let objectUrl: string | undefined
  try {
    if ('createImageBitmap' in window) {
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      } catch {
        bitmap = undefined
      }
    }
    let source: CanvasImageSource
    let width: number
    let height: number
    if (bitmap) {
      source = bitmap
      width = bitmap.width
      height = bitmap.height
    } else {
      const img = await loadImageElement(file)
      objectUrl = img.src
      source = img
      width = img.naturalWidth
      height = img.naturalHeight
      // <img> 默认按 EXIF 方向渲染；naturalWidth 为摆正后的尺寸
    }
    if (!width || !height) throw new Error('empty image')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.drawImage(source, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('encode failed'))),
        'image/jpeg',
        0.95,
      )
    })
    // UI 缩略图（≤512px）
    let previewUrl: string | undefined
    const thumbScale = Math.min(1, 512 / Math.max(width, height))
    if (thumbScale < 1) {
      const thumb = document.createElement('canvas')
      thumb.width = Math.round(width * thumbScale)
      thumb.height = Math.round(height * thumbScale)
      thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height)
      previewUrl = thumb.toDataURL('image/jpeg', 0.85)
    } else {
      previewUrl = canvas.toDataURL('image/jpeg', 0.85)
    }
    return { blob, width, height, metadata, orientation, previewUrl }
  } catch {
    throw new LivePhotoMakerError('photoUnreadable')
  } finally {
    bitmap?.close()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

/** 生成携带配对标识与所选元数据的关键照片 JPEG。 */
export async function buildKeyPhoto(
  decoded: DecodedPhoto,
  metadata: CaptureMetadata,
  identifier: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; exifTiff: Uint8Array }> {
  const jpegBytes = new Uint8Array(await decoded.blob.arrayBuffer())
  const app1 = buildExifApp1({ identifier, metadata })
  return {
    bytes: injectExif(jpegBytes, app1),
    exifTiff: app1.subarray(10), // APP1 marker, length and Exif signature
  }
}

/** 校验输出 JPEG 的 MakerNote 配对标识。 */
export function verifyKeyPhoto(bytes: Uint8Array, identifier: string): boolean {
  const tiffStart = findExifTiff(bytes)
  if (tiffStart === undefined) return false
  const needle = new TextEncoder().encode(identifier)
  outer: for (let i = tiffStart; i <= bytes.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (bytes[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}
