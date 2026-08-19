precision highp float;

/* ------------------------------------------------------------------ *
 * Screen-space "paint" simulation.
 *
 * One RGBA16F buffer, ping-ponged, holding a very cheap 2D fluid:
 *
 *   .rg  velocity            (uv units per SECOND)
 *   .b   film thickness      (fast dissipating - the sharp leading edge)
 *   .a   slow film           (slow dissipating - the lingering broad sheen)
 *
 * Each step: diffusion, semi-Lagrangian advection, a curl-noise swirl, the
 * pointer stroke stamped as a capsule, then exponential dissipation. There is
 * no pressure projection - it is not trying to be Navier-Stokes, it is trying
 * to look like oil dragged across glass.
 *
 * Every deposit and every decay is scaled by u_delta, so the effect behaves
 * identically at 30, 60 and 144 fps.
 * ------------------------------------------------------------------ */

varying vec2 v_uv;

uniform sampler2D u_prevPaintTexture;
uniform sampler2D u_lowPaintTexture;  // coarse buffer: broad, coherent motion
uniform vec2  u_texelSize;
uniform vec2  u_aspect;               // (width/height, 1.0)
uniform vec2  u_scrollOffset;         // keeps paint anchored to the page
uniform float u_delta;                // seconds
uniform float u_time;

uniform vec4  u_drawFrom;             // xy = uv, z = radius, w = ink per second
uniform vec4  u_drawTo;
uniform float u_pushStrength;
uniform vec3  u_dissipations;         // per-frame-at-60fps decay for (vel, film, slow)
uniform vec2  u_vel;                  // global drift, e.g. scroll inertia
uniform float u_advect;
uniform float u_lowInfluence;
uniform float u_diffuse;              // 0 = none, ~0.5 = soupy
uniform float u_diffuseRadius;        // in texels

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

  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;

  return vec3(
    a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
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

  /* --- diffuse ---------------------------------------------------------
   * Without this the film is only ever transported and decayed, so it stays
   * exactly as wide as the brush that laid it down. A four-tap laplacian-ish
   * blend is what turns a stroke into a spreading layer. Cheap, and the low
   * buffer does most of the work because it is ~1/9 the resolution.        */
  if (u_diffuse > 0.0) {
    vec2 e = u_texelSize * u_diffuseRadius;
    vec4 nb = 0.25 * (
      texture2D(u_prevPaintTexture, src + vec2(e.x, 0.0)) +
      texture2D(u_prevPaintTexture, src - vec2(e.x, 0.0)) +
      texture2D(u_prevPaintTexture, src + vec2(0.0, e.y)) +
      texture2D(u_prevPaintTexture, src - vec2(0.0, e.y))
    );
    data = mix(data, nb, clamp(u_diffuse * u_delta * 60.0, 0.0, 1.0));
  }

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

  /* Long-tailed falloff rather than smoothstep with a flat core. The flat core
   * had zero gradient, and since the display pass reads the film's gradient to
   * bend the image, a flat core meant the middle of the stroke did nothing and
   * all the refraction happened in a thin ring at its edge. */
  float q = clamp(d / radius, 0.0, 1.0);
  float stamp = (1.0 - q * q) * (1.0 - q * q);

  if (stamp > 0.0) {
    /* u_drawTo - u_drawFrom is a per-FRAME displacement; .rg is read above as
     * uv per SECOND. Dividing by dt is what lets a flick actually throw the
     * paint across the canvas instead of nudging it a few pixels - and it is
     * what makes the push identical at 30 and 144 fps. */
    vec2 stroke = (u_drawTo.xy - u_drawFrom.xy) / max(u_delta, 1e-5);
    data.rg += stroke * stamp * u_pushStrength;

    // ink is deposited per second, so dwelling thickens the film
    float ink = u_drawTo.w * u_delta * 60.0;
    data.b += stamp * ink;
    data.a += stamp * ink * 0.6;
  }

  // --- dissipate (exponential, so it is frame-rate independent) ----------
  vec3 decay = pow(u_dissipations, vec3(u_delta * 60.0));
  data.rg *= decay.x;
  data.b  *= decay.y;
  data.a  *= decay.z;

  // keep the sim from exploding if the pointer is dragged very fast
  data.rg = clamp(data.rg, vec2(-4.0), vec2(4.0));
  data.b  = min(data.b, 1.3);
  data.a  = min(data.a, 1.1);

  gl_FragColor = data;
}
