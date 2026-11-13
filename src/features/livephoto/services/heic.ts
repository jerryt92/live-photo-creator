import { ByteWriter, concatBytes } from './bytes'
import { findBox, parseBoxes } from './mp4'
import type { HevcColorInfo, HevcStill } from '../models'

export type { HevcColorInfo, HevcStill }

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = payload.reduce((total, bytes) => total + bytes.byteLength, 8)
  return concatBytes([new ByteWriter().u32(size).fourCC(type).build(), ...payload])
}

function fullBox(type: string, version: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, new ByteWriter().u8(version).u24(0).build(), ...payload)
}

export class HeicCoverError extends Error {
  constructor(readonly reason: 'unavailable' | 'encoding', cause?: unknown) {
    super(reason === 'unavailable' ? 'HEVC encoder unavailable' : 'HEIC cover encoding failed', { cause })
  }
}

/**
 * 由 VideoFrame 的原生色彩空间推导 HDR 标注；SDR（bt709 等）返回 undefined。
 * WebCodecs 的 VideoFrame(HTMLVideoElement) 不做色调映射，PQ/HLG 原样保留。
 * 浏览器按现行规范返回 "smpte-st-2084"；TS DOM 库仍是旧拼写 "pq"，两者都接受。
 */
export function hdrColorInfo(
  space: { primaries?: string | null; transfer?: string | null; matrix?: string | null; fullRange?: boolean | null } | null | undefined,
): HevcColorInfo | undefined {
  if (!space || space.primaries !== 'bt2020') return undefined
  const pq = space.transfer === 'smpte-st-2084' || space.transfer === 'pq'
  if (!pq && space.transfer !== 'hlg') return undefined
  return {
    primaries: 9,
    transfer: pq ? 16 : 18,
    matrix: space.matrix === 'bt2020-bc' ? 10 : 9,
    fullRange: space.fullRange === true,
  }
}

/** 编码单帧 HEVC；frame 由调用方负责关闭。 */
export function encodeStill(
  frame: VideoFrame,
  config: VideoEncoderConfig,
  color?: HevcColorInfo,
  bitDepth?: number,
  irot?: number,
): Promise<HevcStill> {
  return new Promise((resolve, reject) => {
    let encoder: VideoEncoder | undefined
    let finished = false
    const timer = window.setTimeout(() => finish(new Error('HEVC encoder timed out')), color ? 8000 : 4000)

    function finish(error?: unknown, still?: HevcStill): void {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      if (encoder && encoder.state !== 'closed') encoder.close()
      if (still) resolve(still)
      else reject(error)
    }

    try {
      encoder = new VideoEncoder({
        output(chunk, metadata) {
          const description = metadata?.decoderConfig?.description
          if (!description) return
          const bytes = ArrayBuffer.isView(description)
            ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
            : new Uint8Array(description)
          const sample = new Uint8Array(chunk.byteLength)
          chunk.copyTo(sample)
          finish(undefined, {
            width: config.width,
            height: config.height,
            config: bytes.slice(),
            sample,
            bitDepth,
            irot,
            colr: color,
          })
        },
        error: finish,
      })
      encoder.configure(config)
      encoder.encode(frame, { keyFrame: true })
      void encoder.flush().then(
        () => finish(new Error('No HEVC frame with decoder configuration')),
        finish,
      )
    } catch (error) {
      finish(error)
    }
  })
}

const SDR_COVER_MAX_EDGE = 1920

function encodeCoverFrame(canvas: HTMLCanvasElement, config: VideoEncoderConfig): Promise<HevcStill> {
  const frame = new VideoFrame(canvas, { timestamp: 0, duration: 33333 })
  return encodeStill(frame, config).finally(() => frame.close())
}

async function encodeNative(jpeg: Blob): Promise<HevcStill> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new HeicCoverError('unavailable')
  }

  const bitmap = await createImageBitmap(jpeg)
  let canvas: HTMLCanvasElement | undefined
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height)
    const sizes = new Set([Math.min(longEdge, SDR_COVER_MAX_EDGE), Math.min(longEdge, 1280)])
    let lastError: unknown
    for (const size of sizes) {
      const scale = size / longEdge
      // HEVC 4:2:0 encoders expect even dimensions.
      const width = Math.ceil(bitmap.width * scale / 2) * 2
      const height = Math.ceil(bitmap.height * scale / 2) * 2
      const config: VideoEncoderConfig = {
        codec: 'hvc1.1.6.L120.B0', width, height,
        bitrate: 10_000_000, framerate: 30, latencyMode: 'realtime',
      }
      try {
        if (!(await VideoEncoder.isConfigSupported(config)).supported) continue
        // 即使不缩放，也先用不透明画布统一 SDR 编码输入。
        canvas ??= document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Canvas unavailable')
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        return await encodeCoverFrame(canvas, config)
      } catch (error) {
        lastError = error
      }
    }
    throw new HeicCoverError(lastError === undefined ? 'unavailable' : 'encoding', lastError)
  } finally {
    bitmap.close()
    if (canvas) canvas.width = canvas.height = 0
  }
}

interface HeifItem {
  id: number
  type: string
  name: string
  bytes: Uint8Array
}

function colrBox(color: HevcColorInfo): Uint8Array {
  // ISOBMFF/HEIF nclx：primaries/transfer/matrix 各 u16 + range 标志（libheif 按 16 位解析）。
  return box('colr', new ByteWriter()
    .fourCC('nclx')
    .u16(color.primaries)
    .u16(color.transfer)
    .u16(color.matrix)
    .u8(color.fullRange ? 0x80 : 0)
    .build())
}

function imageMetadata(still: HevcStill, items: HeifItem[], dataOffset: number): Uint8Array {
  const locations = new ByteWriter().u8(0x44).u8(0).u16(items.length)
  for (const item of items) {
    // File-relative offsets and one extent per item in mdat.
    locations.u16(item.id).u16(0).u16(1).u32(dataOffset).u32(item.bytes.length)
    dataOffset += item.bytes.length
  }
  const infos = items.map(({ id, type, name }) => {
    const info = new ByteWriter().u16(id).u16(0).fourCC(type).ascii(name).u8(0)
    return fullBox('infe', 2, info.build())
  })
  const references = items.slice(1).map(({ id }) =>
    box('cdsc', new ByteWriter().u16(id).u16(1).u16(1).build()),
  )
  const bitDepth = still.bitDepth ?? 8
  const properties: Uint8Array[] = [
    box('hvcC', still.config),
    fullBox('ispe', 0, new ByteWriter().u32(still.width).u32(still.height).build()),
    fullBox('pixi', 0, Uint8Array.of(3, bitDepth, bitDepth, bitDepth)),
  ]
  // Essential flags: hvcC=0x81, ispe=2, pixi=3, colr=0x84（HDR 色彩标注必须 essential）。
  const essential: number[] = [0x81, 2, 3]
  if (still.colr) {
    properties.push(colrBox(still.colr))
    essential.push(0x84)
  }
  // irot 为非 essential 的显示旋转声明（iPhone 旋转矩阵）。
  // ISO 23008-12 §6.5.10：角度存于低 2 位（0..3，逆时针 90° 倍数），高 6 位保留为 0。
  const optional: number[] = []
  if (still.irot) {
    properties.push(box('irot', Uint8Array.of(still.irot & 3)))
    optional.push(properties.length)
  }
  const associations = fullBox('ipma', 0, new ByteWriter()
    .u32(1).u16(1).u8(essential.length + optional.length)
    .raw(essential).raw(optional).build())
  return fullBox('meta', 0,
    fullBox('hdlr', 0, new ByteWriter().u32(0).fourCC('pict').zeros(12).u8(0).build()),
    fullBox('pitm', 0, new ByteWriter().u16(1).build()),
    fullBox('iloc', 0, locations.build()),
    fullBox('iinf', 0, new ByteWriter().u16(items.length).build(), ...infos),
    fullBox('iref', 0, ...references),
    box('iprp', box('ipco', ...properties), associations),
  )
}

/** 纯容器组装：HEVC 单帧（可带 HDR colr nclx）+ 可选 EXIF 项 → HEIC 字节。 */
export function buildHeicCoverFromStill(still: HevcStill, exifTiff?: Uint8Array): Uint8Array<ArrayBuffer> {
  const items: HeifItem[] = [
    { id: 1, type: 'hvc1', name: 'Primary', bytes: still.sample },
  ]
  if (exifTiff) {
    // HEIF Exif items start with the offset from this field to the TIFF header.
    items.push({ id: items.length + 1, type: 'Exif', name: 'Exif', bytes: concatBytes([new Uint8Array(4), exifTiff]) })
  }
  const ftyp = box('ftyp', new ByteWriter().fourCC('heic').u32(0).fourCC('mif1').fourCC('heic').build())
  const metaSize = imageMetadata(still, items, 0).length
  const meta = imageMetadata(still, items, ftyp.length + metaSize + 8)
  const mdat = box('mdat', ...items.map(({ bytes }) => bytes))
  return concatBytes([ftyp, meta, mdat])
}

/** SDR 管线：JPEG 封面 → canvas → hvc1.1.6 单帧 → HEIC。 */
export async function buildHeicCover(photo: Blob, exifTiff: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return buildHeicCoverFromStill(await encodeNative(photo), exifTiff)
}

/**
 * 结构校验：ftyp 品牌、hvcC/ispe 属性、hvc1 主图项、可选配对标识。
 * PVT 封装前调用，任何异常都回退 SDR 封面，保证相册始终能识别。
 */
export function verifyHeicCover(bytes: Uint8Array, identifier?: string): boolean {
  try {
    const boxes = parseBoxes(bytes)
    const ftyp = findBox(boxes, 'ftyp')
    if (!ftyp) return false
    const brands = String.fromCharCode(...bytes.subarray(ftyp.start + 8, ftyp.start + 12)) +
      String.fromCharCode(...bytes.subarray(ftyp.start + 16, ftyp.start + ftyp.size))
    if (!brands.includes('heic')) return false
    const meta = findBox(boxes, 'meta')
    if (!meta?.children) return false
    // parseBoxes 不递归 iprp/ipco，手动下钻。
    const iprp = findBox(meta.children, 'iprp')
    if (!iprp) return false
    const ipco = findBox(parseBoxes(bytes, iprp.start + 8, iprp.start + iprp.size), 'ipco')
    if (!ipco) return false
    const props = parseBoxes(bytes, ipco.start + 8, ipco.start + ipco.size)
    if (!findBox(props, 'hvcC') || !findBox(props, 'ispe')) return false
    const iinf = findBox(meta.children, 'iinf')
    if (!iinf) return false
    const hvc1Item = String.fromCharCode(...bytes.subarray(iinf.start, iinf.start + iinf.size)).includes('hvc1')
    if (!hvc1Item) return false
    const mdat = findBox(boxes, 'mdat')
    if (!mdat || mdat.size <= 8) return false
    if (identifier) {
      // 配对标识在 mdat 里的 Exif 项中，全文搜索。
      const needle = new TextEncoder().encode(identifier)
      let found = false
      outer: for (let i = 0; i <= bytes.byteLength - needle.byteLength; i++) {
        for (let j = 0; j < needle.byteLength; j++) {
          if (bytes[i + j] !== needle[j]) continue outer
        }
        found = true
        break
      }
      if (!found) return false
    }
    return true
  } catch {
    return false
  }
}
