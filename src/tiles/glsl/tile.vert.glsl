precision highp float;

/* ------------------------------------------------------------------ *
 * Media tile vertex shader.
 *
 * The quad is a unit plane with position.xy in [0,1]; everything else is
 * uniforms measured from the DOM every frame. The camera is orthographic
 * in CSS pixels with y pointing DOWN, so a tile drawn at u_domXY/u_domWH
 * lands exactly on top of its (empty) DOM placeholder.
 *
 * Three motions live here, all read off the reference:
 *
 *   1. The show transition. The rect interpolates from a "from" rect
 *      (slightly lower and smaller), with a sideways bulge that peaks
 *      mid-transition (cosine of the ratio) and a settle rotation of
 *      (smoothstep(r) - r) * -0.5 radians - zero at both ends, ~4 deg
 *      in the middle. That is the tilted, drifting card you can catch
 *      mid-reveal on the live site.
 *
 *   2. The scroll bend. While the page scrolls fast, every vertex is
 *      offset vertically by an arch (4x(1-x)) scaled by the smoothed
 *      scroll velocity - the card flexes like a sheet being dragged,
 *      and relaxes flat as the velocity lerps back to zero.
 *
 *   3. A per-tile parallax nudge (u_parallax, set from scroll position)
 *      so tiles drift a few px against the text while in view.
 * ------------------------------------------------------------------ */

uniform vec2  u_domXY;        // css px, top-left of the target rect
uniform vec2  u_domWH;
uniform vec2  u_domXYFrom;    // rect the show transition starts from
uniform vec2  u_domWHFrom;
uniform float u_showRatio;    // eased 0..1
uniform float u_scrollBend;   // smoothed scroll velocity, pre-scaled
uniform float u_parallax;     // css px
/* cloth curl for the expanding showreel: x bows the top/bottom edges
 * (arch across the width), y bows the left/right edges (arch across the
 * height). Driven on the CPU from the expansion's own velocity, so the
 * sheet billows while it grows and relaxes when it lands. */
uniform vec2  u_expandCurl;
uniform float u_expandS;      // asymmetric S-bend across the width
uniform float u_expandTilt;   // radians, whole-sheet rotation

varying vec2  v_uv;
varying vec2  v_domWH;
varying float v_showRatio;

void main() {
  float r = u_showRatio;

  vec2 domXY = mix(u_domXYFrom, u_domXY, r);
  vec2 domWH = mix(u_domWHFrom, u_domWH, r);

  // sideways bulge: 0 at r=0 and r=1, maximal mid-transition
  float bulge = 1.0 - (cos(r * 6.2831853) * 0.5 + 0.5);
  domXY.x += bulge * domWH.x * 0.1;

  // settle rotation from the reveal + the expansion's cloth tilt
  float rot = (smoothstep(0.0, 1.0, r) - r) * -0.5 + u_expandTilt;
  vec2 p = (position.xy - 0.5) * domWH;
  float c = cos(rot), s = sin(rot);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  p += domWH * 0.5;

  // scroll bend: an arch across the tile's width, same offset for the
  // whole column of vertices -> both edges curve in parallel
  float arch = 4.0 * position.x * (1.0 - position.x);
  p.y += u_scrollBend * domWH.y * arch;
  p.y += u_parallax;

  // expansion cloth curl: the same arch, on both axes, from the expand
  // dynamics - this is the "curly" full-width sheet mid-transition
  float archY = 4.0 * position.y * (1.0 - position.y);
  p.y += u_expandCurl.x * domWH.y * arch;
  p.y += u_expandS * domWH.y * sin(6.2831853 * (position.x - 0.5)) * 0.5;
  p.x += u_expandCurl.y * domWH.x * archY;

  vec2 screen = domXY + p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(screen, 0.0, 1.0);

  v_uv = vec2(position.x, position.y);
  v_domWH = domWH;
  v_showRatio = r;
}
