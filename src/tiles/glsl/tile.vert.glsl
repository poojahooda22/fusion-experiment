precision highp float;

/* ------------------------------------------------------------------ *
 * Media tile vertex shader - the SOFT SHEET.
 *
 * The quad is a subdivided unit plane with position.xy in [0,1]; the
 * camera is orthographic in CSS pixels with y pointing DOWN, so the
 * sheet lands exactly on its (empty) DOM placeholder.
 *
 * The rectangle itself is not a uniform any more: the four corners are
 * simulated on the CPU as individual springs chasing the DOM rect, and
 * the vertex bilinearly interpolates between them. When the page moves,
 * the corners desynchronise (top pair is stiffer than the bottom pair),
 * so the sheet shears, stretches and settles with an overshoot instead
 * of translating as a rigid chunk - which is the whole "flexible image"
 * feel of the reference site.
 *
 * On top of the corner motion, two interior deformations (both need the
 * subdivided mesh - they are zero at every edge):
 *
 *   1. u_bow      - parabolic bulge of the interior against the sheet's
 *                   own velocity: the centre lags the corners.
 *   2. u_expandCurl / u_expandS / u_expandTilt - the showreel morph's
 *                   billow, S-wave and carried tilt.
 * ------------------------------------------------------------------ */

uniform vec2  u_cTL;          // spring corners, css px (document -> viewport space)
uniform vec2  u_cTR;
uniform vec2  u_cBL;
uniform vec2  u_cBR;
uniform vec2  u_domWH;        // reference size for effect scaling
uniform vec2  u_bow;          // px: interior lag, x from horizontal velocity, y vertical
uniform vec2  u_expandCurl;
uniform float u_expandS;      // asymmetric S-bend across the width
uniform float u_expandTilt;   // radians, whole-sheet rotation

varying vec2  v_uv;
varying vec2  v_domWH;

void main() {
  // bilinear interpolation of the four spring corners
  vec2 top = mix(u_cTL, u_cTR, position.x);
  vec2 bot = mix(u_cBL, u_cBR, position.x);
  vec2 p = mix(top, bot, position.y); // position.y = 0 at the top row

  // whole-sheet tilt (the reel being "carried"), around the live centre
  vec2 centre = (u_cTL + u_cTR + u_cBL + u_cBR) * 0.25;
  float c = cos(u_expandTilt), s = sin(u_expandTilt);
  vec2 q = p - centre;
  p = centre + vec2(q.x * c - q.y * s, q.x * s + q.y * c);

  // interior arches: zero on every edge, maximal at the centre line
  float archX = 4.0 * position.x * (1.0 - position.x);
  float archY = 4.0 * position.y * (1.0 - position.y);

  // velocity bow: the sheet's interior trails its corners
  p.y += u_bow.y * archX;
  p.x += u_bow.x * archY;

  // showreel billow + S-wave (cloth being carried by two hands)
  p.y += u_expandCurl.x * u_domWH.y * archX;
  p.x += u_expandCurl.y * u_domWH.x * archY;
  p.y += u_expandS * u_domWH.y * sin(6.2831853 * (position.x - 0.5)) * 0.5;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);

  v_uv = vec2(position.x, position.y);
  v_domWH = u_domWH;
}
