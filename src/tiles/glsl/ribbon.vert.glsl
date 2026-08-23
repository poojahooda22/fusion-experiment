precision highp float;

/* ------------------------------------------------------------------ *
 * Scroll-drawn ribbon ("the blue line").
 *
 * The curve is baked on the CPU as per-vertex attributes - centreline
 * point, unit normal, arc ratio, side (-1/+1) - and the GPU only offsets
 * across the width, windows the visible range, and scrolls.
 *
 * The width is NEVER tapered here: a width taper is what turns a line
 * end into an arrow point. Vertices keep full width right through both
 * ends (with a small margin so the fragment shader has room), and the
 * fragment shader cuts a true semicircular cap from the distance to the
 * end point. Vertices far outside the draw window collapse onto the
 * centreline, which produces zero-area triangles the GPU skips.
 * ------------------------------------------------------------------ */

attribute vec2 aCenter;   // document-space px
attribute vec2 aNormal;   // unit normal of the centreline
attribute float aRatio;   // 0..1 along the curve
attribute float aSide;    // -1 or +1

uniform float u_scrollY;
uniform float u_width;      // full width, px
uniform float u_showRatio;
uniform float u_hideRatio;
uniform float u_capLen;     // arc fraction of ONE cap (halfWidth / totalArc)

varying float v_side;
varying float v_ratio;

void main() {
  // full width while inside the window (plus 2.5 caps of margin for the
  // fragment-space semicircles), zero outside
  float lo = u_hideRatio - u_capLen * 2.5;
  float hi = u_showRatio + u_capLen * 2.5;
  float inside = step(lo, aRatio) * step(aRatio, hi);

  vec2 pos = aCenter + aNormal * aSide * (u_width * 0.5 * inside);
  pos.y -= u_scrollY;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 0.0, 1.0);
  v_side = aSide;
  v_ratio = aRatio;
}
