precision highp float;

/* ------------------------------------------------------------------ *
 * Scroll-drawn ribbon ("the blue line").
 *
 * Same construction as the reference: the curve is baked on the CPU as
 * per-vertex attributes - centreline point, unit normal, arc ratio,
 * side (-1/+1) - and the GPU only offsets across the width, windows the
 * visible range, and scrolls. The strip is FLAT; everything that reads
 * as a tube happens in the fragment shader.
 *
 * Draw-on: u_showRatio is the arc length that currently exists,
 * u_hideRatio the arc length already erased behind it. Vertices taper
 * to zero width across u_capLen of arc with a circular profile
 * sqrt(h * (2 - h)), which is what makes the moving head a ROUND cap
 * instead of a chisel cut.
 * ------------------------------------------------------------------ */

attribute vec2 aCenter;   // document-space px
attribute vec2 aNormal;   // unit normal of the centreline
attribute float aRatio;   // 0..1 along the curve
attribute float aSide;    // -1 or +1

uniform float u_scrollY;
uniform float u_width;      // full width, px
uniform float u_showRatio;
uniform float u_hideRatio;
uniform float u_capLen;     // arc fraction the caps taper across

varying float v_side;
varying float v_ratio;

void main() {
  float head = clamp((u_showRatio - aRatio) / u_capLen, 0.0, 1.0);
  float tail = clamp((aRatio - u_hideRatio) / u_capLen, 0.0, 1.0);
  float profile = sqrt(head * (2.0 - head)) * sqrt(tail * (2.0 - tail));

  vec2 pos = aCenter + aNormal * aSide * (u_width * 0.5 * profile);
  pos.y -= u_scrollY;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 0.0, 1.0);
  v_side = aSide;
  v_ratio = aRatio;
}
