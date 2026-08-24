precision highp float;

/* ------------------------------------------------------------------ *
 * Gallery tile vertex shader.
 *
 * The quad is a subdivided unit plane with position.xy in [0,1]; the
 * camera is orthographic in CSS pixels with y pointing DOWN.
 *
 * The four corners arrive as uniforms already positioned by the CPU -
 * glued to the DOM rect, with the staggered slide-in + rotate entry
 * baked into them - and the vertex bilinearly interpolates between
 * them. On top of that, one interior deformation (zero at every edge,
 * so it needs the subdivided mesh):
 *
 *   u_bow - parabolic bulge of the interior against the sheet's own
 *           velocity: the centre lags the corners, cloth pinned at
 *           its corners.
 * ------------------------------------------------------------------ */

uniform vec2  u_cTL;          // corners, css px (viewport space)
uniform vec2  u_cTR;
uniform vec2  u_cBL;
uniform vec2  u_cBR;
uniform vec2  u_domWH;        // reference size for effect scaling
uniform vec2  u_bow;          // px: interior lag, x horizontal, y vertical

varying vec2  v_uv;
varying vec2  v_domWH;

void main() {
  // bilinear interpolation of the four corners
  vec2 top = mix(u_cTL, u_cTR, position.x);
  vec2 bot = mix(u_cBL, u_cBR, position.x);
  vec2 p = mix(top, bot, position.y); // position.y = 0 at the top row

  // interior arches: zero on every edge, maximal at the centre line
  float archX = 4.0 * position.x * (1.0 - position.x);
  float archY = 4.0 * position.y * (1.0 - position.y);

  // velocity bow: the sheet's interior trails its corners
  p.y += u_bow.y * archX;
  p.x += u_bow.x * archY;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);

  v_uv = vec2(position.x, position.y);
  v_domWH = u_domWH;
}
