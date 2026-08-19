/**
 * One knob for the whole effect.
 *
 * The expensive parts, in order:
 *   1. fragment cost  = count x NEIGHBOUR_COUNT x 3 cylinder tests x 2 rays
 *   2. vertex cost    = count x triangles-per-cross, rendered twice when the
 *                       refraction pre-pass is on
 *   3. post chain     = depth of field is by far the heaviest effect
 */
export const QUALITY_PRESETS = {
  // cameraZ tracks count^(1/3): fewer crosses make a smaller cluster, so the
  // camera has to come in to keep the framing identical
  // The reference frames only ever hold ~20 crosses, and they are big enough
  // that several are cut off by the edges of the box. Packing in more makes the
  // cluster read as gravel rather than as a handful of large objects.
  high: { count: 28, resolution: 64, refractionScale: 0.5, post: 'high', cameraZ: 6.6 },
  medium: { count: 24, resolution: 56, refractionScale: 0.4, post: 'medium', cameraZ: 6.5 },
  low: { count: 16, resolution: 44, refractionScale: 0, post: 'low', cameraZ: 6.4 },
  // same scene, no post chain - useful for looking at the raw material
  raw: { count: 28, resolution: 64, refractionScale: 0.5, post: 'off', cameraZ: 6.6 },
}

export function detectQuality() {
  if (typeof window === 'undefined') return 'medium'
  const forced = new URLSearchParams(window.location.search).get('quality')
  if (forced && QUALITY_PRESETS[forced]) return forced
  const coarse = window.matchMedia?.('(pointer: coarse)').matches
  const smallish = Math.min(window.innerWidth, window.innerHeight) < 720
  const cores = navigator.hardwareConcurrency ?? 4
  if (coarse || smallish || cores <= 4) return 'low'
  if (cores <= 8) return 'medium'
  return 'high'
}
