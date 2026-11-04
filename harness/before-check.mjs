import { chromium } from 'playwright'
const url = process.argv[2]
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } })
const fails = []
page.on('response', async (res) => {
  if (!res.url().includes('/api/')) return
  try {
    const body = await res.text()
    if (!body.includes('"ok":false')) return
    const m = body.match(/"code":"([^"]+)","message":"([^"]{0,200})/)
    if (m) fails.push({ api: res.url().replace(/^.*\/api\//, '').slice(0, 28), code: m[1], msg: m[2] })
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
fails.length = 0
await page.locator('button', { hasText: /New Session|新会话/ }).first().click({ force: true }).catch(() => {})
await page.waitForTimeout(11000)
const st = await page.evaluate(() => ({
  unavailable: /Session unavailable|会话不可用/.test(document.body.innerText),
  tail: document.body.innerText.slice(-150).replace(/\s+/g, ' '),
}))
console.log('new session state:', JSON.stringify(st))
console.log('rpc failures:', JSON.stringify(fails.slice(0, 4), null, 1))
await browser.close()
