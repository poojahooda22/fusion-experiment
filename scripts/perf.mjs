import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:4173/?stats=1', { waitUntil: 'networkidle' })
await page.waitForTimeout(8000)
const r = await page.evaluate(() => {
  // R3F stashes the store on the canvas element in v8
  const st = window.__hero
  if (!st) return { error: 'no r3f state' }
  const info = st.gl.info
  let meshes = 0, tris = 0
  st.scene.traverse(o => { if (o.isMesh) { meshes++; if (o.geometry?.index) tris += o.geometry.index.count/3 } })
  return {
    drawCalls: info.render.calls,
    trianglesPerFrame: info.render.triangles,
    programs: info.programs?.length,
    sceneMeshes: meshes,
    sceneTriangles: tris,
    memGeometries: info.memory.geometries,
    memTextures: info.memory.textures,
    dpr: st.viewport.dpr,
    size: [st.size.width, st.size.height],
  }
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
