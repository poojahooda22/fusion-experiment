import * as THREE from 'three'
import vertexShader from './glsl/quad.vert.glsl'

const _tmpColor = new THREE.Color()
import fragmentShader from './glsl/paint.frag.glsl'

/**
 * Owns the two-scale paint simulation.
 *
 * Two ping-ponged buffers run the same shader at different resolutions:
 *
 *   low   ~1/8 screen  - cheap, diffuses fast, carries the broad swirl
 *   main  ~1/2 screen  - the buffer everything else samples, and it reads the
 *                        coarse one so the fine detail rides on top of a large
 *                        coherent motion instead of dissolving on the spot
 *
 * That two-level trick is why the reference trail keeps moving as one body of
 * liquid rather than breaking into per-pixel noise the moment you stop.
 */
export class ScreenPaint {
  constructor(renderer, options = {}) {
    const {
      scale = 0.5,
      lowScale = 0.11,
      dissipations = [0.94, 0.9, 0.975],
      pushStrength = 1.35,
      radius = 0.075,
      strength = 0.55,
      curlScale = 3.2,
      curlStrength = 2.4,
      advect = 1.0,
      lowInfluence = 2.2,
    } = options

    this.renderer = renderer
    this.scale = scale
    this.lowScale = lowScale

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.scene = new THREE.Scene()

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      defines: { USE_NOISE: '' },
      depthTest: false,
      depthWrite: false,
      uniforms: {
        u_prevPaintTexture: { value: null },
        u_lowPaintTexture: { value: null },
        u_texelSize: { value: new THREE.Vector2() },
        u_aspect: { value: new THREE.Vector2(1, 1) },
        u_scrollOffset: { value: new THREE.Vector2() },
        u_delta: { value: 1 / 60 },
        u_time: { value: 0 },
        u_drawFrom: { value: new THREE.Vector4(0, 0, radius, 0) },
        u_drawTo: { value: new THREE.Vector4(0, 0, radius, 0) },
        u_pushStrength: { value: pushStrength },
        u_dissipations: { value: new THREE.Vector3(...dissipations) },
        u_vel: { value: new THREE.Vector2() },
        u_advect: { value: advect },
        u_lowInfluence: { value: lowInfluence },
        u_curlScale: { value: curlScale },
        u_curlStrength: { value: curlStrength },
      },
    })

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    this.radius = radius
    this.strength = strength

    this.main = [this._makeTarget(), this._makeTarget()]
    this.low = [this._makeTarget(), this._makeTarget()]
    this.index = 0

    // pointer state, in uv space
    this._prev = new THREE.Vector2(0.5, 0.5)
    this._curr = new THREE.Vector2(0.5, 0.5)
    this._pending = false
    this._hasPrev = false
    this._time = 0
  }

  _makeTarget() {
    const rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    })
    rt.texture.colorSpace = THREE.NoColorSpace
    return rt
  }

  setSize(width, height) {
    const w = Math.max(4, Math.floor(width * this.scale))
    const h = Math.max(4, Math.floor(height * this.scale))
    const lw = Math.max(4, Math.floor(width * this.lowScale))
    const lh = Math.max(4, Math.floor(height * this.lowScale))
    this.main.forEach((rt) => rt.setSize(w, h))
    this.low.forEach((rt) => rt.setSize(lw, lh))
    this.material.uniforms.u_texelSize.value.set(1 / w, 1 / h)
    this._cleared = false
    this.material.uniforms.u_aspect.value.set(width / height, 1)
    this.width = w
    this.height = h
  }

  /** Feed a pointer position in uv space (0..1, origin bottom-left). */
  pointer(x, y) {
    this._curr.set(x, y)
    if (!this._hasPrev) {
      this._prev.copy(this._curr)
      this._hasPrev = true
    }
    this._pending = true
  }

  get texture() {
    return this.main[this.index].texture
  }

  get lowTexture() {
    return this.low[this.index].texture
  }

  update(delta, scrollOffset) {
    const dt = Math.min(Math.max(delta, 1 / 240), 1 / 20)
    this._time += dt

    const u = this.material.uniforms
    u.u_delta.value = dt
    u.u_time.value = this._time
    if (scrollOffset) u.u_scrollOffset.value.copy(scrollOffset)

    // the stroke is a segment from where the pointer was to where it is now,
    // so a fast flick still leaves an unbroken ribbon
    if (this._pending) {
      u.u_drawFrom.value.set(this._prev.x, this._prev.y, this.radius, this.strength)
      u.u_drawTo.value.set(this._curr.x, this._curr.y, this.radius, this.strength)
      this._prev.copy(this._curr)
      this._pending = false
    } else {
      u.u_drawTo.value.w = 0
      u.u_drawFrom.value.w = 0
    }

    const next = this.index ^ 1
    const renderer = this.renderer
    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    renderer.autoClear = false

    // freshly allocated render targets contain garbage; zero them once
    if (!this._cleared) {
      const clearColor = renderer.getClearColor(_tmpColor).clone()
      const clearAlpha = renderer.getClearAlpha()
      renderer.setClearColor(0x000000, 0)
      for (const rt of [...this.main, ...this.low]) {
        renderer.setRenderTarget(rt)
        renderer.clear(true, false, false)
      }
      renderer.setClearColor(clearColor, clearAlpha)
      this._cleared = true
    }

    // --- coarse pass: no low input of its own, larger swirl ---------------
    u.u_prevPaintTexture.value = this.low[this.index].texture
    u.u_lowPaintTexture.value = this.low[this.index].texture
    u.u_lowInfluence.value = 0
    u.u_curlStrength.value = this._curlLow ?? 1.2
    renderer.setRenderTarget(this.low[next])
    renderer.render(this.scene, this.camera)

    // --- fine pass: reads the coarse result --------------------------------
    u.u_prevPaintTexture.value = this.main[this.index].texture
    u.u_lowPaintTexture.value = this.low[next].texture
    u.u_lowInfluence.value = this._lowInfluence ?? 2.2
    u.u_curlStrength.value = this._curlMain ?? 2.4
    renderer.setRenderTarget(this.main[next])
    renderer.render(this.scene, this.camera)

    renderer.setRenderTarget(previousTarget)
    renderer.autoClear = previousAutoClear
    this.index = next
  }

  configure({ curlLow, curlMain, lowInfluence, radius, strength, pushStrength, dissipations }) {
    if (curlLow !== undefined) this._curlLow = curlLow
    if (curlMain !== undefined) this._curlMain = curlMain
    if (lowInfluence !== undefined) this._lowInfluence = lowInfluence
    if (radius !== undefined) this.radius = radius
    if (strength !== undefined) this.strength = strength
    if (pushStrength !== undefined) this.material.uniforms.u_pushStrength.value = pushStrength
    if (dissipations !== undefined) this.material.uniforms.u_dissipations.value.set(...dissipations)
  }

  dispose() {
    this.main.forEach((rt) => rt.dispose())
    this.low.forEach((rt) => rt.dispose())
    this.quad.geometry.dispose()
    this.material.dispose()
  }
}
