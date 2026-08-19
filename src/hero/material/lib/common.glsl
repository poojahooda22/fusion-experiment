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

/* ---- noise -------------------------------------------------------- */

/*
 * Two decorrelated blue-noise samples for this pixel. The offset uniform is
 * advanced by the golden ratio each frame so the sampling pattern rotates and
 * the single-sample error averages out in motion instead of sticking to the
 * screen like fixed grain.
 */
vec2 blueNoise2(sampler2D tex, vec2 fragCoord, vec2 texelSize, vec2 offset) {
  return texture2D(tex, (fragCoord + offset) * texelSize).rg;
}

/* Cosine-ish jitter of a direction, used to fake a rough (blurred) reflection
 * from a single ray. `spread` is roughly the tangent of the cone half-angle. */
vec3 jitterDirection(vec3 dir, vec3 normal, float spread, vec2 rnd) {
  if (spread <= 0.0) return dir;
  float phi = rnd.x * 2.0 * PI;
  float r = sqrt(rnd.y) * spread;
  vec3 t = normalize(cross(abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), dir));
  vec3 b = cross(dir, t);
  vec3 outDir = normalize(dir + (t * cos(phi) + b * sin(phi)) * r);
  // never let the jitter push the ray below the surface
  float d = dot(outDir, normal);
  if (d < 0.0) outDir = normalize(outDir - 2.0 * d * normal);
  return outDir;
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
  vec3 col = mix(bgColor * 0.4, vec3(0.24, 0.245, 0.27), pow(up, 1.7));
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
