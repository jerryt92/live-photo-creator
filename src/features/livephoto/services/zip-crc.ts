const CRC_TABLES = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const tables = [table]
  for (let i = 1; i < 4; i++) {
    tables.push(Uint32Array.from(tables[i - 1], (crc) => table[crc & 0xff] ^ (crc >>> 8)))
  }
  return tables
})()

// 以有限内存扫描 CRC，减少大 MOV 的 Blob 分片和异步读取次数。
const CRC_CHUNK_BYTES = 4 * 1024 * 1024

function updateCrc(crc: number, data: Uint8Array): number {
  const [byte, second, third, fourth] = CRC_TABLES
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let i = 0
  for (; i + 4 <= data.byteLength; i += 4) {
    const word = crc ^ view.getUint32(i, true)
    crc = fourth[word & 0xff] ^ third[(word >>> 8) & 0xff] ^ second[(word >>> 16) & 0xff] ^ byte[word >>> 24]
  }
  for (; i < data.byteLength; i++) {
    crc = byte[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return crc
}

export async function crc32(data: Blob | Uint8Array, signal?: AbortSignal): Promise<number> {
  let crc = 0xffffffff
  if (data instanceof Blob) {
    for (let offset = 0; offset < data.size; offset += CRC_CHUNK_BYTES) {
      signal?.throwIfAborted()
      const chunk = await data.slice(offset, offset + CRC_CHUNK_BYTES).arrayBuffer()
      crc = updateCrc(crc, new Uint8Array(chunk))
    }
  } else {
    crc = updateCrc(crc, data)
  }
  return (crc ^ 0xffffffff) >>> 0
}
