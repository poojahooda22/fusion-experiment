/* ------------------------------------------------------------------ *
 * The core trick.
 *
 * Every cross knows the transform, radius, colour and opacity of its
 * NEIGHBOUR_COUNT closest neighbours. In the fragment shader we shoot real
 * rays (reflection, shadow) against an analytic proxy of those neighbours -
 * three orthogonal capped cylinders per cross - and shade the hit with the
 * neighbour's colour.
 *
 * Cost per ray: one sphere reject (cheap, kills most neighbours) and, for
 * survivors, three capped-cylinder intersections. No BVH, no acceleration
 * structure, no screen-space information, so it works for off-screen and
 * behind-the-camera geometry and never disocclusion-flickers the way SSR does.
 * ------------------------------------------------------------------ */

/*
 * Capped cylinder whose axis is X, centred on the origin.
 * Half-height h, radius r. Returns the nearest positive t or -1.0.
 * Slab-vs-quadric clip, so it also handles rays that start inside.
 */
float intersectCylinderX(vec3 ro, vec3 rd, float h, float r, out vec3 nrm) {
  nrm = vec3(0.0);

  // --- slab along the axis
  float tS0 = -1e20;
  float tS1 = 1e20;
  if (abs(rd.x) > 1e-9) {
    float ta = (-h - ro.x) / rd.x;
    float tb = ( h - ro.x) / rd.x;
    tS0 = min(ta, tb);
    tS1 = max(ta, tb);
  } else if (abs(ro.x) > h) {
    return -1.0;
  }

  // --- infinite cylinder in the YZ plane
  float tC0 = -1e20;
  float tC1 = 1e20;
  float a = dot(rd.yz, rd.yz);
  float b = dot(ro.yz, rd.yz);
  float c = dot(ro.yz, ro.yz) - r * r;
  if (a > 1e-9) {
    float disc = b * b - a * c;
    if (disc <= 0.0) return -1.0;
    float sq = sqrt(disc);
    tC0 = (-b - sq) / a;
    tC1 = (-b + sq) / a;
  } else if (c > 0.0) {
    return -1.0;
  }

  float t0 = max(tS0, tC0);
  float t1 = min(tS1, tC1);
  if (t1 < max(t0, 0.0)) return -1.0;

  float t = t0 > 1e-5 ? t0 : t1;
  if (t <= 1e-5) return -1.0;

  vec3 p = ro + rd * t;
  // classify the hit: cap or side
  if (abs(p.x) > h - 1e-4) {
    nrm = vec3(p.x > 0.0 ? 1.0 : -1.0, 0.0, 0.0);
  } else {
    nrm = normalize(vec3(0.0, p.yz));
  }
  return t;
}

/*
 * The cross proxy: three capped cylinders along X, Y and Z.
 * Ray must already be in the cross's local (rotation-inverted) frame; h and r
 * are in world units so instance scale is handled by the caller.
 */
float intersectCross(vec3 ro, vec3 rd, float h, float r, out vec3 nrm) {
  vec3 n;
  float best = 1e20;
  nrm = vec3(0.0);

  float t = intersectCylinderX(ro, rd, h, r, n);
  if (t > 0.0 && t < best) { best = t; nrm = n; }

  // swizzle the ray so the same routine handles Y and Z, then swizzle the
  // resulting normal back into local space
  t = intersectCylinderX(ro.yzx, rd.yzx, h, r, n);
  if (t > 0.0 && t < best) { best = t; nrm = n.zxy; }

  t = intersectCylinderX(ro.zxy, rd.zxy, h, r, n);
  if (t > 0.0 && t < best) { best = t; nrm = n.yzx; }

  return best < 1e19 ? best : -1.0;
}

/* Cheap sphere reject. Returns false when the ray misses the bounding sphere
 * entirely or when the sphere is further away than the current best hit. */
bool boundingSphereHit(vec3 ro, vec3 rd, vec3 centre, float radius, float best) {
  vec3 oc = ro - centre;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return false;
  float sq = sqrt(disc);
  if (-b + sq < 0.0) return false;      // sphere entirely behind the ray
  if (-b - sq > best) return false;     // sphere starts beyond the closest hit
  return true;
}

/*
 * iq's analytic soft shadow for a sphere.
 *
 * Returns a SMOOTH 0..1 visibility instead of a binary hit test, which is the
 * whole point: a traced shadow ray returns 0 or 1, so sampling a penumbra
 * stochastically dithers into salt-and-pepper that survives any amount of
 * antialiasing. This is one sqrt and a smoothstep, it is exact for a sphere,
 * and it is completely free of noise.
 *
 * `k` is the softness: larger = tighter penumbra.
 */
float sphereSoftShadow(vec3 ro, vec3 rd, vec4 sph, float k) {
  vec3  oc = sph.xyz - ro;
  float b  = dot(oc, rd);
  if (b <= 0.0) return 1.0;                       // occluder is behind us

  /* The penumbra is driven by how far the ray MISSES the sphere by, measured
     perpendicular to the ray: (closest approach - radius). That difference
     has a finite slope where the ray grazes the surface, which is what makes
     the shadow edge soft.

     The tangent-length form sqrt(d*d - r*r) looks equivalent - it is also
     zero at grazing and grows outside - but its derivative is INFINITE at
     the tangency point, so it snaps from lit to black with no ramp at all.
     Paired with an early `return 0.0` for rays passing inside the sphere,
     that turned the whole term binary: hard white and hard black separated
     by a crisp curve, which read as dark lines cutting across the pieces.
     Inside the sphere this now goes smoothly negative and smoothstep clamps
     it, so full shadow is still full shadow - it is just approached. */
  float d = sqrt(max(dot(oc, oc) - b * b, 0.0));  // closest approach to centre
  return smoothstep(0.0, 1.0, k * (d - sph.w) / b);
}

/*
 * iq's exact analytic sphere occlusion. Used to darken a surface by the
 * neighbours hovering over it - this is what makes crosses look like they are
 * actually touching instead of floating in front of each other.
 */
float sphereOcclusion(vec3 pos, vec3 nor, vec4 sph) {
  vec3 di = sph.xyz - pos;
  float l = length(di);
  if (l < 1e-4) return 0.0;
  float nl = dot(nor, di / l);
  float h = l / sph.w;
  float h2 = h * h;
  float k2 = 1.0 - h2 * nl * nl;

  float res = max(0.0, nl) / h2;
  if (k2 > 0.0 && h2 > 1.0) {
    res = nl * acos(-nl * sqrt((h2 - 1.0) / (1.0 - nl * nl))) - sqrt(k2 * (h2 - 1.0));
    res = (res / h2 + atan(sqrt(k2 / (h2 - 1.0)))) / PI;
  }
  return clamp(res, 0.0, 1.0);
}
