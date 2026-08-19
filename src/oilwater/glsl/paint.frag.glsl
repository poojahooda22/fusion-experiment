precision highp float;

/* ------------------------------------------------------------------ *
 * Screen-space "paint" simulation.
 *
 * One RGBA16F buffer, ping-ponged, holding a very cheap 2D fluid:
 *
 *   .rg  velocity            (uv units per second)
 *   .b   film thickness      (fast dissipating - the sharp leading edge)
 *   .a   slow film           (slow dissipating - the lingering broad sheen)
 *
 * Each step: semi-Lagrangian advection, a curl-noise swirl proportional to
 * how much paint is present, the pointer stroke stamped as a capsule, then
 * exponential dissipation. There is no pressure projection - it is not trying
 * to be Navier-Stokes, it is trying to look like oil pushed across glass.
 * ------------------------------------------------------------------ */

varying vec2 v_uv;

uniform sampler2D u_prevPaintTexture;
uniform sampler2D u_lowPaintTexture;  // coarse buffer: broad, coherent motion
uniform vec2  u_texelSize;
uniform vec2  u_aspect;               // (width/height, 1.0)
uniform vec2  u_scrollOffset;         // keeps paint anchored to the page
uniform float u_delta;                // seconds
uniform float u_time;

uniform vec4  u_drawFrom;             // xy = uv, z = radius, w = strength
uniform vec4  u_drawTo;
uniform float u_pushStrength;
uniform vec3  u_dissipations;         // per-frame decay for (vel, film, slow)
uniform vec2  u_vel;                  // global drift, e.g. scroll inertia
uniform float u_advect;
uniform float u_lowInfluence;

#ifdef USE_NOISE
uniform float u_curlScale;
uniform float u_curlStrength;
#endif

/* distance from p to the segment ab - the pointer moves further than one
 * frame's worth of pixels, so the stamp has to be a capsule or the trail
 * comes out as a string of dots */
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}

#ifdef USE_NOISE
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/* value noise that also returns its analytic gradient, so the curl below is
 * exact rather than a finite difference */
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);

  float a = hash12(i + vec2(0.0, 0.0));
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));

  float k0 = a;
  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;

  return vec3(
    k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
    du.x * (k1 + k3 * u.y),
    du.y * (k2 + k3 * u.x)
  );
}

/* curl of a scalar potential is divergence free by construction, which is
 * what makes the swirl look like a fluid instead of like drifting noise */
vec2 curl(vec2 p, float t) {
  vec3 n = noised(p + vec2(t * 0.11, -t * 0.09));
  return vec2(n.z, -n.y);
}
#endif

void main() {
  vec2 uv = v_uv;

  // --- advect ---------------------------------------------------------
  vec2 vel = texture2D(u_prevPaintTexture, uv).rg + u_vel;
  vec2 src = uv - vel * u_delta * u_advect + u_scrollOffset;
  vec4 data = texture2D(u_prevPaintTexture, src);

  // --- borrow the broad motion from the coarse buffer -------------------
  vec4 low = texture2D(u_lowPaintTexture, src);
  data.rg += low.rg * u_lowInfluence * u_delta;

#ifdef USE_NOISE
  // --- swirl, scaled by how much paint is actually here ------------------
  data.rg += curl(uv * u_aspect * u_curlScale, u_time)
           * u_curlStrength * (data.b + data.a * 0.5) * u_delta;
#endif

  // --- stamp the pointer stroke -----------------------------------------
  float radius = max(u_drawTo.z, 1e-4);
  float d = sdSegment(uv * u_aspect, u_drawFrom.xy * u_aspect, u_drawTo.xy * u_aspect);
  float stamp = smoothstep(radius, radius * 0.15, d);

  if (stamp > 0.0) {
    vec2 stroke = (u_drawTo.xy - u_drawFrom.xy);
    data.rg += stroke * stamp * u_pushStrength;
    data.b  += stamp * u_drawTo.w;
    data.a  += stamp * u_drawTo.w * 0.55;
  }

  // --- dissipate (exponential, so it is frame-rate independent) ----------
  vec3 decay = pow(u_dissipations, vec3(u_delta * 60.0));
  data.rg *= decay.x;
  data.b  *= decay.y;
  data.a  *= decay.z;

  // keep the sim from exploding if the pointer is dragged very fast
  data.rg = clamp(data.rg, vec2(-6.0), vec2(6.0));
  data.b  = min(data.b, 2.5);
  data.a  = min(data.a, 2.0);

  gl_FragColor = data;
}
