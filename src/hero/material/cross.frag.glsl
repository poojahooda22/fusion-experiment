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
uniform float     u_lightRadius;
uniform sampler2D u_matcap;
uniform sampler2D u_blueNoiseTexture;
uniform vec2      u_blueNoiseTexelSize;
uniform vec2      u_blueNoiseCoordOffset;
uniform float     u_time;

#ifdef FROSTED
uniform sampler2D u_refractionTexture;
uniform vec2      u_resolution;
uniform float     u_ior;
uniform float     u_refractionStrength;
uniform float     u_refractionLod;
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
   * The self proxy is shrunk hard, and the length far more than the radius.
   * The proxy is a SOLID capped cylinder but the real arm tip is an annulus
   * with a bore through it, so a proxy cap sitting at the true tip plane
   * intercepts exactly the rays that should escape through the hole - which
   * showed up as a ring of salt-and-pepper speckle around every bore. Pulling
   * the cap back behind the bore floor removes it, and costs nothing that
   * matters: arm-to-arm self reflection happens on the sides, not the caps. */
  {
    vec4 pr = u_selfPositionRadius;
    vec4 q  = u_selfRotation;
    vec3 lo = qrotate(qinverse(q), ro - pr.xyz);
    vec3 ld = qrotate(qinverse(q), rd);
    vec3 n;
    float t = intersectCross(lo, ld, pr.w * u_armRatio.x * 0.78, pr.w * u_armRatio.y * 0.88, n);
    if (t > 0.0 && t < best) {
      best = t;
      hitNormal = qrotate(q, n);
      hitColor  = u_color;
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

/* Any-hit visibility toward the light, accumulating transmission so that a
 * frosted neighbour throws a lighter shadow than an opaque one. */
float traceShadow(vec3 ro, vec3 rd, float maxT) {
  float vis = 1.0;

  {
    vec4 pr = u_selfPositionRadius;
    vec4 qi = qinverse(u_selfRotation);
    vec3 n;
    float t = intersectCross(qrotate(qi, ro - pr.xyz), qrotate(qi, rd),
                             pr.w * u_armRatio.x * 0.78, pr.w * u_armRatio.y * 0.88, n);
    if (t > 0.0 && t < maxT) vis *= u_selfTransmission;
  }

  for (int i = 0; i < NEIGHBOUR_COUNT; i++) {
    vec4 pr = u_nearPositionRadiusList[i];
    if (pr.w <= 0.0) continue;
    if (vis < 0.01) break;
    if (!boundingSphereHit(ro, rd, pr.xyz, pr.w, maxT)) continue;

    vec4 qi = qinverse(u_nearRotationList[i]);
    vec3 n;
    float t = intersectCross(qrotate(qi, ro - pr.xyz), qrotate(qi, rd),
                             pr.w * u_armRatio.x, pr.w * u_armRatio.y, n);
    if (t > 0.0 && t < maxT) vis *= u_nearTransparencyLumaList[i].x;
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
  float ndl = saturate1(dot(n, lightDir));
  float rim = pow(1.0 - saturate1(dot(n, -rd)), 3.0);
  return albedo * (0.16 + 0.95 * ndl) + vec3(0.45) * rim * 0.3;
}

/* ------------------------------------------------------------------ */

void main() {
  vec3 N = normalize(vWorldNormal);
  if (!gl_FrontFacing) N = -N;

  vec3  P     = vWorldPosition;
  vec3  V     = normalize(cameraPosition - P);
  float ndv   = saturate1(dot(N, V));
  float scale = u_selfPositionRadius.w;
  float eps   = scale * 0.055;

  vec2 rnd = blueNoise2(u_blueNoiseTexture, gl_FragCoord.xy,
                        u_blueNoiseTexelSize, u_blueNoiseCoordOffset);

  /* ---- 1. base shading from the baked studio matcap ---------------- */
  vec3  vn  = normalize(vViewNormal);
  vec4  mc  = texture2D(u_matcap, vn.xy * 0.5 + 0.5);

  /* ---- 2. occlusion ------------------------------------------------ */
  vec3  bleed;
  float ao = neighbourOcclusion(P, N, bleed) * mix(1.0, vAo, 0.9);

  /* ---- 3. shadow ray toward the key light -------------------------- */
  vec3  lightVec  = u_lightPosition - P;
  float lightDist = length(lightVec);
  vec3  L         = lightVec / lightDist;
  // jitter by the light's angular radius -> penumbra for free
  /* Two samples, not one. A shadow ray returns 0 or 1, so a single stochastic
   * test across a penumbra dithers into visible salt-and-pepper that no amount
   * of antialiasing removes. Two decorrelated samples quarter the variance for
   * one extra trace, which is the cheapest quality-per-millisecond in the
   * whole shader. */
  float spread    = u_lightRadius / lightDist;
  vec3  Lj        = jitterDirection(L, N, spread, rnd.yx);
  vec3  Lj2       = jitterDirection(L, N, spread, vec2(1.0 - rnd.y, rnd.x));
  float shadow    = 0.5 * (traceShadow(P + N * eps, Lj,  lightDist)
                         + traceShadow(P + N * eps, Lj2, lightDist));

  /* ---- 4. reflection ray ------------------------------------------- */
  vec3 lightDir = normalize(u_lightPosition);
  vec3 R  = reflect(-V, N);
  vec3 Rj = jitterDirection(R, N, u_roughness * 0.32, rnd);

  vec3  hitNormal, hitColor;
  float rt = traceNeighbourhood(P + N * eps, Rj, hitNormal, hitColor);
  vec3  reflection = rt > 0.0
      ? shadeReflectionHit(hitColor, hitNormal, Rj, L)
      : environment(Rj, lightDir, u_bgColor);

  /* One traced sample is plenty for a mirror, but on a rough surface the
   * hit/miss decision flips from pixel to pixel and reads as salt and pepper.
   * A rough reflection converges to the average of its cone anyway, so fade the
   * noisy sample out entirely as roughness rises: by 0.5 the surface is lit
   * purely by the smooth analytic environment and carries no sampling noise at
   * all. One extra environment() call instead of N extra rays.               */
  reflection = mix(reflection, environment(N, lightDir, u_bgColor),
                   smoothstep(0.12, 0.5, u_roughness));

  float fres       = fresnelSchlick(ndv, 0.045);
  float reflAmount = mix(fres, 1.0, u_metalness) * u_reflectivity * mix(1.0, 0.16, u_roughness);

  /* ---- 5. compose --------------------------------------------------- */
  vec3 albedo  = u_color;
  vec3 diffuse = albedo * mc.rgb;
  diffuse     += albedo * bleed * 0.24;               // one bounce of colour bleed
  diffuse     *= ao;
  diffuse     *= mix(0.32, 1.0, shadow);

  vec3 col = diffuse;
  col += reflection * reflAmount * mix(0.3, 1.0, ao);
  col += mc.a * u_specular * mix(0.25, 1.0, shadow) * mix(0.4, 1.0, ao);

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

    vec2 j = (rnd - 0.5) * 0.0025;
    vec3 behind =
        texture2DLodEXT(u_refractionTexture, clamp(uvR,     vec2(0.003), vec2(0.997)), u_refractionLod).rgb * 0.5 +
        texture2DLodEXT(u_refractionTexture, clamp(uvR + j, vec2(0.003), vec2(0.997)), u_refractionLod).rgb * 0.25 +
        texture2DLodEXT(u_refractionTexture, clamp(uvR - j, vec2(0.003), vec2(0.997)), u_refractionLod).rgb * 0.25;

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
