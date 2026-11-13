/**
 * JPEG EXIF 读取与写入。
 *
 * 写入侧生成 Apple 实况照片所需的 MakerNote：14 字节 `Apple iOS` 头 +
 * 大端 TIFF IFD，标签 0x0011（十进制 17）携带配对标识 UUID。
 * 布局与 ExifTool 的 Apple MakerNote 解析一致（IFD 偏移相对 MakerNote 起点）。
 */
import { ByteWriter, concatBytes } from './bytes'
import {
  formatOffset,
  localOffsetMinutes,
  parseExifDate,
  parseOffset,
  toExifDateString,
  validatedCoordinate,
} from './capture'
import type { CaptureMetadata } from '../models'

// ---------------------------------------------------------------- 读取

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 }

interface TiffReader {
  bytes: Uint8Array
  view: DataView
  base: number
  little: boolean
}

function u16(t: TiffReader, pos: number): number {
  return t.view.getUint16(t.base + pos, t.little)
}
function u32(t: TiffReader, pos: number): number {
  return t.view.getUint32(t.base + pos, t.little)
}

function ifdEntries(t: TiffReader, ifdOffset: number): Map<number, { type: number; count: number; valuePos: number }> {
  const result = new Map<number, { type: number; count: number; valuePos: number }>()
  if (ifdOffset <= 0 || t.base + ifdOffset + 2 > t.bytes.byteLength) return result
  const count = u16(t, ifdOffset)
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12
    if (t.base + entry + 12 > t.bytes.byteLength) break
    const tag = u16(t, entry)
    const type = u16(t, entry + 2)
    const n = u32(t, entry + 4)
    const size = (TYPE_SIZES[type] ?? 1) * n
    const valuePos = size <= 4 ? entry + 8 : u32(t, entry + 8)
    result.set(tag, { type, count: n, valuePos })
  }
  return result
}

function readAscii(t: TiffReader, entry: { valuePos: number; count: number }): string {
  let s = ''
  for (let i = 0; i < entry.count; i++) {
    const c = t.bytes[t.base + entry.valuePos + i]
    if (c === undefined || c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

function readRational(t: TiffReader, pos: number): number {
  const num = u32(t, pos)
  const den = u32(t, pos + 4)
  return den === 0 ? 0 : num / den
}

/** 在 JPEG 中定位 EXIF APP1 段，返回 TIFF 块起点。 */
export function findExifTiff(bytes: Uint8Array): number | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let pos = 2
  while (pos + 4 < bytes.byteLength) {
    if (bytes[pos] !== 0xff) break
    const marker = bytes[pos + 1]
    if (marker === 0xda || marker === 0xd9) break // SOS / EOI
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3]
    if (marker === 0xe1 && length >= 8) {
      const sig = String.fromCharCode(...bytes.subarray(pos + 4, pos + 10))
      if (sig === 'Exif\0\0') return pos + 10
    }
    pos += 2 + length
  }
  return undefined
}

export interface PhotoExifInfo {
  metadata: CaptureMetadata
  orientation: number
}

/** 从 JPEG 字节中读取拍摄时间与 GPS。 */
export function readPhotoExif(bytes: Uint8Array): PhotoExifInfo {
  const empty: PhotoExifInfo = { metadata: {}, orientation: 1 }
  const tiffStart = findExifTiff(bytes)
  if (tiffStart === undefined) return empty
  const byteOrder = String.fromCharCode(bytes[tiffStart], bytes[tiffStart + 1])
  if (byteOrder !== 'MM' && byteOrder !== 'II') return empty
  const t: TiffReader = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    base: tiffStart,
    little: byteOrder === 'II',
  }
  if (u16(t, 2) !== 42) return empty
  const ifd0 = ifdEntries(t, u32(t, 4))

  const orientation = ifd0.has(0x0112) ? u16(t, ifd0.get(0x0112)!.valuePos) : 1

  const exifOffset = ifd0.has(0x8769) ? u32(t, ifd0.get(0x8769)!.valuePos) : 0
  const exif = exifOffset ? ifdEntries(t, exifOffset) : new Map()

  const dateEntry = exif.get(0x9003) ?? exif.get(0x9004) ?? ifd0.get(0x0132)
  const offsetEntry = exif.get(0x9010) ?? exif.get(0x9011) ?? exif.get(0x9012)
  let metadata: CaptureMetadata = {}
  if (dateEntry) {
    const offset = offsetEntry ? parseOffset(readAscii(t, offsetEntry)) : undefined
    const date = parseExifDate(readAscii(t, dateEntry), offset ?? localOffsetMinutes())
    if (date) metadata.creationDate = date
  }

  const gpsOffset = ifd0.has(0x8825) ? u32(t, ifd0.get(0x8825)!.valuePos) : 0
  if (gpsOffset) {
    const gps = ifdEntries(t, gpsOffset)
    const latEntry = gps.get(0x0002)
    const lonEntry = gps.get(0x0004)
    if (latEntry && lonEntry && latEntry.count >= 3 && lonEntry.count >= 3) {
      let lat = 0
      let lon = 0
      for (let i = 0; i < 3; i++) {
        lat += readRational(t, latEntry.valuePos + i * 8) / 60 ** i
        lon += readRational(t, lonEntry.valuePos + i * 8) / 60 ** i
      }
      const latRef = gps.has(0x0001) ? readAscii(t, gps.get(0x0001)!) : 'N'
      const lonRef = gps.has(0x0003) ? readAscii(t, gps.get(0x0003)!) : 'E'
      if (latRef.toUpperCase() === 'S') lat = -lat
      if (lonRef.toUpperCase() === 'W') lon = -lon
      const coordinate = validatedCoordinate(lat, lon)
      if (coordinate) {
        metadata.coordinate = coordinate
        const altEntry = gps.get(0x0006)
        if (altEntry) {
          let altitude = readRational(t, altEntry.valuePos)
          const altRef = gps.has(0x0005) ? t.bytes[t.base + gps.get(0x0005)!.valuePos] : 0
          if (altRef === 1) altitude = -altitude
          metadata.altitude = altitude
        }
      }
    }
  }

  return { metadata, orientation: orientation || 1 }
}

// ---------------------------------------------------------------- 写入

/** Apple MakerNote：14 字节头 + IFD（tag 17 = 配对标识）。 */
export function buildAppleMakerNote(identifier: string): Uint8Array {
  const uuidBytes = new TextEncoder().encode(identifier)
  const dataLength = uuidBytes.byteLength + 1
  const w = new ByteWriter()
  // 14 字节头：Apple iOS\0 + \0\x01 + MM
  .ascii('Apple iOS').u8(0).u8(0).u8(1).ascii('MM')
  // IFD（偏移相对 MakerNote 起点）：1 个条目，数据紧随 IFD 之后（offset 32）
  .u16(1)
  .u16(0x0011).u16(2).u32(dataLength).u32(32)
  .u32(0)
  .raw(uuidBytes).u8(0)
  return w.build()
}

interface IfdEntry {
  tag: number
  type: number
  count: number
  value: Uint8Array
}

function asciiEntry(tag: number, s: string): IfdEntry {
  const bytes = new TextEncoder().encode(s + '\0')
  return { tag, type: 2, count: bytes.byteLength, value: bytes }
}

function shortEntry(tag: number, v: number): IfdEntry {
  return { tag, type: 3, count: 1, value: new ByteWriter().u16(v).build() }
}

function longEntry(tag: number, v: number): IfdEntry {
  return { tag, type: 4, count: 1, value: new ByteWriter().u32(v).build() }
}

function rationalEntry(tag: number, parts: [number, number][]): IfdEntry {
  const w = new ByteWriter()
  for (const [n, d] of parts) w.u32(n).u32(d)
  return { tag, type: 5, count: parts.length, value: w.build() }
}

function undefinedEntry(tag: number, value: Uint8Array): IfdEntry {
  return { tag, type: 7, count: value.byteLength, value }
}

function ifdSize(entries: IfdEntry[]): number {
  return 2 + entries.length * 12 + 4
}

function externalSize(entries: IfdEntry[]): number {
  let size = 0
  for (const e of entries) {
    if (e.value.byteLength > 4) size += e.value.byteLength + (e.value.byteLength % 2)
  }
  return size
}

/** 编码 IFD：startOffset 为 IFD 相对 TIFF 起点的偏移。 */
function encodeIfd(entries: IfdEntry[], startOffset: number): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag)
  const w = new ByteWriter().u16(sorted.length)
  let dataOffset = startOffset + ifdSize(sorted)
  const external: Uint8Array[] = []
  for (const e of sorted) {
    w.u16(e.tag).u16(e.type).u32(e.count)
    if (e.value.byteLength <= 4) {
      w.raw(e.value).zeros(4 - e.value.byteLength)
    } else {
      w.u32(dataOffset)
      external.push(e.value)
      if (e.value.byteLength % 2) external.push(new Uint8Array(1))
      dataOffset += e.value.byteLength + (e.value.byteLength % 2)
    }
  }
  w.u32(0) // next IFD
  return concatBytes([w.build(), ...external])
}

export interface ExifWriteOptions {
  identifier: string
  metadata: CaptureMetadata
}

/** 生成完整的 EXIF APP1 段（含 FFE1 标记与长度）。 */
export function buildExifApp1(opts: ExifWriteOptions): Uint8Array {
  const { identifier, metadata } = opts
  const makerNote = buildAppleMakerNote(identifier)

  const exifEntries: IfdEntry[] = [undefinedEntry(0x927c, makerNote)]
  if (metadata.creationDate) {
    const dateStr = toExifDateString(metadata.creationDate)
    const offsetStr = formatOffset(metadata.creationDate.offsetMinutes ?? localOffsetMinutes())
    exifEntries.push(
      asciiEntry(0x9003, dateStr),
      asciiEntry(0x9004, dateStr),
      asciiEntry(0x9010, offsetStr),
      asciiEntry(0x9011, offsetStr),
    )
  }

  const gpsEntries: IfdEntry[] = []
  if (metadata.coordinate) {
    const { latitude, longitude } = metadata.coordinate
    const toRationals = (value: number): [number, number][] => {
      const abs = Math.abs(value)
      const deg = Math.floor(abs)
      const minFloat = (abs - deg) * 60
      const min = Math.floor(minFloat)
      const sec = Math.round((minFloat - min) * 60 * 10000)
      return [
        [deg, 1],
        [min, 1],
        [sec, 10000],
      ]
    }
    gpsEntries.push(
      asciiEntry(0x0001, latitude >= 0 ? 'N' : 'S'),
      rationalEntry(0x0002, toRationals(latitude)),
      asciiEntry(0x0003, longitude >= 0 ? 'E' : 'W'),
      rationalEntry(0x0004, toRationals(longitude)),
    )
    if (metadata.altitude !== undefined) {
      const alt = Math.round(Math.abs(metadata.altitude) * 1000)
      gpsEntries.push(
        { tag: 0x0005, type: 1, count: 1, value: Uint8Array.of(metadata.altitude >= 0 ? 0 : 1) },
        rationalEntry(0x0006, [[alt, 1000]]),
      )
    }
  }

  // 布局：TIFF 头(8) + IFD0 + IFD0 数据 + ExifIFD + Exif 数据 + GPS IFD + GPS 数据
  const ifd0Entries: IfdEntry[] = [shortEntry(0x0112, 1)]
  if (metadata.creationDate) ifd0Entries.push(asciiEntry(0x0132, toExifDateString(metadata.creationDate)))

  const ifd0Start = 8
  const ifd0PointerCount = 1 + (gpsEntries.length > 0 ? 1 : 0)
  const ifd0Size = ifdSize(ifd0Entries) + ifd0PointerCount * 12
  const ifd0DataSize = externalSize(ifd0Entries)
  const exifStart = ifd0Start + ifd0Size + ifd0DataSize
  const exifSize = ifdSize(exifEntries) + externalSize(exifEntries)
  const gpsStart = exifStart + exifSize
  const gpsSize = gpsEntries.length > 0 ? ifdSize(gpsEntries) + externalSize(gpsEntries) : 0

  ifd0Entries.push(longEntry(0x8769, exifStart))
  if (gpsEntries.length > 0) ifd0Entries.push(longEntry(0x8825, gpsStart))

  const tiff = concatBytes([
    new ByteWriter().ascii('MM').u16(42).u32(ifd0Start).build(),
    encodeIfd(ifd0Entries, ifd0Start),
    encodeIfd(exifEntries, exifStart),
    ...(gpsEntries.length > 0 ? [encodeIfd(gpsEntries, gpsStart)] : []),
  ])
  void gpsSize

  const payload = concatBytes([new TextEncoder().encode('Exif\0\0'), tiff])
  return concatBytes([
    new ByteWriter().u8(0xff).u8(0xe1).u16(payload.byteLength + 2).build(),
    payload,
  ])
}

/** 把 EXIF APP1 注入 JPEG（移除已有 EXIF APP1，插在 SOI/APP0 之后）。 */
export function injectExif(jpeg: Uint8Array, app1: Uint8Array): Uint8Array<ArrayBuffer> {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG')
  const parts: Uint8Array[] = [jpeg.subarray(0, 2)]
  let pos = 2
  let inserted = false
  const insert = () => {
    if (!inserted) {
      parts.push(app1)
      inserted = true
    }
  }
  while (pos + 4 < jpeg.byteLength) {
    if (jpeg[pos] !== 0xff) break
    const marker = jpeg[pos + 1]
    if (marker === 0xda || marker === 0xd9) break
    // 填充字节
    if (marker === 0xff) {
      pos++
      continue
    }
    const length = (jpeg[pos + 2] << 8) | jpeg[pos + 3]
    const segEnd = pos + 2 + length
    if (marker === 0xe0) {
      parts.push(jpeg.subarray(pos, segEnd))
      insert()
    } else if (marker === 0xe1) {
      const sig = String.fromCharCode(...jpeg.subarray(pos + 4, Math.min(pos + 10, segEnd)))
      if (sig.startsWith('Exif')) {
        // 丢弃旧 EXIF
      } else {
        parts.push(jpeg.subarray(pos, segEnd))
      }
      insert()
    } else {
      insert()
      parts.push(jpeg.subarray(pos, segEnd))
    }
    pos = segEnd
  }
  insert()
  parts.push(jpeg.subarray(pos))
  return concatBytes(parts)
}
