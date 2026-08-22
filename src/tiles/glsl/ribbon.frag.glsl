precision highp float;

/* ------------------------------------------------------------------ *
 * Ribbon fragment: everything that makes the flat strip read as a fat
 * 3D tube.
 *
 *   1. edge AA from the side coordinate + fwidth (the reference does
 *      exactly this - no MSAA needed for a clean silhouette)
 *   2. a colour gradient along the arc, interpolated IN HSV so the blue
 *      stays saturated through the blend instead of dipping grey
 *   3. lateral shading: darker toward both edges (curvature), plus a
 *      soft highlight band just off-centre - the "gloss line" a rounded
 *      extrusion would catch from a top light
 * ------------------------------------------------------------------ */

uniform vec3 u_color0;   // head colour
uniform vec3 u_color1;   // tail colour

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
  float t = 1.0 - pow(1.0 - clamp(v_ratio, 0.0, 1.0), 2.0);
  vec3 a = rgb2hsv(u_color1);
  vec3 b = rgb2hsv(u_color0);
  float hue = (mod(mod(b.x - a.x, 1.0) + 1.5, 1.0) - 0.5) * t + a.x;
  vec3 color = hsv2rgb(vec3(hue, mix(a.yz, b.yz, t)));

  float s = abs(v_side);
  // rounded-section shading + gloss line
  color *= 0.80 + 0.20 * sqrt(max(1.0 - s * s, 0.0));
  color += 0.06 * smoothstep(0.55, 0.0, abs(v_side + 0.35));

  float alpha = smoothstep(1.0, 1.0 - fwidth(v_side) * 1.6, s);
  gl_FragColor = vec4(color, alpha);
}
