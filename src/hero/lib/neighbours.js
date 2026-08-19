/**
 * Per-frame k-nearest-neighbour solve.
 *
 * Every cross needs to know the transform, colour and opacity of the few
 * crosses closest to it, because that is the entire "scene" its fragment
 * shader is allowed to ray-trace against. With ~45 bodies a brute-force
 * O(n^2) pass is about 2000 distance tests per frame - far cheaper than the
 * spatial hash it would take to avoid it, and completely allocation-free.
 */
export function updateNeighbours(items, k) {
  const n = items.length

  // 1. snapshot every body's transform once
  for (let i = 0; i < n; i++) {
    const it = items[i]
    const body = it.body
    if (!body) continue
    const t = body.translation()
    const r = body.rotation()
    it.px = t.x; it.py = t.y; it.pz = t.z
    it.qx = r.x; it.qy = r.y; it.qz = r.z; it.qw = r.w
  }

  // 2. for each body, keep the k closest in a small insertion-sorted list
  for (let i = 0; i < n; i++) {
    const a = items[i]
    if (!a.body) continue

    const bestD = a._bestD
    const bestI = a._bestI
    bestD.fill(Infinity)
    bestI.fill(-1)

    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const b = items[j]
      if (!b.body) continue
      const dx = b.px - a.px
      const dy = b.py - a.py
      const dz = b.pz - a.pz
      const d = dx * dx + dy * dy + dz * dz
      if (d >= bestD[k - 1]) continue
      let p = k - 1
      while (p > 0 && bestD[p - 1] > d) {
        bestD[p] = bestD[p - 1]
        bestI[p] = bestI[p - 1]
        p--
      }
      bestD[p] = d
      bestI[p] = j
    }

    // 3. push straight into the material's uniform arrays
    const u = a.material.uniforms
    u.u_selfPositionRadius.value.set(a.px, a.py, a.pz, a.radius)
    u.u_selfRotation.value.set(a.qx, a.qy, a.qz, a.qw)

    const prList = u.u_nearPositionRadiusList.value
    const rotList = u.u_nearRotationList.value
    const colList = u.u_nearColorList.value
    const tlList = u.u_nearTransparencyLumaList.value

    for (let s = 0; s < k; s++) {
      const idx = bestI[s]
      if (idx < 0) {
        prList[s].w = 0 // w <= 0 tells the shader to skip this slot
        continue
      }
      const b = items[idx]
      prList[s].set(b.px, b.py, b.pz, b.radius)
      rotList[s].set(b.qx, b.qy, b.qz, b.qw)
      colList[s].copy(b.color)
      tlList[s].set(b.transmission, b.luma)
    }
  }
}
