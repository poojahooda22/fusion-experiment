/**
 * Signed distance field for the "jack" / cross primitive used in the hero.
 *
 * The shape is three orthogonal capped cylinders unioned with a smooth-min
 * (which produces the soft fillet where the arms meet), rounded on every convex
 * edge, then a blind bore is subtracted from each of the six arm tips.
 *
 * Everything downstream — the polygonised mesh, the baked AO, the baked SSS
 * thickness — is derived from this one function, so tweaking these numbers
 * changes the whole look consistently.
 */

export const CROSS = {
  // Measured off the reference at a 1800px window: the overall span of a cross
  // is ~3.3x the diameter of one arm, and the bore is ~0.37 of that diameter.
  // Getting this ratio wrong is what makes the shape read as a blobby plus
  // sign instead of a machined jack.
  armHalfLength: 1.0, // half the span of one arm, from the centre
  armRadius: 0.3, // outer radius of an arm  -> span / thickness = 3.33
  /* Both round-overs have to stay above one marching-cubes cell or they are
     simply not representable: at resolution 64 the cell is 0.0343, so the old
     0.035 / 0.015 were 1.0 and 0.44 cells and the rims quantised to the grid -
     polygonal instead of circular, with the analytic normal swinging 89 degrees
     across a single triangle. */
  round: 0.05, // radius of the rounding applied to every convex edge
  junction: 0.1, // smooth-min factor -> size of the fillet at the hub
  holeRadius: 0.11, // radius of the bore drilled into each arm tip
  holeDepth: 0.55, // how deep that bore goes
  holeRound: 0.028, // rounding of the bore's rim + floor
}

/** Bounding radius of the shape in local units (used for the ray-trace proxy). */
export const CROSS_BOUND = CROSS.armHalfLength + CROSS.round

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/** Capped cylinder whose axis is the first argument. Half-height h, radius r. */
function sdCappedCyl(ax, r1, r2, h, r) {
  const dx = Math.abs(ax) - h
  const dr = Math.sqrt(r1 * r1 + r2 * r2) - r
  const ox = Math.max(dx, 0)
  const or = Math.max(dr, 0)
  return Math.min(Math.max(dx, dr), 0) + Math.sqrt(ox * ox + or * or)
}

/** Quadratic polynomial smooth minimum (iq). */
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

function smax(a, b, k) {
  return -smin(-a, -b, k)
}

/* ------------------------------------------------------------------ */
/* the cross                                                           */
/* ------------------------------------------------------------------ */

export function crossSDF(x, y, z) {
  const L = CROSS.armHalfLength
  const R = CROSS.armRadius
  const rd = CROSS.round
  const k = CROSS.junction

  // shrink by `rd` so that adding it back rounds every convex edge
  const h = L - rd
  const r = R - rd

  let d = sdCappedCyl(x, y, z, h, r)
  d = smin(d, sdCappedCyl(y, z, x, h, r), k)
  d = smin(d, sdCappedCyl(z, x, y, h, r), k)
  d -= rd

  // six blind bores, one per arm tip
  const hr = CROSS.holeRadius
  const hd = CROSS.holeDepth
  let bore = 1e9
  bore = Math.min(bore, sdCappedCyl(x - L, y, z, hd, hr))
  bore = Math.min(bore, sdCappedCyl(x + L, y, z, hd, hr))
  bore = Math.min(bore, sdCappedCyl(y - L, z, x, hd, hr))
  bore = Math.min(bore, sdCappedCyl(y + L, z, x, hd, hr))
  bore = Math.min(bore, sdCappedCyl(z - L, x, y, hd, hr))
  bore = Math.min(bore, sdCappedCyl(z + L, x, y, hd, hr))

  return smax(d, -bore, CROSS.holeRound)
}

/** Analytic-ish gradient of the SDF -> exact-looking smooth normals. */
const EPS = 1e-3
export function crossNormal(x, y, z, out = [0, 0, 0]) {
  const nx = crossSDF(x + EPS, y, z) - crossSDF(x - EPS, y, z)
  const ny = crossSDF(x, y + EPS, z) - crossSDF(x, y - EPS, z)
  const nz = crossSDF(x, y, z + EPS) - crossSDF(x, y, z - EPS)
  const l = Math.hypot(nx, ny, nz) || 1
  out[0] = nx / l
  out[1] = ny / l
  out[2] = nz / l
  return out
}
