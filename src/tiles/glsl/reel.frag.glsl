precision highp float;

/* ------------------------------------------------------------------ *
 * REEL SHEET fragment shader.
 *
 *   - rounded-corner mask from an SDF at the CURRENT (per-vertex
 *     interpolated) width/height, anti-aliased with fwidth
 *   - object-fit: cover via CPU u_uvScale/u_uvOffset
 *   - full colour at every stage (no duotone floor on this surface)
 *   - pixel distortion: a coarse per-sheet offset field, brushed by
 *     the cursor and relaxed on the CPU, shifts the lookup in
 *     whole-cell chunks (nearest-filtered)
 * ------------------------------------------------------------------ */

uniform sampler2D u_texture;
uniform sampler2D u_offsetTexture;  // per-sheet distortion field, NEAREST
uniform vec2  u_uvScale;            // cover-fit
uniform vec2  u_uvOffset;
uniform float u_cornerRadius;       // css px

varying vec2  v_uv;
varying vec2  v_wh;
varying float v_sr;

float sdRoundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
  /* rounded mask at the current size, in the sheet's own uv space */
  vec2 p = (v_uv - 0.5) * v_wh;
  float d = sdRoundedBox(p, v_wh * 0.5, u_cornerRadius);
  float alpha = smoothstep(0.0, -fwidth(d), d);
  if (alpha <= 0.001) discard;

  /* cover fit (v_uv.y is screen top-down; texture is bottom-up, so flip) */
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y) * u_uvScale + u_uvOffset;

  /* pixel distortion: whole cells shift together (nearest-filtered) */
  vec2 cellOffset = (texture2D(u_offsetTexture, v_uv).rg - 0.5) * 30.0;
  uv -= 0.02 * cellOffset;

  vec3 color = texture2D(u_texture, uv).rgb;

  gl_FragColor = vec4(color, alpha);
}
