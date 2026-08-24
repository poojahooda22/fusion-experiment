import * as THREE from 'three'
import vertexShader from './glsl/tile.vert.glsl'
import fragmentShader from './glsl/tile.frag.glsl'
import reelVert from './glsl/reel.vert.glsl'
import reelFrag from './glsl/reel.frag.glsl'
import { ScreenPaint } from '../oilwater/ScreenPaint.js'
import { ScrollState } from './ScrollState.js'
import { ScrollRibbon } from './ScrollRibbon.js'

/**
 * The DOM-synced media overlay.
 *
 * Every visual is a WebGL quad drawn on a fixed full-page canvas,
 * positioned each frame at the rect of an (empty) DOM placeholder. Text
 * stays real DOM above the canvas.
 *
 * ONE principle drives all the motion: each animation is a direct, eased
 * function of the scroll position. No triggers, no timers chasing state,
 * no springs between the scrollbar and the pixels - scrub back and every
 * animation runs exactly backwards; stop and it holds. The page-level
 * smooth scroll supplies the glide, so a wheel flick still eases the
 * animations to rest after the hand stops.
 *
 *   - the REEL sheet unfurls between two rects with a PER-VERTEX reveal
 *     ratio (reel.vert.glsl) - the flex is in the shader, the drive is
 *     one scroll-scrubbed number
 *   - GALLERY tiles are glued to their DOM rects (so captions never
 *     separate), slide+rotate in from alternating sides on entry, bow
 *     their interior against scroll velocity, and ripple with it
 */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)
const expoOut = (e) => (e === 1 ? 1 : 1 - Math.pow(2, -10 * e))

class Tile {
  constructor(el, texture, paint, viewportUniform, index) {
    this.el = el
    this.index = index
    this.showTarget = 0
    this.showDelay = Number(el.dataset.delay ?? 0)
    this.hoverRatio = 0
    this.hoverTarget = 0
    this.textureAspect = 1
    this.expand = el.dataset.expand === '1'

    const common = {
      u_texture: { value: texture },
      u_paintTexture: { value: paint.texture },
      u_paintTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      u_paintPush: { value: 25 },
      u_viewport: { value: viewportUniform },
      u_uvScale: { value: new THREE.Vector2(1, 1) },
      u_uvOffset: { value: new THREE.Vector2(0, 0) },
      u_cornerRadius: { value: Number(el.dataset.radius ?? 15) },
    }

    if (this.expand) {
      /* the showreel: per-vertex unfurl between two rects */
      this.anchorEl = document.querySelector('[data-expand-anchor]')
      this.stageEl = el.closest('.reel-stage')
      this.material = new THREE.ShaderMaterial({
        vertexShader: reelVert,
        fragmentShader: reelFrag,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        /* the y-down pixel camera mirrors the projection and flips every
         * triangle's winding - DoubleSide, or nothing renders */
        side: THREE.DoubleSide,
        uniforms: {
          ...common,
          u_showRatio: { value: 0 },
          u_fromTL: { value: new THREE.Vector2() },
          u_fromTR: { value: new THREE.Vector2() },
          u_fromBL: { value: new THREE.Vector2() },
          u_fromBR: { value: new THREE.Vector2() },
          u_toTL: { value: new THREE.Vector2() },
          u_toTR: { value: new THREE.Vector2() },
          u_toBL: { value: new THREE.Vector2() },
          u_toBR: { value: new THREE.Vector2() },
        },
      })
      return
    }

    const hasTint = el.dataset.tint !== undefined
    const tint = new THREE.Color(el.dataset.tint ?? '#ffffff')
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        ...common,
        u_tint: { value: new THREE.Vector3(tint.r, tint.g, tint.b) },
        u_hasTint: { value: hasTint ? 1 : 0 },
        u_showRatio: { value: 0 },
        u_hoverRatio: { value: 0 },
        u_rippleStrength: { value: 0 },
        u_cTL: { value: new THREE.Vector2() },
        u_cTR: { value: new THREE.Vector2() },
        u_cBL: { value: new THREE.Vector2() },
        u_cBR: { value: new THREE.Vector2() },
        u_domWH: { value: new THREE.Vector2(1, 1) },
        u_bow: { value: new THREE.Vector2() },
      },
    })
    this._bow = new THREE.Vector2()

    el.addEventListener('pointerenter', () => { this.hoverTarget = 1 })
    el.addEventListener('pointerleave', () => { this.hoverTarget = 0 })
  }

  update(dt, scroll, viewportH) {
    if (this.expand) return this._updateReel(viewportH)
    return this._updateGallery(dt, scroll, viewportH)
  }

  /* ---- the showreel: one linear scroll scrub, per-vertex unfurl ------ */
  _updateReel(viewportH) {
    const u = this.material.uniforms
    const from = this.anchorEl.getBoundingClientRect() // small card
    const own = this.el.getBoundingClientRect()        // full slot
    const stage = this.stageEl.getBoundingClientRect() // scroll runway

    /* ~0.6 viewport of scroll = fully grown. No trigger, no snap: the
     * page-level smooth scroll eases this after the wheel stops, and
     * scrubbing back un-morphs it symmetrically. */
    const sr = clamp((viewportH - stage.top) / (viewportH * 0.62), 0, 1)

    /* big endpoint: vertically centred while approaching, riding up with
     * the layout once the slot's own top passes centre */
    const centred = (viewportH - own.height) / 2
    const toTop = own.top < centred ? own.top : centred
    const L = own.left, W = own.width, H = own.height

    u.u_fromTL.value.set(from.left, from.top)
    u.u_fromTR.value.set(from.left + from.width, from.top)
    u.u_fromBL.value.set(from.left, from.top + from.height)
    u.u_fromBR.value.set(from.left + from.width, from.top + from.height)
    u.u_toTL.value.set(L, toTop)
    u.u_toTR.value.set(L + W, toTop)
    u.u_toBL.value.set(L, toTop + H)
    u.u_toBR.value.set(L + W, toTop + H)
    u.u_showRatio.value = sr

    /* cover-fit against the FINAL rect aspect (what it settles to) */
    const rectAspect = W / Math.max(H, 1)
    const s = rectAspect / this.textureAspect
    if (s < 1) { u.u_uvScale.value.set(s, 1); u.u_uvOffset.value.set((1 - s) / 2, 0) }
    else { u.u_uvScale.value.set(1, 1 / s); u.u_uvOffset.value.set(0, (1 - 1 / s) / 2) }

    /* the statement copy + button fade beneath the growing sheet */
    this._sectionEl ??= this.stageEl.closest('section')
    const active = sr > 0.3
    if (active !== this._reelActive) {
      this._reelActive = active
      this._sectionEl?.classList.toggle('reel-active', active)
    }

    const top = Math.min(from.top, toTop)
    const bottom = Math.max(from.top + from.height, toTop + H)
    return bottom > -160 && top < viewportH + 160
  }

  /* ---- gallery tiles: glued rect, staggered entry, bow + ripple ------ */
  _updateGallery(dt, scroll, viewportH) {
    const own = this.el.getBoundingClientRect()
    const u = this.material.uniforms
    const vw = window.innerWidth

    let L = own.left
    const T = own.top, W = own.width, H = own.height

    /* reveal trigger: >=22% of the rect inside the viewport */
    if (this.showTarget === 0) {
      const ix = Math.max(0, Math.min(L + W, vw) - Math.max(L, 0))
      const iy = Math.max(0, Math.min(T + H, viewportH) - Math.max(T, 0))
      if (W * H > 0 && (ix * iy) / (W * H) >= 0.22) this.showTarget = 1
    }

    /* per-tile wall-clock reveal (NOT accumulated dt: dt is clamped for
     * simulation stability and would stretch on slow machines) */
    let b = 0, C = 0
    if (this.showTarget > 0) {
      const now = performance.now() / 1000
      if (this._showT0 === undefined) this._showT0 = now + this.showDelay
      b = expoOut(clamp((now - this._showT0) / 0.9, 0, 1))  // mask opens
      C = expoOut(clamp((now - this._showT0) / 1.2, 0, 1))  // settle
    }

    /* staggered slide-in + rotate, alternating by column */
    const side = (this.index % 2) - 0.5
    L += (1 - C) * side * -vw * 0.1
    const rot = (1 - C) * side * 0.1
    const cx = L + W / 2, cy = T + H / 2
    const cs = Math.cos(rot), sn = Math.sin(rot)
    const rc = (x, y, out) => {
      const dx = x - cx, dy = y - cy
      out.set(cx + dx * cs - dy * sn, cy + dx * sn + dy * cs)
    }
    rc(L, T, u.u_cTL.value)
    rc(L + W, T, u.u_cTR.value)
    rc(L, T + H, u.u_cBL.value)
    rc(L + W, T + H, u.u_cBR.value)
    u.u_domWH.value.set(W, H)
    u.u_showRatio.value = b

    /* interior bow against the rect's own velocity: the sheet's middle
     * trails its corners while the page moves */
    if (this._prevT === undefined) this._prevT = T
    const velY = (T - this._prevT) / Math.max(dt, 1e-4)
    this._prevT = T
    const bowY = THREE.MathUtils.clamp(velY * -0.012, -34, 34)
    this._bow.y += (bowY - this._bow.y) * (1 - Math.pow(0.002, dt))
    u.u_bow.value.copy(this._bow)

    /* scroll-velocity ripple */
    u.u_rippleStrength.value = Math.min(0.15, (scroll.strength || 0) * 0.5)

    /* hover ease, ~200 ms both ways */
    const k = 1 - Math.pow(0.0001, dt)
    this.hoverRatio += (this.hoverTarget - this.hoverRatio) * k
    u.u_hoverRatio.value = this.hoverRatio

    /* cover fit */
    const rectAspect = W / Math.max(H, 1)
    const s = rectAspect / this.textureAspect
    if (s < 1) { u.u_uvScale.value.set(s, 1); u.u_uvOffset.value.set((1 - s) / 2, 0) }
    else { u.u_uvScale.value.set(1, 1 / s); u.u_uvOffset.value.set(0, (1 - 1 / s) / 2) }

    return T + H > -160 && T < viewportH + 160
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
    /* SUBDIVIDED plane: the unfurl and the bow are interior/per-vertex
     * deformations - a 1x1-segment quad renders them as nothing */
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
    let i = 0
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
      const tile = new Tile(el, texture, this.paint, this.viewportUniform, i++)
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
