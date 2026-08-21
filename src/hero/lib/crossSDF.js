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
  // is ~3.3x the diameter of one arm.
  // Getting this ratio wrong is what makes the shape read as a blobby plus
  // sign instead of a machined jack.
  armHalfLength: 1.0, // half the span of one arm, from the centre
  armRadius: 0.3, // outer radius of an arm  -> span / thickness = 3.33
  /* Re-measured against the live reference (zoomed screenshots, several arms):
     the bore mouth is ~0.28-0.30 of the arm DIAMETER, i.e. hole radius ~0.29 x
     arm radius, not the 0.37 previously used - the old bore read visibly too
     wide. The rim has a generous rounded lip (~0.04) that catches a specular
     ring, and the cap edge round-over is a touch softer than before.

     These small radii are now allowed to be near or below one marching-cubes
     cell: the mesh is no longer used raw. After polygonisation every vertex is
     Newton-snapped onto this exact SDF and high-curvature triangles (rims,
     round-overs, fillets) are adaptively subdivided with the new vertices
     snapped too, so the rendered surface follows the analytic shape, not the
     grid. See crossGeometry.js. */
  round: 0.06, // radius of the rounding applied to every convex edge
  junction: 0.1, // smooth-min factor -> size of the fillet at the hub
  holeRadius: 0.09, // radius of the bore drilled into each arm tip
  holeDepth: 0.55, // how deep that bore goes
  holeRound: 0.04, // rounding of the bore's rim + floor
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

/* ------------------------------------------------------------------ */
/* bore ambient visibility                                             */
/* ------------------------------------------------------------------ */

/*
 * How much of the sky/studio a surface point can actually see, considering
 * only the six bore wells. The 5-tap SDF ambient-occlusion march tops out at
 * h = 0.28, which is shallower than the bore is deep - measured at the bore
 * floor it returned ~0.75, which is why the bottoms of the holes were GLOWING
 * with matcap + environment light and the whole bore read as an opening into
 * a hollow, translucent shell instead of a hole drilled into a solid.
 *
 * For a point at depth d inside a well of mouth radius r the cosine-weighted
 * visibility of the opening disc is r^2 / (r^2 + d^2) - exact on the axis,
 * close enough on the wall. That gives the smooth bright-lip -> near-black
 * floor gradient the reference bores have.
 */
function boreWell(axial, radial) {
  const hr = CROSS.holeRadius * 1.15 // effective mouth incl. the rounded lip
  const depth = CROSS.armHalfLength - axial // cap face sits at |axis| = L
  if (depth <= 0) return 1
  // 1 inside the shaft, fading to 0 outside the mouth region
  const t = (CROSS.holeRadius * 2.2 - radial) / (CROSS.holeRadius * 1.0)
  const inside = Math.min(Math.max(t, 0), 1)
  if (inside <= 0) return 1
  const vis = (hr * hr) / (hr * hr + depth * depth)
  return 1 - inside * inside * (1 - vis)
}

/** Combined ambient visibility for all six bores, multiplied into baked AO. */
export function boreAmbient(x, y, z) {
  let v = boreWell(Math.abs(x), Math.hypot(y, z))
  v = Math.min(v, boreWell(Math.abs(y), Math.hypot(z, x)))
  v = Math.min(v, boreWell(Math.abs(z), Math.hypot(x, y)))
  return v
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
