precision highp float;

/* ------------------------------------------------------------------ *
 * Media tile fragment shader.
 *
 *   1. CORNER MASK. A rounded-box SDF at the tile's full size clips the
 *      corners (the quad itself is rectangular), anti-aliased with
 *      fwidth. Entry is NOT a wipe any more: the sheet arrives whole -
 *      the corner springs carry the motion - and this mask only rounds
 *      the corners while u_showRatio fades the whole sheet in.
 *
 *   2. COVER FIT + HOVER ZOOM. UVs are scaled/offset on the CPU for
 *      CSS-style object-fit: cover; hover adds a small centred zoom.
 *
 *   3. CURSOR FLUID. The shared paint buffer displaces the sample
 *      position wherever the cursor's slick crosses the tile.
 *
 *   4. OPTIONAL DUOTONE. Only a tile that declares data-tint renders
 *      the two-tone print (max(tint, luma)); expansion restores full
 *      colour. Tiles without a tint are always full colour.
 * ------------------------------------------------------------------ */

uniform sampler2D u_texture;
uniform sampler2D u_paintTexture;   // shared screen-space fluid
uniform vec2  u_paintTexel;
uniform float u_paintPush;          // sim advection scale, for the ripple
uniform vec2  u_viewport;           // css px
uniform vec2  u_uvScale;            // cover-fit
uniform vec2  u_uvOffset;
uniform vec3  u_tint;               // duotone floor colour
uniform float u_hasTint;            // 0 = always full colour
uniform float u_cornerRadius;       // css px
uniform float u_showRatio;          // eased 0..1, drives the entry fade
uniform float u_hoverRatio;         // eased 0..1
uniform float u_expandRatio;        // showreel expansion, eased 0..1

varying vec2  v_uv;
varying vec2  v_domWH;

/* signed distance to a rounded box centred at the origin */
float sdRoundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
  /* corner mask at full size, in the sheet's own (undeformed) uv space */
  vec2 p = (v_uv - 0.5) * v_domWH;
  float d = sdRoundedBox(p, v_domWH * 0.5, u_cornerRadius);
  float alpha = smoothstep(0.0, -fwidth(d), d);
  alpha *= u_showRatio;
  if (alpha <= 0.001) discard;

  /* cover fit + hover zoom (v_uv.y runs top-down like the DOM; texture
   * space runs bottom-up, so flip before the cover transform) */
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y) * u_uvScale + u_uvOffset;
  uv = (uv - 0.5) / mix(1.0, 1.06, u_hoverRatio) + 0.5;

  /* cursor fluid ripple: the paint buffer lives in screen space */
  vec2 screenUv = gl_FragCoord.xy / (u_viewport);
  vec4 paint = texture2D(u_paintTexture, screenUv);
  vec2 flow = (paint.xy - 0.5) * u_paintPush * u_paintTexel;
  float film = paint.z + paint.w;
  uv -= flow * smoothstep(0.0, 0.1, film) * 0.7;

  vec3 color = texture2D(u_texture, uv).rgb;

  /* optional duotone print; expansion earns the colour back */
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 tinted = max(u_tint, vec3(luma));
  float colorRatio = max(1.0 - u_hasTint, u_expandRatio);
  color = mix(tinted, color, colorRatio);

  /* the slick also lifts the print slightly, like light through liquid */
  color += vec3(film * 0.06);

  gl_FragColor = vec4(color, alpha);
}
