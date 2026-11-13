/**
 * 大端字节读写工具：ISO BMFF（MP4/MOV）与 EXIF/TIFF 均为大端序。
 * Little-endian helpers are included for TIFF "II" EXIF blocks.
 */

export class ByteReader {
  readonly view: DataView
  pos = 0

  constructor(readonly bytes: Uint8Array, pos = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = pos
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos
  }

  u8(): number {
    return this.view.getUint8(this.pos++)
  }

  u16(): number {
    const v = this.view.getUint16(this.pos)
    this.pos += 2
    return v
  }

  i16(): number {
    const v = this.view.getInt16(this.pos)
    this.pos += 2
    return v
  }

  u24(): number {
    return (this.u8() << 16) | (this.u8() << 8) | this.u8()
  }

  u32(): number {
    const v = this.view.getUint32(this.pos)
    this.pos += 4
    return v
  }

  i32(): number {
    const v = this.view.getInt32(this.pos)
    this.pos += 4
    return v
  }

  u64(): number {
    const hi = this.u32()
    const lo = this.u32()
    return hi * 0x100000000 + lo
  }

  i64(): number {
    const hi = this.i32()
    const lo = this.u32()
    return hi * 0x100000000 + lo
  }

  /** 16.16 定点数（QuickTime 矩阵、分辨率）。 */
  fp32(): number {
    return this.i32() / 65536
  }

  /** 8.8 定点数。 */
  fp16(): number {
    return this.i16() / 256
  }

  fourCC(): string {
    let s = ''
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8())
    return s
  }

  /** 读取定长字符串，保留全部字节位置推进。 */
  fixedString(length: number): string {
    const start = this.pos
    this.pos += length
    let end = start
    while (end < start + length && this.bytes[end] !== 0) end++
    let s = ''
    for (let i = start; i < end; i++) s += String.fromCharCode(this.bytes[i])
    return s
  }

  take(length: number): Uint8Array {
    const v = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return v
  }

  skip(length: number): void {
    this.pos += length
  }

  seek(pos: number): void {
    this.pos = pos
  }
}

export class ByteWriter {
  private chunks: number[] = []

  get length(): number {
    return this.chunks.length
  }

  u8(v: number): this {
    this.chunks.push(v & 0xff)
    return this
  }

  u16(v: number): this {
    this.chunks.push((v >>> 8) & 0xff, v & 0xff)
    return this
  }

  /** 小端 u16（ZIP 等小端格式）。 */
  u16le(v: number): this {
    this.chunks.push(v & 0xff, (v >>> 8) & 0xff)
    return this
  }

  /** 小端 u32（ZIP 等小端格式）。 */
  u32le(v: number): this {
    this.chunks.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    return this
  }

  u24(v: number): this {
    this.chunks.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
    return this
  }

  u32(v: number): this {
    this.chunks.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
    return this
  }

  i32(v: number): this {
    return this.u32(v < 0 ? v + 0x100000000 : v)
  }

  u64(v: number): this {
    this.u32(Math.floor(v / 0x100000000))
    this.u32(v >>> 0)
    return this
  }

  fp32(v: number): this {
    return this.i32(Math.round(v * 65536))
  }

  fp16(v: number): this {
    return this.u16(Math.round(v * 256) & 0xffff)
  }

  fourCC(s: string): this {
    for (let i = 0; i < 4; i++) this.chunks.push(s.charCodeAt(i) & 0xff)
    return this
  }

  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.chunks.push(s.charCodeAt(i) & 0xff)
    return this
  }

  raw(bytes: Uint8Array | number[]): this {
    for (let i = 0; i < bytes.length; i++) this.chunks.push(bytes[i])
    return this
  }

  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.chunks.push(0)
    return this
  }

  /** UTF-8 编码（用于元数据键名等）。 */
  utf8(s: string): this {
    return this.raw(new TextEncoder().encode(s))
  }

  build(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.chunks)
  }
}

/** 拼接多个字节段。 */
export function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/** 生成大写 UUID（Apple 配对标识使用大写形式）。 */
export function makeUUID(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
        })
  return uuid.toUpperCase()
}

/** ISO 639-2/T 语言代码打包（'und' → 0x55C4）。 */
export function packLanguage(code: string): number {
  let v = 0
  for (let i = 0; i < 3; i++) {
    v = (v << 5) | ((code.charCodeAt(i) || 96) - 96)
  }
  return v & 0x7fff
}

/** Mac 时间纪元（1904-01-01 UTC）与 Unix 纪元的差值（秒）。 */
export const MAC_EPOCH_OFFSET = 2082844800

export function unixToMacSeconds(unixSeconds: number): number {
  return Math.max(0, Math.floor(unixSeconds + MAC_EPOCH_OFFSET))
}
