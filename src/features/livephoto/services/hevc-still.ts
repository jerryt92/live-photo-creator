/**
 * 从可重封装的 hvc1 源视频中比特级抽取 HEVC 关键帧，作为 HDR 封面主图。
 * 不经过 sRGB 画布、不重新编码：10-bit HLG/PQ 原样保留，绕开 WebKit
 * VideoEncoder 对 IOSurface HDR 帧挂起的问题。仅当目标呈现时刻的样本
 * 恰为 IDR（如默认封面的第一帧、GOP 边界帧）时可用，否则返回 undefined。
 */
import { ByteReader, concatBytes } from './bytes'
import { expandSamples, findBox, parseBoxes, type TrackInfo } from './mp4'
import type { HevcColorInfo, HevcStill } from '../models'

/**
 * 解析样本描述内的 colr/nclx，兼容两种字段宽度：
 * ISO BMFF（primaries/transfer/matrix/range 各 u8）与
 * QuickTime（前三项各 u16，共 6 字节，无 range 字段 → 有限范围）。
 */
export function parseColrNclx(entryRaw: Uint8Array): HevcColorInfo | undefined {
  const boxes = parseBoxes(entryRaw, 86)
  const colr = findBox(boxes, 'colr')
  if (!colr) return undefined
  if (entryRaw[colr.start + 8] !== 0x6e) return undefined // 'nclx'
  const rest = colr.size - 8 - 4
  const r = new ByteReader(entryRaw, colr.start + 12)
  let primaries: number, transfer: number, matrix: number, fullRange = false
  if (rest >= 6) {
    primaries = r.u16()
    transfer = r.u16()
    matrix = r.u16()
    if (rest >= 7) fullRange = (r.u8() & 0x80) !== 0
  } else {
    primaries = r.u8()
    transfer = r.u8()
    matrix = r.u8()
    fullRange = (r.u8() & 0x80) !== 0
  }
  if (primaries !== 9) return undefined
  if (transfer !== 16 && transfer !== 18) return undefined
  return { primaries, transfer, matrix, fullRange }
}

/**
 * hvcC 位深：configurationVersion(0)、profile(1) 低 5 位。
 * Main10（profile 2）及以上 → 10-bit；Main/MainStill(1/3) → 8-bit。
 * （直接读 bit_depth_luma_minus8 字段在厂商实现间偏移不一，profile 更可靠。）
 */
export function hvcCBitDepth(payload: Uint8Array): number {
  if (payload[0] !== 1) return 8
  const profile = payload[1] & 0x1f
  return profile === 2 || profile >= 4 ? 10 : 8
}

/**
 * 逐样本呈现时间（媒体时基）：dts + ctts 偏移。
 * 偏移语义存在两种实况：规范 v0 偏置 2^31、v1 有符号；Apple 则可能在 v0 中
 * 直接写有符号值。用"全部 pts ≥ 0"的启发式在两种解释间自动选择。
 */
function presentationTimes(track: TrackInfo, sampleCount: number): number[] {
  const durations: number[] = []
  for (const { count, delta } of track.stts) {
    for (let i = 0; i < count && durations.length < sampleCount; i++) durations.push(delta)
  }
  const rawOffsets = new Array<number>(sampleCount).fill(0)
  if (track.cttsRaw) {
    const r = new ByteReader(track.cttsRaw, 8)
    r.skip(4) // version + flags
    const entryCount = r.u32()
    let index = 0
    for (let e = 0; e < entryCount && index < sampleCount; e++) {
      const count = r.u32()
      const raw = r.u32()
      for (let i = 0; i < count && index < sampleCount; i++) {
        rawOffsets[index++] = raw
      }
    }
  }
  const build = (interpret: (raw: number) => number): number[] => {
    const out: number[] = []
    let dts = 0
    for (let i = 0; i < sampleCount; i++) {
      out.push(dts + interpret(rawOffsets[i]))
      dts += durations[i] ?? 0
    }
    return out
  }
  const signed = build((raw) => (raw >= 0x80000000 ? raw - 0x100000000 : raw))
  if (signed.every((p) => p >= 0)) return signed
  return build((raw) => raw - 0x80000000)
}

/**
 * 抽取 timeSeconds（呈现秒）处样本：必须为 hvc1 且该样本是关键帧。
 * irot 来自源 tkhd 矩阵，写入 HEIC 使封面方向与视频一致。
 */
export async function extractHevcKeyframe(
  file: Blob,
  track: TrackInfo,
  timeSeconds: number,
  irot: number,
): Promise<HevcStill | undefined> {
  try {
    const entry = track.stsdEntries[0]
    if (!entry || entry.format !== 'hvc1') return undefined
    const colr = parseColrNclx(entry.raw)
    if (!colr) return undefined // SDR 源走原管线

    const hvcC = findBox(parseBoxes(entry.raw, 86), 'hvcC')
    if (!hvcC) return undefined
    const config = entry.raw.slice(hvcC.start + 8, hvcC.start + hvcC.size)
    const bitDepth = hvcCBitDepth(config)

    const samples = expandSamples(track)
    if (samples.length === 0) return undefined
    const pts = presentationTimes(track, samples.length)
    const target = timeSeconds * track.timescale
    // 开放 GOP 下呈现序首帧可能是非关键帧：只在关键帧中找最接近目标
    // 呈现时刻的样本（容差 0.25s），超出则交给回退管线保证封面时刻准确。
    const keyIndices: number[] = []
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].isKey) keyIndices.push(i)
    }
    let best = -1
    let bestDist = Infinity
    for (const i of keyIndices) {
      const dist = Math.abs(pts[i] - target)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    if (best < 0 || bestDist > track.timescale / 4) return undefined
    const sample = samples[best]
    if (sample.offset + sample.size > file.size) return undefined

    const data = new Uint8Array(await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer())
    // hvc1 项只允许 IRAP(16-21) 与 SEI(39/40)：
    // 带内参数集（VPS/SPS/PPS 32-34）在 hvcC 中已有；type 62 是
    // Dolby Vision RPU，ImageIO 解码静态图会拒绝——一并剥离。
    const nalUnits: Uint8Array[] = []
    let hasIrap = false
    let pos = 0
    while (pos + 4 <= data.length) {
      const len = ((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]) >>> 0
      pos += 4
      if (len === 0 || pos + len > data.length) break
      const nalType = (data[pos] >> 1) & 0x3f
      if (nalType >= 16 && nalType <= 21) {
        hasIrap = true
        nalUnits.push(data.subarray(pos - 4, pos + len))
      } else if (nalType === 39 || nalType === 40) {
        nalUnits.push(data.subarray(pos - 4, pos + len))
      }
      pos += len
    }
    if (!hasIrap || nalUnits.length === 0) return undefined

    // 不嵌入 colr：实测 ImageIO 会拒绝带 nclx 属性的抽取件；
    // 而剥离 colr 后仍能从码流 SPS VUI + SEI 正确识别 BT.2100 HLG/PQ 10-bit。
    // 上面的 nclx 解析仅用作 HDR 源判定。
    return {
      width: track.width,
      height: track.height,
      config,
      sample: concatBytes(nalUnits),
      bitDepth,
      irot: irot || undefined,
    }
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[hevc-still] extraction failed:', e)
    return undefined
  }
}
