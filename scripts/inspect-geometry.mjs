/**
 * node scripts/inspect-geometry.mjs [resolution]
 *
 * Builds the cross geometry outside the browser and prints its stats, so you
 * can tune lib/crossSDF.js without reloading the page.
 */
import { buildCrossGeometry } from '../src/hero/lib/crossGeometry.js'

const resolution = Number(process.argv[2] || 48)
const t0 = performance.now()
const g = buildCrossGeometry({ resolution })
const ms = performance.now() - t0

const pos = g.attributes.position.array
const ao = g.attributes.aAo.array
const th = g.attributes.aThickness.array
const range = (a) => [Math.min(...a).toFixed(2), Math.max(...a).toFixed(2)]

console.table({
  resolution,
  buildMs: Math.round(ms),
  vertices: pos.length / 3,
  triangles: g.index.count / 3,
  boundingRadius: g.boundingSphere.radius.toFixed(3),
  ao: range(ao).join(' … '),
  thickness: range(th).join(' … '),
})
