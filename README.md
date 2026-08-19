# Neighbourhood ray-traced cross field

A React Three Fiber study of a neighbour-traced hero: a cluster of
tumbling "jack" shapes, rigid-body simulated with Rapier, shaded by a custom
material that ray-traces each object's nearest neighbours in the fragment
shader to get reflections, contact shadows, occlusion and colour bleeding.
Click anywhere in the box to shove the cluster and cycle the palette.

Move the pointer and an oil-on-water slick follows it, bending and dispersing
the finished frame — a second, independent effect built on a shared
screen-space fluid buffer.

Two write-ups sit next to this file:

* `TECHNIQUE.md` — the cross field: neighbourhood ray tracing, the SDF
  geometry pipeline, the physics, the colour pipeline.
* `OIL-WATER.md` — the hover slick: the paint simulation and the thin-film
  post pass.

This file is just how to run it.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build && npm run preview
```

Requires WebGL2. No external assets: the geometry, matcap and blue-noise
texture are all generated at startup (~200 ms total).

## Use the component

```jsx
import { Hero } from './hero/Hero.jsx'

<Hero headline="…" />              // auto-detects a quality preset
<Hero quality="high" />            // or force one: high | medium | low | raw
```

`Hero` owns the layout chrome and the palette state. If you only want the
canvas contents, mount `<Scene palette={…} preset={…} onPointerBurst={…} />`
inside your own `<Canvas>` — it expects `flat` (no renderer tone mapping)
because the post chain does the tone mapping.

## URL switches

| query | effect |
| --- | --- |
| `?quality=raw` | full scene, post chain off — the quickest way to see what the material alone does |
| `?quality=low` | 26 crosses, coarser mesh, no refraction pass, no depth of field |
| `?stats=1` | exposes the R3F state as `window.__hero` for `__hero.gl.info` |
| `?debug=shape` | the cross on its own at three fixed orientations, for measuring the silhouette |

## Dev scripts

```bash
node scripts/inspect-geometry.mjs 48    # build the mesh in node, print its stats
```

`scripts/shot.mjs`, `scripts/oil-shot.mjs` and `scripts/perf.mjs` screenshot /
profile a running `npm run preview` and need `npm i -D playwright` first.
`oil-shot.mjs` drives a pointer stroke (`sweep`) or spiral (`swirl`) so the
slick is actually visible in the capture.

## Layout

```
src/hero/
  Hero.jsx                  page chrome, palette state, <Canvas>
  Scene.jsx                 physics world, capture pass, post chain
  Crosses.jsx               the field: bodies, forces, click, per-frame uniform feed
  CameraRig.jsx             pointer parallax
  RefractionCapture.jsx     half-res pre-pass + mip chain for the frosted material
  Post.jsx                  DOF -> bloom -> ACES -> grain -> vignette
  palettes.js               colours + the material recipes and their weights
  quality.js                the one perf knob
src/oilwater/
  OilWater.jsx              R3F component: owns the sim, exposes the effect
  ScreenPaint.js            two-scale ping-pong fluid buffer
  OilWaterEffect.js         postprocessing Effect (convolution -> own pass)
  glsl/paint.frag.glsl      advect + curl noise + capsule stamp + dissipate
  glsl/oilWater.frag.glsl   distort + disperse + thin-film + sheen
  lib/
    crossSDF.js             signed distance field for the jack shape
    crossGeometry.js        marching cubes + baked AO / SSS thickness
    matcap.js               procedural studio matcap (RGB diffuse, A specular)
    blueNoise.js            void-and-cluster blue noise
    neighbours.js           per-frame k-nearest-neighbour solve
  material/
    crossMaterial.js        ShaderMaterial factory + uniform layout
    cross.vert.glsl
    cross.frag.glsl
    lib/common.glsl         quaternions, noise, environment, tone mapping
    lib/raytrace.glsl       cylinder / sphere intersection, sphere occlusion
```

## The knobs worth turning first

| where | what |
| --- | --- |
| `material/crossMaterial.js` → `NEIGHBOUR_COUNT` | 8 is the sweet spot. 4 loses obvious reflections, 12 costs ~40% more fragment time |
| `palettes.js` → `RECIPES[].weight` | the mix of glossy / rubber / frosted pieces |
| `palettes.js` → `PALETTES` | add or reorder the click-through colours |
| `lib/crossSDF.js` → `CROSS` | the shape itself: arm length, radius, fillet, bore |
| `Crosses.jsx` → force block in `useFrame` | how tightly the cluster holds together |
| `cross.frag.glsl` → `u_exposure` | overall brightness, applied before tone mapping |
| `lib/crossSDF.js` → `armRadius` | span-to-thickness ratio; 3.3 matches the reference |
| `OilWater.jsx` props | the slick: `amount`, `multiplier`, `rgbShift`, `colorMultiplier`, `shade` |

## Known limitations

* The ray-trace proxy is three cylinders — it ignores the hub fillet and the
  bores, so reflections show a slightly simpler shape than the silhouette.
* `postprocessing` logs a `glBlitFramebuffer` warning at startup when depth of
  field is enabled. It is harmless and comes from the library's depth pass.
* No `prefers-reduced-motion` handling yet; add it in `Crosses.jsx` if you need
  it.
