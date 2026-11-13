/**
 * ISO BMFF（MP4/MOV）解析器。
 *
 * 只解析合成与元数据读取所需的 box：moov/mvhd、trak（tkhd/mdhd/hdlr/
 * edts/stbl）、udta/meta（keys/ilst）。样本数据保持对源缓冲区的引用，
 * 重封装时按 chunk 原样搬运，不做任何转码。
 */
import { ByteReader } from './bytes'

export interface Mp4Box {
  type: string
  /** box 头在文件中的绝对偏移。 */
  start: number
  /** 含头的总长度。 */
  size: number
  headerSize: number
  children?: Mp4Box[]
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'moof', 'traf', 'mvex'])
/** FullBox 容器：子 box 前有 4 字节 version/flags。 */
const FULL_CONTAINERS = new Set(['meta', 'dref'])

export function parseBoxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): Mp4Box[] {
  const boxes: Mp4Box[] = []
  let pos = start
  while (pos + 8 <= end) {
    const r = new ByteReader(bytes, pos)
    let size = r.u32()
    const type = r.fourCC()
    let headerSize = 8
    if (size === 1) {
      size = r.u64()
      headerSize = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < headerSize || pos + size > end) break
    const box: Mp4Box = { type, start: pos, size, headerSize }
    if (CONTAINERS.has(type)) {
      box.children = parseBoxes(bytes, pos + headerSize, pos + size)
    } else if (FULL_CONTAINERS.has(type)) {
      const payload = pos + headerSize
      const isQuickTimeMeta = type === 'meta' && payload + 8 <= pos + size &&
        new ByteReader(bytes, payload + 4).fourCC() === 'hdlr'
      box.children = parseBoxes(bytes, payload + (isQuickTimeMeta ? 0 : 4), pos + size)
    }
    boxes.push(box)
    pos += size
  }
  return boxes
}

export function findBox(boxes: Mp4Box[] | undefined, type: string): Mp4Box | undefined {
  return boxes?.find((b) => b.type === type)
}

export interface EditEntry {
  duration: number
  mediaTime: number
  rate: number
}

export interface StsdEntry {
  format: string
  raw: Uint8Array
}

export interface TrackInfo {
  id: number
  handler: string
  /** 电影时基下的轨道时长。 */
  duration: number
  width: number
  height: number
  matrix: Uint8Array
  tkhdRaw: Uint8Array
  timescale: number
  mediaDuration: number
  mdhdRaw: Uint8Array
  language: string
  edits?: EditEntry[]
  elstRaw?: Uint8Array
  stsdRaw: Uint8Array
  stsdEntries: StsdEntry[]
  stts: { count: number; delta: number }[]
  cttsRaw?: Uint8Array
  stss?: number[]
  stsc: { firstChunk: number; samplesPerChunk: number; sampleDescriptionIndex: number }[]
  sampleSizes: number[]
  chunkOffsets: number[]
  /** vmhd / smhd 原始字节（可能不存在）。 */
  mediaHeaderRaw?: Uint8Array
  mediaHeaderType?: string
}

export interface MovieInfo {
  boxes: Mp4Box[]
  timescale: number
  duration: number
  creationTime?: number
  tracks: TrackInfo[]
  /** moov.udta.meta 中的 QuickTime 元数据（mdta 键）。 */
  metadata: Map<string, string | number>
  fragmented: boolean
  brands: string[]
}

export class Mp4ParseError extends Error {}

function readFullBox(r: ByteReader): { version: number; flags: number } {
  const version = r.u8()
  const flags = r.u24()
  return { version, flags }
}

function parseTrack(bytes: Uint8Array, trak: Mp4Box): TrackInfo | undefined {
  const tkhdBox = findBox(trak.children, 'tkhd')
  const mdia = findBox(trak.children, 'mdia')
  if (!tkhdBox || !mdia) return undefined
  const mdhdBox = findBox(mdia.children, 'mdhd')
  const hdlrBox = findBox(mdia.children, 'hdlr')
  const minf = findBox(mdia.children, 'minf')
  if (!mdhdBox || !hdlrBox || !minf) return undefined
  const stbl = findBox(minf.children, 'stbl')
  if (!stbl) return undefined

  // tkhd
  const tkhdRaw = bytes.subarray(tkhdBox.start, tkhdBox.start + tkhdBox.size)
  let r = new ByteReader(bytes, tkhdBox.start + tkhdBox.headerSize)
  const tkhdVersion = r.u8()
  r.u24() // flags
  if (tkhdVersion === 1) {
    r.u64()
    r.u64()
  } else {
    r.u32()
    r.u32()
  }
  const id = r.u32()
  r.u32() // reserved
  const duration = tkhdVersion === 1 ? r.u64() : r.u32()
  r.skip(8) // reserved
  r.u16() // layer
  r.u16() // alternate group
  r.u16() // volume
  r.u16() // reserved
  const matrix = r.take(36)
  const widthFp = r.fp32()
  const heightFp = r.fp32()

  // mdhd
  const mdhdRaw = bytes.subarray(mdhdBox.start, mdhdBox.start + mdhdBox.size)
  r = new ByteReader(bytes, mdhdBox.start + mdhdBox.headerSize)
  const mdhdVersion = r.u8()
  r.u24()
  if (mdhdVersion === 1) {
    r.u64()
    r.u64()
  } else {
    r.u32()
    r.u32()
  }
  const timescale = r.u32()
  const mediaDuration = mdhdVersion === 1 ? r.u64() : r.u32()
  const languageCode = r.u16()
  let language = ''
  for (let i = 0; i < 3; i++) language += String.fromCharCode(((languageCode >> (5 * (2 - i))) & 31) + 96)

  // hdlr
  r = new ByteReader(bytes, hdlrBox.start + hdlrBox.headerSize)
  readFullBox(r)
  r.u32() // pre_defined
  const handler = r.fourCC()

  // edts/elst
  let edits: EditEntry[] | undefined
  let elstRaw: Uint8Array | undefined
  const edts = findBox(trak.children, 'edts')
  const elstBox = findBox(edts?.children, 'elst')
  if (elstBox) {
    elstRaw = bytes.subarray(elstBox.start, elstBox.start + elstBox.size)
    r = new ByteReader(bytes, elstBox.start + elstBox.headerSize)
    const { version } = readFullBox(r)
    const count = r.u32()
    edits = []
    for (let i = 0; i < count; i++) {
      const d = version === 1 ? r.u64() : r.u32()
      const m = version === 1 ? r.i64() : r.i32()
      const rate = r.u32()
      edits.push({ duration: d, mediaTime: m, rate })
    }
  }

  // stsd
  const stsdBox = findBox(stbl.children, 'stsd')
  if (!stsdBox) return undefined
  const stsdRaw = bytes.subarray(stsdBox.start, stsdBox.start + stsdBox.size)
  r = new ByteReader(bytes, stsdBox.start + stsdBox.headerSize)
  readFullBox(r)
  const entryCount = r.u32()
  const stsdEntries: StsdEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    const entryStart = r.pos
    const entrySize = r.u32()
    const format = r.fourCC()
    if (entrySize < 8 || entryStart + entrySize > stsdBox.start + stsdBox.size) break
    stsdEntries.push({ format, raw: bytes.subarray(entryStart, entryStart + entrySize) })
    r.seek(entryStart + entrySize)
  }

  // stts
  const sttsBox = findBox(stbl.children, 'stts')
  const stts: { count: number; delta: number }[] = []
  if (sttsBox) {
    r = new ByteReader(bytes, sttsBox.start + sttsBox.headerSize)
    readFullBox(r)
    const count = r.u32()
    for (let i = 0; i < count; i++) stts.push({ count: r.u32(), delta: r.u32() })
  }

  // stss（同步样本表，1 基索引）
  const stssBox = findBox(stbl.children, 'stss')
  let stss: number[] | undefined
  if (stssBox) {
    r = new ByteReader(bytes, stssBox.start + stssBox.headerSize)
    readFullBox(r)
    const count = r.u32()
    stss = []
    for (let i = 0; i < count; i++) stss.push(r.u32())
  }

  // stsc
  const stscBox = findBox(stbl.children, 'stsc')
  const stsc: TrackInfo['stsc'] = []
  if (stscBox) {
    r = new ByteReader(bytes, stscBox.start + stscBox.headerSize)
    readFullBox(r)
    const count = r.u32()
    for (let i = 0; i < count; i++) {
      stsc.push({ firstChunk: r.u32(), samplesPerChunk: r.u32(), sampleDescriptionIndex: r.u32() })
    }
  }

  // stsz
  const stszBox = findBox(stbl.children, 'stsz')
  const sampleSizes: number[] = []
  if (stszBox) {
    r = new ByteReader(bytes, stszBox.start + stszBox.headerSize)
    readFullBox(r)
    const uniform = r.u32()
    const count = r.u32()
    if (uniform !== 0) {
      for (let i = 0; i < count; i++) sampleSizes.push(uniform)
    } else {
      for (let i = 0; i < count; i++) sampleSizes.push(r.u32())
    }
  }

  // stco / co64
  const stcoBox = findBox(stbl.children, 'stco')
  const co64Box = findBox(stbl.children, 'co64')
  const chunkOffsets: number[] = []
  if (stcoBox) {
    r = new ByteReader(bytes, stcoBox.start + stcoBox.headerSize)
    readFullBox(r)
    const count = r.u32()
    for (let i = 0; i < count; i++) chunkOffsets.push(r.u32())
  } else if (co64Box) {
    r = new ByteReader(bytes, co64Box.start + co64Box.headerSize)
    readFullBox(r)
    const count = r.u32()
    for (let i = 0; i < count; i++) chunkOffsets.push(r.u64())
  }

  const ctts = findBox(stbl.children, 'ctts')
  // vmhd / smhd / nmhd / gmhd
  let mediaHeaderRaw: Uint8Array | undefined
  let mediaHeaderType: string | undefined
  for (const t of ['vmhd', 'smhd', 'nmhd', 'gmhd', 'hmhd']) {
    const b = findBox(minf.children, t)
    if (b) {
      mediaHeaderType = t
      mediaHeaderRaw = bytes.subarray(b.start, b.start + b.size)
      break
    }
  }

  return {
    id,
    handler,
    duration,
    width: widthFp,
    height: heightFp,
    matrix,
    tkhdRaw,
    timescale,
    mediaDuration,
    mdhdRaw,
    language,
    edits,
    elstRaw,
    stsdRaw,
    stsdEntries,
    stts,
    cttsRaw: ctts && bytes.subarray(ctts.start, ctts.start + ctts.size),
    stss,
    stsc,
    sampleSizes,
    chunkOffsets,
    mediaHeaderRaw,
    mediaHeaderType,
  }
}

/** 解析 QuickTime keys/ilst 元数据。 */
export function parseQuickTimeMetadata(bytes: Uint8Array, metaBox: Mp4Box): Map<string, string | number> {
  const result = new Map<string, string | number>()
  const keysBox = findBox(metaBox.children, 'keys')
  const ilstBox = findBox(metaBox.children, 'ilst')
  if (!keysBox || !ilstBox) return result

  let r = new ByteReader(bytes, keysBox.start + keysBox.headerSize)
  readFullBox(r)
  const keyCount = r.u32()
  const keys: string[] = []
  for (let i = 0; i < keyCount; i++) {
    const keySize = r.u32()
    if (keySize < 8) break
    r.skip(4) // namespace（mdta）
    keys.push(r.fixedString(keySize - 8))
  }

  const ilstEnd = ilstBox.start + ilstBox.size
  r = new ByteReader(bytes, ilstBox.start + ilstBox.headerSize)
  while (r.pos + 8 <= ilstEnd) {
    const itemSize = r.u32()
    const index = r.u32()
    if (itemSize < 16 || r.pos + itemSize - 8 > ilstEnd) break
    const itemEnd = r.pos + itemSize - 8
    // 内层 data box
    const dataSize = r.u32()
    const dataType = r.fourCC()
    if (dataType === 'data' && dataSize >= 16) {
      const type = r.u32()
      r.u32() // locale
      const valueLength = dataSize - 16
      const key = keys[index - 1]
      if (key && valueLength >= 0) {
        if (type === 1) {
          result.set(key, r.fixedString(valueLength))
        } else if (type === 21 || type === 22 || type === 0) {
          let v = 0
          for (let i = 0; i < Math.min(valueLength, 6); i++) v = v * 256 + r.u8()
          if (type === 21 && valueLength > 0 && (v & (1 << (valueLength * 8 - 1))) !== 0) {
            v -= 1 << (valueLength * 8)
          }
          result.set(key, v)
        } else {
          r.skip(valueLength)
        }
      } else {
        r.skip(Math.max(0, valueLength))
      }
    }
    r.seek(itemEnd)
  }
  return result
}

/** 解析整个电影容器。 */
export function parseMovie(bytes: Uint8Array): MovieInfo {
  const boxes = parseBoxes(bytes)
  const ftyp = findBox(boxes, 'ftyp')
  const moov = findBox(boxes, 'moov')
  if (!moov) throw new Mp4ParseError('moov box not found')

  const brands: string[] = []
  if (ftyp) {
    const r = new ByteReader(bytes, ftyp.start + ftyp.headerSize)
    brands.push(r.fourCC())
    r.u32()
    while (r.pos + 4 <= ftyp.start + ftyp.size) brands.push(r.fourCC())
  }

  const mvhdBox = findBox(moov.children, 'mvhd')
  if (!mvhdBox) throw new Mp4ParseError('mvhd box not found')
  let r = new ByteReader(bytes, mvhdBox.start + mvhdBox.headerSize)
  const { version } = readFullBox(r)
  let creationTime: number | undefined
  if (version === 1) {
    creationTime = r.u64()
    r.u64()
  } else {
    creationTime = r.u32()
    r.u32()
  }
  const timescale = r.u32()
  const duration = version === 1 ? r.u64() : r.u32()
  if (!timescale) throw new Mp4ParseError('invalid timescale')

  const tracks: TrackInfo[] = []
  for (const trak of moov.children ?? []) {
    if (trak.type !== 'trak') continue
    const info = parseTrack(bytes, trak)
    if (info) tracks.push(info)
  }

  let metadata = new Map<string, string | number>()
  const udta = findBox(moov.children, 'udta')
  const meta = findBox(moov.children, 'meta') ?? findBox(udta?.children, 'meta')
  if (meta) metadata = parseQuickTimeMetadata(bytes, meta)

  const fragmented = boxes.some((b) => b.type === 'moof')

  return { boxes, timescale, duration, creationTime, tracks, metadata, fragmented, brands }
}

export interface ExpandedSample {
  offset: number
  size: number
  /** 媒体时基下的时长。 */
  duration: number
  isKey: boolean
}

/** 把样本表展开为逐样本的偏移/大小/时长序列。 */
export function expandSamples(track: TrackInfo): ExpandedSample[] {
  const durations: number[] = []
  for (const { count, delta } of track.stts) {
    for (let i = 0; i < count; i++) durations.push(delta)
  }
  const sampleCount = Math.min(track.sampleSizes.length, durations.length)
  if (sampleCount === 0) return []

  const keySet = track.stss ? new Set(track.stss) : undefined

  // chunk → 样本数
  const chunkSampleCounts: number[] = []
  for (let i = 0; i < track.stsc.length; i++) {
    const entry = track.stsc[i]
    const next = track.stsc[i + 1]
    const lastChunk = next ? next.firstChunk - 1 : track.chunkOffsets.length
    for (let c = entry.firstChunk; c <= lastChunk; c++) {
      chunkSampleCounts[c - 1] = entry.samplesPerChunk
    }
  }

  const samples: ExpandedSample[] = []
  let sampleIndex = 0
  for (let c = 0; c < track.chunkOffsets.length && sampleIndex < sampleCount; c++) {
    let offset = track.chunkOffsets[c]
    const count = chunkSampleCounts[c] ?? 1
    for (let i = 0; i < count && sampleIndex < sampleCount; i++) {
      const size = track.sampleSizes[sampleIndex]
      samples.push({
        offset,
        size,
        duration: durations[sampleIndex],
        isKey: keySet ? keySet.has(sampleIndex + 1) : true,
      })
      offset += size
      sampleIndex++
    }
  }
  return samples
}

/** 轨道的呈现时长（电影时基），考虑 edit list。 */
export function trackPresentationDuration(track: TrackInfo, movieTimescale: number): number {
  if (track.edits && track.edits.length > 0) {
    let total = 0
    for (const e of track.edits) total += e.duration
    return total
  }
  return Math.round((track.mediaDuration * movieTimescale) / track.timescale)
}
