precision highp float;

/* ------------------------------------------------------------------ *
 * Media tile fragment shader.
 *
 * Four responsibilities, in order:
 *
 *   1. REVEAL MASK. The tile's visible area is a rounded box whose
 *      half-size grows with the show ratio, radiating outward from
 *      u_radialCenter: the box can never extend further than
 *      showRatio * (distance to the farthest corner), so the tile
 *      opens up from that point like a spreading droplet, corners
 *      last. Anti-aliased with fwidth, corner radius u_cornerRadius.
 *
 *   2. COVER FIT + HOVER ZOOM. UVs are scaled/offset on the CPU for
 *      CSS-style object-fit: cover; hover adds a small centred zoom.
 *
 *   3. CURSOR FLUID. The shared paint buffer (same sim as the oil
 *      pass) displaces the sample position wherever the cursor's
 *      slick crosses the tile, so images ripple under the pointer.
 *
 *   4. DUOTONE -> COLOUR. The unrevealed image is a two-tone print:
 *      luminance with a colour floor - max(u_tint, luma) sends the
 *      shadows to ultramarine and the highlights to paper white.
 *      The mix to full colour rides the show ratio; a tile flagged
 *      u_keepTint (the showreel) stays duotone forever.
 * ------------------------------------------------------------------ */

uniform sampler2D u_texture;
uniform sampler2D u_paintTexture;   // shared screen-space fluid
uniform vec2  u_paintTexel;
uniform float u_paintPush;          // sim advection scale, for the ripple
uniform vec2  u_viewport;           // css px
uniform vec2  u_uvScale;            // cover-fit
uniform vec2  u_uvOffset;
uniform vec3  u_tint;               // duotone floor colour
uniform float u_keepTint;           // 1 = stay duotone after reveal
uniform float u_cornerRadius;       // css px
uniform vec2  u_radialCenter;       // uv the reveal radiates from
uniform float u_showRatio;          // eased, same value the vertex saw
uniform float u_hoverRatio;         // eased 0..1
uniform float u_expandRatio;        // showreel expansion, eased 0..1

varying vec2  v_uv;
varying vec2  v_domWH;
varying float v_showRatio;

/* signed distance to a rounded box centred at the origin */
float sdRoundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float revealMask(vec2 uv) {
  vec2 halfSize = v_domWH * 0.5;
  float aspect = v_domWH.x / v_domWH.y;

  // farthest corner from the radial centre, aspect corrected, in px
  vec2 toCorner = max(u_radialCenter, 1.0 - u_radialCenter) * v_domWH;
  float maxDist = length(toCorner);

  float t = u_showRatio * maxDist;
  float minSize = min(halfSize.x, halfSize.y);
  float maxSize = max(halfSize.x, halfSize.y);

  // corner radius eases in as the box grows past the small side
  float radius = mix(
    minSize * clamp(t / max(minSize, 1.0), 0.0, 1.0),
    u_cornerRadius,
    clamp((t - maxSize) / max(maxDist - maxSize, 1.0), 0.0, 1.0)
  );

  // the box may not extend past the reveal front
  halfSize = min(halfSize, vec2(t));

  vec2 p = (uv - u_radialCenter) * v_domWH;
  float d = sdRoundedBox(p, halfSize, radius);
  return smoothstep(0.0, -fwidth(d), d);
}

void main() {
  float alpha = revealMask(v_uv);
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

  /* duotone print of the same frame */
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 tinted = max(u_tint, vec3(luma));

  /* Reveal decides colour for ordinary tiles; a keep-tint tile (the
   * showreel) stays duotone UNTIL it expands - growing to full width is
   * what earns it its colour back, exactly like the reference. */
  float colorRatio = max(v_showRatio * (1.0 - u_keepTint), u_expandRatio);
  color = mix(tinted, color, colorRatio);

  /* the slick also lifts the print slightly, like light through liquid */
  color += vec3(film * 0.06);

  gl_FragColor = vec4(color, alpha);
}
