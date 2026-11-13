/**
 * ZIP 打包（store 模式，无压缩）。
 * ZIP 所有整数字段为小端序。
 */
import { ByteWriter, concatBytes } from './bytes'

import { crc32 } from './zip-crc'

function crc32InWorker(data: Blob, signal?: AbortSignal): Promise<number> {
  if (typeof Worker === 'undefined' || data.size < 4 * 1024 * 1024) return crc32(data, signal)
  return new Promise<number>((resolve, reject) => {
    const worker = new Worker(new URL('./zip-crc.worker.ts', import.meta.url), { type: 'module' })
    function finish() {
      worker.terminate()
      signal?.removeEventListener('abort', abort)
    }
    function abort() {
      finish()
      reject(signal?.reason)
    }
    worker.onmessage = ({ data: result }: MessageEvent<number | null>) => {
      finish()
      if (result === null) reject(new Error('ZIP checksum worker could not read the file'))
      else resolve(result)
    }
    worker.onerror = worker.onmessageerror = () => {
      finish()
      reject(new Error('ZIP checksum worker failed'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      worker.postMessage(data)
    } catch (error) {
      finish()
      reject(error)
    }
  }).catch((error) => {
    if (signal?.aborted) throw error
    return crc32(data, signal)
  })
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

type ZipData = Blob | Uint8Array<ArrayBuffer>

export interface ZipEntry {
  name: string
  data: ZipData | Promise<ZipData>
}

export async function createZip(entries: ZipEntry[], signal?: AbortSignal): Promise<Blob> {
  const now = dosDateTime(new Date())
  const localParts: BlobPart[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  // 封面生成与 MOV 校验并行，写入时仍按原有条目顺序排列。
  const prepared = await Promise.all(entries.map(async (entry) => {
    const data = await entry.data
    signal?.throwIfAborted()
    const crc = await (data instanceof Blob ? crc32InWorker(data, signal) : crc32(data))
    return { name: entry.name, data, crc }
  }))
  signal?.throwIfAborted()
  for (const { name, data, crc } of prepared) {
    const isDirectory = name.endsWith('/')
    const nameBytes = new TextEncoder().encode(name)
    const size = data instanceof Blob ? data.size : data.byteLength
    const local = new ByteWriter()
      .u32le(0x04034b50)
      .u16le(20) // version needed
      .u16le(0x0800) // UTF-8 names
      .u16le(0) // store
      .u16le(now.time)
      .u16le(now.date)
      .u32le(crc)
      .u32le(size)
      .u32le(size)
      .u16le(nameBytes.byteLength)
      .u16le(0)
      .raw(nameBytes)
      .build()
    localParts.push(local, data)

    centralParts.push(
      new ByteWriter()
        .u32le(0x02014b50)
        .u16le(0x0314) // ZIP 2.0, Unix attributes
        .u16le(20) // version needed
        .u16le(0x0800)
        .u16le(0)
        .u16le(now.time)
        .u16le(now.date)
        .u32le(crc)
        .u32le(size)
        .u32le(size)
        .u16le(nameBytes.byteLength)
        .u16le(0).u16le(0).u16le(0).u16le(0)
        .u32le(isDirectory ? 0x41ed0010 : 0x81a40000)
        .u32le(offset)
        .raw(nameBytes)
        .build(),
    )
    offset += local.byteLength + size
  }

  const central = concatBytes(centralParts)
  const eocd = new ByteWriter()
    .u32le(0x06054b50)
    .u16le(0).u16le(0)
    .u16le(entries.length)
    .u16le(entries.length)
    .u32le(central.byteLength)
    .u32le(offset)
    .u16le(0)
    .build()

  return new Blob([...localParts, central, eocd], { type: 'application/zip' })
}
