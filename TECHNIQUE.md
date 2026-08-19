# How the reference hero actually works

Everything below is either (a) something I read off the live site, or (b) how I
rebuilt it. Section 1 is the evidence; the rest is the rebuild.

---

## 1. What the original is doing

Opening the reference site and inspecting the runtime gives a fairly complete picture.

**Stack.** `window.__THREE__ === 158`, so it is three.js r158. One 1.25 MB
bundle, no dynamic imports. Loaded assets: 20 `.buf` files (their own binary
mesh/animation format), 1 `.exr`, 2 `.jpg`, 16 `.ogg` — the ogg files are
collision sounds.

**Not instanced.** The hero uses one draw call per cross, not an
`InstancedMesh`. You can tell because the material has *singular*
`u_selfPositionRadius` and `u_selfRotation` uniforms: an instanced draw could
not vary those per instance. The `InstancedMesh` / `instanceMatrix` strings in
the bundle are three.js's own shader chunks.

**The material's uniform block** (extracted from the bundled GLSL) is the
whole story:

```
uniform vec4 u_selfPositionRadius;
uniform vec4 u_selfRotation;
uniform vec4 u_nearPositionRadiusList[NEIGHBOUR_COUNT];
uniform vec4 u_nearRotationList[NEIGHBOUR_COUNT];
uniform vec3 u_nearColorList[NEIGHBOUR_COUNT];
uniform vec2 u_nearTransparencyLumaList[NEIGHBOUR_COUNT];
uniform float u_roughness;
uniform vec3  u_bgColor;
uniform sampler2D u_matcap;
uniform sampler2D u_sceneTexture;
uniform sampler2D u_blurredTextures[...];
uniform float u_sss;
uniform vec3  u_sssColor;
uniform sampler2D u_blueNoiseTexture;
uniform vec2  u_blueNoiseCoordOffset;
```

and the identifiers inside the shader body:

```
cylIntersect  centerSphereHitTest  qrotate  intersectDist  refl  shadow
aoShadowIntersect  neighNearFarDist  getBlueNoise  reflectViewBN
textureBicubic  matcapDiff  matcapSpec  selfShadow  fresnel  v_thickness
v_ao  v_selfShadow  refractionVector  ior  filmicToneMapping  hueShift
```

Read that list and the technique falls out:

> **Every cross is handed the transform, radius, colour and opacity of its
> N closest neighbours as uniforms. Its fragment shader then shoots real rays
> against an analytic proxy of those neighbours — a bounding-sphere reject
> (`centerSphereHitTest`) followed by capped-cylinder intersections
> (`cylIntersect`) in the neighbour's local frame (`qrotate`) — to compute
> reflections (`refl`), shadows (`shadow`) and occlusion
> (`aoShadowIntersect`).**

Everything else is dressing: a matcap split into diffuse and specular lobes for
the base shading, blue noise to jitter the reflection ray so roughness costs
one sample instead of sixteen, per-vertex baked AO and thickness, and a
separate semi-transparent variant that refracts into a blurred copy of the
opaque pass (`u_sceneTexture` + `u_blurredTextures` + `textureBicubic` — which
is lifted almost verbatim from three's own `transmission_pars_fragment`).

**Why do it this way instead of the obvious alternatives?**

| approach | problem |
| --- | --- |
| cube-map probe per object | 6 renders per object per frame; dynamic objects need re-rendering constantly |
| screen-space reflections | cannot reflect anything off-screen or behind another object, and the whole point here is objects reflecting each other from every angle |
| `MeshPhysicalMaterial` + env map | reflections show the environment but not the *other crosses*, which is the entire look |
| real BVH ray tracing | needs a rebuilt acceleration structure every frame for 50 moving rigid bodies |

The neighbour-list trick sidesteps all of it. The "scene" a fragment can see is
capped at 8 objects, which is a constant, so the shader has a fixed instruction
count with no data structure to maintain. It is wrong in a way nobody notices:
the 9th-nearest cross does not appear in your reflection, but at that distance
it would be a handful of pixels anyway.

---

## 2. The shape

The cross is a "jack": three orthogonal tubes with a fillet where they meet and
a blind bore drilled into each of the six tips. That fillet is the hard part —
it is trivial in an SDF and painful in a hand-built parametric mesh — so the
shape is defined once as a distance field (`lib/crossSDF.js`):

```js
let d = sdCappedCyl(x, y, z, h, r)          // arm along X
d = smin(d, sdCappedCyl(y, z, x, h, r), k)  // arm along Y, smooth union
d = smin(d, sdCappedCyl(z, x, y, h, r), k)  // arm along Z
d -= rd                                     // round every convex edge

let bore = min over the six tip positions of sdCappedCyl(...)
return smax(d, -bore, holeRound)            // subtract, with a rounded rim
```

`smin` is iq's quadratic polynomial smooth minimum. Shrinking the cylinders by
`rd` and then subtracting `rd` from the result is the standard rounding trick:
it inflates the surface uniformly, which rounds convex edges by exactly `rd`
and leaves concave ones alone.

`lib/crossGeometry.js` turns that field into a mesh:

1. Sample `-sdf` into a 72³ scalar field and polygonise it with three's
   `MarchingCubes` at `isolation = 0`. (`-sdf` because marching cubes wants
   *inside* to be the high value.)
2. Weld the non-indexed output on a 1e-4 grid — 31 496 triangles drop from
   94 488 vertices to 15 750. (72 rather than 64 because `round = 0.035` has to
   stay above one grid cell or the tip fillets facet; at 64 the cell is 0.0343
   and the rounding disappears into it.)
3. **Snap every vertex onto the exact surface** with two Newton steps,
   `p -= n * sdf(p)`. Marching cubes places vertices by linearly interpolating
   the field along a cell edge, which is only first-order accurate; on a
   cylinder that error shows up as a fine sawtooth along the silhouette. Two
   iterations against the real distance function remove it without adding a
   single triangle. This is the difference between "clean machined object" and
   "slightly melted".
4. Replace the marching-cubes normals with the analytic SDF gradient. Gradient
   normals are exact, so a 72³ mesh shades like a much denser one.
5. Bake two extra attributes per vertex:
   * `aAo` — iq's SDF ambient occlusion, five taps marched along the normal.
     Darkens the fillets and the insides of the bores. Free at runtime.
   * `aThickness` — five taps marched along *minus* the normal, measuring how
     much solid sits behind the surface. Drives subsurface scattering: the thin
     tube walls glow, the hub does not.
6. Sum the signed volume of all triangles; if it is negative, flip the winding.
   Marching-cubes implementations disagree about orientation and this is
   cheaper than reasoning about it.

Cost: ~256 ms once, at startup.

**The proportions matter more than anything else in this file.** Measured off
the reference at an 1800 px window, the overall span of a cross is about
**3.3× the diameter of one arm**, and the bore is about **0.37 of that
diameter**. Getting that ratio wrong — even by 20% — is what makes the shape
read as a blobby plus sign instead of a machined jack, and no amount of
shading rescues it. The junction fillet and the edge rounding have to stay
small for the same reason: they eat the arms and the object goes soft.

**Why marching cubes and not a lower-poly hand-built mesh?** Because the mesh
has to agree with the SDF for the baked AO and thickness to be meaningful, and
because the fillet is the shape's signature. 15 k triangles × 52 crosses is
~800 k triangles per pass — chunky, but it is all one geometry and one program,
and the effect is fragment-bound anyway.

---

## 3. The intersection maths

`material/lib/raytrace.glsl`. Three routines, all closed-form.

### Capped cylinder

Written for the X axis only, then reused for Y and Z by swizzling the ray in
and swizzling the normal back out:

```glsl
float t = intersectCylinderX(ro,     rd,     h, r, n);  // X: normal as-is
      t = intersectCylinderX(ro.yzx, rd.yzx, h, r, n);  // Y: normal is n.zxy
      t = intersectCylinderX(ro.zxy, rd.zxy, h, r, n);  // Z: normal is n.yzx
```

The intersection itself is a slab-versus-quadric clip rather than the usual
"test the tube, then test the caps":

```glsl
// slab along the axis  ->  [tS0, tS1]
// infinite cylinder in YZ  ->  [tC0, tC1]
float t0 = max(tS0, tC0);
float t1 = min(tS1, tC1);
if (t1 < max(t0, 0.0)) return -1.0;
float t = t0 > 1e-5 ? t0 : t1;   // if the ray starts inside, take the exit
```

Cheaper than the naive version and it handles rays that begin inside the
volume, which matters because reflection rays start on a surface.

The hit is classified as cap or side *after* the fact, from the hit point:
`abs(p.x) > h - 1e-4` means cap. Deciding it from which `t` won means
comparing floats for equality, which is exactly the kind of thing that works
on your GPU and not on someone else's.

### Bounding sphere reject

Every neighbour is tested against its bounding sphere first. It also rejects
spheres that begin *behind* the current closest hit:

```glsl
if (-b + sq < 0.0) return false;   // sphere entirely behind the ray
if (-b - sq > best) return false;  // sphere starts past the closest hit so far
```

In a dense cluster this kills roughly 5 of 8 neighbours before any cylinder
work happens.

### Sphere occlusion

Contact darkening does *not* use rays. It uses iq's exact analytic solid-angle
integral for a sphere over a hemisphere, accumulated over the neighbour list:

```glsl
occ  += sphereOcclusion(P, N, vec4(neighbourCentre, neighbourRadius * 0.62));
```

`0.62` because a cross fills roughly 62 % of its bounding sphere. Rays would be
noisy here and would need many samples; the analytic form is one `acos`, one
`atan` and stable frame to frame. The same loop accumulates `bleed` — the
neighbour's colour weighted by how much of the hemisphere it covers — which is
one bounce of colour bleeding for free. It is why a white cross next to a red
one picks up a red edge.

---

## 4. The fragment shader, in order

`material/cross.frag.glsl`.

**Base shading — matcap.** One texture fetch indexed by the view-space normal
(`vn.xy * 0.5 + 0.5`) supplies an entire three-point studio rig. `lib/matcap.js`
generates it procedurally as a linear-space `DataTexture`: RGB is diffuse
irradiance, **alpha is the tight specular lobe kept separately** so each recipe
can scale its highlight without touching its body colour. That separation is
what lets the same texture serve glossy plastic and matte rubber.

**Occlusion.** `neighbourOcclusion(P, N)` × the baked `aAo`. Runtime contact
shading times static crevice shading.

**Shadow.** Analytic, not traced — see below. `sphereSoftShadow` against each
neighbour's bounding sphere, multiplied together, with transmission mixed in so
a frosted neighbour casts a lighter shadow than an opaque one (that is what
`u_nearTransparencyLumaList.x` is for).

**Reflection.** One deterministic ray, `reflect(-V, N)`. Hit → shade the neighbour's albedo with a cheap lambert + rim so
the reflection shows *form* rather than a flat colour patch. Miss → the
analytic `environment()` function: a vertical gradient tinted by `u_bgColor`
plus a tight `pow(dot(dir, lightDir), 900)` disc for the key light. That disc
is the entire reason the glossy crosses have crisp white flecks.

One traced sample is plenty for a mirror, but on a rough surface the hit/miss
decision flips from pixel to pixel and reads as salt-and-pepper. A rough
reflection converges to the average of its cone anyway, so the result is faded
toward the smooth `environment(N)` as roughness rises:

```glsl
reflection = mix(reflection, environment(N, lightDir, bgColor), u_roughness * 0.55);
```

One extra `environment()` call, versus N extra rays. The same reasoning
governs `u_lightRadius`: a wide penumbra means a noisy binary shadow test, so
it is kept at ~1.1 world units rather than the 2+ that would look softer.

Note the shader traces **itself** first, with the ray origin pushed
`0.055 × scale` along the normal, the proxy shrunk (78 % in length, 88 % in
radius — see §9b for why the length matters so much more), and near hits below
`0.22 × radius` ignored so a ray leaving the side of an arm cannot clip back
into the cylinder it just left. Without the self trace the arms do not reflect
each other and the object reads as hollow.

**No stochastic sampling anywhere — and that is the single biggest thing that
separates a clean surface from a dirty one here.**

The first version of this shader sampled both the shadow penumbra and the
reflection cone stochastically, jittered by a void-and-cluster blue-noise
texture, at one sample per pixel. That is standard practice and it was the
wrong call, for a reason worth stating plainly:

> Blue noise makes a *converging* estimator look good. It spreads the error
> evenly so that many samples — or many frames — average to the right answer.
> But both estimators here are **binary**. A shadow ray returns 0 or 1. A
> reflection ray either hits a neighbour (dark) or escapes to the environment
> (bright). One sample of a two-valued function is not a blurry approximation
> of that function; it is a **dither pattern**.

The result was blotchy, patchy surfaces that looked like dirt rather than like
roughness, and no amount of antialiasing touched it — MSAA resolves geometric
coverage, not shading variance. Two samples instead of one only halved the
amplitude and added a third grey level.

Both estimators are now analytic and smooth by construction:

* **Shadow** — `sphereSoftShadow`, iq's exact soft shadow for a sphere. One
  `sqrt` and a `smoothstep` per neighbour, against the same bounding sphere the
  occlusion term uses. Smooth by construction, and *cheaper* than the traced
  version it replaced (which cost three cylinder intersections per neighbour,
  twice). Arm-on-arm self shadowing is already baked into `aAo`, so nothing is
  lost.
* **Reflection** — one deterministic ray, no jitter at all, faded out entirely
  as roughness rises (`1 - smoothstep(0.05, 0.26, roughness)`). A mirror gets a
  crisp traced reflection; anything matte is lit purely by the smooth analytic
  `environment()`. There is no in-between where a single sample has to stand in
  for a wide lobe.

The blue-noise generator has been deleted along with the jitter it fed.

**Micro-surface, and why it is in object space.** Matte pieces on the reference
have a fine flocked texture, and with all the sampling noise gone the matte
materials read as bare plastic without it. It is supplied as a *material*
property: a value-noise gradient evaluated at `vLocalPosition`, rotated into
world space by the instance quaternion, and added to both the world normal and
the view normal (perturbing only the world normal leaves the matcap body
shading glassy while the reflections alone acquire texture).

Object space is the whole point. Anything driven by `gl_FragCoord` crawls
across the geometry as the piece tumbles and reads as dirt on the lens; this
way a given speck stays on the same square millimetre of plastic forever.
Strength runs from 0 on the glossy recipes to 0.13 on the black rubber.

**Subsurface scattering.** Wrapped back-lighting × `(1 - aThickness)`, tinted by
`u_sssColor`. Only the thin tube walls glow.

**Refraction (`#ifdef FROSTED`).** Three taps into a blurred copy of the opaque
pass at screen coordinates offset by the view-space refraction vector, tinted
by the object's own albedo and mixed against the surface shading by Fresnel.

**Output.** Raw linear HDR — deliberately un-tone-mapped and unclamped, scaled
by `u_exposure`. See §8.

---

## 5. Feeding the neighbour lists

`lib/neighbours.js`, one pass per frame at `useFrame` priority `-50`:

1. Snapshot every rigid body's translation and rotation once.
2. For each body, brute-force the squared distance to every other body and keep
   the 8 smallest in an insertion-sorted `Float32Array`.
3. Write straight into that body's material uniform arrays. Slots with no
   neighbour get `w = 0`, which the shader skips.

At 52 bodies that is ~2 700 distance tests per frame, allocation-free. A
spatial hash would cost more to maintain than it saves at this scale. The
`bestD[k-1]` early-out means most candidates are one compare.

three re-uploads array uniforms every frame with no caching, so mutating the
`Vector4`/`Color` objects in place is enough — no `needsUpdate` dance.

**Frame order matters and is enforced with `useFrame` priorities:**

| priority | what | why |
| --- | --- | --- |
| `-100` | Rapier steps the world | everything downstream reads body transforms |
| `-60` | camera parallax | before anything that uses the camera |
| `-50` | neighbour solve + colour easing | writes the uniforms both render passes read |
| `-10` | refraction capture (renders the scene, frosted hidden) | needs final uniforms |
| `+1` | `EffectComposer` | any priority > 0 disables R3F's automatic render |

That last row is the load-bearing one: R3F stops auto-rendering as soon as a
subscriber registers with priority > 0, and runs subscribers in ascending
order. Negative priorities are free to do work — including extra `gl.render`
calls — before the composer produces the frame the user sees.

---

## 6. Physics

Rapier, **zero gravity**. Every cross is sprung toward **its own home slot**,
not toward the origin:

```js
const hx = home[0] + Math.sin(t * dax + ph) * HOME_DRIFT   // the slot itself
const hy = home[1] + Math.cos(t * day + ph * 1.7) * ...    // wanders slowly
const hz = home[2] + Math.sin(t * daz + ph * 2.3) * ...
body.applyImpulse({ x: (hx - p.x) * k, … })
```

Home slots come from a stratified (jittered-grid) sample of the field, then
shuffled so colours and sizes do not land in grid-shaped patterns.

A single central attractor is the obvious first thing to write and it does not
work here. Big crosses **interlock**; under a central spring they jam, arch,
and settle into a hollow shell with an empty middle — which on screen reads as
a ring of objects around a dark hole. Giving every cross its own slot
guarantees the frame stays evenly covered, and the collisions still supply all
the jostling. If you take one practical lesson from this file, it is that one.

Each cross is a compound of **three capsule colliders**, one per arm. Rapier's
capsules are Y-axis-aligned, so two are rotated 90°:

```jsx
<CapsuleCollider args={[hh, r]} />                              // Y
<CapsuleCollider args={[hh, r]} rotation={[0, 0, Math.PI / 2]} /> // X
<CapsuleCollider args={[hh, r]} rotation={[Math.PI / 2, 0, 0]} /> // Z
```

with `hh = (armHalfLength - armRadius) * scale` so the hemispherical cap makes
the total half-length come out at exactly `armHalfLength * scale`. Capsules
rather than cylinders because Rapier's capsule–capsule contact is analytic and
cheap, and because rounded ends make the tumbling contacts stable — 52 bodies
with three colliders each is 156 colliders in a dense pile, and this is the
configuration that does not jitter.

`canSleep={false}` because a sleeping body stops reporting transforms and the
cluster would freeze mid-drift.

---

## 7. Click

`pointerdown` on the canvas, unprojected onto the `z = 0` plane, then a radial
impulse with `1 / (1 + d² · 0.5)` falloff plus a small random torque. The
falloff is what makes it read as a shockwave rather than an explosion.

The same handler advances the palette index. Colours then ease per-frame
(`1 - exp(-Δt · 5)`) rather than snapping — every material's `u_color`, every
neighbour's entry in every *other* material's `u_nearColorList`, and the scene
background all cross-fade together, so the reflections change colour at the
same rate as the surfaces. That coupling is why it reads as one continuous
event.

The easing uses the **raw** frame delta, not the delta clamped for physics. Reusing
the clamped one makes colour transitions crawl on slow machines.

---

## 8. Colour management, and the one thing that is easy to get wrong

The material writes **linear HDR with no tone mapping**. Everything downstream
assumes that:

```
material (linear, values > 1 allowed)
  -> half-float render targets
  -> DepthOfField
  -> Bloom            (needs the > 1 values; tone-mapping first kills it)
  -> ToneMapping      (ACES, linear -> linear)
  -> Noise, Vignette
  -> sRGB transfer, once, by postprocessing's final pass
```

The original tone-maps inside the shader (`filmicToneMapping`, the
Hejl/Burgess curve, which folds gamma in). That works if bloom is fed from a
separate pass, but with a standard `EffectComposer` it means bloom only ever
sees clamped values and the highlights stop blooming. Hence `<Canvas flat>` to
set `NoToneMapping` on the renderer, and one ACES pass at the end.

`u_exposure` (default `0.78`) is the global brightness knob and it lives
*before* the tone map, where exposure belongs.

One consequence worth knowing: the background colours in `palettes.js` look far
too bright as hex values (`#250d0f`, not `#0d0506`) because ACES compresses the
bottom of the range hard. Pick them by looking at the render, not at the
swatch.

---

## 9. The frosted pass

Frosted crosses need to see what is behind them. `RefractionCapture.jsx`:

1. Hide every frosted mesh.
2. Render the scene into a half-resolution half-float target that has
   `generateMipmaps: true` and `LinearMipmapLinearFilter`.
3. Restore visibility and hand the texture to the frosted materials.

three regenerates the mip chain automatically after rendering into a target
whose texture asks for mipmaps, so a *free* blur pyramid falls out — no
separable Gaussian pass needed. The shader then reads a high LOD with
`texture2DLodEXT` (three `#define`s it to `textureLod` for GLSL1 shaders on
WebGL2) and takes two extra blue-noise-jittered taps so the mip's boxiness
reads as frost rather than as blocks.

The original does this more carefully — an explicit blur chain plus bicubic
sampling — which is sharper at the cost of several more passes.

Frosted materials are **opaque** (`transparent: false`, `alpha = 1`). They read
the backbuffer instead of blending with it, so there is no transparency sort
and no depth-write compromise. This is the same trick three's own transmission
material uses.

---

## 9b. Sharpness — four things that were quietly softening every frame

Worth its own section, because three of the four are invisible in code review
and one of them is a units trap in a third-party library.

**1. There was no antialiasing at all.** The `Canvas` had `antialias: true`,
which does nothing here: once an `EffectComposer` is in the chain the scene is
rasterised into an offscreen render target, and the WebGL context's `antialias`
attribute only affects the *default* framebuffer. The composer's own
`multisampling` prop is the only switch wired to the sample count, and it was
`0`. Every silhouette was a raw staircase.

```jsx
<EffectComposer multisampling={4} …>   // was 0
```

MSAA shades once per pixel per triangle, so on a scene this fragment-heavy it
costs bandwidth, not shader time — the cheapest quality in the whole project.

**2. `DepthOfField` was blurring ~90% of the frame, and it could not be tuned
out.** In `postprocessing` 6.3x, `focalLength` is a deprecated alias for
**`focusRange`, in world units** — it was a normalised 0..1 value in older
versions, which is where `0.14` came from. That gave an in-focus shell 0.28
world units deep around a cluster spanning more than four units:

| | |
| --- | --- |
| focus distance | 6.40 world units |
| in-focus shell | 6.26 … 6.54 |
| cluster surface range | 4.73 … 8.88 |
| surface at **maximum** circle of confusion | **91.5 %** |

A single cross is four to six times deeper than the entire in-focus band. And
no value fixes it: the CoC ramp is `smoothstep(0.0, focusRange, …)`, which has
no flat in-focus plateau — it starts blurring at zero deviation.

Worse, the `height={720}` prop sizes the effect's internal bokeh buffers, and
where the far CoC saturates the composite *discards* the full-resolution input
and replaces it with the upsampled 720p version. At dpr 2 that is a 2.3× linear
downsample applied to most of the frame.

The effect is now removed entirely — which is also a straight speedup, since it
was eight fullscreen passes. `<Post dof />` is left as an opt-in.

**3. A ring of speckle around every bore, from the object's own reflection
proxy.** The ray-trace proxy is three solid capped cylinders, but the real arm
tip is an annulus with a bore through it. The proxy's cap plane sat exactly at
the true tip, so it intercepted precisely the rays that should have escaped
through the hole — a stochastic hit/miss that dithered into salt and pepper.
Pulling the self proxy's *length* back hard fixes it and costs nothing that
matters, because arm-to-arm self reflection happens on the sides, not the caps:

```glsl
intersectCross(lo, ld, pr.w * u_armRatio.x * 0.78,   // length: pulled well back
                       pr.w * u_armRatio.y * 0.88, n) // radius: barely shrunk
```

**4. One binary shadow ray dithers.** `traceShadow` returns 0 or 1, so a single
stochastic sample across a penumbra is pure noise no matter how good the blue
noise is. Two decorrelated samples quarter the variance for one extra trace.

The canvas CSS was also forcing `width/height: 100% !important`, which put the
backing store a fraction of a pixel off the layout box and made the compositor
bilinearly resample every frame. three already writes exact pixel dimensions to
`canvas.style`; the override just had to go.

## 10. Performance

Measured at 1204×710, `quality=high`, 28 crosses:

| | |
| --- | --- |
| meshes | 28, one draw call each, one shared geometry; the crosses compile 2 programs (opaque + frosted) |
| triangles | 31 496 per cross at resolution 72, ~880 k per pass, ×2 passes with refraction on |
| antialiasing | 4× MSAA on the composer (2× on the `low` preset) |
| fragment work | per pixel: 1 reflection ray (glossy only) × (8 sphere rejects + ~3 surviving × 3 cylinder tests), 8 analytic soft shadows, 8 analytic sphere occlusions, 4 value-noise taps on matte |
| startup | ~256 ms geometry + ~10 ms matcap |
| textures | 30 (mostly the post chain's) |

The effect is fragment-bound, and `NEIGHBOUR_COUNT` is the exponent. In order of
what to cut when it is slow:

1. `multisampling` 4 → 2 → 0 (memory and bandwidth, not shader time)
2. the refraction pre-pass — halves the vertex work
3. `u_microTexture` → 0 on the matte recipes (4 value-noise taps)
4. `NEIGHBOUR_COUNT` 8 → 6
5. cross count
6. marching cubes resolution

`quality.js` bundles these into `high` / `medium` / `low` presets and
auto-selects from `pointer: coarse`, viewport size and
`navigator.hardwareConcurrency`.

---

## 11. Where this differs from the original

| | original | here |
| --- | --- | --- |
| meshes | streamed `.buf` binaries | marching cubes at startup, ~125 ms |
| matcap / blue noise | shipped textures + an `.exr` | generated procedurally, zero assets |
| blurred backbuffer | explicit blur chain + bicubic taps | mip chain + jittered LOD taps |
| tone mapping | in-shader Hejl filmic | ACES at the end of the post chain |
| physics | custom solver | Rapier compound capsules |
| extras | collision sounds, a comet streak, scroll-driven camera | not implemented |

The core — neighbour lists as uniforms, sphere reject, quaternion into local
space, three capped cylinders, one reflection ray and one shadow ray per
fragment, blue-noise jitter for roughness — is the same.
