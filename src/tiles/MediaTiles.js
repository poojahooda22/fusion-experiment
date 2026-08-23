import * as THREE from 'three'
import vertexShader from './glsl/tile.vert.glsl'
import fragmentShader from './glsl/tile.frag.glsl'
import { ScreenPaint } from '../oilwater/ScreenPaint.js'
import { ScrollState } from './ScrollState.js'
import { ScrollRibbon } from './ScrollRibbon.js'
import { lenis } from '../scroll/smooth.js'

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
 *   fixed <canvas> (pointer-events: none)  ->  one SOFT SHEET per slot
 *
 * Soft sheet: the rect is GLUED to the DOM - the reference's media never
 * lags its caption, so any positional spring here makes text and image
 * visibly separate while scrolling. All the flexibility lives in the
 * INTERIOR: the sheet's middle bows against the rect's own velocity
 * (u_bow, zero at every corner), so it reads as cloth pinned at the
 * corners, never as a screenshot sliding against its label.
 */

const EASE = (t) => 1 - Math.pow(1 - t, 3) // cubic out

class Tile {
  constructor(el, texture, paint, viewportUniform) {
    this.el = el
    this.showRatio = 0
    this.showTarget = 0
    this.showDelay = Number(el.dataset.delay ?? 0)
    this.hoverRatio = 0
    this.hoverTarget = 0
    this.textureAspect = 1

    const hasTint = el.dataset.tint !== undefined
    const tint = new THREE.Color(el.dataset.tint ?? '#ffffff')

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
        u_hasTint: { value: hasTint ? 1 : 0 },
        u_cornerRadius: { value: Number(el.dataset.radius ?? 15) },
        u_showRatio: { value: 0 },
        u_hoverRatio: { value: 0 },
        u_cTL: { value: new THREE.Vector2() },
        u_cTR: { value: new THREE.Vector2() },
        u_cBL: { value: new THREE.Vector2() },
        u_cBR: { value: new THREE.Vector2() },
        u_domWH: { value: new THREE.Vector2(1, 1) },
        u_bow: { value: new THREE.Vector2() },
        u_expandRatio: { value: 0 },
        u_expandCurl: { value: new THREE.Vector2() },
        u_expandS: { value: 0 },
        u_expandTilt: { value: 0 },
      },
    })

    this._bow = new THREE.Vector2()

    /* Expanding showreel: this tile morphs between TWO dom rects - the
     * small anchor box in the text row and its own full-width slot inside
     * the sticky stage - driven by how far the stage has been scrolled. */
    this.expand = el.dataset.expand === '1'
    if (this.expand) {
      this.anchorEl = document.querySelector('[data-expand-anchor]')
      this.stageEl = el.closest('.reel-stage')
      this._pe = 0
      this._peVel = 0
      this._peAuto = 0
      this._peS = 0
      this._upT = 0
      this._quietT = 0
    }

    el.addEventListener('pointerenter', () => { this.hoverTarget = 1 })
    el.addEventListener('pointerleave', () => { this.hoverTarget = 0 })
  }

  update(dt, scroll, viewportH) {
    const own = this.el.getBoundingClientRect()
    const u = this.material.uniforms

    /* ---- target rect ----------------------------------------------- *
     * Gallery tiles: the DOM rect plus a small parallax drift.
     * The showreel: the per-component lerp of the anchor rect and the
     * full slot, scrubbed by how far the sticky stage has consumed its
     * runway - both endpoints are LIVE rects, so resize keeps working. */
    let L = own.left, T = own.top, W = own.width, H = own.height
    if (this.expand && this.anchorEl && this.stageEl) {
      const stage = this.stageEl.getBoundingClientRect()
      /* The reference's expansion is TRIGGERED, not scrubbed: one scroll
       * into the stage starts it, and it completes to full width ON ITS
       * OWN (~0.7s) even if the scroll pauses. A scroll-locked floor
       * stays underneath so blasting straight through can never leave
       * the sheet half-grown. */
      const scrub = Math.min(Math.max((viewportH - stage.top) / (viewportH * 0.62), 0), 1)
      /* Bistable by design: below the trigger the sheet is a card, above
       * it the sheet is HEADED to full-width - no scroll position leaves
       * it paused half-grown. Every part of this is DIRECTIONAL: going
       * down, an easy trigger, a scroll-mapped floor (so blasting
       * through can't outrun the completion) and the quiet-snap. Going
       * UP, none of those may hold the sheet open or drag the page back
       * to the pin - the sheet lets go early and shrinks home within
       * the first upward flick. */
      /* Direction latch with real hysteresis. Mice and trackpads emit
       * micro-reversals while decelerating - a single frame of small
       * negative velocity must NOT read as "the user is leaving": that
       * collapsed the half-grown sheet and re-grew it (the bounce, and
       * the snap-back-to-card bug). Leaving = sustained, deliberate
       * upward velocity. */
      const vDir = lenis?.velocity ?? 0
      this._upT = vDir < -80 ? (this._upT ?? 0) + dt : 0
      if (this._upT > 0.08) this._dirUp = true
      else if (vDir > 30) this._dirUp = false
      const trig = scrub > (this._dirUp ? 0.8 : 0.25) ? 1 : 0
      const k = 1 - Math.pow(0.02, dt)
      this._peAuto += (trig - this._peAuto) * k
      const fs = this._dirUp ? 0 : Math.max(0, (scrub - 0.25) / 0.75)
      /* pe is the max of two racing easings (the auto clock and the
       * scroll floor); every leadership handoff kinks its slope, and a
       * kink in pe is a visible hitch in the grow. One low-pass turns
       * the pieces into a single continuous curve - it cannot overshoot,
       * only round off. */
      const peRaw = Math.max(this._peAuto, fs * fs * (3 - 2 * fs))
      this._peS += (peRaw - this._peS) * (1 - Math.pow(0.002, dt))
      const pe = this._peS

      /* The BIG endpoint: full-slot size, VERTICALLY CENTRED in the
       * viewport - clamped below the statement copy while any of it is
       * still on screen. So the sheet can never cover the paragraph,
       * sits "just below" while text remains, and is dead centre the
       * moment the text has scrolled away - no matter where the page
       * paused. (Lerping to the raw slot instead left the sheet parked
       * ~300px low whenever the scroll rested between trigger and pin.)
       * Once the stage releases, the real slot rises past centre and
       * takes over, so the sheet scrolls away naturally.
       *
       * The page still finishes the arrival itself: past the trigger,
       * once the wheel goes QUIET for a beat, one glide carries the
       * scroll to the pin - it must wait for quiet, because Lenis
       * cancels programmatic glides on any user input. */
      if (trig === 1 && stage.top > 2 && !this._dirUp) {
        /* "quiet" must tolerate the long tail of the wheel glide, or the
         * snap waits seconds before engaging */
        const v = Math.abs(lenis?.velocity ?? 0)
        this._quietT = v < 25 ? (this._quietT ?? 0) + dt : 0
        if (v > 40) this._snapLatch = false // user actively moving: re-arm
        if (this._quietT > 0.15 && !this._snapLatch) {
          this._snapLatch = true
          lenis?.scrollTo(stage.top + window.scrollY, { duration: 0.9 })
        }
      } else {
        this._quietT = 0
        this._snapLatch = false
      }

      /* One straight trajectory to the CENTRE - no below-the-copy detour
       * (down-then-up read as a bounce). The paragraph and button yield
       * instead: the reel-active class fades them under the approaching
       * sheet, so the image always reads as the top layer. */
      const centred = (viewportH - own.height) / 2
      let bigTop = centred
      if (own.top < centred) bigTop = own.top // stage released: ride up

      /* The morph's ORIGIN is frozen the moment it starts. Lerping from
       * the live anchor rect - which keeps scrolling up while pe is
       * still finishing - leaves a (1-pe) * anchor residue that drags
       * the sheet past centre and back: a dip-and-return bounce built
       * into the math. A fixed origin makes the path strictly monotonic
       * in pe. While collapsing (leaving), the origin eases back onto
       * the live card so the sheet lands exactly home. */
      const aLive = this.anchorEl.getBoundingClientRect()
      if (pe < 0.02 || !this._from) {
        this._from = { left: aLive.left, top: aLive.top, width: aLive.width, height: aLive.height }
      } else if (trig === 0) {
        const kf = 1 - Math.pow(0.001, dt)
        this._from.left += (aLive.left - this._from.left) * kf
        this._from.top += (aLive.top - this._from.top) * kf
        this._from.width += (aLive.width - this._from.width) * kf
        this._from.height += (aLive.height - this._from.height) * kf
      }

      L = this._from.left + (own.left - this._from.left) * pe
      T = this._from.top + (bigTop - this._from.top) * pe
      W = this._from.width + (own.width - this._from.width) * pe
      H = this._from.height + (own.height - this._from.height) * pe

      /* billow with the morph's own velocity; the springs add the shear */
      const vel = (pe - this._pe) / Math.max(dt, 1e-4)
      this._peVel += (vel - this._peVel) * (1 - Math.pow(0.001, dt))
      this._pe = pe
      /* soft billow only - the auto-completed morph moves FAST, and at
       * the previous gains its velocity kicked a visible bounce. The
       * reference's sheet is carried smoothly; it never springs. */
      const pulse = pe * (1 - pe)
      const curlY = THREE.MathUtils.clamp(this._peVel * 0.035, -0.04, 0.04)
        + pulse * 0.05 + pe * 0.015
      const curlX = THREE.MathUtils.clamp(this._peVel * -0.012, -0.015, 0.015)
        + pulse * 0.02
      const sBend = THREE.MathUtils.clamp(this._peVel * 0.02, -0.02, 0.02)
        + pulse * 0.015
      const tilt = THREE.MathUtils.clamp(-this._peVel * 0.018, -0.02, 0.02)
        + pulse * 0.018
      u.u_expandCurl.value.set(curlY, curlX)
      u.u_expandS.value = sBend
      u.u_expandTilt.value = tilt
      u.u_expandRatio.value = pe

      /* the statement copy + button fade beneath the growing sheet */
      this._sectionEl ??= this.stageEl.closest('section')
      const active = pe > 0.3
      if (active !== this._reelActive) {
        this._reelActive = active
        this._sectionEl?.classList.toggle('reel-active', active)
      }
    } else {
      const mid = T + H * 0.5 - viewportH * 0.5
      T += mid * -0.02 // parallax folded into the target; springs smooth it
    }

    /* ---- corners glued to the layout -------------------------------- *
     * The rect follows the DOM exactly; captions and images never
     * separate. Only the interior deforms.                             */
    u.u_cTL.value.set(L, T)
    u.u_cTR.value.set(L + W, T)
    u.u_cBL.value.set(L, T + H)
    u.u_cBR.value.set(L + W, T + H)
    u.u_domWH.value.set(W, H)

    /* interior bow against the rect's own velocity (scroll or morph):
     * content moving up leaves the sheet's middle trailing downward */
    if (this._prevT === undefined) { this._prevT = T; this._prevL = L }
    const velY = (T - this._prevT) / Math.max(dt, 1e-4)
    const velX = (L - this._prevL) / Math.max(dt, 1e-4)
    this._prevT = T; this._prevL = L
    const bowY = THREE.MathUtils.clamp(velY * -0.012, -34, 34)
    const bowX = THREE.MathUtils.clamp(velX * -0.012, -24, 24)
    this._bow.x += (bowX - this._bow.x) * (1 - Math.pow(0.002, dt))
    this._bow.y += (bowY - this._bow.y) * (1 - Math.pow(0.002, dt))
    u.u_bow.value.copy(this._bow)

    /* Reveal trigger: >=22% of the target rect inside the viewport. */
    if (this.showTarget === 0) {
      const vw = window.innerWidth
      const ix = Math.max(0, Math.min(L + W, vw) - Math.max(L, 0))
      const iy = Math.max(0, Math.min(T + H, viewportH) - Math.max(T, 0))
      if (W * H > 0 && (ix * iy) / (W * H) >= 0.22) this.showTarget = 1
    }

    /* reveal clock - wall time, NOT accumulated dt: dt is clamped for the
     * simulation's stability, and on a slow machine accumulating clamped
     * steps would stretch the fade into tens of seconds */
    if (this.showTarget > 0 && this.showRatio < 1) {
      const now = performance.now() / 1000
      if (this._showT0 === undefined) this._showT0 = now + this.showDelay
      const t = Math.min(Math.max((now - this._showT0) / 0.7, 0), 1)
      this.showRatio = EASE(t)
    }
    u.u_showRatio.value = this.showRatio

    /* hover ease, ~200 ms both ways */
    const k = 1 - Math.pow(0.0001, dt)
    this.hoverRatio += (this.hoverTarget - this.hoverRatio) * k
    u.u_hoverRatio.value = this.hoverRatio

    /* cover fit */
    const rectAspect = W / Math.max(H, 1)
    const s = rectAspect / this.textureAspect
    if (s < 1) u.u_uvScale.value.set(s, 1), u.u_uvOffset.value.set((1 - s) / 2, 0)
    else u.u_uvScale.value.set(1, 1 / s), u.u_uvOffset.value.set(0, (1 - 1 / s) / 2)

    return T + H > -160 && T < viewportH + 160 // visible? (bow stays small)
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
    /* SUBDIVIDED plane: the bows and curls are interior deformations -
     * they are zero on every edge, so a 1x1-segment quad renders them as
     * nothing at all. 48x32 keeps the big showreel sheet smooth. */
    this.geometry = new THREE.PlaneGeometry(1, 1, 48, 32)
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

    let anyVisible = false
    for (const t of this.tiles) {
      const visible = t.update(dt, this.scroll, window.innerHeight)
      t.mesh.visible = visible
      t.material.uniforms.u_paintTexture.value = this.paint.texture
      anyVisible = anyVisible || visible
    }

    /* the ribbon erases in sync with the showreel's own expansion, so it
     * always vanishes as the sheet takes the stage - however the user
     * scrolls. Updated after the tiles so it reads this frame's pe. */
    const reelPe = this.tiles.find((t) => t.expand)?._pe ?? 0
    this.ribbon?.update(dt, this.scroll.y, window.innerHeight, reelPe)
    anyVisible = anyVisible || !!(this.ribbon && this.ribbon.mesh.visible)

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
