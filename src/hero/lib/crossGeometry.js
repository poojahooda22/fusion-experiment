import * as THREE from 'three'
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js'
import { CROSS, CROSS_BOUND, crossSDF, crossNormal, boreAmbient } from './crossSDF.js'

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
  /* Welding collapses marching-cubes slivers thinner than epsilon into
     triangles with a repeated index. They render as nothing but corrupt the
     edge topology (an a-b edge inside a degenerate triangle gets counted
     twice), which breaks the manifold guarantees the subdivision relies on -
     drop them here. */
  const filtered = []
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2]
    if (a === b || b === c || c === a) continue
    filtered.push(a, b, c)
  }
  return { positions: new Float32Array(outPos), index: new Uint32Array(filtered) }
}

/** iq's SDF ambient occlusion, marched along the surface normal. */
function bakeAo(px, py, pz, nx, ny, nz) {
  let occ = 0
  let sca = 1
  for (let i = 0; i < 5; i++) {
    const h = 0.04 + 0.24 * (i / 4)  // wide enough that vAo has room to interpolate
    const d = crossSDF(px + nx * h, py + ny * h, pz + nz * h)
    occ += (h - d) * sca
    sca *= 0.72
  }
  return Math.min(Math.max(1 - 1.7 * occ, 0), 1)
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

/** Newton-snap one vertex onto the exact SDF surface. */
const _g = [0, 0, 0]
function snapVertex(pos, i, iterations = 3) {
  let x = pos[i], y = pos[i + 1], z = pos[i + 2]
  for (let it = 0; it < iterations; it++) {
    const d = crossSDF(x, y, z)
    if (!isFinite(d) || Math.abs(d) < 1e-6) break
    crossNormal(x, y, z, _g)
    x -= _g[0] * d
    y -= _g[1] * d
    z -= _g[2] * d
  }
  pos[i] = x
  pos[i + 1] = y
  pos[i + 2] = z
}

/*
 * Adaptive, crack-free 1->4 / 1->3 / 1->2 subdivision, with every new vertex
 * Newton-snapped onto the SDF.
 *
 * Why this exists: the bore mouth is ~0.18 units across but a marching-cubes
 * cell at resolution 64 is 0.035, so the rim circle only ever gets ~6 grid
 * crossings - it polygonised into a literal hexagon, and no amount of vertex
 * snapping can fix that because snapping moves vertices, it cannot add them.
 * Raising the grid until a hexagon becomes a circle would need resolution
 * ~160 (~156k triangles). Instead the grid stays coarse and only triangles
 * whose vertex normals disagree (rims, round-overs, the hub fillet - i.e.
 * curvature the grid under-resolved) are split, with midpoints pulled onto
 * the true surface. Flat caps and straight arm walls are left untouched, so
 * two passes cost ~1.6x triangles instead of 16x.
 *
 * Crack-freedom: an edge is split for BOTH triangles that share it or for
 * neither (the split set is keyed on the undirected edge), and a triangle
 * with 1 / 2 / 3 split edges emits 2 / 3 / 4 conforming triangles - no
 * T-junctions, so no pinholes along the boundary between refined and
 * untouched regions.
 */
function subdivideAdaptive(positionsIn, indexIn, { passes = 2, normalDot = 0.9, minEdge = 0.011 } = {}) {
  let pos = Array.from(positionsIn)
  let idx = Array.from(indexIn)
  const n = [0, 0, 0]
  const minEdge2 = minEdge * minEdge

  for (let pass = 0; pass < passes; pass++) {
    const vCount = pos.length / 3
    const vn = new Float32Array(vCount * 3)
    for (let i = 0; i < vCount; i++) {
      crossNormal(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], n)
      vn[i * 3] = n[0]
      vn[i * 3 + 1] = n[1]
      vn[i * 3 + 2] = n[2]
    }

    const ndot = (a, b) =>
      vn[a * 3] * vn[b * 3] + vn[a * 3 + 1] * vn[b * 3 + 1] + vn[a * 3 + 2] * vn[b * 3 + 2]
    const elen2 = (a, b) => {
      const dx = pos[a * 3] - pos[b * 3]
      const dy = pos[a * 3 + 1] - pos[b * 3 + 1]
      const dz = pos[a * 3 + 2] - pos[b * 3 + 2]
      return dx * dx + dy * dy + dz * dz
    }
    const ekey = (a, b) => (a < b ? a * 0x1000000 + b : b * 0x1000000 + a)

    /* mark: split every sufficiently long edge whose endpoint normals
       disagree - that is exactly where the grid under-sampled curvature */
    const split = new Set()
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2]
      if (ndot(a, b) < normalDot && elen2(a, b) > minEdge2) split.add(ekey(a, b))
      if (ndot(b, c) < normalDot && elen2(b, c) > minEdge2) split.add(ekey(b, c))
      if (ndot(c, a) < normalDot && elen2(c, a) > minEdge2) split.add(ekey(c, a))
    }
    if (split.size === 0) break

    /* midpoints, deduped per undirected edge, snapped onto the SDF */
    const mid = new Map()
    const midpoint = (a, b) => {
      const k = ekey(a, b)
      let m = mid.get(k)
      if (m === undefined) {
        m = pos.length / 3
        pos.push(
          (pos[a * 3] + pos[b * 3]) * 0.5,
          (pos[a * 3 + 1] + pos[b * 3 + 1]) * 0.5,
          (pos[a * 3 + 2] + pos[b * 3 + 2]) * 0.5
        )
        snapVertex(pos, m * 3)
        mid.set(k, m)
      }
      return m
    }

    const out = []
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2]
      const sab = split.has(ekey(a, b))
      const sbc = split.has(ekey(b, c))
      const sca = split.has(ekey(c, a))
      const count = (sab ? 1 : 0) + (sbc ? 1 : 0) + (sca ? 1 : 0)

      if (count === 0) {
        out.push(a, b, c)
      } else if (count === 3) {
        const mab = midpoint(a, b), mbc = midpoint(b, c), mca = midpoint(c, a)
        out.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca)
      } else if (count === 1) {
        // rotate so the split edge is a-b
        let A = a, B = b, C = c
        if (sbc) { A = b; B = c; C = a }
        else if (sca) { A = c; B = a; C = b }
        const m = midpoint(A, B)
        out.push(A, m, C, m, B, C)
      } else {
        // rotate so the UNSPLIT edge is a-b
        let A = a, B = b, C = c
        if (!sbc) { A = b; B = c; C = a }
        else if (!sca) { A = c; B = a; C = b }
        const mBC = midpoint(B, C)
        const mCA = midpoint(C, A)
        out.push(A, B, mBC, A, mBC, mCA, mCA, mBC, C)
      }
    }
    idx = out
  }

  return { positions: new Float32Array(pos), index: new Uint32Array(idx) }
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
  const welded = weld(raw)

  /* --- 3b. snap every vertex onto the exact SDF surface -------------------
   * Marching cubes places vertices by linearly interpolating the field along a
   * cell edge, which is only first-order accurate. On a cylinder that error
   * shows up as a fine sawtooth along the silhouette. Newton steps against
   * the real distance function - p -= n * sdf(p) - move each vertex onto the
   * true surface and the silhouette goes clean, without adding a triangle.  */
  for (let i = 0; i < welded.positions.length; i += 3) {
    snapVertex(welded.positions, i)
  }

  /* --- 3c. adaptively refine what the grid could not resolve --------------
   * Rims of the bores, the cap round-overs and the hub fillet all carry more
   * curvature per cell than the grid sampled; split those triangles and snap
   * the new vertices onto the SDF. This is what turns the hexagonal bore
   * mouths back into circles. */
  /* 0.95 ~= split while adjacent normals disagree by >18 degrees. The hub
     fillet (junction 0.1) bends ~20 degrees per cell, so a looser 0.9
     threshold skipped it and its baked AO stayed a visible zigzag ring. */
  const { positions, index } = subdivideAdaptive(welded.positions, welded.index, {
    passes: 2,
    normalDot: 0.95,
    minEdge: 0.009,
  })
  const vCount = positions.length / 3

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
    /* The short AO march cannot see how deep the bore is (its taps stop at
       h=0.28); multiply in the analytic well visibility so bore interiors
       darken with depth like a real drilled hole. */
    aos[i] = bakeAo(x, y, z, n[0], n[1], n[2]) * boreAmbient(x, y, z)
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
