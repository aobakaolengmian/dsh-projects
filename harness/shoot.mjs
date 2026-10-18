/**
 * Screenshot the harness in several states for visual review.
 * Usage: node harness/shoot.mjs [name-substring]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'harness/shots')
await mkdir(shots, { recursive: true })

const configs = [
  { name: 'light-wide', query: 'theme=light&wide=1' },
  { name: 'dark-wide', query: 'theme=dark&wide=1' },
  { name: 'light-rail', query: 'theme=light&wide=0' },
  { name: 'dark-rail', query: 'theme=dark&wide=0' },
  { name: 'minimal-wide', query: 'scenario=minimal&theme=light&wide=1' },
  { name: 'empty-wide', query: 'scenario=empty&theme=light&wide=1' },
  { name: 'empty-dark', query: 'scenario=empty&theme=dark&wide=1' },
  { name: 'minimal-dark', query: 'scenario=minimal&theme=dark&wide=1' },
  { name: 'error-wide', query: 'scenario=error&theme=light&wide=1' },
  { name: 'loading-wide', query: 'scenario=loading&theme=light&wide=1' },
]

const filter = process.argv[2]
const selected = filter === undefined ? configs : configs.filter((config) => config.name.includes(filter))
const browser = await chromium.launch({ channel: 'chrome' })
const failures = []
try {
  for (const config of selected) {
    const page = await browser.newPage({ viewport: { width: 360, height: 860 }, deviceScaleFactor: 2 })
    const consoleErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(String(error)))
    const base = pathToFileURL(join(root, 'harness/index.html')).href
    await page.goto(`${base}?${config.query}`)
    try {
      await page.waitForFunction(() => document.body.dataset.ready === '1' || document.body.dataset.error !== undefined, undefined, { timeout: 20_000 })
    } catch {
      failures.push(`${config.name}: harness did not become ready`)
    }
    const error = await page.evaluate(() => document.body.dataset.error ?? null)
    if (error !== null) failures.push(`${config.name}: ${error}`)
    if (consoleErrors.length > 0) failures.push(`${config.name}: console ${consoleErrors.join(' | ')}`)
    await page.waitForTimeout(350)
    const rail = config.query.includes('wide=0')
    const sidebar = page.locator('#sidebar')
    const box = await sidebar.boundingBox()
    const file = join(shots, `${config.name}.png`)
    await page.screenshot({
      path: file,
      clip: { x: 0, y: 0, width: rail ? 56 : 280, height: 860 },
    })
    console.log(`shot ${config.name} (${box?.width ?? '?'}x${box?.height ?? '?'}) -> harness/shots/${config.name}.png`)
    await page.close()
  }
} finally {
  await browser.close()
}

if (failures.length > 0) {
  console.error('FAILURES:')
  for (const failure of failures) console.error(' -', failure)
  process.exitCode = 1
} else {
  console.log('all shots ok')
}
