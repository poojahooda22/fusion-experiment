precision highp float;

/* ------------------------------------------------------------------ *
 * Gallery tile fragment shader.
 *
 *   1. CORNER MASK that OPENS on entry: the rounded-box half-size
 *      scales 70% -> 100% with the reveal ratio, so the image grows
 *      open inside its slot while the corners slide/rotate in.
 *
 *   2. SCROLL RIPPLE. A horizontal warp driven by eased scroll
 *      strength - the picture wobbles while the page moves fast.
 *
 *   3. PIXEL DISTORTION. A coarse per-tile offset field, brushed by
 *      the cursor and relaxed every frame on the CPU, shifts the
 *      lookup in whole-cell chunks (nearest-filtered).
 *
 *   4. COVER FIT + OPTIONAL DUOTONE - unchanged.
 * ------------------------------------------------------------------ */

uniform sampler2D u_texture;
uniform sampler2D u_offsetTexture;  // per-tile distortion field, NEAREST
uniform vec2  u_viewport;           // css px
uniform vec2  u_uvScale;            // cover-fit
uniform vec2  u_uvOffset;
uniform vec3  u_tint;               // duotone floor colour
uniform float u_hasTint;            // 0 = always full colour
uniform float u_cornerRadius;       // css px
uniform float u_showRatio;          // eased 0..1 entry
uniform float u_hoverRatio;         // eased 0..1
uniform float u_rippleStrength;     // scroll-velocity warp, 0..0.15

varying vec2  v_uv;
varying vec2  v_domWH;

float sdRoundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
  /* corner mask, opening 70% -> 100% with the reveal */
  vec2 halfWH = v_domWH * 0.5 * mix(0.7, 1.0, u_showRatio);
  vec2 pm = (v_uv - 0.5) * v_domWH;
  float d = sdRoundedBox(pm, halfWH, u_cornerRadius);
  float alpha = smoothstep(0.0, -fwidth(d), d);
  if (alpha <= 0.001) discard;

  /* cover fit (v_uv.y runs top-down like the DOM; texture space runs
   * bottom-up, so flip before the cover transform) */
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y) * u_uvScale + u_uvOffset;

  /* scroll-velocity ripple: strongest mid-screen, fades at the edges */
  vec2 screenUv = gl_FragCoord.xy / u_viewport;
  uv.x -= (screenUv.x - 0.5) * (1.0 - sin(screenUv.y * 3.14159265)) * u_rippleStrength;

  /* pixel distortion: a coarse offset field (one vector per grid cell,
   * NEAREST-sampled so whole cells shift together - the blocky smear)
   * displaces the photo's lookup. The CPU brushes cursor velocity into
   * the field and relaxes it toward zero every frame, so swipes smear
   * the picture in chunks and it heals when the cursor rests. */
  vec2 cellOffset = (texture2D(u_offsetTexture, v_uv).rg - 0.5) * 30.0;
  uv -= 0.02 * cellOffset;

  vec3 color = texture2D(u_texture, uv).rgb;

  /* optional duotone print */
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 tinted = max(u_tint, vec3(luma));
  color = mix(tinted, color, 1.0 - u_hasTint * (1.0 - u_showRatio));

  gl_FragColor = vec4(color, alpha);
}
