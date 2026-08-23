precision highp float;

/* ------------------------------------------------------------------ *
 * Ribbon fragment: silhouette + caps + tube shading, all from one
 * distance field.
 *
 * d = distance (px) from this fragment to the nearest point of the
 * VISIBLE centreline segment [hideRatio .. showRatio]:
 *
 *   - inside the window, that is just the lateral offset |side * halfW|
 *   - beyond either end, the longitudinal overshoot (in px, via the
 *     total arc length) joins the lateral offset in a length(), which
 *     makes the cut at d = halfW an exact SEMICIRCLE - the round pen
 *     tip of the reference, at every scroll position, both ends.
 *
 * The same d/halfW drives the rounded-section shading, so the cap
 * shades like a sphere and the body like a tube, with no seam.
 * ------------------------------------------------------------------ */

uniform vec3  u_color0;   // head colour
uniform vec3  u_color1;   // tail colour
uniform float u_width;
uniform float u_totalArc;
uniform float u_showRatio;
uniform float u_hideRatio;

varying float v_side;
varying float v_ratio;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  rgb = rgb * rgb * (3.0 - 2.0 * rgb);
  return c.z * mix(vec3(1.0), rgb, c.y);
}

void main() {
  float halfW = u_width * 0.5;
  float lat = v_side * halfW;

  // longitudinal overshoot past the visible ends, in px of arc
  float over = max(v_ratio - u_showRatio, u_hideRatio - v_ratio);
  float longPx = max(over, 0.0) * u_totalArc;
  float d = length(vec2(longPx, lat));

  float aa = max(fwidth(d), 0.75);
  float alpha = smoothstep(halfW, halfW - aa * 1.6, d);
  if (alpha <= 0.002) discard;

  // colour gradient along the arc, interpolated in HSV so the blue stays
  // saturated through the blend instead of dipping grey
  float t = 1.0 - pow(1.0 - clamp(v_ratio, 0.0, 1.0), 2.0);
  vec3 a = rgb2hsv(u_color1);
  vec3 b = rgb2hsv(u_color0);
  float hue = (mod(mod(b.x - a.x, 1.0) + 1.5, 1.0) - 0.5) * t + a.x;
  vec3 color = hsv2rgb(vec3(hue, mix(a.yz, b.yz, t)));

  // rounded-section shading from the same field: tube body, sphere cap
  float sN = clamp(d / halfW, 0.0, 1.0);
  color *= 0.80 + 0.20 * sqrt(max(1.0 - sN * sN, 0.0));
  // the gloss line a rounded extrusion catches from a top light
  color += 0.06 * smoothstep(0.55, 0.0, abs(v_side + 0.35));

  gl_FragColor = vec4(color, alpha);
}
