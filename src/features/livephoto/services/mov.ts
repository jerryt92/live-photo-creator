/**
 * QuickTime MOV 重封装器。
 *
 * 把 MP4/MOV 中的视频/音频样本原样搬运进新的 MOV 容器（不转码），并写入
 * Apple 实况照片所需的配对元数据：
 *
 * 1. moov.meta 中的 `com.apple.quicktime.content.identifier`（mdta 键）；
 * 2. 一条 handler 为 `meta` 的定时元数据轨道，mebx 样本描述声明
 *    `com.apple.quicktime.still-image-time`，单个一 tick 样本（值 0xFF），
 *    通过前导空 edit（media_time = -1）把样本的呈现时间推迟到视频中段。
 *
 * 轨道结构与 Apple 原生文件一致：LivePhotosKit 通过
 * `tracks.meta[0].trak.edts.elst.editList[0].trackDuration / timescale`
 * 读取静帧时刻，本实现写入的正是该字段。
 */
import { ByteWriter, concatBytes, packLanguage, unixToMacSeconds } from './bytes'
import { expandSamples, findBox, parseBoxes, parseMovie, type EditEntry, type TrackInfo } from './mp4'

export const CONTENT_IDENTIFIER_KEY = 'com.apple.quicktime.content.identifier'
export const STILL_IMAGE_TIME_KEY = 'com.apple.quicktime.still-image-time'

/**
 * 由 tkhd 矩阵推导 HEIF `irot` 角度（对编码图像逆时针旋转的 90° 倍数）。
 * iPhone 视频以横向编码 + 90° 矩阵显示，截帧 HEIC 必须带同样的旋转声明，
 * 否则封面方向与视频不一致，Photos 会拒收整对文件。
 */
export function irotAngleFromMatrix(matrix?: Uint8Array): 0 | 1 | 2 | 3 {
  if (!matrix || matrix.byteLength < 36) return 0
  const view = new DataView(matrix.buffer, matrix.byteOffset, matrix.byteLength)
  const a = Math.round(view.getInt32(0) / 65536)
  const b = Math.round(view.getInt32(4) / 65536)
  const c = Math.round(view.getInt32(12) / 65536)
  const d = Math.round(view.getInt32(16) / 65536)
  if (a === 1 && d === 1) return 0
  if (b === 1 && c === -1) return 3 // 显示需顺时针 90° = 逆时针 270°
  if (b === -1 && c === 1) return 1
  if (a === -1 && d === -1) return 2
  return 0
}

export interface MovSample {
  data: Uint8Array | { offset: number; byteLength: number }
  /** 媒体时基下的时长（tick）。 */
  duration: number
  isKey: boolean
}

export interface MovTrackInput {
  handler: 'vide' | 'soun'
  trackId: number
  timescale: number
  samples: MovSample[]
  /** 完整的 stsd 样本描述条目（avc1/hvc1/mp4a…）。 */
  sampleEntry: Uint8Array
  width: number
  height: number
  matrix?: Uint8Array
  volume?: number
  edits?: EditEntry[]
  language?: string
  mediaHeaderRaw?: Uint8Array
  cttsRaw?: Uint8Array
}

export function copyMovieTrack(track: TrackInfo, handler: MovTrackInput['handler'], trackId: number): MovTrackInput {
  return {
    handler,
    trackId,
    timescale: track.timescale,
    samples: expandSamples(track).map((sample) => ({
      data: { offset: sample.offset, byteLength: sample.size },
      duration: sample.duration,
      isKey: sample.isKey,
    })),
    sampleEntry: track.stsdEntries[0].raw,
    width: track.width,
    height: track.height,
    matrix: track.matrix,
    edits: track.edits,
    language: track.language,
    mediaHeaderRaw: track.mediaHeaderRaw,
    cttsRaw: track.cttsRaw,
  }
}

export interface MovBuildOptions {
  movieTimescale: number
  tracks: MovTrackInput[]
  identifier: string
  createdAt?: Date
  /** 静帧时刻（秒），写入 still-image-time 轨道的呈现时间。 */
  stillTimeSeconds: number
}

const IDENTITY_MATRIX = new ByteWriter()
  .fp32(1).fp32(0).fp32(0)
  .fp32(0).fp32(1).fp32(0)
  .fp32(0).fp32(0).fp32(1)
  .build()

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  let size = 8
  for (const p of payload) size += p.byteLength
  return concatBytes([new ByteWriter().u32(size).fourCC(type).build(), ...payload])
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, new ByteWriter().u8(version).u24(flags).build(), ...payload)
}

function rawBox(bytes: Uint8Array): Uint8Array {
  return bytes
}

function quickTimeAudioEntry(entry: Uint8Array): Uint8Array {
  // MP4 的版本 0 AAC 描述把 esds 放在条目下，QuickTime 从 wave 读取解码配置。
  if (entry.byteLength < 36 || entry[16] !== 0 || entry[17] !== 0 ||
      String.fromCharCode(...entry.subarray(4, 8)) !== 'mp4a') return entry
  const children = parseBoxes(entry, 36)
  const esds = findBox(children, 'esds')
  if (!esds || findBox(children, 'wave')) return entry

  const header = entry.slice(8, 36)
  const view = new DataView(header.buffer)
  view.setUint16(8, 1)
  view.setInt16(20, -2)
  const packetFields = new ByteWriter().u32(1024).u32(0).u32(0).u32(2).build()
  const wave = box('wave',
    box('frma', new ByteWriter().fourCC('mp4a').build()),
    box('mp4a', new Uint8Array(4)),
    entry.subarray(esds.start, esds.start + esds.size),
    new ByteWriter().u32(8).u32(0).build(),
  )
  return box('mp4a', header, packetFields,
    entry.subarray(36, esds.start), wave, entry.subarray(esds.start + esds.size))
}

/** 标准自包含数据引用。 */
function dinfBox(): Uint8Array {
  return box('dinf', fullBox('dref', 0, 0, new ByteWriter().u32(1).build(), fullBox('url ', 0, 1)))
}

function hdlrBox(handler: string, name: string): Uint8Array {
  return fullBox(
    'hdlr',
    0,
    0,
    new ByteWriter().u32(0).fourCC(handler).zeros(12).utf8(name).u8(0).build(),
  )
}

function sttsBox(samples: MovSample[]): Uint8Array {
  const runs: { count: number; delta: number }[] = []
  for (const s of samples) {
    const last = runs[runs.length - 1]
    if (last && last.delta === s.duration) last.count++
    else runs.push({ count: 1, delta: s.duration })
  }
  const w = new ByteWriter().u32(runs.length)
  for (const r of runs) w.u32(r.count).u32(r.delta)
  return fullBox('stts', 0, 0, w.build())
}

function stscBox(): Uint8Array {
  // 每 chunk 一个样本。
  return fullBox('stsc', 0, 0, new ByteWriter().u32(1).u32(1).u32(1).u32(1).build())
}

function stszBox(samples: MovSample[]): Uint8Array {
  const w = new ByteWriter().u32(0).u32(samples.length)
  for (const s of samples) w.u32(s.data.byteLength)
  return fullBox('stsz', 0, 0, w.build())
}

function stssBox(samples: MovSample[]): Uint8Array | undefined {
  const keys: number[] = []
  samples.forEach((s, i) => {
    if (s.isKey) keys.push(i + 1)
  })
  if (keys.length === samples.length) return undefined
  const w = new ByteWriter().u32(keys.length)
  for (const k of keys) w.u32(k)
  return fullBox('stss', 0, 0, w.build())
}

function tkhdBox(opts: {
  trackId: number
  duration: number
  width: number
  height: number
  matrix?: Uint8Array
  volume?: number
  now: number
}): Uint8Array {
  const w = new ByteWriter()
    .u32(opts.now).u32(opts.now)
    .u32(opts.trackId)
    .u32(0)
    .u32(opts.duration)
    .zeros(8)
    .u16(0) // layer
    .u16(0) // alternate group
    .fp16(opts.volume ?? 0)
    .u16(0)
    .raw(opts.matrix ?? IDENTITY_MATRIX)
    .fp32(opts.width)
    .fp32(opts.height)
  return fullBox('tkhd', 0, 0x000007, w.build())
}

function elstBox(edits: EditEntry[]): Uint8Array {
  const w = new ByteWriter().u32(edits.length)
  for (const e of edits) {
    w.u32(e.duration).i32(e.mediaTime).u32(e.rate)
  }
  return fullBox('elst', 0, 0, w.build())
}

function mdhdBox(timescale: number, duration: number, language: string, now: number): Uint8Array {
  const w = new ByteWriter()
    .u32(now).u32(now)
    .u32(timescale)
    .u32(duration)
    .u16(packLanguage(language || 'und'))
    .u16(0)
  return fullBox('mdhd', 0, 0, w.build())
}

/** mebx 样本描述内的键声明表（keys → 本地键 id 子 box → keyd）。 */
function mebxKeysBox(keys: string[]): Uint8Array {
  const children: Uint8Array[] = []
  keys.forEach((key, i) => {
    const keyd = box('keyd', new ByteWriter().fourCC('mdta').utf8(key).build())
    const type = box('dtyp', new ByteWriter().u32(0).u32(0x41).build())
    children.push(box(String.fromCharCode(0, 0, 0, i + 1), keyd, type))
  })
  return box('keys', ...children)
}

function mebxSampleEntry(keys: string[]): Uint8Array {
  const header = new ByteWriter().zeros(6).u16(1).build()
  // 注意：mebx 条目内只放 keys。曾尝试追加 Apple 原生的 kind 声明，
  // 但 iOS LivePhotosKit 的 PVT 导入遇到未知子 box 会整对拒收，实测已回退。
  return box('mebx', header, mebxKeysBox(keys))
}

/** still-image-time：本地键 1 的单字节有符号值 0（与 AVAssetWriter 参考输出一致，静帧时刻由 elst 承载）。 */
export function stillImageTimeSample(): Uint8Array {
  return new ByteWriter().u32(9).u32(1).u8(0x00).build()
}

interface TrakBuild {
  bytes: Uint8Array
  /** stco/co64 载荷在 moov 缓冲中的位置（用于回填偏移）。 */
  offsetPatch?: { pos: number; count: number; wide: boolean }
  chunkCount: number
}

function buildMediaTrak(track: MovTrackInput, movieTimescale: number, now: number, wide: boolean): TrakBuild {
  const mediaDuration = track.samples.reduce((sum, s) => sum + s.duration, 0)
  const presentationDuration =
    track.edits && track.edits.length > 0
      ? track.edits.reduce((sum, e) => sum + e.duration, 0)
      : Math.round(mediaDuration * movieTimescale / track.timescale)

  const sampleEntry = track.handler === 'soun' ? quickTimeAudioEntry(track.sampleEntry) : track.sampleEntry
  const stblChildren: Uint8Array[] = [
    fullBox('stsd', 0, 0, new ByteWriter().u32(1).build(), rawBox(sampleEntry)),
    sttsBox(track.samples),
  ]
  if (track.cttsRaw) stblChildren.push(track.cttsRaw)
  if (track.handler === 'vide') {
    const stss = stssBox(track.samples)
    if (stss) stblChildren.push(stss)
  }
  stblChildren.push(stscBox(), stszBox(track.samples))

  // chunk 偏移占位，稍后回填。
  const chunkCount = track.samples.length
  const offsetPayload = new Uint8Array(chunkCount * (wide ? 8 : 4))
  const offsetBox = fullBox(wide ? 'co64' : 'stco', 0, 0, new ByteWriter().u32(chunkCount).build(), offsetPayload)
  stblChildren.push(offsetBox)

  const minfChildren: Uint8Array[] = []
  if (track.mediaHeaderRaw) {
    minfChildren.push(rawBox(track.mediaHeaderRaw))
  } else if (track.handler === 'vide') {
    minfChildren.push(fullBox('vmhd', 0, 1, new ByteWriter().u16(0).zeros(6).build()))
  } else {
    minfChildren.push(fullBox('smhd', 0, 0, new ByteWriter().u16(0).u16(0).build()))
  }
  minfChildren.push(dinfBox(), box('stbl', ...stblChildren))

  const trakChildren: Uint8Array[] = [
    tkhdBox({
      trackId: track.trackId,
      duration: presentationDuration,
      width: track.width,
      height: track.height,
      matrix: track.matrix,
      volume: track.handler === 'soun' ? (track.volume ?? 1) : 0,
      now,
    }),
  ]
  // 与 AVAssetWriter 输出一致：媒体轨始终写恒等 edit list。
  trakChildren.push(
    box('edts', elstBox(
      track.edits && track.edits.length > 0
        ? track.edits
        : [{ duration: presentationDuration, mediaTime: 0, rate: 0x00010000 }],
    )),
  )
  trakChildren.push(
    box(
      'mdia',
      mdhdBox(track.timescale, mediaDuration, track.language ?? 'und', now),
      hdlrBox(track.handler, track.handler === 'vide' ? 'Core Media Video' : 'Core Media Audio'),
      box('minf', ...minfChildren),
    ),
  )

  const bytes = box('trak', ...trakChildren)
  // 定位偏移表载荷：从尾部往前找 stco/co64。
  const offsetBoxStart = bytes.byteLength - offsetBox.byteLength
  const patchPos = offsetBoxStart + 8 + 4 + 4 // box 头 + version/flags + entry_count
  return { bytes, offsetPatch: { pos: patchPos, count: chunkCount, wide }, chunkCount }
}

function buildMetadataTrak(opts: {
  trackId: number
  movieTimescale: number
  stillTicks: number
  sampleTicks: number
  now: number
  wide: boolean
}): TrakBuild {
  const { trackId, movieTimescale, stillTicks, sampleTicks, now, wide } = opts
  const sample = stillImageTimeSample()

  const stsd = fullBox('stsd', 0, 0, new ByteWriter().u32(1).build(), mebxSampleEntry([STILL_IMAGE_TIME_KEY]))
  const stts = fullBox('stts', 0, 0, new ByteWriter().u32(1).u32(1).u32(sampleTicks).build())
  // 单样本固定 9 字节：stsz 用 uniform 形式（与 AVAssetWriter 输出一致）。
  const stsz = fullBox('stsz', 0, 0, new ByteWriter().u32(sample.byteLength).u32(1).build())
  const offsetPayload = new Uint8Array(wide ? 8 : 4)
  const offsetBox = fullBox(wide ? 'co64' : 'stco', 0, 0, new ByteWriter().u32(1).build(), offsetPayload)
  const stbl = box('stbl', stsd, stts, stscBox(), stsz, offsetBox)

  const minf = box(
    'minf',
    fullBox('nmhd', 0, 0),
    dinfBox(),
    stbl,
  )
  const mdia = box(
    'mdia',
    mdhdBox(movieTimescale, sampleTicks, 'und', now),
    hdlrBox('meta', 'Core Media Metadata'),
    minf,
  )
  const edits: EditEntry[] = [
    { duration: sampleTicks, mediaTime: 0, rate: 0x00010000 },
  ]
  if (stillTicks > 0) edits.unshift({ duration: stillTicks, mediaTime: -1, rate: 0x00010000 })
  const trak = box(
    'trak',
    tkhdBox({ trackId, duration: stillTicks + sampleTicks, width: 0, height: 0, now }),
    box('edts', elstBox(edits)),
    mdia,
  )
  const offsetBoxStart = trak.byteLength - offsetBox.byteLength
  return {
    bytes: trak,
    offsetPatch: { pos: offsetBoxStart + 8 + 4 + 4, count: 1, wide },
    chunkCount: 1,
  }
}

/** QuickTime moov.meta：配对标识与创建时间（mdta keys + ilst）。 */
function movieMetadataBox(identifier: string, createdAt: Date): Uint8Array {
  const metadata = [
    [CONTENT_IDENTIFIER_KEY, identifier],
    ['com.apple.quicktime.creationdate', createdAt.toISOString()],
  ]
  const keyEntries = metadata.map(([key]) =>
    new ByteWriter().u32(8 + key.length).fourCC('mdta').utf8(key).build(),
  )
  const keys = fullBox('keys', 0, 0, new ByteWriter().u32(keyEntries.length).build(), ...keyEntries)
  const items = metadata.map(([, value], index) => {
    const dataBox = box('data', new ByteWriter().u32(1).u32(0).utf8(value).build())
    return box(String.fromCharCode(0, 0, 0, index + 1), dataBox)
  })
  const ilst = box('ilst', ...items)
  // 保持普通 box（无 version/flags）：与已验证可被 iOS Photos 识别的字节布局一致；
  // LivePhotosKit 导入对 meta 的解析方式与规范 fullbox 不同，改 fullbox 会导致 PVT 不识别。
  return box('meta', hdlrBox('mdta', 'Core Media Metadata'), keys, ilst)
}

function mvhdBox(timescale: number, duration: number, nextTrackId: number, now: number): Uint8Array {
  const w = new ByteWriter()
    .u32(now).u32(now)
    .u32(timescale)
    .u32(duration)
    .fp32(1) // rate
    .fp16(1) // volume
    .zeros(10)
    .raw(IDENTITY_MATRIX)
    .zeros(24)
    .u32(nextTrackId)
  return fullBox('mvhd', 0, 0, w.build())
}

/** 计算容器头与样本位置，媒体数据仍引用原始样本。 */
function buildMovieParts(opts: MovBuildOptions) {
  const { movieTimescale, tracks, identifier, stillTimeSeconds, createdAt = new Date() } = opts
  if (tracks.length === 0) throw new Error('no tracks')
  const now = unixToMacSeconds(createdAt.getTime() / 1000)
  const stillTicks = Math.max(0, Math.round(stillTimeSeconds * movieTimescale))

  let movieDuration = stillTicks + 1
  for (const t of tracks) {
    const mediaDuration = t.samples.reduce((sum, s) => sum + s.duration, 0)
    const presentation =
      t.edits && t.edits.length > 0
        ? t.edits.reduce((sum, e) => sum + e.duration, 0)
        : Math.round((mediaDuration * movieTimescale) / t.timescale)
    movieDuration = Math.max(movieDuration, presentation)
  }
  // 参考 AVAssetWriter：样本时长 0.1s（clamp 到剩余时长），承载静帧时刻。
  const sampleTicks = Math.max(1, Math.min(Math.round(movieTimescale / 10), movieDuration - stillTicks))

  const totalSampleBytes = tracks.reduce(
    (sum, t) => sum + t.samples.reduce((s2, s) => s2 + s.data.byteLength, 0),
    0,
  )
  // 预估总体积决定 32/64 位偏移表。
  const wide = totalSampleBytes + 1024 * 1024 > 0xffffffff

  const maxTrackId = tracks.reduce((m, t) => Math.max(m, t.trackId), 0)
  const built = tracks.map((t) => buildMediaTrak(t, movieTimescale, now, wide))
  const metaTrak = buildMetadataTrak({
    trackId: maxTrackId + 1,
    movieTimescale,
    stillTicks,
    sampleTicks,
    now,
    wide,
  })

  const mvhd = mvhdBox(movieTimescale, movieDuration, maxTrackId + 2, now)
  const moovChildren = [mvhd, ...built.map((b) => b.bytes), metaTrak.bytes, movieMetadataBox(identifier, createdAt)]
  const moov = box('moov', ...moovChildren)

  // 各子 box 在 moov 中的基址（偏移回填需要绝对位置）。
  const bases: number[] = []
  let base = 8 // moov 头
  for (const child of moovChildren) {
    bases.push(base)
    base += child.byteLength
  }

  const ftyp = box(
    'ftyp',
    new ByteWriter().fourCC('qt  ').u32(0x200).fourCC('qt  ').build(),
  )

  const mdatDataStart = ftyp.byteLength + moov.byteLength + 8
  let cursor = mdatDataStart
  const allSamples: MovSample['data'][] = []
  for (let i = 0; i < tracks.length; i++) {
    const patch = built[i].offsetPatch!
    let pos = bases[1 + i] + patch.pos
    for (const s of tracks[i].samples) {
      writeOffset(moov, pos, patch.wide, cursor)
      pos += patch.wide ? 8 : 4
      cursor += s.data.byteLength
      allSamples.push(s.data)
    }
  }
  // 元数据轨道样本
  const metaBase = bases[1 + built.length]
  const metaPatch = metaTrak.offsetPatch!
  const metaSample = stillImageTimeSample()
  writeOffset(moov, metaBase + metaPatch.pos, metaPatch.wide, cursor)
  cursor += metaSample.byteLength
  allSamples.push(metaSample)

  const mdatHeader = new ByteWriter().u32(8 + (cursor - mdatDataStart)).fourCC('mdat').build()
  return { header: concatBytes([ftyp, moov, mdatHeader]), allSamples }
}

export function buildMov(opts: MovBuildOptions): Uint8Array<ArrayBuffer> {
  const { header, allSamples } = buildMovieParts(opts)
  return concatBytes([header, ...allSamples.map((sample) => {
    if (!(sample instanceof Uint8Array)) throw new Error('Missing source video for sample range')
    return sample
  })])
}

export function buildMovieBlob(opts: MovBuildOptions, source: Blob) {
  const { header, allSamples } = buildMovieParts(opts)
  const parts: BlobPart[] = [header]
  let start = -1
  let end = -1
  for (const sample of allSamples) {
    if (!(sample instanceof Uint8Array) && sample.offset === end && start !== -1) {
      end += sample.byteLength
      continue
    }
    if (start !== -1) {
      if (end > source.size) throw new Error('Video sample exceeds source file')
      parts.push(source.slice(start, end))
      start = end = -1
    }
    if (sample instanceof Uint8Array) {
      parts.push(sample.buffer instanceof ArrayBuffer
        ? new Uint8Array(sample.buffer, sample.byteOffset, sample.byteLength)
        : sample.slice())
    } else {
      start = sample.offset
      end = start + sample.byteLength
    }
  }
  if (start !== -1) {
    if (end > source.size) throw new Error('Video sample exceeds source file')
    parts.push(source.slice(start, end))
  }
  return {
    header,
    blob: new Blob(parts, { type: 'video/quicktime' }),
  }
}

function writeOffset(target: Uint8Array, pos: number, wide: boolean, value: number): void {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength)
  if (wide) {
    view.setUint32(pos, Math.floor(value / 0x100000000))
    view.setUint32(pos + 4, value >>> 0)
  } else {
    view.setUint32(pos, value)
  }
}

export interface MovVerification {
  identifier?: string
  stillTimeSeconds?: number
  hasVideo: boolean
  hasAudio: boolean
}

/** 解析 mebx 样本描述中的键名（与 TIKA/Apple 的解析方式一致）。 */
export function mebxKeyNames(entry: Uint8Array): string[] {
  const names: string[] = []
  // 跳过 box 头(8) + 6 字节 reserved + 2 字节 data_reference_index
  const boxes = parseBoxes(entry, 16)
  const keysBox = findBox(boxes, 'keys')
  if (!keysBox) return names
  const keyBoxes = parseBoxes(entry, keysBox.start + 8, keysBox.start + keysBox.size)
  for (const kb of keyBoxes) {
    const decls = parseBoxes(entry, kb.start + 8, kb.start + kb.size)
    for (const d of decls) {
      if (d.type === 'keyd' && d.size > 12) {
        let s = ''
        for (let i = d.start + 12; i < d.start + d.size; i++) s += String.fromCharCode(entry[i])
        names.push(s)
      }
    }
  }
  return names
}

/** 校验输出 MOV 的配对标识与 still-image-time 轨道。 */
export function verifyMov(bytes: Uint8Array): MovVerification {
  const movie = parseMovie(bytes)
  const identifier = movie.metadata.get(CONTENT_IDENTIFIER_KEY)
  const video = movie.tracks.find((t) => t.handler === 'vide')
  const audio = movie.tracks.find((t) => t.handler === 'soun')
  const metaTrack = movie.tracks.find((t) => t.handler === 'meta')

  let stillTimeSeconds: number | undefined
  if (metaTrack && metaTrack.edits && metaTrack.edits.length > 0) {
    const first = metaTrack.edits[0]
    if (first.mediaTime === -1) {
      stillTimeSeconds = first.duration / movie.timescale
    } else {
      stillTimeSeconds = 0
    }
    const entry = metaTrack.stsdEntries[0]
    if (entry && entry.format === 'mebx') {
      const names = mebxKeyNames(entry.raw)
      if (!names.includes(STILL_IMAGE_TIME_KEY)) stillTimeSeconds = undefined
    } else {
      stillTimeSeconds = undefined
    }
  }

  return {
    identifier: typeof identifier === 'string' ? identifier : undefined,
    stillTimeSeconds,
    hasVideo: !!video,
    hasAudio: !!audio,
  }
}
