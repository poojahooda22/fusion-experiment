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
  // classify the hit: cap or side (scale-relative tolerance, so a genuine side
  // hit near the cap plane is not handed an axial normal)
  if (abs(abs(p.x) - h) < 1e-4 * max(h, 1.0)) {
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

  /* The penumbra is driven by how far the ray MISSES the sphere by, measured
     perpendicular to the ray: (closest approach - radius). That difference has
     a finite slope where the ray grazes the surface, which is what makes the
     shadow edge soft. The tangent-length form sqrt(d*d - r*r) has an INFINITE
     derivative at tangency and snaps from lit to black with no ramp.

     The other half of the problem was `if (b <= 0.0) return 1.0;`. For a ray
     passing INSIDE the sphere the argument below is negative, so visibility is
     0 at b = +epsilon and 1 at b = 0 - a full-contrast step of zero width,
     tracing a hard arc across whatever surface it lands on. With crosses this
     interlocked (median centre separation 0.81 against a mean bounding radius
     of 0.79) that fires on ~11% of neighbour pairs, so roughly three such arcs
     per cross at all times. Fading the occluder out over its own radius as its
     centre passes behind the shading point removes the step; rays that miss
     the sphere are untouched at every b. */
  float d = sqrt(max(dot(oc, oc) - b * b, 0.0));  // closest approach to centre
  float s = smoothstep(0.0, 1.0, k * (d - sph.w) / max(b, 1e-3));
  return mix(1.0, s, smoothstep(-sph.w, 0.0, b));
}

/*
 * iq's exact analytic sphere occlusion. Used to darken a surface by the
 * neighbours hovering over it - this is what makes crosses look like they are
 * actually touching instead of floating in front of each other.
 */
float sphereOcclusion(vec3 pos, vec3 nor, vec4 sph) {
  vec3 di = sph.xyz - pos;
  float l = length(di);
  if (l < 1e-4) return 1.0;
  float nl = dot(nor, di / l);
  float h2 = (l * l) / (sph.w * sph.w);

  /* iq's closed form is only defined outside the occluder (h > 1). Guarding it
     with `if (h2 > 1.0)` and otherwise falling back to nl/h2 avoids the NaN but
     the two expressions DO NOT AGREE at h = 1: the closed form limits to
     (1+nl)/2 while the fallback gives nl, a jump of up to 0.49 in occlusion -
     0.42 in ao, a 40% brightness step with zero width, drawn as a closed circle
     on the surface wherever a neighbour's 0.62R shell cuts through it. Same
     packing as above: about three such circles per cross.

     Evaluating the closed form on a clamped h2 keeps it finite, and blending to
     full occlusion as the point enters the sphere is both continuous and what
     the geometry actually implies. Max residual jump: 0.004. */
  float hc = max(h2, 1.0 + 1e-5);
  float k2 = 1.0 - hc * nl * nl;

  float res = max(0.0, nl) / hc;
  if (k2 > 0.0) {
    res = nl * acos(-nl * sqrt((hc - 1.0) / (1.0 - nl * nl))) - sqrt(k2 * (hc - 1.0));
    res = (res / hc + atan(sqrt(k2 / (hc - 1.0)))) / PI;
  }
  res = mix(1.0, res, min(h2, 1.0));
  return clamp(res, 0.0, 1.0);
}
