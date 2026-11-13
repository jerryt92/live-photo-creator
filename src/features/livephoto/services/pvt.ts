import type { LivePhotoBuild } from '../models'
import { buildHeicCover, buildHeicCoverFromStill, verifyHeicCover } from './heic'
import { createZip } from './zip'

async function prepareCover(result: LivePhotoBuild): Promise<Uint8Array<ArrayBuffer>> {
  if (result.hevcStill) {
    const candidate = buildHeicCoverFromStill(result.hevcStill, result.exifTiff)
    if (verifyHeicCover(candidate, result.identifier)) {
      return candidate
    }
    console.warn('[pvt] HDR cover failed structural validation; falling back to SDR cover')
  }
  return buildHeicCover(result.photoBlob, result.exifTiff)
}

export async function buildPvtZip(result: LivePhotoBuild, stem: string, signal?: AbortSignal): Promise<Blob> {
  const directory = `${stem}.pvt/`
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PFVideoComplementMetadataVersionKey</key>
  <string>1</string>
</dict>
</plist>
`
  return createZip([
    { name: directory, data: new Uint8Array() },
    { name: directory + stem + '.heic', data: prepareCover(result) },
    { name: directory + result.videoName, data: result.videoBlob },
    { name: directory + 'metadata.plist', data: new TextEncoder().encode(plist) },
  ], signal)
}
