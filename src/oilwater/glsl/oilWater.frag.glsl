/* ------------------------------------------------------------------ *
 * Oil-on-water post effect.
 *
 * Reads the paint buffer and does four things with it, in this order:
 *
 *   1. bends the underlying image along the film's slope + flow velocity
 *   2. samples R, G and B at slightly different offsets  -> dispersion
 *   3. multiplies in a thin-film interference ramp       -> the rainbow
 *   4. adds a specular sheen from the film's normal      -> the wet look
 *
 * Marked as a convolution effect because it samples inputBuffer away from the
 * current fragment, so postprocessing gives it its own pass instead of merging
 * it with the others.
 * ------------------------------------------------------------------ */

uniform sampler2D uPaint;
uniform vec2  uPaintTexel;
uniform float uAmount;           // how much the flow velocity bends the image
uniform float uMultiplier;       // how much the film's own slope bends it
uniform float uRgbShift;         // dispersion between the R and B samples
uniform float uColorMultiplier;  // frequency of the interference bands
uniform float uShade;            // overall strength of colour + sheen
uniform vec3  uLightDirection;

/*
 * The surface height that everything geometric is derived from.
 *
 * This deliberately includes the SLOW channel. Reading .b alone tied the
 * distortion, the normal and the sheen to a film with a ~0.8 s half-life, so a
 * third of a second after the stroke the only thing left was a flat tint - all
 * the liquid character died while the colour lingered. Matching `mass` keeps
 * the geometry alive as long as the paint is visible.
 */
float filmAt(vec2 uv) {
  vec4 d = texture2D(uPaint, uv);
  return d.b + d.a * 0.6;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec4 data = texture2D(uPaint, uv);
  vec2 vel = data.rg;
  float mass = data.b + data.a * 0.6;

  // the vast majority of the screen has no paint on it - bail immediately.
  // kept well below the visibility floor so the cull never shows as a contour
  if (mass < 0.0012) {
    outputColor = inputColor;
    return;
  }

  /* Central difference of the thickness field = the slope of the oil surface.
   * Taken over TWO texels rather than one: the paint buffer is half-resolution,
   * so a one-texel stencil measures slope at the Nyquist limit of the sim and
   * the result aliases into chromatic static wherever the fluid has filaments. */
  vec2 e = uPaintTexel * 2.0;
  vec2 grad = vec2(
    filmAt(uv + vec2(e.x, 0.0)) - filmAt(uv - vec2(e.x, 0.0)),
    filmAt(uv + vec2(0.0, e.y)) - filmAt(uv - vec2(0.0, e.y))
  );

  // 0.02 keeps the tuning numbers in a readable range; the product is a uv offset
vec2 offset = (grad * uMultiplier + vel * uAmount) * 0.02;
  // an unbounded offset tears the image apart on a fast flick
  offset = clamp(offset, vec2(-0.055), vec2(0.055));

  vec2 uvR = clamp(uv - offset * (1.0 + uRgbShift), vec2(0.001), vec2(0.999));
  vec2 uvG = clamp(uv - offset,                     vec2(0.001), vec2(0.999));
  vec2 uvB = clamp(uv - offset * (1.0 - uRgbShift), vec2(0.001), vec2(0.999));

  vec3 color = vec3(
    texture2D(inputBuffer, uvR).r,
    texture2D(inputBuffer, uvG).g,
    texture2D(inputBuffer, uvB).b
  );

  /* Thin-film interference: the optical path through the film sets which
   * wavelengths cancel. Approximating the path by thickness + flow speed and
   * running it through three phase-shifted cosines gives the familiar petrol
   * rainbow, and because thickness varies smoothly the bands sweep as the
   * liquid moves. */
  /* Optical path length. Driven by thickness and, weakly, by flow speed.
   * A `dot(grad, grad)` term used to be in here and it was a mistake: squaring
   * the slope makes the band frequency explode exactly where the film has the
   * most detail, so the rainbow aliased into per-pixel noise instead of reading
   * as smooth interference fringes. */
  float thickness = mass * uColorMultiplier + length(vel) * 0.22;
  vec3 iridescence = 0.5 + 0.5 * cos(6.28318530718 *
      (thickness * vec3(1.0, 0.86, 0.71) + vec3(0.0, 0.28, 0.56)));

  /* A low knee is what turns this from a hard-edged disc into a layer: with a
   * 0.3 knee the film saturated to fully opaque across most of the stroke and
   * the entire soft falloff was crushed into its outer third. */
  float coverage = smoothstep(0.0, 0.14, mass);
  color = mix(color, color * (0.32 + 1.55 * iridescence) + iridescence * 0.05, coverage * uShade);

  // wet sheen off the film's normal
  vec3 normal = normalize(vec3(-grad * 32.0, 1.0));
  float sheen = pow(max(dot(normal, normalize(uLightDirection)), 0.0), 26.0);
  color += sheen * coverage * uShade * 0.4;

  outputColor = vec4(color, inputColor.a);
}
