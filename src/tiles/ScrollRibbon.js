import * as THREE from 'three'
import vertexShader from './glsl/ribbon.vert.glsl'
import fragmentShader from './glsl/ribbon.frag.glsl'

/**
 * The fat blue line that draws itself across the statement section as the
 * page scrolls.
 *
 * Construction (mirrors the reference's line renderer):
 *
 *   author time  - a handful of anchor points, written as fractions of the
 *                  section's width and of one viewport height, so the path
 *                  survives resizes and font changes
 *   build time   - Catmull-Rom through the anchors -> ~240 samples ->
 *                  a two-vertex-per-sample triangle strip whose centreline,
 *                  normal, arc-ratio and side are baked as attributes
 *                  (document-space pixels; only u_scrollY moves it after)
 *   frame time   - two numbers: u_showRatio (how much of the arc exists)
 *                  and u_hideRatio (how much has been erased behind it),
 *                  both eased from the section's scroll progress. Draw-on
 *                  and draw-off are THE SAME mechanism at opposite ends.
 *
 * The mesh renders before the media tiles, so the line passes BEHIND the
 * imagery but in front of the page background - and DOM text (z-index 2)
 * stays above all of it, which is why the line can duck under a headline.
 */

const ANCHORS = [
  // x: fraction of section width; y: fraction of one viewport height,
  // both measured from the section's top-left in document space
  [-0.10, 0.14],
  [0.30, 0.02],
  [0.74, 0.08],
  [0.965, 0.30],
  [0.78, 0.52],
  [0.44, 0.46],
  [0.16, 0.37],
  [0.045, 0.20],
  [0.10, 0.045],
  [0.285, 0.09],
  [0.345, 0.30],
  [0.20, 0.475],
  [0.295, 0.72],
  [0.56, 0.95],
  [0.86, 1.16],
  [1.12, 1.32],
]

const SAMPLES = 240

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t
  const t3 = t2 * t
  return [
    0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3),
  ]
}

export class ScrollRibbon {
  constructor(scene, sectionEl) {
    this.sectionEl = sectionEl
    this.progress = 0

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide, // the y-down camera flips winding
      uniforms: {
        u_scrollY: { value: 0 },
        u_width: { value: 48 },
        u_showRatio: { value: 0 },
        u_hideRatio: { value: 0 },
        u_capLen: { value: 0.009 },
        u_color0: { value: new THREE.Color('#4b3ff2') },
        u_color1: { value: new THREE.Color('#2b28e4') },
      },
    })

    this.geometry = new THREE.BufferGeometry()
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 0 // before the tiles (renderOrder 1)
    scene.add(this.mesh)
  }

  /** Bake the strip in document-space pixels. Call on init and resize. */
  build(scrollY, viewportH) {
    const rect = this.sectionEl.getBoundingClientRect()
    const left = rect.left + 0 // section is full-bleed; fractions handle inset
    const top = rect.top + scrollY
    const w = rect.width
    const u = Math.min(viewportH, w * 0.72) // vertical unit

    // resample the anchor polyline
    const pts = []
    for (let i = 0; i < ANCHORS.length - 1; i++) {
      const p0 = ANCHORS[Math.max(i - 1, 0)]
      const p1 = ANCHORS[i]
      const p2 = ANCHORS[i + 1]
      const p3 = ANCHORS[Math.min(i + 2, ANCHORS.length - 1)]
      const seg = Math.ceil(SAMPLES / (ANCHORS.length - 1))
      for (let s = 0; s < seg; s++) {
        const [x, y] = catmullRom(p0, p1, p2, p3, s / seg)
        pts.push([left + x * w, top + y * u])
      }
    }
    pts.push([left + ANCHORS.at(-1)[0] * w, top + ANCHORS.at(-1)[1] * u])

    // arc lengths -> uniform ratio, so draw speed is constant in px/s
    const arc = [0]
    for (let i = 1; i < pts.length; i++) {
      arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    }
    const total = arc.at(-1)

    const n = pts.length
    const center = new Float32Array(n * 2 * 2)
    const normal = new Float32Array(n * 2 * 2)
    const ratio = new Float32Array(n * 2)
    const side = new Float32Array(n * 2)
    const index = []

    for (let i = 0; i < n; i++) {
      const prev = pts[Math.max(i - 1, 0)]
      const next = pts[Math.min(i + 1, n - 1)]
      let tx = next[0] - prev[0]
      let ty = next[1] - prev[1]
      const tl = Math.hypot(tx, ty) || 1
      tx /= tl; ty /= tl
      const nx = -ty, ny = tx

      for (let k = 0; k < 2; k++) {
        const v = i * 2 + k
        center[v * 2] = pts[i][0]
        center[v * 2 + 1] = pts[i][1]
        normal[v * 2] = nx
        normal[v * 2 + 1] = ny
        ratio[v] = arc[i] / total
        side[v] = k === 0 ? -1 : 1
      }
      if (i < n - 1) {
        const a = i * 2
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }

    this.geometry.setIndex(index)
    this.geometry.setAttribute('aCenter', new THREE.BufferAttribute(center, 2))
    this.geometry.setAttribute('aNormal', new THREE.BufferAttribute(normal, 2))
    this.geometry.setAttribute('aRatio', new THREE.BufferAttribute(ratio, 1))
    this.geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
    // ShaderMaterial still expects a `position` attribute to exist
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3))

    this.material.uniforms.u_width.value = Math.min(64, Math.max(34, w * 0.052))
  }

  /**
   * Drive the draw window from the section's position in the viewport.
   * P: 0 as the section's top reaches the bottom of the screen, 1 as its
   * authored region (~1.5 viewport heights) has scrolled past.
   */
  update(dt, scrollY, viewportH) {
    const rect = this.sectionEl.getBoundingClientRect()
    const span = Math.min(viewportH * 1.5, rect.height)
    const P = THREE.MathUtils.clamp(
      (viewportH * 0.9 - rect.top) / (span + viewportH * 0.9), 0, 1)

    // smooth the input so wheel steps become one continuous stroke
    const k = 1 - Math.pow(0.002, dt)
    this.progress += (P - this.progress) * k

    const sm = (a, b, x) => {
      const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1)
      return t * t * (3 - 2 * t)
    }
    const u = this.material.uniforms
    /* Draw fast, early: the whole stroke must finish while its own region
     * is still on screen, or the loop completes where nobody sees it. */
    u.u_showRatio.value = sm(0.0, 0.42, this.progress) * 1.06
    u.u_hideRatio.value = sm(0.85, 1.0, this.progress)
    u.u_scrollY.value = scrollY

    // nothing to draw yet (or fully erased): skip the mesh entirely
    this.mesh.visible = u.u_showRatio.value > 0.001 && u.u_hideRatio.value < 0.999
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
