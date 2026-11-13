/**
 * WebCodecs 转码兜底：WebM（VP8/VP9/AV1 + Opus）或 MP4 中不可直接重封装的
 * 编码，先解码再编码为 H.264 + AAC，交给 MOV 重封装器写入。
 * 不支持 WebCodecs 的环境抛出 videoUnsupported。
 */
import { ByteWriter, concatBytes } from './bytes'
import { expandSamples, type MovieInfo } from './mp4'
import { copyMovieTrack, type MovSample, type MovTrackInput } from './mov'
import type { VideoAnalysis } from './media'
import { LivePhotoMakerError } from '../models'

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

export async function transcodeToTracks(
  analysis: VideoAnalysis,
  onProgress?: (fraction: number) => void,
): Promise<TranscodeResult> {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    throw new LivePhotoMakerError('videoUnsupported')
  }
  const bytes = new Uint8Array(await analysis.file.arrayBuffer())

  // 1. 收集编码样本与解码配置
  let videoConfig: VideoDecoderConfig | undefined
  let hasAudio = false
  let copiedAudio: MovTrackInput | undefined
  let movieTimescale = TIMESCALE
  let audioConfig: AudioDecoderConfig | undefined
  let videoPackets: { data: Uint8Array; timestampUs: number; durationUs: number; isKey: boolean }[] = []
  let audioPackets: { data: Uint8Array; timestampUs: number; durationUs: number }[] = []
  let width = analysis.width
  let height = analysis.height

  if (analysis.webm) {
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
        videoPackets.push({ data, timestampUs: b.timecodeMs * 1000, durationUs: 33333, isKey })
      } else if (aTrack && b.trackNumber === aTrack.trackNumber) {
        audioPackets.push({ data: b.data, timestampUs: b.timecodeMs * 1000, durationUs: 20000 })
      }
    }
  } else if (analysis.movie) {
    const movie = analysis.movie
    const vTrack = movie.tracks.find((t) => t.handler === 'vide')
    if (!vTrack) throw new LivePhotoMakerError('videoTrackMissing')
    videoConfig = mp4VideoDecoderConfig(movie)
    videoPackets = expandSamples(vTrack).map((s) => ({
      data: bytes.subarray(s.offset, s.offset + s.size),
      timestampUs: 0, // 下方按 stts 累计
      durationUs: (s.duration * 1e6) / vTrack.timescale,
      isKey: s.isKey,
    }))
    let t = 0
    for (const p of videoPackets) {
      p.timestampUs = t
      t += p.durationUs
    }
    const aTrack = movie.tracks.find((t2) => t2.handler === 'soun')
    hasAudio = !!aTrack
    if (aTrack?.stsdEntries[0]?.format === 'mp4a') {
      copiedAudio = copyMovieTrack(aTrack, 'soun', 2)
      if (copiedAudio.samples.length === 0) throw new LivePhotoMakerError('audioUnsupported')
      // 原始音轨的 edit list 使用源容器时基。
      movieTimescale = movie.timescale
    }
  } else {
    throw new LivePhotoMakerError('videoUnreadable')
  }

  if (!videoConfig) throw new LivePhotoMakerError('videoUnsupported')
  const decoderConfig = videoConfig

  // 2. 选择编码器配置
  const candidates = ['avc1.640028', 'avc1.4D4028', 'avc1.42E01E']
  let encoderCodec: string | undefined
  for (const codec of candidates) {
    const support = await VideoEncoder.isConfigSupported({ codec, width: width || 640, height: height || 360 })
    if (support.supported) {
      encoderCodec = codec
      break
    }
  }
  if (!encoderCodec) throw new LivePhotoMakerError('videoUnsupported')
  const codec = encoderCodec

  const totalVideoUs = videoPackets.length
    ? videoPackets[videoPackets.length - 1].timestampUs + videoPackets[videoPackets.length - 1].durationUs
    : 1
  const bitrate = Math.min(8_000_000, Math.max(1_200_000, Math.round((width || 640) * (height || 360) * 30 * 0.08)))

  // 音频和视频独立转码，避免在视频编码结束后才开始处理整条音轨。
  const [videoResult, audioResult] = await Promise.allSettled([
    transcodeVideo(),
    copiedAudio ?? (hasAudio ? transcodeAudio(audioConfig, audioPackets) : undefined),
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
    const encodedVideo: EncodedSample[] = []
    let avcC: Uint8Array | undefined
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
        if (desc && !avcC) {
          avcC = desc instanceof Uint8Array ? desc : new Uint8Array(desc as ArrayBuffer)
        }
      },
      error: () => {},
    })
    videoEncoder.configure({
      codec,
      width: width || 640,
      height: height || 360,
      bitrate,
      framerate: 30,
      avc: { format: 'avc' },
      latencyMode: 'quality',
    })

    let decodeError: Error | undefined
    const videoDecoder = new VideoDecoder({
      output: (frame) => {
        try {
          videoEncoder.encode(frame, { keyFrame: done % 60 === 0 })
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
      videoDecoder.decode(
        new EncodedVideoChunk({
          type: p.isKey ? 'key' : 'delta',
          timestamp: p.timestampUs,
          duration: p.durationUs,
          data: p.data,
        }),
      )
      // 背压：避免解码队列无限增长
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
    if (decodeError || encodedVideo.length === 0 || !avcC) {
      throw new LivePhotoMakerError('videoUnsupported')
    }

    return {
      handler: 'vide',
      trackId: 1,
      timescale: TIMESCALE,
      samples: toMovSamples(encodedVideo),
      sampleEntry: avc1Entry(width || 640, height || 360, avcC),
      width: width || 640,
      height: height || 360,
    }
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
