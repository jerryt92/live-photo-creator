import { crc32 } from './zip-crc'

self.onmessage = async ({ data }: MessageEvent<Blob>) => {
  try {
    self.postMessage(await crc32(data))
  } catch {
    self.postMessage(null)
  }
}
