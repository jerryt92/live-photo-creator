/**
 * HEVC / Dolby Vision 码流与样本描述工具（转码与封面抽取共用）。
 *
 * 目标：HDR 源（BT.2020 HLG/PQ，10-bit）在导出时原样保留。
 *  - 可重封装的 HEVC：比特级搬运，不做任何转码；
 *  - 兼容基底的 Dolby Vision（profile 8.x，HLG/HDR10 兼容）：剥离 RPU 与
 *    DV 配置 box，还原为标准 hvc1 HLG/PQ —— 与 iPhone 原生实况照片一致，
 *    避免第三方（微信/相册）因 dvh1/dvvC 拒收；
 *  - 必须转码时：优先 HEVC Main10 保留 HDR，而非降级 H.264 SDR。
 */
import { ByteWriter, concatBytes } from './bytes'
import { findBox, parseBoxes } from './mp4'
import type { HevcColorInfo } from '../models'

/** Dolby Vision 解码配置记录（dvcC/dvvC/dvwC 载荷，ETSI TS 103 572）。 */
export interface DolbyVisionInfo {
  profile: number
  level: number
  rpuPresent: boolean
  elPresent: boolean
  blPresent: boolean
  /** 基底信号兼容性：1=HDR10(PQ)，4=HLG，6=BD PQ；0=无兼容基底(profile 5)。 */
  blSignalCompatibilityId: number
}

const DV_BOX_TYPES = ['dvcC', 'dvvC', 'dvwC'] as const

/** 从样本描述中查找 Dolby Vision 配置 box；无则 undefined。 */
export function findDolbyVisionConfig(entryRaw: Uint8Array): { info: DolbyVisionInfo; type: string } | undefined {
  const children = parseBoxes(entryRaw, 86)
  for (const type of DV_BOX_TYPES) {
    const box = findBox(children, type)
    if (!box || box.size < 8 + 5) continue
    const p = entryRaw.subarray(box.start + 8, box.start + box.size)
    const info: DolbyVisionInfo = {
      profile: p[2] >> 1,
      level: ((p[2] & 1) << 5) | (p[3] >> 3),
      rpuPresent: ((p[3] >> 2) & 1) === 1,
      elPresent: ((p[3] >> 1) & 1) === 1,
      blPresent: (p[3] & 1) === 1,
      blSignalCompatibilityId: p[4] >> 4,
    }
    return { info, type }
  }
  return undefined
}

/**
 * 基底是否为可独立播放的标准 HDR 信号（可直接剥离 RPU 当普通 HEVC 用）。
 * profile 8.x 且兼容 HDR10/HLG、单层（无增强层）时成立；profile 5 的
 * IPT-PQ-c2 基底离开 RPU 无法正确显色，必须整段保留 DV。
 */
export function isConvertibleDolbyVision(info: DolbyVisionInfo): boolean {
  return (
    info.blPresent &&
    !info.elPresent &&
    (info.blSignalCompatibilityId === 1 || info.blSignalCompatibilityId === 4 || info.blSignalCompatibilityId === 6)
  )
}

/** 由 DV 兼容性 id 推导 HDR 色彩标注（仅兼容基底有意义）。 */
export function hdrColorFromDolbyVision(info: DolbyVisionInfo): HevcColorInfo | undefined {
  if (!isConvertibleDolbyVision(info)) return undefined
  return {
    primaries: 9,
    transfer: info.blSignalCompatibilityId === 4 ? 18 : 16,
    matrix: 9,
    fullRange: false,
  }
}

/** HEVC NAL 单元类型（2 字节头的首字节高 6 位）。 */
export function nalUnitType(firstByte: number): number {
  return (firstByte >> 1) & 0x3f
}

/** Dolby Vision RPU 的 NAL 类型。 */
export const NAL_TYPE_RPU = 62

/**
 * 扫描 4 字节长度前缀的 HEVC 样本，返回每个 NAL 的 [start, end)（含长度前缀）。
 * iPhone hvc1 样本一律 4 字节长度前缀（lengthSizeMinusOne=3）。
 */
export function* iterNals(sample: Uint8Array): Generator<{ start: number; end: number; type: number }> {
  let pos = 0
  while (pos + 4 <= sample.byteLength) {
    const len = ((sample[pos] << 24) | (sample[pos + 1] << 16) | (sample[pos + 2] << 8) | sample[pos + 3]) >>> 0
    pos += 4
    if (len === 0 || pos + len > sample.byteLength) break
    yield { start: pos - 4, end: pos + len, type: nalUnitType(sample[pos]) }
    pos += len
  }
}

/** 样本是否携带 Dolby Vision RPU（决定是否值得重写该样本）。 */
export function sampleHasRpu(sample: Uint8Array): boolean {
  for (const nal of iterNals(sample)) {
    if (nal.type === NAL_TYPE_RPU) return true
  }
  return false
}

/** 剥离样本中的 RPU NAL，其余字节原样保留。 */
export function stripRpu(sample: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = []
  for (const nal of iterNals(sample)) {
    if (nal.type !== NAL_TYPE_RPU) parts.push(sample.subarray(nal.start, nal.end))
  }
  return concatBytes(parts)
}

/**
 * colr nclx box（ISOBMFF 布局：primaries/transfer/matrix 各 u16 + range 标志）。
 * 与 iPhone HDR MP4 的 nclx 一致；QuickTime/ImageIO 按 16 位字段解析。
 */
export function nclxBox(color: HevcColorInfo): Uint8Array {
  const payload = new ByteWriter()
    .fourCC('nclx')
    .u16(color.primaries)
    .u16(color.transfer)
    .u16(color.matrix)
    .u8(color.fullRange ? 0x80 : 0)
    .build()
  return concatBytes([new ByteWriter().u32(8 + payload.byteLength).fourCC('colr').build(), payload])
}

/**
 * 组装 hvc1 样本描述：86 字节 QuickTime 固定头 + hvcC + colr + 可选 pasp/btrt。
 * hvcC 为裸配置记录（不含 box 头），colr 为完整 box。
 */
export function buildHvc1Entry(
  width: number,
  height: number,
  hvcC: Uint8Array,
  colr?: Uint8Array,
  extraBoxes: Uint8Array[] = [],
): Uint8Array {
  const header = new ByteWriter()
    .zeros(6).u16(1)
    .u16(0).u16(0).zeros(12)
    .u16(width).u16(height)
    .fp32(72).fp32(72)
    .u32(0)
    .u16(1)
    .zeros(32) // compressor name
    .u16(24)
    .u16(0xffff)
    .build()
  const hvcCBox = concatBytes([new ByteWriter().u32(8 + hvcC.byteLength).fourCC('hvcC').build(), hvcC])
  const body = concatBytes([header, hvcCBox, ...(colr ? [colr] : []), ...extraBoxes])
  return concatBytes([new ByteWriter().u32(8 + body.byteLength).fourCC('hvc1').build(), body])
}
