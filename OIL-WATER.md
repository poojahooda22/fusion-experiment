# The oil-on-water hover effect

The second effect on the reference site: drag the pointer anywhere and a slick of
liquid follows it, bending whatever is underneath and breaking the edges into
a petrol rainbow. It is not a material on any one object — it is a page-level
post pass fed by a persistent screen-space fluid buffer, which is why it works
over the hero, over images, over text, over everything at once.

**It ships off by default** (`?oil=1`, or `<Post oilWater />`). That is not a
bug workaround — it is a full-screen post pass, so by construction it bends the
crosses along with everything else, and while you are judging the material that
is just in the way.

Same structure as `TECHNIQUE.md`: section 1 is what I read off the live site,
the rest is the rebuild.

---

## 1. What the original is doing

### The uniform blocks

Two shaders in the bundle, adjacent to each other, tell the whole story.

**The simulation** (one fragment shader, ping-ponged):

```
uniform sampler2D u_prevPaintTexture;   // last frame's buffer
uniform sampler2D u_lowPaintTexture;    // a coarse version of the same thing
uniform vec2  u_paintTexelSize;
uniform vec2  u_scrollOffset;
uniform vec4  u_drawFrom;               // vec4, not vec2
uniform vec4  u_drawTo;
uniform float u_pushStrength;
uniform vec3  u_dissipations;           // three separate decay rates
uniform vec2  u_vel;
uniform float u_curlScale;              // inside #ifdef USE_NOISE
uniform float u_curlStrength;
```

with `sdSegment`, `hash`, `noised`, and in `main`: `radiusWeight`, `lowData`,
`velInv`, `noise3`, `data`, `delta`, `newVel`.

**The post effect** that consumes it:

```
uniform sampler2D u_texture;              // the finished frame
uniform sampler2D u_screenPaintTexture;   // the fluid buffer
uniform vec2  u_screenPaintTexelSize;
uniform float u_amount;
uniform float u_rgbShift;
uniform float u_multiplier;
uniform float u_colorMultiplier;
uniform float u_shade;
```

with `bnoise`, `data`, `weight`, `vel`, `velocity`, a `for (int …)` loop, and
`sin`, `smoothstep`, `max`, `abs`.

And the class around it, in the minified JS:

```
class … extends PostEffect {
  screenPaint, amount, rgbShift, multiplier, colorMultiplier, shade, renderOrder
  …uniforms: u_texture, u_screenPaintTexture ← sharedUniforms.u_currPaintTexture,
             u_screenPaintTexelSize ← sharedUniforms.u_paintTexelSize, …
}
```

`sharedUniforms.u_currPaintTexture` is the giveaway. The paint buffer is a
**global, shared resource**, not something this effect owns. Grepping for
`u_screenPaintTexture` finds fifteen consumers across the bundle — the post
effect, card/tile materials (`u_invertRatio`, `u_gradientTexture`, `hue`),
image tiles (`sdRoundedBox`, `u_radialCenter`, `u_showRatio`). One fluid
simulation drives every hover-reactive surface on the site.

### Reading it back

* `u_drawFrom` / `u_drawTo` are **vec4** and `sdSegment` takes two points, so
  the pointer stroke is stamped as a **capsule** from where the pointer was to
  where it is now. A circle stamped per frame would leave a dotted trail
  whenever the mouse moves faster than its own radius.
* `u_lowPaintTexture` plus `radiusWeight` means **two resolutions**: a coarse
  buffer supplies the broad, coherent motion, and the fine buffer rides on top
  of it. Without that, detail dissolves in place instead of travelling.
* `u_dissipations` is a **vec3** — velocity, ink and something slower decay at
  different rates, which is what lets the sharp leading edge fade while a
  broad sheen lingers behind it.
* `noised` (noise *with derivatives*) plus `u_curlStrength` means **curl
  noise**: the perpendicular of an analytic gradient, which is divergence-free
  by construction, so the swirl looks like fluid rather than like drifting
  static.
* `u_scrollOffset` shifts the buffer as the page scrolls, so the paint stays
  stuck to the page instead of to the viewport.
* The `for (int …)` loop in the post effect, next to `u_rgbShift`, is the
  per-channel sampling that produces the dispersion.

### What it looks like

Screenshotting the live site mid-stroke: a thin ribbon that distorts the page
behind it — including the lavender background *outside* the hero box, which
confirms it is a full-page pass — with strong rainbow fringing along the high
gradient edges and a bright specular highlight along the ridge. It dissipates
in roughly a second.

---

## 2. Architecture

```
pointer / scroll
      │
      ▼
┌─────────────────┐   ping-pong, RGBA16F
│  ScreenPaint    │   .rg velocity   .b film   .a slow film
│  low  ~1/8 res  │──┐
│  main ~1/2 res  │◀─┘  the fine pass reads the coarse result
└─────────────────┘
      │  u_currPaintTexture
      ├──────────────► oil-on-water post pass   (implemented here)
      ├──────────────► card / tile hover materials   (same buffer, other uses)
      └──────────────► image reveal materials
```

The buffer is the interesting object. It is a piece of **persistent
screen-space state** that every hover-reactive thing on the page can read, and
it costs two small fullscreen passes per frame regardless of how many
consumers there are.

---

## 2b. What the reference actually measures

Screenshotting the reference at 1288×937 while dragging, and again two seconds
later:

| | |
| --- | --- |
| fresh smear thickness | ~160 px = **17 % of viewport height** → brush radius ≈ 0.085 in screen-height units |
| fresh smear length | ~870 px = **68 % of viewport width** after a single drag |
| still visibly flowing at | **> 2 s**, thinned and stretched, not faded in place |
| rainbow | concentrated in the thin high-gradient edges, not the body |
| body | dark and glassy — it *displaces* what is behind it |

That last row is the point people miss. The shapes appear to "move like
particles" under the cursor because the oil layer is **bending the image**, not
because anything in the physics reacted. The distortion is the effect.

The length is the diagnostic number. A 870 px trail from one gesture is not
something a bigger brush produces — it means the paint is genuinely being
thrown across the canvas and then carried by its own velocity field. Which is
exactly what the first version of this got wrong (see below).

## 3. The simulation

`src/oilwater/glsl/paint.frag.glsl`. Channel layout:

| channel | holds | decays |
| --- | --- | --- |
| `.r .g` | velocity, in uv units per second | fast (`0.94`) |
| `.b` | film thickness — the sharp leading edge | fast (`0.90`) |
| `.a` | slow film — the lingering broad sheen | slow (`0.975`) |

Per step:

**1. Advect (semi-Lagrangian).** Look up where this parcel came from and copy
it forward. One texture fetch, unconditionally stable at any timestep — which
is exactly why every real-time fluid does it this way instead of pushing
particles forward:

```glsl
vec2 vel = texture2D(u_prevPaintTexture, uv).rg + u_vel;
vec2 src = uv - vel * u_delta * u_advect + u_scrollOffset;
vec4 data = texture2D(u_prevPaintTexture, src);
```

**2. Borrow the coarse motion.** The 1/8-res buffer runs the same shader and
its velocity is added in. This is the two-scale trick.

```glsl
data.rg += texture2D(u_lowPaintTexture, src).rg * u_lowInfluence * u_delta;
```

**3. Swirl with curl noise,** scaled by how much paint is actually present so
empty screen stays perfectly still:

```glsl
vec3 n = noised(p);            // (value, ∂/∂x, ∂/∂y)
vec2 curl = vec2(n.z, -n.y);   // ∇×ψ  ⇒  divergence free
data.rg += curl * u_curlStrength * (data.b + data.a * 0.5) * u_delta;
```

**4. Stamp the stroke** as a capsule, depositing both velocity and ink:

```glsl
float d = sdSegment(uv * aspect, from * aspect, to * aspect);
float stamp = smoothstep(radius, radius * 0.15, d);
data.rg += (to - from) * stamp * u_pushStrength;
data.b  += stamp * strength;
```

**5. Dissipate,** exponentially so the rate is wall-clock rather than
frame-rate dependent:

```glsl
vec3 decay = pow(u_dissipations, vec3(u_delta * 60.0));
```

There is no pressure projection. A real solver would run a Jacobi/multigrid
step here to enforce incompressibility; skipping it costs a lot of physical
accuracy and almost nothing visually, because curl noise already supplies the
divergence-free swirl the eye is reading.

### The three bugs that made it a disc instead of a layer

Worth recording, because each one is a single line and each one was worth more
than any amount of parameter tuning.

**1. The velocity deposit was a per-frame delta being read as a velocity.**

```glsl
vec2 stroke = (u_drawTo.xy - u_drawFrom.xy) / max(u_delta, 1e-5);   // the /dt
```

`u_drawTo - u_drawFrom` is how far the pointer moved *this frame*; `.rg` is
consumed by the advection step as uv *per second*. Without the division the
deposited velocity was 60× too small at 60 fps — a 1000 px/s drag produced a
**7 px** smear instead of a 430 px one. The giveaway was the safety clamp:
`clamp(data.rg, -4.0, 4.0)` allows ~5000 px/s, and real values were peaking at
0.3 % of it. It was also a frame-rate bug: the effect was four times stronger
on a 30 Hz machine than on a 144 Hz one.

**2. There was no diffusion at all.** `u_texelSize` was declared and uploaded
and never read. Paint was only ever advected and decayed, so the film stayed
exactly as wide as the brush that laid it down. A four-tap blend against the
neighbours is what turns a stroke into a spreading layer, and it is nearly free
on the coarse buffer, which is 1/9 the resolution.

**3. The ink deposit had no `dt`,** so stroke intensity scaled with frame rate —
a fast flick laid down four times as much paint at 120 fps as at 30. Ink is
deposited per *second* now, which also gives the natural behaviour that
dwelling in one place thickens the film.

### The coarse buffer is a different field, not a smaller copy

Originally both passes ran the same shader with the same brush, the same decay
and the same noise scale, differing only in `curlStrength` — so the "two-scale"
architecture contributed a 1.57× velocity persistence multiplier and nothing
else. It now has its own character:

| | fine | coarse |
| --- | --- | --- |
| brush radius | ×1 | **×2.4** |
| dissipation (vel / film / slow) | 0.9885 / 0.9836 / 0.9954 | **0.996 / 0.9955 / 0.9988** |
| noise cell | ×1 | **×2.2** |
| diffusion | 0.34 | **0.5** |

That is what makes it read as one large body of liquid the fine detail rides
on, rather than as a downsampled ghost of the same stroke.

---

## 4. The post effect

`src/oilwater/glsl/oilWater.frag.glsl`. Four steps.

**Early out.** Almost the whole screen has no paint on it:

```glsl
if (mass < 0.0025) { outputColor = inputColor; return; }
```

**1. Bend the image.** Central-difference the thickness field to get the slope
of the oil surface, and displace along it plus the flow itself:

```glsl
vec2 grad = vec2(filmAt(uv + dx) - filmAt(uv - dx),
                 filmAt(uv + dy) - filmAt(uv - dy));
vec2 offset = (grad * u_multiplier + vel * u_amount) * 0.02;
```

**2. Disperse.** Three samples of the input at three slightly different
offsets. This is what makes the edges rainbow rather than merely smeared:

```glsl
color.r = texture2D(inputBuffer, uv - offset * (1.0 + u_rgbShift)).r;
color.g = texture2D(inputBuffer, uv - offset).g;
color.b = texture2D(inputBuffer, uv - offset * (1.0 - u_rgbShift)).b;
```

**3. Thin-film interference — the actual "oil on water".** Light reflecting
off the top of a thin film interferes with light reflecting off the bottom.
Whether a wavelength cancels or reinforces depends on the optical path
difference, which is proportional to thickness. So thickness maps to hue, and
because thickness varies smoothly across a slick you get bands that sweep as
the liquid moves.

Approximating the path length by thickness plus flow speed and running it
through three phase-shifted cosines reproduces that:

```glsl
float thickness = mass * u_colorMultiplier + length(vel) * 0.22;
vec3 iridescence = 0.5 + 0.5 * cos(6.28318 * (thickness * vec3(1.0, 0.86, 0.71)
                                            + vec3(0.0, 0.28, 0.56)));
```

There used to be a `+ dot(grad, grad) * 60.0` term in there and it was a
mistake worth naming: squaring the slope makes the band frequency explode
exactly where the film has the most detail, so the rainbow aliased into
per-pixel chromatic static instead of reading as smooth interference fringes.
For the same reason the gradient stencil spans **two** paint texels, not one —
the paint buffer is half-resolution, so a one-texel central difference measures
slope at the Nyquist limit of the simulation.

Two more things the display pass has to get right, both of which were wrong at
first:

* **`filmAt` must include the slow channel.** Reading `.b` alone tied the
  distortion, the surface normal and the sheen to a film with a sub-second
  half-life, so a third of a second after the stroke all that survived was a
  flat tint — the colour outlived the liquid.
* **The coverage knee has to be low.** `smoothstep(0.0, 0.3, mass)` saturated
  to fully opaque across most of the stroke and crushed the entire soft falloff
  into its outer third: a hard-edged disc. `0.14` gives a layer.

The `vec3(1.0, 0.86, 0.71)` is the per-channel frequency — red bands are wider
than blue because red light has the longer wavelength. That detail is what
makes it read as *oil* and not as a hue rotation.

**4. Sheen.** Treat the gradient as a surface normal and add a tight specular
lobe, which supplies the wet highlight along the ridge of the slick.

---

## 5. Wiring it in

The effect samples `inputBuffer` **away from the current fragment**, so it is
declared as a convolution effect:

```js
super('OilWaterEffect', fragmentShader, {
  attributes: EffectAttribute.CONVOLUTION,
  …
})
```

`@react-three/postprocessing` splits its effect list at any convolution
effect, so this automatically gets its own `EffectPass` and therefore reads
the *result* of everything before it rather than the raw scene. Placement:

```jsx
<EffectComposer>
  <DepthOfField … />
  <Bloom … />
  <ToneMapping mode={ACES_FILMIC} />
  <OilWater />        {/* distorts the finished image */}
  <Noise … />
  <Vignette … />
</EffectComposer>
```

The simulation itself runs at `useFrame` priority `-20`, so it is up to date
before the composer (priority `+1`) renders. It saves and restores the
renderer's render target and `autoClear` around its own two passes.

Pointer events are listened for on `window`, not on the canvas, so a stroke
that begins outside the section enters it already moving.

---

## 6. Tuning

| prop | does what | try |
| --- | --- | --- |
| `amount` | how much the flow velocity bends the image | 0.6 subtle · 1.6 default · 3 syrupy |
| `multiplier` | how much the film's own slope bends it — this is the "glass" | 20 · 44 · 80 |
| `rgbShift` | dispersion between the R and B samples | 0.1 · 0.26 · 0.5 |
| `colorMultiplier` | frequency of the interference bands | 0.8 wide · 1.5 · 4 psychedelic |
| `shade` | overall strength of colour + sheen | 0 off · 0.85 · 1.5 |
| `radius` | stroke width, in uv | 0.03 pen · 0.07 · 0.15 |
| `pushStrength` | how hard the stroke shoves the fluid | 0.5 · 1.5 · 4 |
| `dissipations` | `[velocity, film, slowFilm]` per-frame decay | `[0.94, 0.90, 0.975]` |
| `curlMain` / `curlLow` | swirl at each scale | 2.4 / 1.2 |
| `resolutionScale` | sim resolution vs canvas | 0.35 cheap · 0.5 · 0.75 |

Two decay rates doing different jobs is worth understanding: drop
`dissipations[1]` and the trail gets a crisp, fast-fading edge; raise
`dissipations[2]` and a soft sheen hangs around for several seconds after.

---

## 7. Cost

Two fullscreen passes at 1/2 and 1/8 of canvas resolution, plus one extra
composer pass. On a 1280×900 canvas that is roughly 640×450 + 140×100 fragments
of simulation and one convolution pass with three input samples — under a
millisecond on anything with a discrete GPU, and the early-out means the post
pass is nearly free wherever there is no paint.

The buffers are `RGBA16F`. `RGBA8` would work for the film channels but the
velocity needs the signed range and the precision — at 8 bits the advection
quantises and the trail visibly stair-steps.

---

## 8. Where this differs from the original

| | original | here |
| --- | --- | --- |
| scope | whole page, including DOM content rendered into WebGL | the section's canvas |
| consumers | ~15 materials share the buffer | one post pass (the buffer is exposed for more) |
| coarse buffer | `radiusWeight`-blended, tuned per consumer | flat `lowInfluence` blend |
| dithering | blue noise inside the post effect | the existing `<Noise>` pass |
| scroll | `u_scrollOffset` fully wired to page scroll | plumbed but unused in a single-section demo |

The mechanism — a shared, persistent, ping-ponged screen-space fluid stamped
with a capsule stroke, swirled by curl noise, decayed at three rates, then read
by a post pass that bends, disperses and thin-film-tints the finished frame —
is the same.
