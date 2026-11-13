/**
 * 生成社交分享卡片 public/share-card.png（1200×630 @2x）。
 * 设计稿：scripts/share-card.html（品牌色 / logo / 文案与站点保持一致）。
 *
 * 运行：npm run share-card   （需要本机安装 Google Chrome）
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DESIGN = join(ROOT, 'scripts/share-card.html')
const OUT = join(ROOT, 'public/share-card.png')

if (!existsSync(CHROME)) throw new Error('Google Chrome not found')

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 })
  await page.goto(`file://${DESIGN}`, { waitUntil: 'networkidle0' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1200, height: 630 } })
  const { size } = statSync(OUT)
  console.log(`[share-card] wrote ${OUT} (${(size / 1024).toFixed(0)}KB, 2400×1260)`)
} finally {
  await browser.close()
}
