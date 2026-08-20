/* ------------------------------------------------------------------ *
 * Shared helpers: quaternions, noise, tonemapping, environment.
 * ------------------------------------------------------------------ */

#ifndef PI
#define PI 3.141592653589793
#endif

float saturate1(float x) { return clamp(x, 0.0, 1.0); }
vec3  saturate3(vec3 x)  { return clamp(x, 0.0, 1.0); }

/* ---- quaternions -------------------------------------------------- */

vec3 qrotate(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

vec4 qinverse(vec4 q) {
  return vec4(-q.xyz, q.w);
}

/* ---- noise -------------------------------------------------------- *
 *
 * Note what is NOT here any more: there used to be a blue-noise texture and a
 * `jitterDirection` helper, used to stochastically sample the shadow penumbra
 * and the reflection cone at one sample per pixel.
 *
 * It was the wrong tool. Blue noise makes a *converging* estimator look good -
 * it spreads the error evenly so many samples, or many frames, average to the
 * right answer. But both estimators here are BINARY: a shadow ray returns 0 or
 * 1, and a reflection ray either hits a neighbour (dark) or escapes to the
 * environment (bright). One sample of a two-valued function is not a blurry
 * approximation of it, it is a dither pattern - and the surfaces read as dirty
 * rather than as rough, with blotches that no amount of antialiasing removes.
 *
 * Both are now analytic and smooth by construction: `sphereSoftShadow` for the
 * shadow, and a roughness fade to `environment()` for the reflection. Cheaper
 * and completely free of noise. The only remaining texture on the surface is
 * `microGradient` below, which is deliberate and welded to the object.
 */

/* ---- stable micro-surface ------------------------------------------ *
 *
 * Matte pieces on the reference have a fine flocked texture. The important
 * word is *fine* - and, crucially, it is a property of the surface, so it
 * tumbles with the object. Anything driven by gl_FragCoord crawls across the
 * geometry as it moves and reads as dirt rather than as material, which is
 * exactly what screen-space jitter was doing here before.
 *
 * This is evaluated in LOCAL space and rotated into world space, so a given
 * speck stays on the same square millimetre of plastic forever.
 */

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float valueNoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

/* Gradient of that noise, i.e. the direction the micro-surface tilts. */
vec3 microGradient(vec3 localPosition, float scale) {
  vec3 p = localPosition * scale;
  const float e = 0.85;
  float n0 = valueNoise3(p);
  return vec3(
    valueNoise3(p + vec3(e, 0.0, 0.0)) - n0,
    valueNoise3(p + vec3(0.0, e, 0.0)) - n0,
    valueNoise3(p + vec3(0.0, 0.0, e)) - n0
  );
}

/* ---- shading helpers ---------------------------------------------- */

float fresnelSchlick(float cosTheta, float f0) {
  return f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0);
}

/*
 * Analytic studio environment. This is what a reflection ray sees when it
 * escapes the cluster: a soft vertical gradient plus a tight key-light disc,
 * which is what produces the sharp white flecks on the glossy crosses.
 */
vec3 environment(vec3 dir, vec3 lightDir, vec3 bgColor) {
  float up = dir.y * 0.5 + 0.5;
  vec3 col = mix(bgColor * 0.4, vec3(0.24, 0.245, 0.27), pow(saturate1(up), 1.7));
  col += vec3(0.42) * pow(saturate1(up), 9.0);
  // the key light itself, as a small bright disc
  float key = pow(saturate1(dot(dir, lightDir)), 900.0);
  col += vec3(6.0, 5.9, 5.7) * key;
  // a wide soft box light behind the camera
  float fill = pow(saturate1(dot(dir, normalize(vec3(-0.6, 0.2, 0.8)))), 12.0);
  col += vec3(0.16, 0.18, 0.24) * fill;
  return col;
}

/*
 * ACES filmic curve, linear in -> linear out.
 *
 * NOTE: the cross material deliberately does NOT tonemap. It writes raw linear
 * HDR so that bloom can pick up values above 1.0; tonemapping happens once, at
 * the end of the post chain. This function is here for the standalone /
 * no-postprocessing path.
 */
vec3 acesToneMapping(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 hueShift(vec3 color, float hue) {
  const vec3 k = vec3(0.57735);
  float c = cos(hue);
  return color * c + cross(k, color) * sin(hue) + k * dot(k, color) * (1.0 - c);
}
