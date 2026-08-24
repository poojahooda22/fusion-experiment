precision highp float;

/* ------------------------------------------------------------------ *
 * Gallery tile fragment shader.
 *
 *   1. CORNER MASK that OPENS on entry: the rounded-box half-size
 *      scales 70% -> 100% with the reveal ratio, so the image grows
 *      open inside its slot while the corners slide/rotate in.
 *
 *   2. SCROLL RIPPLE. A horizontal warp driven by eased scroll
 *      strength - the picture wobbles like liquid while the page
 *      moves fast, and stills when it stops.
 *
 *   3. COVER FIT + HOVER ZOOM, CURSOR FLUID, OPTIONAL DUOTONE -
 *      unchanged from before.
 * ------------------------------------------------------------------ */

uniform sampler2D u_texture;
uniform sampler2D u_paintTexture;   // shared screen-space fluid
uniform vec2  u_paintTexel;
uniform float u_paintPush;
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

  /* hover zoom */
  uv = (uv - 0.5) / mix(1.0, 1.06, u_hoverRatio) + 0.5;

  /* cursor fluid ripple: the paint buffer lives in screen space */
  vec4 paint = texture2D(u_paintTexture, screenUv);
  vec2 flow = (paint.xy - 0.5) * u_paintPush * u_paintTexel;
  float film = paint.z + paint.w;
  uv -= flow * smoothstep(0.0, 0.1, film) * 0.7;

  vec3 color = texture2D(u_texture, uv).rgb;

  /* optional duotone print */
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 tinted = max(u_tint, vec3(luma));
  color = mix(tinted, color, 1.0 - u_hasTint * (1.0 - u_showRatio));

  /* the slick also lifts the print slightly, like light through liquid */
  color += vec3(film * 0.06);

  gl_FragColor = vec4(color, alpha);
}
