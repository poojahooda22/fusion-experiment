precision highp float;

/* ------------------------------------------------------------------ *
 * REEL SHEET vertex shader - the "flexible image" unfurl.
 *
 * The morph runs between TWO rects, both fed as their four pixel
 * corners so a resize just moves the endpoints:
 *   from = the small statement card       (u_fromTL..u_fromBR)
 *   to   = the full, centred slot         (u_toTL..u_toBR)
 *
 * The trick that makes it flex instead of scale: every vertex reveals
 * on its OWN ratio (`sr`), derived from a diagonal weight across the
 * plane. The bottom-right begins before the top-left, so the sheet
 * unrolls corner to corner, momentarily shearing, then flattens when
 * all vertices reach 1. The drive is ONE scroll-scrubbed number -
 * scrub back and it unrolls in reverse, stop and it holds.
 * ------------------------------------------------------------------ */

uniform vec2  u_fromTL; uniform vec2 u_fromTR;
uniform vec2  u_fromBL; uniform vec2 u_fromBR;
uniform vec2  u_toTL;   uniform vec2 u_toTR;
uniform vec2  u_toBL;   uniform vec2 u_toBR;
uniform float u_showRatio;                    // scroll scrub, 0..1

varying vec2  v_uv;
varying vec2  v_wh;   // current width/height for the rounded-corner mask
varying float v_sr;   // this vertex's reveal ratio

void main() {
  // diagonal reveal weight: ~1 at screen top-left, ~0 at bottom-right
  float pw = 1.0 - (pow(position.x * position.x, 0.75) + pow(position.y, 1.5)) * 0.5;

  /* global ease on the drive so the whole cloud DECELERATES into full
   * width - a linear scrub lands with visible speed; this sticks */
  float g = u_showRatio * u_showRatio * (3.0 - 2.0 * u_showRatio);

  // remap the eased scrub into a PER-VERTEX ratio -> the unfurl
  float sr = smoothstep(pw * 0.3, 0.7 + pw * 0.3, g);

  // interpolate this vertex's rect corners from card -> full on its own sr
  vec2 tl = mix(u_fromTL, u_toTL, sr);
  vec2 tr = mix(u_fromTR, u_toTR, sr);
  vec2 bl = mix(u_fromBL, u_toBL, sr);
  vec2 br = mix(u_fromBR, u_toBR, sr);

  vec2 top = mix(tl, tr, position.x);
  vec2 bot = mix(bl, br, position.x);
  vec2 p   = mix(top, bot, position.y);

  vec2 wh = vec2(distance(tr, tl), distance(bl, tl));

  // lateral sway that peaks mid-morph (carried by two hands), zero at ends
  p.x += mix(wh.x, 0.0, cos(sr * 6.2831853) * 0.5 + 0.5) * 0.1;

  /* small twist, maximal mid-morph. The bump 16 t^2 (1-t)^2 is zero AND
   * flat at both ends - the old (smoothstep - t) curve ended on a slope,
   * so the sheet was still rotating the instant it reached full width,
   * which read as a bounce at the landing. */
  float rot = -0.05 * 16.0 * sr * sr * (1.0 - sr) * (1.0 - sr);
  vec2 centre = (tl + tr + bl + br) * 0.25;
  vec2 q = p - centre;
  float c = cos(rot), s = sin(rot);
  p = centre + vec2(q.x * c - q.y * s, q.x * s + q.y * c);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);

  v_uv = position.xy;
  v_wh = wh;
  v_sr = sr;
}
