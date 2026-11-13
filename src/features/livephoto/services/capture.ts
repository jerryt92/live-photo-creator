/**
 * 拍摄时间 / 位置字符串的解析（对应 iOS 端 LivePhotoMetadataReader 的解析逻辑）。
 */
import type { CaptureDate, CaptureMetadata, Coordinate } from '../models'

/** 解析 EXIF 日期 `yyyy:MM:dd HH:mm:ss`（按给定时区偏移解释为墙上时钟）。 */
export function parseExifDate(value: string, offsetMinutes?: number): CaptureDate | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  if (!m) return undefined
  const [, y, mo, d, h, mi, s] = m
  const epochMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - (offsetMinutes ?? 0) * 60000
  if (Number.isNaN(epochMs)) return undefined
  return { epochMs, offsetMinutes }
}

/** 解析 `+08:00`、`+0800` 形式的时区偏移，返回分钟数。 */
export function parseOffset(value: string | undefined): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.length !== 5 && trimmed.length !== 6) return undefined
  const sign = trimmed[0]
  if (sign !== '+' && sign !== '-') return undefined
  const digits = trimmed.slice(1).replace(':', '')
  if (!/^\d{4}$/.test(digits)) return undefined
  const hours = +digits.slice(0, 2)
  const minutes = +digits.slice(2)
  if (hours > 14 || minutes >= 60) return undefined
  const total = hours * 60 + minutes
  return sign === '-' ? -total : total
}

/** 解析 ISO 8601 时间（QuickTime creationdate），保留原始时区。 */
export function parseISO8601(value: string): CaptureDate | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?/.exec(trimmed)
  if (!m) return undefined
  const [, y, mo, d, h, mi, s, frac, tz] = m
  let offsetMinutes: number | undefined
  if (tz === 'Z') offsetMinutes = 0
  else if (tz) offsetMinutes = parseOffset(tz)
  const epochMs =
    Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, frac ? +frac.padEnd(3, '0') : 0) -
    (offsetMinutes ?? 0) * 60000
  if (Number.isNaN(epochMs)) return undefined
  return { epochMs, offsetMinutes }
}

/** 校验坐标有效性（与 iOS 端一致：有限、范围内、非 (0,0)）。 */
export function validatedCoordinate(latitude: number, longitude: number): Coordinate | undefined {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return undefined
  }
  return { latitude, longitude }
}

/** 解析 ISO 6709 位置字符串，如 `+37.7858-122.4064+010.000/`。 */
export function parseISO6709(value: string): { coordinate: Coordinate; altitude?: number } | undefined {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(value.trim())
  if (!m) return undefined
  const coordinate = validatedCoordinate(+m[1], +m[2])
  if (!coordinate) return undefined
  return { coordinate, altitude: m[3] ? +m[3] : undefined }
}

/** 本地时区偏移（分钟）。 */
export function localOffsetMinutes(date = new Date()): number {
  return -date.getTimezoneOffset()
}

/** 把偏移分钟数格式化为 `+08:00`。 */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const h = String(Math.floor(abs / 60)).padStart(2, '0')
  const m = String(abs % 60).padStart(2, '0')
  return `${sign}${h}:${m}`
}

/**
 * 按拍摄时区格式化墙上时钟时间。
 * 通过平移时间戳 + UTC 取值实现，避免依赖 IANA 时区数据库。
 */
export function formatCaptureDate(date: CaptureDate, locale: string): string {
  const offset = date.offsetMinutes ?? localOffsetMinutes()
  const shifted = new Date(date.epochMs + offset * 60000)
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })
    return formatter.format(shifted)
  } catch {
    return shifted.toISOString().replace('T', ' ').slice(0, 16)
  }
}

/** 坐标显示（4 位小数，与 iOS 端一致）。 */
export function formatCoordinate(coordinate: Coordinate): string {
  return `${coordinate.latitude.toFixed(4)}, ${coordinate.longitude.toFixed(4)}`
}

/** 生成 EXIF 日期字符串（墙上时钟）。 */
export function toExifDateString(date: CaptureDate): string {
  const offset = date.offsetMinutes ?? localOffsetMinutes()
  const d = new Date(date.epochMs + offset * 60000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** 合并元数据：用来源覆盖目标（未记录的项目移除，对应 iOS 端 apply 逻辑）。 */
export function applyMetadata(source: CaptureMetadata): CaptureMetadata {
  return {
    creationDate: source.creationDate,
    coordinate: source.coordinate,
    altitude: source.coordinate ? source.altitude : undefined,
  }
}
