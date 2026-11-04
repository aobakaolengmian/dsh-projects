import { chromium } from 'playwright'
const url = process.argv[2]
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const fails = []
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('response', async (res) => {
  if (!res.url().includes('/api/')) return
  try {
    const body = await res.text()
    if (!body.includes('"ok":false')) return
    const m = body.match(/"code":"([^"]+)","message":"([^"]{0,170})/)
    if (m) fails.push({ api: res.url().replace(/^.*\/api\//, '').slice(0, 30), code: m[1], msg: m[2] })
  } catch {}
})
await page.goto(url)
await page.waitForTimeout(7000)
for (let i = 0; i < 8; i++) {
  if ((await page.locator('[role="dialog"]').count()) === 0) break
  const btn = page.locator('[role="dialog"] button', { hasText: /Continue|继续|Got it|知道了|Configure later|稍后|Skip|跳过/i }).first()
  if ((await btn.count()) > 0) await btn.click({ force: true }).catch(() => {})
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
}
const ui = await page.evaluate(() => ({
  pjRoot: !!document.querySelector('.pj-root'),
  rows: document.querySelectorAll('[role="treeitem"]').length,
}))
console.log('ui:', JSON.stringify(ui))

// 1) new session
fails.length = 0
await page.locator('button', { hasText: /New Session|新会话/ }).first().click({ force: true }).catch(() => {})
await page.waitForTimeout(10000)
const created = await page.evaluate(() => ({
  unavailable: /Session unavailable|会话不可用/.test(document.body.innerText),
  tail: document.body.innerText.slice(-140).replace(/\s+/g, ' '),
}))
console.log('new session:', JSON.stringify(created), 'fails:', JSON.stringify(fails.slice(0, 3)))

// 2) open a historical session
const sessionRow = page.locator('[role="treeitem"][data-row-key^="session:"]').first()
if ((await sessionRow.count()) === 0) {
  const ws = page.locator('[role="treeitem"][data-row-key^="workspace:"]').first()
  if ((await ws.count()) > 0) { await ws.click({ force: true }); await page.waitForTimeout(2500) }
}
const row = page.locator('[role="treeitem"][data-row-key^="session:"]').first()
console.log('historical row:', await row.count())
if ((await row.count()) > 0) {
  fails.length = 0
  await row.click({ force: true })
  await page.waitForTimeout(12000)
  const hist = await page.evaluate(() => ({
    unavailable: /Session unavailable|会话不可用/.test(document.body.innerText),
    bodyLen: document.body.innerText.length,
    tail: document.body.innerText.slice(-140).replace(/\s+/g, ' '),
  }))
  console.log('historical:', JSON.stringify(hist), 'fails:', JSON.stringify(fails.slice(0, 3)))
}
console.log('console errors:', JSON.stringify(errors.filter((e) => !/favicon|ERR_|net::|Failed to load resource/.test(e)).slice(0, 3)))
await page.screenshot({ path: '/tmp/v22-state.png' })
await browser.close()
