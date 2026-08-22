import * as THREE from 'three'
import vertexShader from './glsl/tile.vert.glsl'
import fragmentShader from './glsl/tile.frag.glsl'
import { ScreenPaint } from '../oilwater/ScreenPaint.js'
import { ScrollState } from './ScrollState.js'
import { ScrollRibbon } from './ScrollRibbon.js'

/**
 * The DOM-synced media overlay.
 *
 * The reference site has NO <img> or <video> elements at all - every visual
 * is a WebGL quad drawn on a fixed full-page canvas, positioned each frame
 * at the rect of an (empty) DOM placeholder. Text stays real DOM above the
 * canvas. This class is that mechanism, scoped to this page:
 *
 *   <div class="media-slot" data-media="/media/x.jpg" ...>  (visual: nothing)
 *          |  getBoundingClientRect() every frame
 *          v
 *   fixed <canvas> (pointer-events: none)  ->  one quad per slot
 *
 * Each tile runs the show transition when it enters the viewport, flexes
 * with scroll velocity, ripples under the cursor via a ScreenPaint fluid
 * simulation (the same sim the oil pass uses - textures cannot cross WebGL
 * contexts, so this overlay owns its own instance), and renders duotone
 * until revealed.
 */

const EASE = (t) => 1 - Math.pow(1 - t, 3) // cubic out, close to the reference feel

class Tile {
  constructor(el, texture, paint, viewportUniform) {
    this.el = el
    this.showRatio = 0
    this.showTarget = 0
    this.showTime = 0
    this.showDelay = Number(el.dataset.delay ?? 0)
    this.hoverRatio = 0
    this.hoverTarget = 0
    this.textureAspect = 1

    const tint = new THREE.Color(el.dataset.tint ?? '#3230ee')

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      /* The y-down pixel camera (top=0, bottom=h) mirrors the projection,
       * which flips every triangle's winding - with default back-face
       * culling the quads simply vanish. DoubleSide, or nothing renders. */
      side: THREE.DoubleSide,
      uniforms: {
        u_texture: { value: texture },
        u_paintTexture: { value: paint.texture },
        u_paintTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        u_paintPush: { value: 25 },
        u_viewport: { value: viewportUniform },
        u_uvScale: { value: new THREE.Vector2(1, 1) },
        u_uvOffset: { value: new THREE.Vector2(0, 0) },
        u_tint: { value: new THREE.Vector3(tint.r, tint.g, tint.b) },
        u_keepTint: { value: el.dataset.keepTint === '1' ? 1 : 0 },
        u_cornerRadius: { value: Number(el.dataset.radius ?? 24) },
        u_radialCenter: { value: new THREE.Vector2(...(el.dataset.origin ?? '0.5,0.62').split(',').map(Number)) },
        u_showRatio: { value: 0 },
        u_hoverRatio: { value: 0 },
        u_domXY: { value: new THREE.Vector2() },
        u_domWH: { value: new THREE.Vector2(1, 1) },
        u_domXYFrom: { value: new THREE.Vector2() },
        u_domWHFrom: { value: new THREE.Vector2(1, 1) },
        u_scrollBend: { value: 0 },
        u_parallax: { value: 0 },
        u_expandRatio: { value: 0 },
        u_expandCurl: { value: new THREE.Vector2() },
      },
    })

    /* Expanding showreel: this tile morphs between TWO dom rects - the
     * small anchor box in the text row and its own full-width slot inside
     * the sticky stage - driven by how far the stage has been scrolled. */
    this.expand = el.dataset.expand === '1'
    if (this.expand) {
      this.anchorEl = document.querySelector('[data-expand-anchor]')
      this.stageEl = el.closest('.reel-stage')
      this._pe = 0
      this._peVel = 0
    }

    el.addEventListener('pointerenter', () => { this.hoverTarget = 1 })
    el.addEventListener('pointerleave', () => { this.hoverTarget = 0 })
  }

  update(dt, scroll, viewportH) {
    const own = this.el.getBoundingClientRect()
    const u = this.material.uniforms

    /* ---- expansion: mix between the anchor rect and the full slot ----- *
     * Progress is a pure function of scroll (scrubbed, like the
     * reference): 0 while the sticky stage hasn't started consuming its
     * runway, 1 when the runway is spent. The tile's drawn rect is the
     * per-component lerp of the two live DOM rects, so BOTH endpoints
     * keep responding to resize and layout while the morph runs.        */
    let L = own.left, T = own.top, W = own.width, H = own.height
    if (this.expand && this.anchorEl && this.stageEl) {
      const stage = this.stageEl.getBoundingClientRect()
      /* The morph spends exactly the stage-top's travel across one viewport:
       * p hits 1 at the instant the sticky pins, so the sheet arrives
       * centred and then DWELLS there for the rest of the runway. The
       * anchor box is still on screen for most of that travel, which is
       * what keeps the whole morph inside the viewport. */
      const p = Math.min(Math.max((viewportH - stage.top) / viewportH, 0), 1)
      const pe = p * p * (3 - 2 * p) // smoothstep ease, still scroll-locked

      const a = this.anchorEl.getBoundingClientRect()
      L = a.left + (own.left - a.left) * pe
      T = a.top + (own.top - a.top) * pe
      W = a.width + (own.width - a.width) * pe
      H = a.height + (own.height - a.height) * pe

      /* cloth dynamics: billow with the expansion's own velocity, breathe
       * mid-morph, keep a faint bow once open (the reference's expanded
       * sheet is never perfectly straight) */
      const vel = (pe - this._pe) / Math.max(dt, 1e-4)
      this._peVel += (vel - this._peVel) * (1 - Math.pow(0.001, dt))
      this._pe = pe
      const pulse = pe * (1 - pe)
      const curlY = THREE.MathUtils.clamp(this._peVel * 0.055, -0.085, 0.085)
        + pulse * 0.11 + pe * 0.028
      const curlX = THREE.MathUtils.clamp(this._peVel * -0.02, -0.03, 0.03)
        + pulse * 0.04
      u.u_expandCurl.value.set(curlY, curlX)
      u.u_expandRatio.value = pe

      // the play pill + caption fade in via CSS from this one variable
      this.stageEl.style.setProperty('--reel-p', pe.toFixed(4))
    }

    /* Reveal trigger: >=22% of the drawn rect inside the viewport. Checked
     * per frame from the rect we already measured - an IntersectionObserver
     * does the same job but its callbacks starve when the main thread is
     * busy, and a scroll-linked site is exactly where that happens. */
    if (this.showTarget === 0) {
      const vw = window.innerWidth
      const ix = Math.max(0, Math.min(L + W, vw) - Math.max(L, 0))
      const iy = Math.max(0, Math.min(T + H, viewportH) - Math.max(T, 0))
      if (W * H > 0 && (ix * iy) / (W * H) >= 0.22) this.showTarget = 1
    }

    u.u_domXY.value.set(L, T)
    u.u_domWH.value.set(W, H)
    // the show transition starts lower and slightly smaller
    u.u_domXYFrom.value.set(L + W * 0.03, T + 70)
    u.u_domWHFrom.value.set(W * 0.94, H * 0.94)

    /* reveal clock - wall time, NOT accumulated dt: dt is clamped for the
     * simulation's stability, and on a slow machine accumulating clamped
     * steps would stretch a 1.15 s reveal into tens of seconds */
    if (this.showTarget > 0 && this.showRatio < 1) {
      const now = performance.now() / 1000
      if (this._showT0 === undefined) this._showT0 = now + this.showDelay
      const t = Math.min(Math.max((now - this._showT0) / 1.15, 0), 1)
      this.showRatio = EASE(t)
    }
    u.u_showRatio.value = this.showRatio

    /* hover ease, ~200 ms both ways */
    const k = 1 - Math.pow(0.0001, dt)
    this.hoverRatio += (this.hoverTarget - this.hoverRatio) * k
    u.u_hoverRatio.value = this.hoverRatio

    /* scroll flex + a small parallax drift against the text (a pinned,
     * expanding tile must not parallax against its own stage) */
    u.u_scrollBend.value = scroll.bend
    const mid = T + H * 0.5 - viewportH * 0.5
    u.u_parallax.value = this.expand ? 0 : mid * -0.02

    /* cover fit */
    const rectAspect = W / Math.max(H, 1)
    const s = rectAspect / this.textureAspect
    if (s < 1) u.u_uvScale.value.set(s, 1), u.u_uvOffset.value.set((1 - s) / 2, 0)
    else u.u_uvScale.value.set(1, 1 / s), u.u_uvOffset.value.set(0, (1 - 1 / s) / 2)

    return T + H > -100 && T < viewportH + 100 // visible?
  }
}

export class MediaTiles {
  constructor() {
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, {
      position: 'fixed', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '1',
    })
    document.body.appendChild(this.canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, alpha: true, antialias: true,
      powerPreference: 'high-performance', stencil: false,
    })
    this.renderer.setClearColor(0x000000, 0)

    this.scene = new THREE.Scene()
    // CSS-pixel orthographic camera, y DOWN, so DOM rects map 1:1
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10)
    this.viewportUniform = new THREE.Vector2(1, 1)

    this.paint = new ScreenPaint(this.renderer, { scale: 0.35, lowScale: 0.1 })
    this.scroll = new ScrollState()
    this.tiles = []
    this.geometry = new THREE.PlaneGeometry(1, 1)
    this.geometry.translate(0.5, 0.5, 0) // position.xy in [0,1]

    this._loader = new THREE.TextureLoader()
    this._clock = new THREE.Clock()
    this._running = true

    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)
    /* ScreenPaint's pointer() takes uv space (0..1, origin bottom-left) -
     * feeding it raw client pixels puts the brush hundreds of units off the
     * buffer and the ripple never draws. Normalise against the viewport. */
    this._onMove = (e) => this.paint.pointer(
      e.clientX / window.innerWidth,
      1 - e.clientY / window.innerHeight,
    )
    window.addEventListener('pointermove', this._onMove, { passive: true })

    this.resize()
    this.collect()

    /* the scroll-drawn line, if the page marks a section for it */
    const ribbonHost = document.querySelector('[data-ribbon]')
    if (ribbonHost) {
      this.ribbon = new ScrollRibbon(this.scene, ribbonHost)
      this.ribbon.build(window.scrollY, window.innerHeight)
    }

    this._loop = this._loop.bind(this)
    this._frames = 0
    if (typeof window !== 'undefined') window.__tilesDebug = this
    requestAnimationFrame(this._loop)
  }

  collect() {
    for (const el of document.querySelectorAll('[data-media]')) {
      const texture = this._loader.load(el.dataset.media, (t) => {
        t.colorSpace = THREE.SRGBColorSpace
        t.minFilter = THREE.LinearFilter
        t.generateMipmaps = false
        const img = t.image
        const tile = this.tiles.find((x) => x.material.uniforms.u_texture.value === t)
        if (tile && img) tile.textureAspect = img.width / img.height
      })
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
      const tile = new Tile(el, texture, this.paint, this.viewportUniform)
      const mesh = new THREE.Mesh(this.geometry, tile.material)
      mesh.frustumCulled = false
      mesh.renderOrder = 1 // after the ribbon (renderOrder 0)
      tile.mesh = mesh
      this.scene.add(mesh)
      this.tiles.push(tile)
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h)
    this.camera.right = w
    this.camera.bottom = h
    this.camera.updateProjectionMatrix()
    this.viewportUniform.set(w * dpr, h * dpr)
    this.paint.setSize(w, h)
    for (const t of this.tiles) {
      t.material.uniforms.u_paintTexel.value.set(1 / this.paint.width, 1 / this.paint.height)
    }
    this.ribbon?.build(window.scrollY, h)
  }

  _loop() {
    if (!this._running) return
    this._frames++
    const dt = Math.min(this._clock.getDelta(), 1 / 20)

    this.scroll.update(dt)
    this.paint.update(dt)
    this.ribbon?.update(dt, this.scroll.y, window.innerHeight)

    let anyVisible = !!(this.ribbon && this.ribbon.mesh.visible)
    for (const t of this.tiles) {
      const visible = t.update(dt, this.scroll, window.innerHeight)
      t.mesh.visible = visible
      t.material.uniforms.u_paintTexture.value = this.paint.texture
      anyVisible = anyVisible || visible
    }

    if (anyVisible) this.renderer.render(this.scene, this.camera)
    else this.renderer.clear()
    requestAnimationFrame(this._loop)
  }

  dispose() {
    this._running = false
    window.removeEventListener('resize', this._onResize)
    window.removeEventListener('pointermove', this._onMove)
    this.paint.dispose()
    this.ribbon?.dispose()
    this.geometry.dispose()
    this.tiles.forEach((t) => t.material.dispose())
    this.renderer.dispose()
    this.canvas.remove()
  }
}
