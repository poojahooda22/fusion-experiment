import * as THREE from 'three'
import vertexShader from './glsl/tile.vert.glsl'
import fragmentShader from './glsl/tile.frag.glsl'
import reelVert from './glsl/reel.vert.glsl'
import reelFrag from './glsl/reel.frag.glsl'
import { ScreenPaint } from '../oilwater/ScreenPaint.js'
import { ScrollState } from './ScrollState.js'
import { ScrollRibbon } from './ScrollRibbon.js'
import { lenis } from '../scroll/smooth.js'

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
 *
 * ONE exception to "no triggers": the reel's morph zone SNAPS. The
 * reference never lets its reel rest half-open - a nudge into the
 * zone commits the page (an eased auto-scroll) to whichever end the
 * hand was travelling toward, so the scrub always plays to a clean
 * state. The morph itself stays a pure function of scroll; only the
 * scroll position is chaperoned. See _updateSnap().
 */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)
const expoOut = (e) => (e === 1 ? 1 : 1 - Math.pow(2, -10 * e))

/* Pixel-distortion field step, shared by every media surface: relax all
 * cells toward zero (the heal), then brush the cursor's velocity into the
 * cells within radius, weighted by 1/distance. Source effect's tuning:
 * radius 0.25 of the grid, strength 0.11, relaxation 0.9. */
function brushField(data, g, rectL, rectT, rectW, rectH, m) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] *= 0.9
    data[i + 1] *= 0.9
  }
  if (!m) return
  const mx = (m.x - rectL) / rectW
  const my = (m.y - rectT) / rectH
  if (mx < -0.3 || mx > 1.3 || my < -0.3 || my > 1.3) return
  const gx = mx * g, gy = my * g
  const maxDist = g * 0.25
  const nvx = m.dx / rectW, nvy = m.dy / rectH
  const i0 = Math.max(0, Math.floor(gx - maxDist))
  const i1 = Math.min(g - 1, Math.ceil(gx + maxDist))
  const j0 = Math.max(0, Math.floor(gy - maxDist))
  const j1 = Math.min(g - 1, Math.ceil(gy + maxDist))
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d2 = (i - gx) * (i - gx) + (j - gy) * (j - gy)
      if (d2 < maxDist * maxDist) {
        const power = Math.min(maxDist / Math.sqrt(Math.max(d2, 1)), 10)
        const idx = 4 * (j * g + i)
        data[idx] += 0.11 * 100 * nvx * power
        data[idx + 1] -= 0.11 * 100 * nvy * power
      }
    }
  }
}

/* One distortion field per surface. The physics runs in floats; the GPU
 * copy is a BYTE texture (float DataTextures upload as zeros on this
 * stack - proven by bisect - and bytes are plenty for a chunky effect).
 * Encoding: offset range [-15, +15] mapped to [0, 255], 128 = zero. */
const OFF_RANGE = 15
function makeField(grid) {
  const data = new Float32Array(grid * grid * 4)
  const bytes = new Uint8Array(grid * grid * 4).fill(128)
  const tex = new THREE.DataTexture(bytes, grid, grid, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true
  return { data, bytes, tex, grid }
}

/* float working values -> byte texture, clamped to the encoding range */
function quantizeField(field) {
  const { data, bytes } = field
  for (let i = 0; i < data.length; i += 4) {
    const x = data[i] < -OFF_RANGE ? -OFF_RANGE : data[i] > OFF_RANGE ? OFF_RANGE : data[i]
    const y = data[i + 1] < -OFF_RANGE ? -OFF_RANGE : data[i + 1] > OFF_RANGE ? OFF_RANGE : data[i + 1]
    bytes[i] = (x / OFF_RANGE) * 127 + 128
    bytes[i + 1] = (y / OFF_RANGE) * 127 + 128
  }
  field.tex.needsUpdate = true
}

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
          u_offsetTexture: { value: null },
        },
      })
      this.grid = Number(el.dataset.grid ?? 50)
      this._field = makeField(this.grid)
      this.material.uniforms.u_offsetTexture.value = this._field.tex
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
        u_offsetTexture: { value: null },
      },
    })
    this._bow = new THREE.Vector2()

    /* pixel-distortion field: one offset vector per grid cell. NEAREST
     * filtering is the effect - whole cells shift together, the blocky
     * smear. Brushed and relaxed on the CPU every frame. */
    this.grid = Number(el.dataset.grid ?? 50)
    this._field = makeField(this.grid)
    this.material.uniforms.u_offsetTexture.value = this._field.tex

    el.addEventListener('pointerenter', () => { this.hoverTarget = 1 })
    el.addEventListener('pointerleave', () => { this.hoverTarget = 0 })
  }

  update(dt, scroll, viewportH) {
    this._mouse = scroll.mouse
    if (this.expand) return this._updateReel(viewportH)
    return this._updateGallery(dt, scroll, viewportH)
  }

  /* ---- the showreel: one linear scroll scrub, per-vertex unfurl ------ */
  _updateReel(viewportH) {
    const u = this.material.uniforms
    const from = this.anchorEl.getBoundingClientRect() // small card
    const own = this.el.getBoundingClientRect()        // full slot
    const stage = this.stageEl.getBoundingClientRect() // scroll runway

    /* ~0.6 viewport of scroll = fully grown. The scrub stays a pure
     * function of position; MediaTiles' snap (see _updateSnap) walks
     * the position itself to an end state, so this always completes. */
    const sr = clamp((viewportH - stage.top) / (viewportH * 0.62), 0, 1)

    /* the plus-sign frame appears IN PLACE - a plain fade, one second
     * after the sheet reaches full width. No travel, no spin: the
     * crosses were always there, the light just comes up on them.
     * Wall-clock, so a throttled tab cannot stretch the delay. */
    if (sr >= 0.995) {
      this._fullT ??= performance.now()
      if (!this._crossesIn && performance.now() - this._fullT > 1000) {
        this._crossesIn = true
        this.stageEl.classList.add('crosses-in')
      }
    } else if (sr < 0.9) {
      this._fullT = undefined
      if (this._crossesIn) {
        this._crossesIn = false
        this.stageEl.classList.remove('crosses-in')
      }
    }

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

    /* pixel distortion rides the sheet: brush against its current rect
     * (the from->to lerp is a fair stand-in for the unfurling shape) */
    const rl = from.left + (L - from.left) * sr
    const rt = from.top + (toTop - from.top) * sr
    const rw = from.width + (W - from.width) * sr
    const rh = from.height + (H - from.height) * sr
    brushField(this._field.data, this.grid, rl, rt, rw, rh, this._mouse)
    quantizeField(this._field)

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

    /* pixel distortion: relax + brush against this tile's rect */
    brushField(this._field.data, this.grid, own.left, T, W, H, scroll.mouse)
    quantizeField(this._field)

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
    /* cursor position + per-event velocity, for the tiles' distortion
     * brush. Exposed through the scroll object every tile already gets. */
    this.mouse = { x: -1e4, y: -1e4, dx: 0, dy: 0 }
    this.scroll.mouse = this.mouse
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
    this._onMove = (e) => {
      this.paint.pointer(
        e.clientX / window.innerWidth,
        1 - e.clientY / window.innerHeight,
      )
      if (this.mouse.x > -1e3) {
        this.mouse.dx = e.clientX - this.mouse.x
        this.mouse.dy = e.clientY - this.mouse.y
      }
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
    }
    window.addEventListener('pointermove', this._onMove, { passive: true })

    this.resize()
    this.collect()

    /* the scroll-drawn line, if the page marks a section for it */
    const ribbonHost = document.querySelector('[data-ribbon]')
    if (ribbonHost) {
      this.ribbon = new ScrollRibbon(this.scene, ribbonHost)
      this.ribbon.build(window.scrollY, window.innerHeight)
    }

    /* reel snap state: no auto-scroll for reduced-motion hands */
    this._snapTarget = null
    this._reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    this._loop = this._loop.bind(this)
    this._frames = 0
    if (typeof window !== 'undefined') window.__tilesDebug = this
    requestAnimationFrame(this._loop)
  }

  /* ---- the reel's chaperone -------------------------------------------
   * The reference commits: inside the morph zone the page auto-scrolls
   * (~1s ease) to full-and-centred when travelling down, back to the
   * statement when travelling up, and to the nearest end from a dead
   * stop. The user's hand always wins - wheeling against a snap in
   * flight releases it. Everything is measured fresh each frame, so
   * resizes and relayouts can't strand a stale target. */
  _updateSnap() {
    if (this._reduced || !lenis) return
    const t = (this._reelTile ??= this.tiles.find((x) => x.expand))
    if (!t || !t.stageEl) return

    const vh = window.innerHeight
    const top = t.stageEl.getBoundingClientRect().top
    const pz = (vh - top) / vh
    if (pz <= 0.02 || pz >= 0.98) { this._snapTarget = null; return }

    const y = window.scrollY
    const yExpanded = Math.round(y + top) // stage top pinned to viewport top
    const yCollapsed = yExpanded - vh     // stage a full viewport away
    const v = this.scroll.velocity        // smoothed px/s, + is down

    /* a hitched frame (shader compile, tab wake) can pair a stale
     * scrollY with a fresh rect and cook a nonsense velocity or end
     * point - sit that frame out rather than commit to garbage */
    if (Math.abs(v) > 6000) return

    if (this._snapTarget != null) {
      const toward = Math.sign(this._snapTarget - y) || 1
      const wanted = this._snapTarget - y > 0 ? yExpanded : yCollapsed
      if (Math.abs(wanted - this._snapTarget) > 40) this._snapTarget = null // aim drifted: re-fire
      else if (v * toward < -80) this._snapTarget = null       // hand fights: let go
      else if (Math.abs(v) < 15 && Math.abs(this._snapTarget - y) > 8) {
        this._snapTarget = null                                // stalled: re-arm below
      } else return
    }

    let target = null
    if (v > 60) target = yExpanded                             // travelling down: commit full
    else if (v < -60) target = yCollapsed                      // travelling up: commit closed
    else if (Math.abs(v) < 30) target = pz > 0.5 ? yExpanded : yCollapsed // idle: nearest
    if (target == null || Math.abs(target - y) < 4) return

    this._snapTarget = target
    lenis.scrollTo(target, {
      duration: 1.05,
      easing: (x) => 1 - Math.pow(1 - x, 3),
      onComplete: () => { this._snapTarget = null },
    })
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
    this.mouse.dx *= 0.9
    this.mouse.dy *= 0.9
    this._updateSnap()
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
    this.tiles.forEach((t) => { t._field?.tex.dispose(); t.material.dispose() })
    this.renderer.dispose()
    this.canvas.remove()
  }
}
