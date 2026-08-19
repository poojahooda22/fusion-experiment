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
        u_diffuse: { value: 0 },
        u_diffuseRadius: { value: 1.6 },
      },
    })

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    this.radius = radius
    this.strength = strength

    /* Per-pass character. The coarse buffer is not a downsampled copy of the
     * fine one - it is a genuinely different field: a much wider brush, much
     * slower decay, a much larger noise cell and heavier diffusion. That is
     * what makes it behave as one large body of liquid that the fine buffer
     * then rides on. */
    this.mainPass = {
      radius,
      dissipations: options.dissipations ?? dissipations,
      curlScale,
      curlStrength: options.curlMain ?? curlStrength,
      diffuse: options.diffuse ?? 0.22,
      diffuseRadius: 1.6,
      lowInfluence,
    }
    this.lowPass = {
      radiusScale: options.lowRadiusScale ?? 2.4,
      dissipations: options.lowDissipations ?? [0.996, 0.9955, 0.9988],
      curlScaleScale: 0.45,
      curlStrength: options.curlLow ?? 0.55,
      diffuse: options.lowDiffuse ?? 0.5,
      diffuseRadius: 2.0,
      lowInfluence: 0,
    }

    this.main = [this._makeTarget(), this._makeTarget()]
    this.low = [this._makeTarget(), this._makeTarget()]
    this.index = 0

    // pointer state, in uv space
    this.mainTexel = new THREE.Vector2(1 / 512, 1 / 512)
    this.lowTexel = new THREE.Vector2(1 / 128, 1 / 128)

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
    this.mainTexel.set(1 / w, 1 / h)
    this.lowTexel.set(1 / lw, 1 / lh)
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
    // radius is re-applied per pass below, w carries the ink rate

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

    const applyPass = (cfg, radiusScale, curlScaleScale) => {
      u.u_dissipations.value.set(...cfg.dissipations)
      u.u_curlScale.value = this.mainPass.curlScale * (curlScaleScale ?? 1)
      u.u_curlStrength.value = cfg.curlStrength
      u.u_diffuse.value = cfg.diffuse
      u.u_diffuseRadius.value = cfg.diffuseRadius
      u.u_lowInfluence.value = cfg.lowInfluence
      u.u_drawFrom.value.z = this.radius * (radiusScale ?? 1)
      u.u_drawTo.value.z = this.radius * (radiusScale ?? 1)
    }

    // --- coarse pass: wide brush, slow decay, big swirl, heavy diffusion ---
    applyPass(this.lowPass, this.lowPass.radiusScale, this.lowPass.curlScaleScale)
    u.u_prevPaintTexture.value = this.low[this.index].texture
    u.u_lowPaintTexture.value = this.low[this.index].texture
    u.u_texelSize.value.copy(this.lowTexel)
    renderer.setRenderTarget(this.low[next])
    renderer.render(this.scene, this.camera)

    // --- fine pass: reads the coarse result ---------------------------------
    applyPass(this.mainPass, 1, 1)
    u.u_prevPaintTexture.value = this.main[this.index].texture
    u.u_lowPaintTexture.value = this.low[next].texture
    u.u_texelSize.value.copy(this.mainTexel)
    renderer.setRenderTarget(this.main[next])
    renderer.render(this.scene, this.camera)

    renderer.setRenderTarget(previousTarget)
    renderer.autoClear = previousAutoClear
    this.index = next
  }

  configure(options = {}) {
    const {
      curlLow, curlMain, curlScale, lowInfluence, radius, strength, pushStrength,
      dissipations, lowDissipations, diffuse, lowDiffuse, lowRadiusScale, advect,
    } = options
    if (curlMain !== undefined) this.mainPass.curlStrength = curlMain
    if (curlLow !== undefined) this.lowPass.curlStrength = curlLow
    if (curlScale !== undefined) this.mainPass.curlScale = curlScale
    if (lowInfluence !== undefined) this.mainPass.lowInfluence = lowInfluence
    if (diffuse !== undefined) this.mainPass.diffuse = diffuse
    if (lowDiffuse !== undefined) this.lowPass.diffuse = lowDiffuse
    if (lowRadiusScale !== undefined) this.lowPass.radiusScale = lowRadiusScale
    if (dissipations !== undefined) this.mainPass.dissipations = dissipations
    if (lowDissipations !== undefined) this.lowPass.dissipations = lowDissipations
    if (radius !== undefined) this.radius = radius
    if (strength !== undefined) this.strength = strength
    if (advect !== undefined) this.material.uniforms.u_advect.value = advect
    if (pushStrength !== undefined) this.material.uniforms.u_pushStrength.value = pushStrength
  }

  dispose() {
    this.main.forEach((rt) => rt.dispose())
    this.low.forEach((rt) => rt.dispose())
    this.quad.geometry.dispose()
    this.material.dispose()
  }
}
