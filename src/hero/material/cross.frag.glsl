precision highp float;

#include ./lib/common.glsl
#include ./lib/raytrace.glsl

varying vec3  vWorldPosition;
varying vec3  vWorldNormal;
varying vec3  vViewNormal;
varying vec3  vLocalPosition;
varying vec3  vLocalNormal;
varying float vAo;
varying float vThickness;

/* --- who am I ------------------------------------------------------ */
uniform vec4 u_selfPositionRadius;   // xyz = world centre, w = bounding radius
uniform vec4 u_selfRotation;         // quaternion

/* --- who is near me ------------------------------------------------ */
uniform vec4 u_nearPositionRadiusList[NEIGHBOUR_COUNT];
uniform vec4 u_nearRotationList[NEIGHBOUR_COUNT];
uniform vec3 u_nearColorList[NEIGHBOUR_COUNT];
uniform vec2 u_nearTransparencyLumaList[NEIGHBOUR_COUNT]; // x = light transmitted, y = luma

/* --- proxy shape --------------------------------------------------- */
uniform vec2 u_armRatio;             // (armHalfLength, armRadius) / boundingRadius

/* --- material ------------------------------------------------------ */
uniform vec3  u_color;
uniform vec3  u_bgColor;
uniform float u_roughness;
uniform float u_metalness;
uniform float u_reflectivity;
uniform float u_specular;
uniform float u_sss;
uniform vec3  u_sssColor;
uniform float u_aoStrength;
uniform float u_exposure;
uniform float u_opacity;
uniform float u_selfTransmission;   // how much light passes through *this* object

/* --- lighting / sampling ------------------------------------------- */
uniform vec3      u_lightPosition;
uniform float     u_shadowSoftness;   // larger = tighter penumbra
uniform sampler2D u_matcap;
uniform float     u_microTexture;     // strength of the stable surface grain
uniform float     u_microScale;       // grain frequency, in local units
uniform float     u_time;

#ifdef FROSTED
uniform sampler2D u_refractionTexture;
uniform vec2      u_resolution;
uniform float     u_ior;
uniform float     u_refractionStrength;
uniform float     u_refractionLod;
uniform float     u_refractionSpread;
#endif

/* ------------------------------------------------------------------ *
 * Ray casts against the neighbourhood
 * ------------------------------------------------------------------ */

/* Nearest hit. Also returns the surface normal and albedo of whatever we hit
 * so the reflection can be shaded rather than just tinted. */
float traceNeighbourhood(vec3 ro, vec3 rd, out vec3 hitNormal, out vec3 hitColor) {
  float best = 1e19;
  hitNormal = vec3(0.0);
  hitColor  = vec3(0.0);

  /* Ourselves first - this is what gives the crosses real self-reflection
   * between their own arms.
   *
   * Three things have to be true at once here or the self trace draws lines on
   * the object instead of reflections in it:
   *
   * 1. The proxy has to be close to the real arm. It used to be shrunk to 78%
   *    of the length, which left the outer 22% of every arm with no proxy at
   *    all and put a hard ring where the missing cap's shadow cone landed.
   * 2. A ray whose origin is INSIDE the proxy must not be traced. The bore
   *    wall sits at r = 0.11 but the proxy radius is 0.26, so after the normal
   *    offset most bore fragments start inside it and get a hit taken from the
   *    inside - an outward-facing normal and a meaningless colour, which is
   *    what painted the flat ring down every bore.
   * 3. The near-hit reject must be a RAMP, not a cut. A binary threshold is a
   *    curve on the surface separating "traced" (dark) from "environment"
   *    (bright), and at grazing incidence reflAmount is ~0.96, so that curve is
   *    close to a full-contrast line. Fading the self colour in over the near
   *    band removes the boundary entirely.                                   */
  {
    vec4 pr = u_selfPositionRadius;
    vec4 q  = u_selfRotation;
    vec3 lo = qrotate(qinverse(q), ro - pr.xyz);
    vec3 ld = qrotate(qinverse(q), rd);

    float ph = pr.w * u_armRatio.x * 0.94;   // proxy half-length
    float prr = pr.w * u_armRatio.y * 0.97;  // proxy radius
    vec3  al = abs(lo);
    bool inside = (al.x < ph && length(lo.yz) < prr)
               || (al.y < ph && length(lo.zx) < prr)
               || (al.z < ph && length(lo.xy) < prr);

    if (!inside) {
      vec3 n;
      float t = intersectCross(lo, ld, ph, prr, n);
      if (t > 0.0 && t < best) {
        best = t;
        hitNormal = qrotate(q, n);
        hitColor  = mix(u_bgColor * 0.4, u_color, smoothstep(pr.w * 0.10, pr.w * 0.30, t));
      }
    }
  }

  for (int i = 0; i < NEIGHBOUR_COUNT; i++) {
    vec4 pr = u_nearPositionRadiusList[i];
    if (pr.w <= 0.0) continue;
    if (!boundingSphereHit(ro, rd, pr.xyz, pr.w, best)) continue;

    vec4 q  = u_nearRotationList[i];
    vec4 qi = qinverse(q);
    vec3 lo = qrotate(qi, ro - pr.xyz);
    vec3 ld = qrotate(qi, rd);
    vec3 n;
    float t = intersectCross(lo, ld, pr.w * u_armRatio.x, pr.w * u_armRatio.y, n);
    if (t > 0.0 && t < best) {
      best = t;
      hitNormal = qrotate(q, n);
      hitColor  = u_nearColorList[i];
    }
  }

  return best < 1e18 ? best : -1.0;
}

/*
 * Visibility toward the key light.
 *
 * This deliberately does NOT trace. A traced shadow ray returns 0 or 1, so
 * covering a penumbra means sampling it stochastically, and one or two samples
 * per pixel dither into blotchy salt-and-pepper that antialiasing cannot touch
 * - it was the single biggest source of "dirty" looking surfaces here.
 *
 * The analytic sphere shadow is smooth by construction, exact for a sphere,
 * costs one sqrt per neighbour instead of three cylinder intersections, and
 * the crosses' own arm-on-arm shadowing is already baked into aAo.
 */
float neighbourShadow(vec3 p, vec3 lightDir) {
  float vis = 1.0;
  for (int i = 0; i < NEIGHBOUR_COUNT; i++) {
    vec4 pr = u_nearPositionRadiusList[i];
    if (pr.w <= 0.0) continue;
    // the cross fills roughly 60% of its bounding sphere
    float s = sphereSoftShadow(p, lightDir, vec4(pr.xyz, pr.w * 0.6), u_shadowSoftness);
    vis *= mix(s, 1.0, u_nearTransparencyLumaList[i].x);
  }
  return vis;
}

/* Contact occlusion + one bounce of colour bleeding, both from the analytic
 * sphere-occlusion integral rather than from rays. Cheap and stable. */
float neighbourOcclusion(vec3 p, vec3 n, out vec3 bleed) {
  float occ = 0.0;
  bleed = vec3(0.0);
  for (int i = 0; i < NEIGHBOUR_COUNT; i++) {
    vec4 pr = u_nearPositionRadiusList[i];
    if (pr.w <= 0.0) continue;
    // the cross fills roughly 60% of its bounding sphere
    float o = sphereOcclusion(p, n, vec4(pr.xyz, pr.w * 0.62));
    o *= 1.0 - u_nearTransparencyLumaList[i].x * 0.7;
    occ   += o;
    bleed += u_nearColorList[i] * o * u_nearTransparencyLumaList[i].y;
  }
  return clamp(1.0 - occ * u_aoStrength, 0.0, 1.0);
}

vec3 shadeReflectionHit(vec3 albedo, vec3 n, vec3 rd, vec3 lightDir) {
  /* A hit taken from inside the proxy returns an outward normal facing away
     from the ray, which pins rim to 1.0 and paints a flat direction-independent
     colour. Flipping it to face the ray costs nothing and fixes the bore. */
  n = faceforward(n, rd, n);
  float ndl = saturate1(dot(n, lightDir));
  float rim = pow(1.0 - saturate1(dot(n, -rd)), 3.0);
  return albedo * (0.16 + 0.95 * ndl) + vec3(0.45) * rim * 0.3;
}

/* ------------------------------------------------------------------ */

/* How much of the flock survives where no light rakes across the surface.
   0.0 = perfectly smooth in shadow, 1.0 = the old constant-amplitude grain. */
#define MICRO_SHADOW_FLOOR 0.10

void main() {
  vec3 N  = normalize(vWorldNormal);
  vec3 vn = normalize(vViewNormal);
  if (!gl_FrontFacing) { N = -N; vn = -vn; }

  vec3  P     = vWorldPosition;
  float scale = u_selfPositionRadius.w;
  float eps   = scale * 0.055;

  /* ---- 0. occlusion + shadow, from the SMOOTH normal -----------------
   * Both are broad geometric terms that depend on where the piece sits, not
   * on its micro-relief, so they are computed before the grain is applied.
   * Taking them first is what lets the grain below be scaled by how much
   * light this point actually receives. Using the un-perturbed normal for
   * the shadow ray origin is also strictly more correct: a fraction of a
   * degree of surface grain should not move where the ray starts.          */
  vec3  bleed;
  float ao = neighbourOcclusion(P, N, bleed) * mix(1.0, vAo, 0.9);

  vec3  lightVec  = u_lightPosition - P;
  float lightDist = length(lightVec);
  vec3  L         = lightVec / lightDist;
  float shadow    = neighbourShadow(P + N * eps, L);

  /* ---- 0b. stable micro-surface -------------------------------------
   * Evaluated in local space and rotated into world space, so the grain is
   * welded to the plastic and tumbles with it. Applied to BOTH the world
   * normal (reflections, shadow) and the view normal (matcap), or the body
   * shading would stay glassy while only the reflections got texture.
   *
   * Its strength follows the light. Surface relief is only visible when
   * something rakes across it: in shadow there is no directional light to
   * catch the flock, so a constant-amplitude perturbation there is not
   * texture at all - it is a fixed-size wobble sitting on top of an almost
   * black surface, and against that surface its CONTRAST is what reads as
   * dirt. Measured on the un-gated version, the grain held a near-constant
   * absolute amplitude while the signal fell away, so relative noise climbed
   * from ~1.3% on lit surfaces to ~9.6% in the darkest bands. A floor is
   * kept so the material never goes completely smooth and plastic.         */
  if (u_microTexture > 0.0) {
    float raking = saturate1(dot(N, L))
                 * mix(0.15, 1.0, shadow)
                 * mix(0.25, 1.0, ao);
    /* Band-limit against the pixel footprint. One noise cell spans
       1/u_microScale in local units; fwidth gives how much local space a
       single pixel covers at this fragment. Where a pixel spans most of a
       cell the grain is past Nyquist and stops being texture: it turns into
       the wire-mesh moire that shows up on grazing faces and on bore rims,
       where foreshortening stretches the footprint. Fade it out there
       rather than sampling something the raster cannot resolve. */
    vec3  fpd  = fwidth(vLocalPosition);
    float cell = 1.0 / max(u_microScale, 1e-3);
    float band = 1.0 - smoothstep(cell * 0.35, cell * 1.0,
                                  max(max(fpd.x, fpd.y), fpd.z));

    float amount = u_microTexture * mix(MICRO_SHADOW_FLOOR, 1.0, raking) * band;

    vec3 g = qrotate(u_selfRotation, microGradient(vLocalPosition, u_microScale));
    g -= N * dot(g, N);                       // tangential component only
    N  = normalize(N + g * amount);
    vn = normalize(vn + (viewMatrix * vec4(g, 0.0)).xyz * amount);
  }

  vec3  V   = normalize(cameraPosition - P);
  float ndv = saturate1(dot(N, V));

  /* ---- 1. base shading from the baked studio matcap ---------------- */
  vec4 mc = texture2D(u_matcap, vn.xy * 0.5 + 0.5);

  /* ---- 4. reflection ----------------------------------------------- *
   * One deterministic ray. There is no jitter anywhere: a stochastic ray
   * flips between "hit a neighbour" (dark) and "escaped to the environment"
   * (bright) from pixel to pixel, which is a two-tone dither, not a blur.
   * Instead the traced sample is faded out entirely as roughness rises, so a
   * matte surface is lit purely by the smooth analytic environment and carries
   * no sampling artefacts at all.                                          */
  vec3  lightDir = normalize(u_lightPosition);
  float mirrorness = 1.0 - smoothstep(0.05, 0.26, u_roughness);

  vec3 reflection = environment(reflect(-V, N), lightDir, u_bgColor);
  if (mirrorness > 0.0) {
    vec3  hitNormal, hitColor;
    vec3  R  = reflect(-V, N);
    float rt = traceNeighbourhood(P + N * eps, R, hitNormal, hitColor);
    vec3  traced = rt > 0.0
        ? shadeReflectionHit(hitColor, hitNormal, R, L)
        : environment(R, lightDir, u_bgColor);
    reflection = mix(reflection, traced, mirrorness);
  }

  float fres       = fresnelSchlick(ndv, 0.045);
  float reflAmount = mix(fres, 1.0, u_metalness) * u_reflectivity * mix(1.0, 0.16, u_roughness);

  /* ---- 5. compose --------------------------------------------------- */
  vec3 albedo  = u_color;
  vec3 diffuse = albedo * mc.rgb;
  diffuse     += albedo * bleed * 0.24;               // one bounce of colour bleed
  diffuse     *= ao;
  /* The shadow side has to read as the SAME material as the lit side. Crushing
   * it to a third of its value turns a plain painted surface into two different
   * finishes joined by a terminator. */
diffuse     *= mix(0.55, 1.0, shadow);

  vec3 col = diffuse;
  col += reflection * reflAmount * mix(0.5, 1.0, ao);
  col += mc.a * u_specular * mix(0.45, 1.0, shadow) * mix(0.55, 1.0, ao);

  /* ---- 6. subsurface scattering ------------------------------------ */
  if (u_sss > 0.0) {
    float back  = saturate1(dot(-N, L)) * 0.6 + 0.4;
    float wrap  = pow(saturate1(dot(V, -L)), 2.5);
    float thin  = 1.0 - vThickness;
    col += u_sssColor * u_sss * thin * (back * 0.55 + wrap * 0.65) * mix(0.3, 1.0, shadow);
  }

  float alpha = u_opacity;

  /* ---- 7. refraction through the frosted instances ------------------ */
  #ifdef FROSTED
  {
    vec3 refrDir  = refract(-V, N, 1.0 / u_ior);
    vec3 refrView = (viewMatrix * vec4(refrDir, 0.0)).xyz;
    vec2 uvScreen = gl_FragCoord.xy / u_resolution;
    vec2 uvR      = uvScreen + refrView.xy * u_refractionStrength * (1.0 - ndv * 0.45);

    // a fixed cross-shaped tap pattern, not a jittered one: random offsets
    // here produced exactly the same two-tone dither as the shadow rays did
    vec2 j = vec2(u_refractionSpread, 0.0);
    vec2 k = vec2(0.0, u_refractionSpread);
    vec3 behind =
        texture2DLodEXT(u_refractionTexture, clamp(uvR,     vec2(0.003), vec2(0.997)), u_refractionLod).rgb * 0.4 +
        texture2DLodEXT(u_refractionTexture, clamp(uvR + j, vec2(0.003), vec2(0.997)), u_refractionLod).rgb * 0.15 +
        texture2DLodEXT(u_refractionTexture, clamp(uvR - j, vec2(0.003), vec2(0.997)), u_refractionLod).rgb * 0.15 +
        texture2DLodEXT(u_refractionTexture, clamp(uvR + k, vec2(0.003), vec2(0.997)), u_refractionLod).rgb * 0.15 +
        texture2DLodEXT(u_refractionTexture, clamp(uvR - k, vec2(0.003), vec2(0.997)), u_refractionLod).rgb * 0.15;

    behind *= mix(vec3(1.0), albedo, 0.7);
    behind *= mix(0.55, 1.0, ao);
    col = mix(behind, col, mix(0.34, 1.0, fres));
    alpha = 1.0;
  }
  #endif

  /* ---- 8. output ----------------------------------------------------
   * Linear HDR, deliberately un-tonemapped and unclamped: bloom needs the
   * values above 1.0 that the key-light reflection produces. The single ACES
   * tonemap + sRGB transfer happens at the very end of the post chain.        */
  gl_FragColor = vec4(col * u_exposure, alpha);
}
