import { chromium } from 'playwright'

const url = process.argv[2] || 'http://localhost:4173/'
const out = process.argv[3] || '/home/claude/shots/shot.png'
const clicks = Number(process.argv[4] || 0)
const waitMs = Number(process.argv[5] || 4000)

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(waitMs)

for (let i = 0; i < clicks; i++) {
  await page.mouse.click(640, 500)
  await page.waitForTimeout(1500)
}
await page.waitForTimeout(500)
await page.screenshot({ path: out })

const info = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  const gl = c && (c.getContext('webgl2') || c.getContext('webgl'))
  return { canvas: c ? [c.width, c.height] : null, gl: !!gl, ver: gl ? gl.getParameter(gl.VERSION) : null }
})
console.log(JSON.stringify({ info, logs: logs.slice(0, 40) }, null, 1))
await browser.close()
