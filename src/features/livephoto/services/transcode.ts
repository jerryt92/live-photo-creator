/**
 * 视频/音频导出管线，HDR 保真优先：
 *
 * 1. 可比特级搬运的视频（H.264/HEVC/Dolby Vision）绝不转码——直接重封装，
 *    HDR（BT.2020 HLG/PQ 10-bit）原样保留；兼容基底的 Dolby Vision 剥离
 *    RPU 还原为标准 hvc1 HLG/PQ。音频优先复制 AAC，否则仅转码音频。
 * 2. 必须转码时（WebM、不可搬运编码）：HDR 帧优先编码 HEVC Main10 保留
 *    高动态范围，编码器不支持才回退 H.264 SDR。音频转 AAC。
 *
 * 不支持 WebCodecs 且无法重封装的环境抛出 videoUnsupported。
 */
import { ByteWriter, concatBytes } from './bytes'
import { expandSamples, findBox, parseBoxes, type MovieInfo, type TrackInfo } from './mp4'
import { copyMovieTrack, irotAngleFromMatrix, type MovSample, type MovTrackInput } from './mov'
import type { VideoAnalysis } from './media'
import { LivePhotoMakerError, scaledDimensions, type HevcColorInfo } from '../models'
import {
  buildHvc1Entry, findDolbyVisionConfig, hdrColorFromDolbyVision, isConvertibleDolbyVision,
  nclxBox, sampleHasRpu, stripRpu,
} from './hevc'
import { encodeStill, hdrColorInfo } from './heic'

const TIMESCALE = 600

export interface TranscodeResult {
  tracks: MovTrackInput[]
  movieTimescale: number
  duration: number
}

// ---------------------------------------------------------------- WebM 解封装

interface WebMTrack {
  trackNumber: number
  type: 'video' | 'audio'
  codecId: string
  codecPrivate?: Uint8Array
  width: number
  height: number
  sampleRate: number
  channels: number
}

interface WebMBlock {
  trackNumber: number
  timecodeMs: number
  data: Uint8Array
  isKey: boolean
}

interface WebMDemux {
  tracks: WebMTrack[]
  blocks: WebMBlock[]
  durationMs: number
}

class EbmlReader {
  pos = 0
  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.byteLength
  }

  /** 读取 vint，返回 {value, length}；size 模式下屏蔽长度位。 */
  vint(mask: boolean): { value: number; length: number } | undefined {
    if (this.pos >= this.bytes.byteLength) return undefined
    const first = this.bytes[this.pos]
    if (first === 0) return undefined
    let length = 1
    let marker = 0x80
    while (length <= 8 && !(first & marker)) {
      length++
      marker >>= 1
    }
    if (length > 8 || this.pos + length > this.bytes.byteLength) return undefined
    let value = mask ? first & (marker - 1) : first
    for (let i = 1; i < length; i++) value = value * 256 + this.bytes[this.pos + i]
    this.pos += length
    return { value, length }
  }

  id(): number | undefined {
    const v = this.vint(false)
    return v?.value
  }

  readUint(size: number): number {
    let v = 0
    for (let i = 0; i < size; i++) v = v * 256 + this.bytes[this.pos++]
    return v
  }

  readFloat(size: number): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, size)
    this.pos += size
    return size === 4 ? view.getFloat32(0) : view.getFloat64(0)
  }

  readInt(size: number): number {
    let v = 0
    for (let i = 0; i < size; i++) v = v * 256 + this.bytes[this.pos++]
    if (size > 0 && v >= 2 ** (size * 8 - 1)) v -= 2 ** (size * 8)
    return v
  }

  take(size: number): Uint8Array {
    const v = this.bytes.subarray(this.pos, this.pos + size)
    this.pos += size
    return v
  }

  skip(size: number): void {
    this.pos += size
  }
}

const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  BlockDuration: 0x9b,
}

const UNKNOWN_SIZE = 0x1fffffffffffff

export function demuxWebM(bytes: Uint8Array): WebMDemux {
  const tracks: WebMTrack[] = []
  const blocks: WebMBlock[] = []
  let timecodeScaleNs = 1e6
  let durationScale = 0

  const r = new EbmlReader(bytes)
  // EBML 头
  if (r.id() !== 0x1a45dfa3) throw new LivePhotoMakerError('videoUnreadable')
  const headerSize = r.vint(true)!.value
  r.skip(headerSize === UNKNOWN_SIZE ? 0 : headerSize)

  const readBlock = (payload: Uint8Array, clusterMs: number, isSimple: boolean, hasRef: boolean) => {
    const br = new EbmlReader(payload)
    const trackV = br.vint(true)
    if (!trackV) return
    const rel = br.readInt(2)
    const flags = isSimple ? br.readUint(1) : 0
    blocks.push({
      trackNumber: trackV.value,
      timecodeMs: clusterMs + rel,
      data: br.take(payload.byteLength - br.pos),
      isKey: isSimple ? (flags & 0x80) !== 0 : !hasRef,
    })
  }

  const parseLevel = (end: number, depth: number, ctx: { track?: WebMTrack; clusterMs?: number; inBlockGroup?: boolean; hasRef?: boolean; blockPayload?: Uint8Array }) => {
    while (r.pos < end && !r.done && depth < 8) {
      const id = r.id()
      if (id === undefined) break
      const sizeV = r.vint(true)
      if (!sizeV) break
      const size = sizeV.value
      const start = r.pos
      const actualEnd = size === UNKNOWN_SIZE ? end : Math.min(start + size, end)

      switch (id) {
        case ID.Segment:
        case ID.Tracks:
        case ID.Cluster:
          if (id === ID.Cluster) ctx.clusterMs = 0
          parseLevel(actualEnd, depth + 1, ctx)
          break
        case ID.Info:
        case ID.TrackEntry:
        case ID.Video:
        case ID.Audio:
          if (id === ID.TrackEntry) {
            ctx.track = {
              trackNumber: 0,
              type: 'video',
              codecId: '',
              width: 0,
              height: 0,
              sampleRate: 48000,
              channels: 2,
            }
          }
          parseLevel(actualEnd, depth + 1, ctx)
          if (id === ID.TrackEntry && ctx.track && ctx.track.trackNumber > 0) {
            tracks.push(ctx.track)
            ctx.track = undefined
          }
          break
        case ID.BlockGroup: {
          const groupCtx = { ...ctx, hasRef: false, blockPayload: undefined as Uint8Array | undefined }
          parseLevel(actualEnd, depth + 1, groupCtx)
          if (groupCtx.blockPayload) {
            readBlock(groupCtx.blockPayload, ctx.clusterMs ?? 0, false, !!groupCtx.hasRef)
          }
          break
        }
        case ID.TimecodeScale:
          timecodeScaleNs = r.readUint(size)
          break
        case ID.Duration:
          durationScale = r.readFloat(size)
          break
        case ID.TrackNumber:
          if (ctx.track) ctx.track.trackNumber = r.readUint(size)
          else r.skip(size)
          break
        case ID.TrackType:
          if (ctx.track) ctx.track.type = r.readUint(size) === 2 ? 'audio' : 'video'
          else r.skip(size)
          break
        case ID.CodecID: {
          const codec = new TextDecoder().decode(r.take(size))
          if (ctx.track) ctx.track.codecId = codec
          break
        }
        case ID.CodecPrivate:
          if (ctx.track) ctx.track.codecPrivate = r.take(size)
          else r.skip(size)
          break
        case ID.PixelWidth:
          if (ctx.track) ctx.track.width = r.readUint(size)
          else r.skip(size)
          break
        case ID.PixelHeight:
          if (ctx.track) ctx.track.height = r.readUint(size)
          else r.skip(size)
          break
        case ID.SamplingFrequency:
          if (ctx.track) ctx.track.sampleRate = r.readFloat(size)
          else r.skip(size)
          break
        case ID.Channels:
          if (ctx.track) ctx.track.channels = r.readUint(size)
          else r.skip(size)
          break
        case ID.Timecode:
          ctx.clusterMs = r.readUint(size) * (timecodeScaleNs / 1e6)
          break
        case ID.SimpleBlock:
          readBlock(r.take(size), ctx.clusterMs ?? 0, true, false)
          break
        case ID.Block:
          ctx.blockPayload = r.take(size)
          break
        case ID.ReferenceBlock:
          ctx.hasRef = true
          r.skip(size)
          break
        default:
          r.skip(size === UNKNOWN_SIZE ? 0 : size)
      }
      if (size !== UNKNOWN_SIZE) r.pos = actualEnd
    }
  }

  // Segment（可能未知长度）
  if (r.id() !== ID.Segment) throw new LivePhotoMakerError('videoUnreadable')
  const segSize = r.vint(true)!.value
  const segEnd = segSize === UNKNOWN_SIZE ? bytes.byteLength : Math.min(r.pos + segSize, bytes.byteLength)
  parseLevel(segEnd, 0, {})

  blocks.sort((a, b) => a.timecodeMs - b.timecodeMs)
  return { tracks, blocks, durationMs: durationScale * (timecodeScaleNs / 1e6) }
}

// ---------------------------------------------------------------- 编码配置

function videoDecoderConfig(track: WebMTrack): VideoDecoderConfig | undefined {
  const codecId = track.codecId.toUpperCase()
  if (codecId === 'V_VP8') return { codec: 'vp8' }
  if (codecId === 'V_VP9') return { codec: 'vp09.00.10.08' }
  if (codecId === 'V_AV1') return { codec: 'av01.0.04M.08' }
  if (codecId === 'V_MPEG4/ISO/AVC' && track.codecPrivate) {
    const p = track.codecPrivate
    const hex = (b: number) => b.toString(16).padStart(2, '0')
    return { codec: `avc1.${hex(p[1])}${hex(p[2])}${hex(p[3])}`, description: track.codecPrivate }
  }
  return undefined
}

function audioDecoderConfig(track: WebMTrack): AudioDecoderConfig | undefined {
  const codecId = track.codecId.toUpperCase()
  if (codecId === 'A_OPUS') {
    return { codec: 'opus', sampleRate: 48000, numberOfChannels: track.channels || 2, description: track.codecPrivate }
  }
  if (codecId === 'A_AAC') {
    return { codec: 'mp4a.40.2', sampleRate: track.sampleRate || 48000, numberOfChannels: track.channels || 2, description: track.codecPrivate }
  }
  return undefined
}

/** 从 MP4 样本描述中提取 codec 配置 box。 */
function findCodecConfig(entry: Uint8Array, fourCC: string): Uint8Array | undefined {
  for (let i = 8; i + 8 <= entry.byteLength; i++) {
    if (
      entry[i + 4] === fourCC.charCodeAt(0) &&
      entry[i + 5] === fourCC.charCodeAt(1) &&
      entry[i + 6] === fourCC.charCodeAt(2) &&
      entry[i + 7] === fourCC.charCodeAt(3)
    ) {
      const size = (entry[i] << 24) | (entry[i + 1] << 16) | (entry[i + 2] << 8) | entry[i + 3]
      if (size >= 8 && i + size <= entry.byteLength) return entry.subarray(i, i + size)
    }
  }
  return undefined
}

function mp4VideoDecoderConfig(movie: MovieInfo): VideoDecoderConfig | undefined {
  const track = movie.tracks.find((t) => t.handler === 'vide')
  const entry = track?.stsdEntries[0]
  if (!track || !entry) return undefined
  if (entry.format === 'av01') return { codec: 'av01.0.04M.08', description: findCodecConfig(entry.raw, 'av1C') }
  if (entry.format === 'vp09') return { codec: 'vp09.00.10.08', description: findCodecConfig(entry.raw, 'vpcC') }
  if (entry.format === 'avc1' || entry.format === 'avc3') {
    const avcC = findCodecConfig(entry.raw, 'avcC')
    if (avcC && avcC.byteLength > 7) {
      const hex = (b: number) => b.toString(16).padStart(2, '0')
      return { codec: `avc1.${hex(avcC[5])}${hex(avcC[6])}${hex(avcC[7])}`, description: avcC.subarray(8) }
    }
  }
  // HEVC / Dolby Vision：hvcC 记录（第 1 字节低 5 位 profile，第 12 字节 level）。
  // dvh1/dvhe 样本喂解码器前已剥离 RPU，按普通 HEVC 基底解码。
  if (entry.format === 'hvc1' || entry.format === 'hev1' || entry.format === 'dvh1' || entry.format === 'dvhe') {
    const hvcC = findCodecConfig(entry.raw, 'hvcC')
    if (hvcC && hvcC.byteLength > 13) {
      const record = hvcC.subarray(8)
      const profile = record[1] & 0x1f
      const level = record[12]
      return { codec: `hvc1.${profile}.4.L${level}.B0`, description: record }
    }
  }
  return undefined
}

// ---------------------------------------------------------------- 样本描述构建

export function avc1Entry(width: number, height: number, avcC: Uint8Array): Uint8Array {
  const w = new ByteWriter()
    .zeros(6).u16(1)
    .u16(0).u16(0).zeros(12)
    .u16(width).u16(height)
    .fp32(72).fp32(72)
    .u32(0)
    .u16(1)
    .zeros(32) // compressor name
    .u16(24)
    .u16(0xffff)
  // avcC 必须是带 box 头的子 box；裸配置记录会让 AVFoundation 丢弃整条视频轨。
  const avcCBox = new ByteWriter().u32(8 + avcC.byteLength).fourCC('avcC').raw(avcC).build()
  const body = concatBytes([w.build(), avcCBox])
  return concatBytes([new ByteWriter().u32(8 + body.byteLength).fourCC('avc1').build(), body])
}

function descriptorLength(length: number): Uint8Array {
  const bytes: number[] = []
  let v = length
  do {
    bytes.unshift(v & 0x7f)
    v >>= 7
  } while (v > 0)
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80
  return Uint8Array.from(bytes)
}

function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(tag), descriptorLength(payload.byteLength), payload])
}

function esdsBox(audioSpecificConfig: Uint8Array, bitrate: number): Uint8Array {
  const decSpecific = descriptor(0x05, audioSpecificConfig)
  const decoderConfig = descriptor(
    0x04,
    concatBytes([
      Uint8Array.of(0x40, 0x15), // AAC, audio stream
      new ByteWriter().u24(0).u32(bitrate).u32(bitrate).build(),
      decSpecific,
    ]),
  )
  const slConfig = descriptor(0x06, Uint8Array.of(0x02))
  const es = descriptor(0x03, concatBytes([new ByteWriter().u16(1).u8(0).build(), decoderConfig, slConfig]))
  return concatBytes([new ByteWriter().u32(12 + es.byteLength).fourCC('esds').u32(0).build(), es])
}

function mp4aEntry(sampleRate: number, channels: number, audioSpecificConfig: Uint8Array): Uint8Array {
  const header = new ByteWriter()
    .zeros(6).u16(1)
    .u16(0).u16(0).u32(0)
    .u16(channels).u16(16).u16(0).u16(0)
    .u32(sampleRate * 65536)
    .build()
  const body = concatBytes([header, esdsBox(audioSpecificConfig, 128000)])
  return concatBytes([new ByteWriter().u32(8 + body.byteLength).fourCC('mp4a').build(), body])
}

// ---------------------------------------------------------------- 帧归一化

/**
 * Chrome MediaRecorder 输出的 VP9 WebM 每帧带一个多余的 0x00 前缀；
 * 标准文件则没有。VP9 帧首字节高 2 位必为 frame_marker=2，据此定位真实帧头。
 */
function vp9FrameOffset(data: Uint8Array): number {
  for (let i = 0; i < Math.min(4, data.byteLength); i++) {
    if (data[i] >> 6 === 2) return i
  }
  return 0
}

/** 从 VP9 未压缩头读取真实关键帧标志（容器标志不可靠）。 */
function vp9IsKeyFrame(data: Uint8Array, offset: number): boolean {
  const b = data[offset]
  // show_existing_frame(bit3)=0 且 frame_type(bit2)=0 才是关键帧
  return (b & 0x08) === 0 && (b & 0x04) === 0
}

/** VP8：首字节 bit0=0 为关键帧。 */
function vp8IsKeyFrame(data: Uint8Array): boolean {
  return (data[0] & 0x01) === 0
}

// ---------------------------------------------------------------- 转码主流程

interface EncodedSample {
  data: Uint8Array
  timestampUs: number
  durationUs: number
  isKey: boolean
}

function toMovSamples(encoded: EncodedSample[], timescale = TIMESCALE): MovSample[] {
  const sorted = [...encoded].sort((a, b) => a.timestampUs - b.timestampUs)
  const ticks = sorted.map((s) => Math.round((s.timestampUs * timescale) / 1e6))
  return sorted.map((s, i) => {
    const next = ticks[i + 1]
    const duration =
      next !== undefined ? Math.max(1, next - ticks[i]) : Math.max(1, Math.round((s.durationUs * timescale) / 1e6))
    return { data: s.data, duration, isKey: s.isKey }
  })
}

export interface TranscodeOptions {
  /** 显示长边上限（像素）：存在即进入压缩档——缩放 + SDR H.264。 */
  maxLongEdge?: number
  /** 压缩码率策略（按目标像素面积自动取值）。 */
  bitrateFactor?: number
  bitrateMin?: number
  bitrateMax?: number
}

export async function transcodeToTracks(
  analysis: VideoAnalysis,
  onProgress?: (fraction: number) => void,
  options?: TranscodeOptions,
): Promise<TranscodeResult> {
  const compress = options?.maxLongEdge !== undefined && Number.isFinite(options.maxLongEdge)
  // 首选混合重封装：视频比特级搬运（HDR 原样保留），仅音频按需转码。
  // 这条路径不做任何视频转码，是 HDR 源保真的关键。压缩档必须绕开它。
  if (!compress && analysis.movie && analysis.videoCopyable) {
    return remuxCopyableVideo(analysis, onProgress)
  }

  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    throw new LivePhotoMakerError('videoUnsupported')
  }

  // 1. 收集编码样本与解码配置
  let videoConfig: VideoDecoderConfig | undefined
  let hasAudio = false
  let copiedAudio: MovTrackInput | undefined
  let audioTrackToTranscode: TrackInfo | undefined
  let videoMatrix: Uint8Array | undefined
  let videoHasDv = false
  let movieTimescale = TIMESCALE
  let audioConfig: AudioDecoderConfig | undefined
  // MOV 样本只记偏移，转码循环里经窗口读取器分批取字节：
  // 整读 500MB+ 源文件会在 Safari（尤其 iOS WebContent 内存上限）抛 RangeError，
  // 被上层归为 compositionFailed——「合适/较小无法合成」的根因。
  interface PacketRef { data?: Uint8Array; offset?: number; size: number; timestampUs: number; durationUs: number; isKey: boolean }
  let videoPackets: PacketRef[] = []
  let audioPackets: { data: Uint8Array; timestampUs: number; durationUs: number }[] = []
  const sampleReader = new SampleWindowReader(analysis.file)
  let width = analysis.width
  let height = analysis.height

  if (analysis.webm) {
    const bytes = new Uint8Array(await analysis.file.arrayBuffer())
    const demux = demuxWebM(bytes)
    const vTrack = demux.tracks.find((t) => t.type === 'video')
    const aTrack = demux.tracks.find((t) => t.type === 'audio')
    if (!vTrack) throw new LivePhotoMakerError('videoTrackMissing')
    videoConfig = videoDecoderConfig(vTrack)
    if (aTrack) {
      hasAudio = true
      audioConfig = audioDecoderConfig(aTrack)
    }
    width = width || vTrack.width
    height = height || vTrack.height
    for (const b of demux.blocks) {
      if (b.trackNumber === vTrack.trackNumber) {
        let data = b.data
        let isKey = b.isKey
        const codecId = vTrack.codecId.toUpperCase()
        if (codecId === 'V_VP9') {
          const offset = vp9FrameOffset(data)
          if (offset > 0) data = data.subarray(offset)
          isKey = vp9IsKeyFrame(data, 0)
        } else if (codecId === 'V_VP8') {
          isKey = vp8IsKeyFrame(data)
        }
        videoPackets.push({ data, size: data.byteLength, timestampUs: b.timecodeMs * 1000, durationUs: 33333, isKey })
      } else if (aTrack && b.trackNumber === aTrack.trackNumber) {
        audioPackets.push({ data: b.data, timestampUs: b.timecodeMs * 1000, durationUs: 20000 })
      }
    }
  } else if (analysis.movie) {
    const movie = analysis.movie
    const vTrack = movie.tracks.find((t) => t.handler === 'vide')
    if (!vTrack) throw new LivePhotoMakerError('videoTrackMissing')
    videoMatrix = vTrack.matrix
    videoConfig = mp4VideoDecoderConfig(movie)
    // Dolby Vision 源喂给普通 HEVC 解码器前需剥离 RPU（type 62 未知 NAL 会导致解码报错）；
    // 在解码循环里按样本处理，避免此处整读源文件。
    const vEntry = vTrack.stsdEntries[0]
    videoHasDv = vEntry !== undefined && findDolbyVisionConfig(vEntry.raw) !== undefined
    videoPackets = expandSamples(vTrack).map((s) => ({
      offset: s.offset,
      size: s.size,
      timestampUs: 0, // 下方按 stts 累计
      durationUs: (s.duration * 1e6) / vTrack.timescale,
      isKey: s.isKey,
    }))
    let t = 0
    for (const p of videoPackets) {
      p.timestampUs = t
      t += p.durationUs
    }
    const aTracks = movie.tracks.filter((t2) => t2.handler === 'soun')
    const mp4aTrack = aTracks.find((t2) => t2.stsdEntries[0]?.format === 'mp4a')
    hasAudio = aTracks.length > 0
    if (mp4aTrack) {
      copiedAudio = copyMovieTrack(mp4aTrack, 'soun', 2)
      if (copiedAudio.samples.length === 0) throw new LivePhotoMakerError('audioUnsupported')
      // 原始音轨的 edit list 使用源容器时基。
      movieTimescale = movie.timescale
    } else if (aTracks[0]) {
      audioTrackToTranscode = aTracks[0]
    }
  } else {
    throw new LivePhotoMakerError('videoUnreadable')
  }

  if (!videoConfig) throw new LivePhotoMakerError('videoUnsupported')
  const decoderConfig = videoConfig

  // 2. 选择编码器配置：按目标尺寸 + **实际源帧率** 计算满足 H.264 level 宏块
  // 预算的候选（1080p60 必须 ≥L4.2）。只按宽高探测会让 Chrome 蒙混过关而
  // Safari 的 VideoToolbox 严格拒绝——level/帧率超预算时编码器运行时报错，
  // 连锁触发 "VideoDecoder is not configured" 的误导性失败。
  const srcFramerate = estimateFramerate(videoPackets)
  const compressAngle = compress ? irotAngleFromMatrix(videoMatrix) : 0
  const compressTarget = compress
    ? scaledDimensions(
        (compressAngle % 2 === 1 ? height : width) || 640,
        (compressAngle % 2 === 1 ? width : height) || 360,
        options!.maxLongEdge!,
      )
    : undefined
  const probeWidth = compressTarget?.width ?? width ?? 640
  const probeHeight = compressTarget?.height ?? height ?? 360
  const probeBitrate = compress
    ? Math.min(options!.bitrateMax ?? 8_000_000, Math.max(options!.bitrateMin ?? 1_500_000, Math.round(probeWidth * probeHeight * srcFramerate * (options!.bitrateFactor ?? 0.08))))
    : Math.min(8_000_000, Math.max(1_200_000, Math.round(probeWidth * probeHeight * srcFramerate * 0.08)))
  let encoderCodec: string | undefined
  for (const candidate of avcHighCandidates(probeWidth, probeHeight, srcFramerate)) {
    let support
    try {
      support = await VideoEncoder.isConfigSupported({
        codec: candidate,
        width: probeWidth,
        height: probeHeight,
        bitrate: probeBitrate,
        framerate: srcFramerate,
      })
    } catch {
      continue
    }
    if (support.supported) {
      encoderCodec = candidate
      break
    }
  }
  if (!encoderCodec) throw new LivePhotoMakerError('videoUnsupported')
  const codec = encoderCodec

  const totalVideoUs = videoPackets.length
    ? videoPackets[videoPackets.length - 1].timestampUs + videoPackets[videoPackets.length - 1].durationUs
    : 1
  const bitrate = probeBitrate

  // 音频和视频独立转码，避免在视频编码结束后才开始处理整条音轨。
  const [videoResult, audioResult] = await Promise.allSettled([
    transcodeVideo(),
    copiedAudio ??
      (audioTrackToTranscode
        ? transcodeMovieAudio(audioTrackToTranscode, analysis.file).catch(() => undefined)
        : hasAudio
          ? transcodeAudio(audioConfig, audioPackets)
          : undefined),
  ])
  if (videoResult.status === 'rejected') throw videoResult.reason
  if (audioResult.status === 'rejected') throw audioResult.reason
  const videoTrack = videoResult.value
  const audioTrack = audioResult.value
  onProgress?.(1)
  return {
    tracks: audioTrack ? [videoTrack, audioTrack] : [videoTrack],
    movieTimescale,
    duration: totalVideoUs / 1e6,
  }

  async function transcodeVideo(): Promise<MovTrackInput> {
    // 压缩档：画布缩放 + 旋转摆正 + sRGB 色调映射（HDR→SDR），输出 H.264。
    if (compress && compressTarget) {
      const angle = compressAngle
      const target = compressTarget
      const factor = options!.bitrateFactor ?? 0.08
      const minBitrate = options!.bitrateMin ?? 1_500_000
      const maxBitrate = options!.bitrateMax ?? 8_000_000
      const bitrate = Math.min(maxBitrate, Math.max(minBitrate, Math.round(target.width * target.height * 30 * factor)))

      const encodedVideo: EncodedSample[] = []
      let avcC: Uint8Array | undefined
      let done = 0
      const canvas = document.createElement('canvas')
      canvas.width = target.width
      canvas.height = target.height
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new LivePhotoMakerError('videoUnsupported')

      const videoEncoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          encodedVideo.push({
            data,
            timestampUs: chunk.timestamp,
            durationUs: chunk.duration ?? 33333,
            isKey: chunk.type === 'key',
          })
          const desc = metadata?.decoderConfig?.description
          if (desc && !avcC) {
            avcC = desc instanceof Uint8Array ? desc : new Uint8Array(desc as ArrayBuffer)
          }
        },
        error: () => {},
      })
      videoEncoder.configure({
        codec,
        width: target.width,
        height: target.height,
        bitrate,
        framerate: srcFramerate,
        avc: { format: 'avc' },
        latencyMode: 'quality',
      })

      let decodeError: Error | undefined
      const videoDecoder = new VideoDecoder({
        output: (frame) => {
          try {
            try {
              // 显示 = 对编码帧逆时针旋转 angle×90°；canvas.rotate 正值视觉顺时针，故取负。
              const cw = frame.codedWidth
              const ch = frame.codedHeight
              const scale = angle % 2 === 1 ? target.width / ch : target.width / cw
              ctx.fillStyle = '#000'
              ctx.fillRect(0, 0, canvas.width, canvas.height)
              ctx.save()
              ctx.translate(canvas.width / 2, canvas.height / 2)
              ctx.rotate((-angle * Math.PI) / 2)
              ctx.drawImage(frame, (-cw * scale) / 2, (-ch * scale) / 2, cw * scale, ch * scale)
              ctx.restore()
              const scaled = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration || undefined })
              try {
                videoEncoder.encode(scaled, { keyFrame: done % 60 === 0 })
              } finally {
                scaled.close()
              }
            } catch (e) {
              // 编码/绘制异常必须就地捕获：从输出回调逃出会让 WebKit 把解码器
              // 打进错误态，之后的 decode() 报误导性的 "VideoDecoder is not configured"。
              if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e))
            }
          } finally {
            frame.close()
            done++
            onProgress?.(Math.min(0.9, (done / Math.max(1, videoPackets.length)) * 0.9))
          }
        },
        error: (e) => {
          decodeError = e instanceof Error ? e : new Error(String(e))
        },
      })
      videoDecoder.configure(decoderConfig)
      for (const p of videoPackets) {
        if (decodeError) break
        try {
          videoDecoder.decode(
            new EncodedVideoChunk({
              type: p.isKey ? 'key' : 'delta',
              timestamp: p.timestampUs,
              duration: p.durationUs,
              data: await resolvePacket(p, sampleReader, videoHasDv),
            }),
          )
        } catch (e) {
          if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e))
        }
        // 背压只限解码输入队列：输出回调里已逐帧 close，已编码 chunk 落进
        // encodedVideo（体积受输出尺寸约束，安全）。切勿对 encodeQueueSize 阻塞——
        // 输出回调仍会为每个已解码帧调用 encode()，编码慢于解码时会自锁死。
        if (videoDecoder.decodeQueueSize > 24) {
          await new Promise<void>((resolve) => {
            const check = () => (videoDecoder.decodeQueueSize <= 8 ? resolve() : setTimeout(check, 8))
            check()
          })
        }
      }
      await videoDecoder.flush().catch(() => {})
      videoDecoder.close()
      await videoEncoder.flush()
      videoEncoder.close()
      canvas.width = canvas.height = 0
      if (decodeError || encodedVideo.length === 0 || !avcC) {
        // 带上原始异常：弹框可展示真实原因（level 超预算、编码器格式等）。
        throw decodeError ?? new LivePhotoMakerError('videoUnsupported')
      }
      return {
        handler: 'vide',
        trackId: 1,
        timescale: TIMESCALE,
        samples: toMovSamples(encodedVideo),
        sampleEntry: avc1Entry(target.width, target.height, avcC),
        width: target.width,
        height: target.height,
      }
    }

    const w = width || 640
    const h = height || 360

    // HDR 探测：解码首帧读原生色彩空间。HDR（BT.2020 HLG/PQ）且 HEVC Main10
    // 编码器真实可用时保 HDR；否则回退 H.264 SDR。单帧试编码带超时保护，
    // 规避 WebKit VideoEncoder 对 HDR 帧挂起的问题。
    let hdrColr: HevcColorInfo | undefined
    let hevcConfig: VideoEncoderConfig | undefined
    const firstRef = videoPackets[0]
    const firstPacket = firstRef
      ? { ...firstRef, data: await resolvePacket(firstRef, sampleReader, videoHasDv) }
      : undefined
    const firstFrame = await decodeFirstFrame(decoderConfig, firstPacket)
    if (firstFrame) {
      hdrColr = hdrColorInfo(firstFrame.colorSpace)
      if (hdrColr) {
        const candidate: VideoEncoderConfig = {
          codec: 'hvc1.2.4.L153.B0',
          width: w,
          height: h,
          bitrate: Math.min(25_000_000, Math.max(8_000_000, Math.round(w * h * srcFramerate * 0.1))),
          framerate: srcFramerate,
          latencyMode: 'quality',
        }
        try {
          await encodeStill(firstFrame, candidate, hdrColr, 10)
          hevcConfig = candidate
        } catch {
          hevcConfig = undefined
        }
      }
      firstFrame.close()
    }
    const useHevc = !!hevcConfig && !!hdrColr

    const encodedVideo: EncodedSample[] = []
    let codecDesc: Uint8Array | undefined
    let done = 0

    const videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        encodedVideo.push({
          data,
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? 33333,
          isKey: chunk.type === 'key',
        })
        const desc = metadata?.decoderConfig?.description
        if (desc && !codecDesc) {
          codecDesc = desc instanceof Uint8Array ? desc : new Uint8Array(desc as ArrayBuffer)
        }
      },
      error: () => {},
    })
    if (useHevc) {
      videoEncoder.configure(hevcConfig!)
    } else {
      videoEncoder.configure({
        codec,
        width: w,
        height: h,
        bitrate,
        framerate: srcFramerate,
        avc: { format: 'avc' },
        latencyMode: 'quality',
      })
    }

    let decodeError: Error | undefined
    const videoDecoder = new VideoDecoder({
      output: (frame) => {
        try {
          videoEncoder.encode(frame, { keyFrame: done % 60 === 0 })
        } catch (e) {
          if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e))
        } finally {
          frame.close()
          done++
          onProgress?.(Math.min(0.9, (done / Math.max(1, videoPackets.length)) * 0.9))
        }
      },
      error: (e) => {
        decodeError = e instanceof Error ? e : new Error(String(e))
      },
    })
    videoDecoder.configure(decoderConfig)
    for (const p of videoPackets) {
      if (decodeError) break
      try {
        videoDecoder.decode(
          new EncodedVideoChunk({
            type: p.isKey ? 'key' : 'delta',
            timestamp: p.timestampUs,
            duration: p.durationUs,
            data: await resolvePacket(p, sampleReader, videoHasDv),
          }),
        )
      } catch (e) {
        if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e))
      }
      // 背压：仅解码输入侧（同上，避免对 encodeQueueSize 阻塞导致自锁）。
      if (videoDecoder.decodeQueueSize > 24) {
        await new Promise<void>((resolve) => {
          const check = () => (videoDecoder.decodeQueueSize <= 8 ? resolve() : setTimeout(check, 8))
          check()
        })
      }
    }
    await videoDecoder.flush().catch(() => {})
    videoDecoder.close()
    await videoEncoder.flush()
    videoEncoder.close()
    if (decodeError || encodedVideo.length === 0 || !codecDesc) {
      throw decodeError ?? new LivePhotoMakerError('videoUnsupported')
    }

    const sampleEntry = useHevc
      ? buildHvc1Entry(w, h, codecDesc, nclxBox(hdrColr!))
      : avc1Entry(w, h, codecDesc)
    return {
      handler: 'vide',
      trackId: 1,
      timescale: TIMESCALE,
      samples: toMovSamples(encodedVideo),
      sampleEntry,
      width: w,
      height: h,
    }
  }
}

/** 解码首个样本取一帧（HDR 探测用）；失败/超时返回 undefined，不影响主管线。 */
function decodeFirstFrame(
  config: VideoDecoderConfig,
  packet: { data: Uint8Array; timestampUs: number; durationUs: number; isKey: boolean } | undefined,
): Promise<VideoFrame | undefined> {
  if (!packet) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let settled = false
    let decoder: VideoDecoder
    const finish = (frame?: VideoFrame) => {
      if (settled) {
        frame?.close()
        return
      }
      settled = true
      window.clearTimeout(timer)
      resolve(frame)
    }
    const timer = window.setTimeout(() => {
      finish(undefined)
      try { decoder.close() } catch { /* already closed */ }
    }, 5000)
    decoder = new VideoDecoder({
      output: (frame) => finish(frame),
      error: () => finish(undefined),
    })
    try {
      decoder.configure(config)
      decoder.decode(new EncodedVideoChunk({
        type: packet.isKey ? 'key' : 'delta',
        timestamp: packet.timestampUs,
        duration: packet.durationUs,
        data: packet.data,
      }))
      void decoder.flush().then(
        () => { try { decoder.close() } catch { /* noop */ } },
        () => { try { decoder.close() } catch { /* noop */ } },
      )
    } catch {
      finish(undefined)
    }
  })
}

// ---------------------------------------------------------------- 样本窗口读取

/**
 * 顺序样本的小窗口读取器：只缓冲当前窗口（默认 16MB），按样本偏移命中；
 * 未命中则从样本起点重读窗口。样本按呈现序基本等于文件序，命中率极高，
 * 全程内存占用与源文件大小无关（大文件在 Safari 里整读会 OOM）。
 */
export class SampleWindowReader {
  private start = -1
  private end = -1
  private buf: Uint8Array = new Uint8Array(0)

  constructor(private readonly file: Blob, private readonly windowBytes = 16 * 1024 * 1024) {}

  async get(offset: number, size: number): Promise<Uint8Array> {
    if (this.start >= 0 && offset >= this.start && offset + size <= this.end) {
      return this.buf.subarray(offset - this.start, offset - this.start + size)
    }
    const end = Math.min(offset + Math.max(this.windowBytes, size), this.file.size)
    this.buf = new Uint8Array(await this.file.slice(offset, end).arrayBuffer())
    this.start = offset
    this.end = end
    return this.buf.subarray(0, size)
  }
}

/** 取回包引用字节（WebM 已有 data 直接用；MOV 走窗口读取），DV 源顺带剥 RPU。 */
async function resolvePacket(
  p: { data?: Uint8Array; offset?: number; size: number },
  reader: SampleWindowReader,
  stripDvRpu: boolean,
): Promise<Uint8Array> {
  const data = p.data ?? await reader.get(p.offset ?? 0, p.size)
  if (stripDvRpu && sampleHasRpu(data)) return stripRpu(data)
  return data
}

// ---------------------------------------------------------------- H.264 编码器能力

/** 源平均帧率（按样本时长合计估算），限幅 1–120；不可估算时取 fallback。 */
export function estimateFramerate(
  packets: { durationUs: number }[],
  fallback = 30,
): number {
  if (packets.length < 2) return fallback
  const totalUs = packets.reduce((sum, p) => sum + p.durationUs, 0)
  if (!Number.isFinite(totalUs) || totalUs <= 0) return fallback
  return Math.min(120, Math.max(1, Math.round((packets.length * 1e6) / totalUs)))
}

/** 各 H.264 level 的宏块预算（level_idc → [maxFS 宏块/帧, maxMBPS 宏块/秒]），ISO 14496-10 Table A-1。 */
const AVC_LEVEL_BUDGETS: [number, number, number][] = [
  [30, 1620, 40500],
  [31, 3600, 108000],
  [40, 8192, 245760],
  [42, 8704, 522240],
  [50, 22080, 589824],
  [51, 36864, 983040],
  [52, 36864, 2073600],
]

/** 满足 分辨率×帧率 的最小 level_idc（十六进制两位，如 42 → "2A"）。 */
export function minAvcLevelHex(width: number, height: number, framerate: number): string {
  const mbFrames = Math.ceil(width / 16) * Math.ceil(height / 16)
  const mbPerSec = mbFrames * Math.max(1, framerate)
  for (const [level, maxFS, maxMBPS] of AVC_LEVEL_BUDGETS) {
    if (mbFrames <= maxFS && mbPerSec <= maxMBPS) return level.toString(16).padStart(2, '0')
  }
  return '34' // 52
}

/** High profile 候选 codec：从所需最小 level 起逐级升高（VideoToolbox 对超预算直接报错）。 */
export function avcHighCandidates(width: number, height: number, framerate: number): string[] {
  const hexToLevel = (h: string) => parseInt(h, 16)
  const wanted = hexToLevel(minAvcLevelHex(width, height, framerate))
  const ladder = [30, 31, 40, 42, 50, 51, 52].filter((l) => l >= wanted)
  const codes = ladder.map((l) => `avc1.6400${l.toString(16).padStart(2, '0')}`)
  // 兜底：更保守的主 profile 旧候选链（历史行为）
  codes.push('avc1.4D4028', 'avc1.42E01E')
  return codes
}

// ---------------------------------------------------------------- 混合重封装（HDR 保真）

/**
 * 视频可比特级搬运时的导出：视频零转码（HDR 原样保留，兼容基底的 Dolby
 * Vision 还原为 hvc1 HLG/PQ），音频优先复制 AAC，否则仅转码音频。
 * 绝不因音频问题把 HDR 视频降级 SDR。
 */
async function remuxCopyableVideo(
  analysis: VideoAnalysis,
  onProgress?: (fraction: number) => void,
): Promise<TranscodeResult> {
  const movie = analysis.movie!
  const vTrack = movie.tracks.find((t) => t.handler === 'vide')
  if (!vTrack) throw new LivePhotoMakerError('videoTrackMissing')

  const videoTrack = await copyVideoTrackPreservingHdr(vTrack, analysis.file)
  onProgress?.(0.5)

  const audioTracks = movie.tracks.filter((t) => t.handler === 'soun')
  const aacTrack = audioTracks.find((t) => t.stsdEntries[0]?.format === 'mp4a')
  let audioTrack: MovTrackInput | undefined
  if (aacTrack) {
    const copied = copyMovieTrack(aacTrack, 'soun', 2)
    if (copied.samples.length > 0) audioTrack = copied
  } else if (audioTracks.length > 0) {
    // 无 AAC：尝试把第一条音轨转 AAC；失败则输出无声视频（仍是有效实况照片）。
    audioTrack = await transcodeMovieAudio(audioTracks[0], analysis.file).catch(() => undefined)
  }
  onProgress?.(1)

  return {
    tracks: audioTrack ? [videoTrack, audioTrack] : [videoTrack],
    movieTimescale: movie.timescale,
    duration: movie.duration / movie.timescale,
  }
}

/**
 * 搬运视频轨并保留 HDR。普通 hvc1/hev1/avc1 零拷贝；携带兼容基底 Dolby
 * Vision 的样本剥离 RPU、去掉 DV 配置 box，还原为标准 hvc1 HLG/PQ。
 * 不兼容基底（profile 5）原样保留 dvh1/dvhe。
 */
async function copyVideoTrackPreservingHdr(track: TrackInfo, file: Blob): Promise<MovTrackInput> {
  const entry = track.stsdEntries[0]
  const dv = entry ? findDolbyVisionConfig(entry.raw) : undefined
  if (!entry || !dv || !isConvertibleDolbyVision(dv.info)) {
    return copyMovieTrack(track, 'vide', 1)
  }
  const children = parseBoxes(entry.raw, 86)
  const hvcCBox = findBox(children, 'hvcC')
  if (!hvcCBox) return copyMovieTrack(track, 'vide', 1)
  const hvcC = entry.raw.slice(hvcCBox.start + 8, hvcCBox.start + hvcCBox.size)
  const colrBox = findBox(children, 'colr')
  const color = hdrColorFromDolbyVision(dv.info)
  const colr = colrBox
    ? entry.raw.slice(colrBox.start, colrBox.start + colrBox.size)
    : (color ? nclxBox(color) : undefined)
  const extras: Uint8Array[] = []
  for (const type of ['pasp', 'btrt']) {
    const b = findBox(children, type)
    if (b) extras.push(entry.raw.slice(b.start, b.start + b.size))
  }
  const sampleEntry = buildHvc1Entry(track.width, track.height, hvcC, colr, extras)

  const samples = expandSamples(track)
  if (samples.length === 0) return copyMovieTrack(track, 'vide', 1)
  // 窗口读取 + 仅对含 RPU 的样本落地新字节；干净样本继续用源文件区间引用，
  // 全程内存占用与文件大小解耦（大文件整读会撑爆 Safari）。
  const reader = new SampleWindowReader(file)
  const rewritten: MovSample[] = []
  for (const s of samples) {
    const raw = await reader.get(s.offset, s.size)
    if (sampleHasRpu(raw)) rewritten.push({ data: stripRpu(raw), duration: s.duration, isKey: s.isKey })
    else rewritten.push({ data: { offset: s.offset, byteLength: s.size }, duration: s.duration, isKey: s.isKey })
  }
  return {
    handler: 'vide',
    trackId: 1,
    timescale: track.timescale,
    samples: rewritten,
    sampleEntry,
    width: track.width,
    height: track.height,
    matrix: track.matrix,
    edits: track.edits,
    language: track.language,
    mediaHeaderRaw: track.mediaHeaderRaw,
    cttsRaw: track.cttsRaw,
  }
}

/** 把一条非 AAC 音轨转成 AAC；PCM 直接构造 AudioData，其余交给 AudioDecoder。 */
async function transcodeMovieAudio(track: TrackInfo, file: Blob): Promise<MovTrackInput> {
  const entry = track.stsdEntries[0]
  const samples = expandSamples(track)
  if (!entry || samples.length === 0) throw new LivePhotoMakerError('audioUnsupported')
  // 交错容器里音频样本区间横跨整文件，用窗口读取而非一次性 span 读。
  const reader = new SampleWindowReader(file)
  let t = 0
  const packets: { data: Uint8Array; timestampUs: number; durationUs: number }[] = []
  for (const s of samples) {
    const data = await reader.get(s.offset, s.size)
    packets.push({
      // 拷贝：窗口缓冲会在后续读取中被复用，而 packet 要在编码阶段长期持有。
      data: data.slice(),
      timestampUs: t,
      durationUs: (s.duration * 1e6) / track.timescale,
    })
    t += packets[packets.length - 1].durationUs
  }
  const pcm = parsePcmEntry(entry.raw, samples[0].size)
  if (pcm) return encodePcmToAac(pcm, packets)
  throw new LivePhotoMakerError('audioUnsupported')
}

interface PcmFormat {
  channels: number
  sampleSize: number
  sampleRate: number
  littleEndian: boolean
}

function isSaneRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 8000 && rate <= 192000
}

/**
 * 解析 PCM 样本描述（twos/sowt 标准布局；lpcm 为 Apple 紧凑 v2 布局）。
 * 声道数优先用「每样本字节数 / 每帧字节数」交叉验证，任何不一致都返回
 * undefined（调用方降级为无声），绝不输出错误音频。
 */
export function parsePcmEntry(entry: Uint8Array, firstSampleBytes: number): PcmFormat | undefined {
  if (entry.byteLength < 36) return undefined
  const format = String.fromCharCode(entry[4], entry[5], entry[6], entry[7])
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
  let channels = 0
  let sampleSize = 0
  let sampleRate = 0
  let littleEndian = false
  if (format === 'twos' || format === 'sowt') {
    channels = view.getUint16(0x10)
    sampleSize = view.getUint16(0x12)
    sampleRate = view.getUint32(0x18) / 65536
    littleEndian = format === 'sowt'
  } else if (format === 'lpcm') {
    sampleSize = view.getUint16(0x1a)
    channels = view.getUint16(0x20)
    littleEndian = view.getUint16(0x1c) === 0xfffe
    for (let o = 28; o + 12 <= entry.byteLength; o += 4) {
      if (view.getUint32(o) === entry.byteLength) {
        sampleRate = view.getFloat64(o + 4)
        break
      }
    }
    if (!isSaneRate(sampleRate)) sampleRate = view.getUint32(0x18) / 65536
  } else {
    return undefined
  }
  if (![8, 16, 24, 32].includes(sampleSize) || !isSaneRate(sampleRate)) return undefined
  // MOV PCM 每样本即一帧：用实际字节数反推声道，覆盖描述中的可疑值。
  const inferred = firstSampleBytes / (sampleSize / 8)
  if (Number.isInteger(inferred) && inferred >= 1 && inferred <= 8) channels = inferred
  if (!(channels >= 1 && channels <= 8)) return undefined
  return { channels, sampleSize, sampleRate: Math.round(sampleRate), littleEndian }
}

function swapEndian(data: Uint8Array, width: number): Uint8Array {
  const out = new Uint8Array(data.byteLength)
  for (let i = 0; i + width <= data.byteLength; i += width) {
    for (let j = 0; j < width; j++) out[i + j] = data[i + width - 1 - j]
  }
  return out
}

/** 把一段 PCM 样本构造成 WebCodecs AudioData（24-bit 提升到 s32）。 */
function pcmToAudioData(data: Uint8Array, pcm: PcmFormat, timestampUs: number): AudioData | undefined {
  const bytesPerSample = pcm.sampleSize / 8
  const numberOfFrames = Math.floor(data.byteLength / (bytesPerSample * pcm.channels))
  if (numberOfFrames <= 0) return undefined
  const base = { sampleRate: pcm.sampleRate, numberOfFrames, numberOfChannels: pcm.channels, timestamp: timestampUs }
  if (pcm.sampleSize === 16) {
    const buf = pcm.littleEndian ? data : swapEndian(data, 2)
    return new AudioData({ ...base, format: 's16', data: buf })
  }
  if (pcm.sampleSize === 32) {
    const buf = pcm.littleEndian ? data : swapEndian(data, 4)
    return new AudioData({ ...base, format: 's32', data: buf })
  }
  if (pcm.sampleSize === 8) {
    return new AudioData({ ...base, format: 'u8', data })
  }
  if (pcm.sampleSize === 24) {
    const out = new DataView(new ArrayBuffer(numberOfFrames * pcm.channels * 4))
    let o = 0
    for (let i = 0; i + 3 <= data.byteLength; i += 3) {
      let v = pcm.littleEndian
        ? data[i] | (data[i + 1] << 8) | (data[i + 2] << 16)
        : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
      if (v & 0x800000) v |= ~0xffffff
      out.setInt32(o, v << 8, true)
      o += 4
    }
    return new AudioData({ ...base, format: 's32', data: new Uint8Array(out.buffer) })
  }
  return undefined
}

/** PCM → AAC（不经过 AudioDecoder，直接构造 AudioData 编码）。 */
async function encodePcmToAac(
  pcm: PcmFormat,
  packets: { data: Uint8Array; timestampUs: number; durationUs: number }[],
): Promise<MovTrackInput> {
  if (typeof AudioEncoder === 'undefined') throw new LivePhotoMakerError('audioUnsupported')
  const encoded: EncodedSample[] = []
  let asc: Uint8Array | undefined
  let failed = false
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      encoded.push({ data, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? 23220, isKey: true })
      const desc = metadata?.decoderConfig?.description
      if (desc && !asc) asc = desc instanceof Uint8Array ? desc : new Uint8Array(desc as ArrayBuffer)
    },
    error: () => { failed = true },
  })
  try {
    encoder.configure({ codec: 'mp4a.40.2', sampleRate: pcm.sampleRate, numberOfChannels: pcm.channels, bitrate: 128000 })
    for (const p of packets) {
      if (failed) break
      const audioData = pcmToAudioData(p.data, pcm, p.timestampUs)
      if (!audioData) { failed = true; break }
      encoder.encode(audioData)
      audioData.close()
    }
    await encoder.flush()
    if (failed || encoded.length === 0 || !asc) throw new LivePhotoMakerError('audioUnsupported')
    return {
      handler: 'soun',
      trackId: 2,
      timescale: pcm.sampleRate,
      samples: toMovSamples(encoded, pcm.sampleRate),
      sampleEntry: mp4aEntry(pcm.sampleRate, pcm.channels, asc),
      width: 0,
      height: 0,
    }
  } catch {
    throw new LivePhotoMakerError('audioUnsupported')
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
}

async function transcodeAudio(
  config: AudioDecoderConfig | undefined,
  packets: { data: Uint8Array; timestampUs: number; durationUs: number }[],
): Promise<MovTrackInput> {
  if (!config || !packets.length || typeof AudioDecoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    throw new LivePhotoMakerError('audioUnsupported')
  }

  const bitrate = 128000
  const encoded: EncodedSample[] = []
  let asc: Uint8Array | undefined
  let failed = false
  let sampleRate = 0
  let channels = 0
  const onError = () => { failed = true }

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      encoded.push({
        data,
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration ?? Math.round(1024 * 1e6 / sampleRate),
        isKey: true,
      })
      const description = metadata?.decoderConfig?.description
      if (description && !asc) {
        asc = description instanceof Uint8Array ? description : new Uint8Array(description as ArrayBuffer)
      }
    },
    error: onError,
  })
  const decoder = new AudioDecoder({
    output: (audioData) => {
      try {
        if (failed) return
        if (encoder.state === 'unconfigured') {
          // AAC 编码器的采样率和声道数必须与解码后的数据一致。
          sampleRate = audioData.sampleRate
          channels = audioData.numberOfChannels
          encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate })
        }
        encoder.encode(audioData)
      } catch {
        failed = true
      } finally {
        audioData.close()
      }
    },
    error: onError,
  })
  try {
    decoder.configure(config)
    for (const packet of packets) {
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: packet.timestampUs,
        duration: packet.durationUs,
        data: packet.data,
      }))
    }
    await decoder.flush()
    if (failed || encoder.state !== 'configured') throw new LivePhotoMakerError('audioUnsupported')
    await encoder.flush()
    if (failed || encoded.length === 0 || !asc) throw new LivePhotoMakerError('audioUnsupported')
    return {
      handler: 'soun',
      trackId: 2,
      timescale: sampleRate,
      samples: toMovSamples(encoded, sampleRate),
      sampleEntry: mp4aEntry(sampleRate, channels, asc),
      width: 0,
      height: 0,
    }
  } catch {
    throw new LivePhotoMakerError('audioUnsupported')
  } finally {
    if (decoder.state !== 'closed') decoder.close()
    if (encoder.state !== 'closed') encoder.close()
  }
}
