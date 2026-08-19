import { chromium } from 'playwright'

const url = process.argv[2] || 'http://127.0.0.1:4173/'
const out = process.argv[3] || '/home/claude/shots/oil.png'
const mode = process.argv[4] || 'sweep'

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const logs = []
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message))
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(9000)

if (mode === 'swirl') {
  const cx = 640, cy = 500, r = 210
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 3.2
    await page.mouse.move(cx + Math.cos(a) * r * (0.4 + i / 60), cy + Math.sin(a) * r * (0.4 + i / 60))
    if (i % 6 === 0) await page.waitForTimeout(120)
  }
} else {
  await page.mouse.move(120, 700)
  await page.mouse.move(420, 300, { steps: 10 })
  await page.waitForTimeout(160)
  await page.mouse.move(760, 720, { steps: 10 })
  await page.waitForTimeout(160)
  await page.mouse.move(1120, 320, { steps: 10 })
}
await page.waitForTimeout(350)
await page.screenshot({ path: out })
console.log(JSON.stringify({ logs: logs.slice(0, 8) }))
await browser.close()
