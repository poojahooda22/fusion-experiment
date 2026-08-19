import * as THREE from 'three'

/**
 * Procedural studio matcap, generated as a linear-space DataTexture.
 *
 *   RGB = diffuse irradiance of a three-point studio rig
 *   A   = the tight specular lobe, kept in its own channel so the shader can
 *         scale it independently per material (glossy vs rubber vs frosted)
 *
 * A matcap bakes an entire lighting environment into one 2D lookup indexed by
 * the view-space normal, so the base shading of 40+ objects costs a single
 * texture fetch each. The ray-traced neighbour reflections are layered on top;
 * the matcap only ever supplies the "studio" part that never moves.
 */

const LIGHTS = [
  // dir (view space)                intensity  colour            shininess
  { d: [0.42, 0.78, 0.46], i: 1.0, c: [1.0, 0.99, 0.96], s: 140 }, // key, top right
  { d: [-0.78, 0.16, 0.42], i: 0.22, c: [0.84, 0.88, 1.0], s: 28 }, // cool fill, left
  { d: [-0.24, -0.72, -0.6], i: 0.55, c: [1.0, 0.94, 0.9], s: 46 }, // rim, below/behind
  { d: [0.1, 0.2, 0.98], i: 0.16, c: [1.0, 1.0, 1.0], s: 220 }, // on-axis catchlight
]

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

export function makeMatcapTexture(size = 256) {
  const data = new Uint8Array(size * size * 4)
  const lights = LIGHTS.map((l) => ({ ...l, d: norm(l.d) }))
  const V = [0, 0, 1]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size
      const nx = u * 2 - 1
      const ny = v * 2 - 1
      const r2 = nx * nx + ny * ny
      const i = (y * size + x) * 4

      if (r2 > 1) {
        // outside the sphere: clamp to the silhouette so bilinear taps at the
        // very edge don't smear black into the rim
        const s = 1 / Math.sqrt(r2)
        data[i] = data[i + 1] = data[i + 2] = 0
        data[i + 3] = 0
        continue
      }

      const nz = Math.sqrt(1 - r2)

      let dr = 0.018, dg = 0.02, db = 0.026 // ambient floor (slightly cool)
      // hemisphere ambient: brighter from above
      const hemi = ny * 0.5 + 0.5
      dr += 0.062 * hemi
      dg += 0.066 * hemi
      db += 0.076 * hemi

      let spec = 0
      for (const l of lights) {
        const ndl = nx * l.d[0] + ny * l.d[1] + nz * l.d[2]
        if (ndl > 0) {
          const w = ndl * l.i
          dr += w * l.c[0]
          dg += w * l.c[1]
          db += w * l.c[2]
        }
        // blinn-phong half vector
        const hx = l.d[0] + V[0], hy = l.d[1] + V[1], hz = l.d[2] + V[2]
        const hl = Math.hypot(hx, hy, hz)
        const ndh = (nx * hx + ny * hy + nz * hz) / hl
        if (ndh > 0) spec += Math.pow(ndh, l.s) * l.i
      }

      data[i + 0] = Math.min(255, Math.round(dr * 215))
      data[i + 1] = Math.min(255, Math.round(dg * 215))
      data[i + 2] = Math.min(255, Math.round(db * 215))
      data[i + 3] = Math.min(255, Math.round(Math.min(spec, 1) * 255))
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.colorSpace = THREE.NoColorSpace // it is lighting data, not an sRGB image
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}
