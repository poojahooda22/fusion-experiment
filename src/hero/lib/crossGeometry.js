import * as THREE from 'three'
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js'
import { CROSS, CROSS_BOUND, crossSDF, crossNormal } from './crossSDF.js'

/**
 * Polygonises the cross SDF once, welds the result into an indexed geometry,
 * and bakes two extra per-vertex attributes that the shader needs:
 *
 *   aAo        - SDF ambient occlusion. Darkens the fillets where the arms
 *                meet and the inside of the bores. Free at runtime.
 *   aThickness - how much solid sits behind the surface along -normal.
 *                Drives subsurface scattering on the translucent instances.
 *
 * Marching cubes gives us a watertight mesh with a proper fillet at the hub,
 * which is very hard to get from a hand-built parametric mesh.
 */

const DOMAIN = CROSS_BOUND * 1.06 // marching cube field covers [-DOMAIN, DOMAIN]

function weld(positions, epsilon = 1e-4) {
  const map = new Map()
  const outPos = []
  const index = new Uint32Array(positions.length / 3)
  const inv = 1 / epsilon
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    const key =
      Math.round(x * inv) + '|' + Math.round(y * inv) + '|' + Math.round(z * inv)
    let id = map.get(key)
    if (id === undefined) {
      id = outPos.length / 3
      map.set(key, id)
      outPos.push(x, y, z)
    }
    index[v] = id
  }
  return { positions: new Float32Array(outPos), index }
}

/** iq's SDF ambient occlusion, marched along the surface normal. */
function bakeAo(px, py, pz, nx, ny, nz) {
  let occ = 0
  let sca = 1
  for (let i = 0; i < 5; i++) {
    const h = 0.02 + 0.16 * (i / 4)
    const d = crossSDF(px + nx * h, py + ny * h, pz + nz * h)
    occ += (h - d) * sca
    sca *= 0.72
  }
  return Math.min(Math.max(1 - 3.2 * occ, 0), 1)
}

/** How much material is behind this point, sampled along -normal. */
function bakeThickness(px, py, pz, nx, ny, nz) {
  const steps = [0.06, 0.14, 0.26, 0.42, 0.62]
  let acc = 0
  let wsum = 0
  for (let i = 0; i < steps.length; i++) {
    const h = steps[i]
    const w = 1 / (i + 1)
    const d = crossSDF(px - nx * h, py - ny * h, pz - nz * h)
    acc += w * Math.min(Math.max(-d / h, 0), 1)
    wsum += w
  }
  return acc / wsum
}

let cached = null

export function buildCrossGeometry({ resolution = 48 } = {}) {
  if (cached && cached.resolution === resolution) return cached.geometry

  /* --- 1. fill the scalar field with -SDF (inside is positive) ---------- */
  const mc = new MarchingCubes(resolution, new THREE.MeshBasicMaterial(), false, false, 120000)
  mc.isolation = 0

  const size = mc.size
  const half = mc.halfsize
  for (let z = 0; z < size; z++) {
    const wz = ((z - half) / half) * DOMAIN
    for (let y = 0; y < size; y++) {
      const wy = ((y - half) / half) * DOMAIN
      for (let x = 0; x < size; x++) {
        const wx = ((x - half) / half) * DOMAIN
        mc.field[mc.size2 * z + mc.size * y + x] = -crossSDF(wx, wy, wz)
      }
    }
  }

  /* --- 2. polygonise ---------------------------------------------------- */
  mc.update()
  const vertexCount = mc.count
  const raw = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertexCount * 3; i++) raw[i] = mc.positionArray[i] * DOMAIN

  /* --- 3. weld ---------------------------------------------------------- */
  const { positions, index } = weld(raw)
  const vCount = positions.length / 3

  /* --- 3b. snap every vertex onto the exact SDF surface -------------------
   * Marching cubes places vertices by linearly interpolating the field along a
   * cell edge, which is only first-order accurate. On a cylinder that error
   * shows up as a fine sawtooth along the silhouette. Two Newton steps against
   * the real distance function - p -= n * sdf(p) - move each vertex onto the
   * true surface and the silhouette goes clean, without adding a triangle.  */
  {
    const g = [0, 0, 0]
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2]
        const d = crossSDF(x, y, z)
        if (!isFinite(d) || Math.abs(d) < 1e-6) continue
        crossNormal(x, y, z, g)
        positions[i] = x - g[0] * d
        positions[i + 1] = y - g[1] * d
        positions[i + 2] = z - g[2] * d
      }
    }
  }

  /* --- 4. analytic normals + baked AO / thickness ------------------------ */
  const normals = new Float32Array(vCount * 3)
  const aos = new Float32Array(vCount)
  const thick = new Float32Array(vCount)
  const n = [0, 0, 0]
  for (let i = 0; i < vCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    crossNormal(x, y, z, n)
    normals[i * 3] = n[0]
    normals[i * 3 + 1] = n[1]
    normals[i * 3 + 2] = n[2]
    aos[i] = bakeAo(x, y, z, n[0], n[1], n[2])
    thick[i] = bakeThickness(x, y, z, n[0], n[1], n[2])
  }

  /* --- 5. fix winding if marching cubes handed us inside-out triangles --- */
  let volume = 0
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]
    volume +=
      ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  if (volume < 0) {
    for (let t = 0; t < index.length; t += 3) {
      const tmp = index[t + 1]
      index[t + 1] = index[t + 2]
      index[t + 2] = tmp
    }
  }

  /* --- 6. assemble ------------------------------------------------------ */
  const geometry = new THREE.BufferGeometry()
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('aAo', new THREE.BufferAttribute(aos, 1))
  geometry.setAttribute('aThickness', new THREE.BufferAttribute(thick, 1))
  geometry.computeBoundingSphere()
  geometry.userData.stats = {
    resolution,
    vertices: vCount,
    triangles: index.length / 3,
  }

  mc.geometry.dispose()
  cached = { resolution, geometry }
  return geometry
}

export { CROSS, CROSS_BOUND }
