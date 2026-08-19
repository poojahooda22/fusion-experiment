import * as THREE from 'three'

/**
 * Void-and-cluster blue noise (Ulichney 1993), generated at startup.
 *
 * We use it to jitter the reflection ray per-pixel. White noise would make the
 * rough reflections look like TV static; blue noise spreads the error evenly
 * across the screen so a single sample per pixel already reads as a soft,
 * even blur. The lookup is offset every frame by the golden ratio so the
 * remaining error animates and the eye integrates it away.
 */
export function generateBlueNoise(size = 64) {
  const N = size
  const n = N * N

  // gaussian energy kernel, wrapped toroidally
  const R = 6
  const sigma = 1.9
  const kernel = []
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kernel.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))])
    }
  }

  const binary = new Uint8Array(n)
  const energy = new Float32Array(n)

  const splat = (i, sign) => {
    const x = i % N
    const y = (i / N) | 0
    for (let k = 0; k < kernel.length; k++) {
      const [dx, dy, w] = kernel[k]
      energy[((y + dy + N) % N) * N + ((x + dx + N) % N)] += sign * w
    }
  }

  const tightestCluster = () => {
    let best = -1
    let bestE = -Infinity
    for (let i = 0; i < n; i++) if (binary[i] && energy[i] > bestE) (bestE = energy[i]), (best = i)
    return best
  }
  const largestVoid = () => {
    let best = -1
    let bestE = Infinity
    for (let i = 0; i < n; i++) if (!binary[i] && energy[i] < bestE) (bestE = energy[i]), (best = i)
    return best
  }

  // --- initial random pattern -------------------------------------------
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 100000) / 100000
  }
  const initialCount = Math.max(1, Math.round(n * 0.1))
  let placed = 0
  while (placed < initialCount) {
    const i = (rnd() * n) | 0
    if (!binary[i]) {
      binary[i] = 1
      splat(i, 1)
      placed++
    }
  }

  // --- relax it into a true blue-noise prototype -------------------------
  for (let guard = 0; guard < n * 4; guard++) {
    const c = tightestCluster()
    binary[c] = 0
    splat(c, -1)
    const v = largestVoid()
    if (v === c) {
      binary[c] = 1
      splat(c, 1)
      break
    }
    binary[v] = 1
    splat(v, 1)
  }

  const prototype = binary.slice()
  const rank = new Int32Array(n).fill(-1)

  // --- phase 1: remove points from the prototype, ranking downwards ------
  for (let r = initialCount - 1; r >= 0; r--) {
    const c = tightestCluster()
    binary[c] = 0
    splat(c, -1)
    rank[c] = r
  }

  // --- phase 2: re-insert into the largest voids, ranking upwards --------
  binary.set(prototype)
  energy.fill(0)
  for (let i = 0; i < n; i++) if (binary[i]) splat(i, 1)
  const half = (n / 2) | 0
  for (let r = initialCount; r < half; r++) {
    const v = largestVoid()
    binary[v] = 1
    splat(v, 1)
    rank[v] = r
  }

  // --- phase 3: swap roles, keep filling the remaining holes -------------
  energy.fill(0)
  for (let i = 0; i < n; i++) if (!binary[i]) splat(i, 1)
  const flipped = new Uint8Array(n)
  for (let i = 0; i < n; i++) flipped[i] = binary[i] ? 0 : 1
  const savedBinary = binary.slice()
  binary.set(flipped)
  for (let r = n - 1; r >= half; r--) {
    const c = tightestCluster()
    binary[c] = 0
    splat(c, -1)
    rank[c] = r
  }
  binary.set(savedBinary)

  // --- pack: R = value, G = value rotated (a second decorrelated channel)
  const data = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const v = Math.min(255, Math.max(0, Math.round((rank[i] / (n - 1)) * 255)))
    const x = i % N
    const y = (i / N) | 0
    const j = ((y + 37) % N) * N + ((x + 17) % N)
    const v2 = Math.min(255, Math.max(0, Math.round((rank[j] / (n - 1)) * 255)))
    data[i * 4 + 0] = v
    data[i * 4 + 1] = v2
    data[i * 4 + 2] = 255 - v
    data[i * 4 + 3] = 255
  }
  return { data, size: N }
}

export function makeBlueNoiseTexture(size = 64) {
  const { data, size: N } = generateBlueNoise(size)
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}
