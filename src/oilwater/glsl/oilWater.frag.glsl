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

float filmAt(vec2 uv) {
  return texture2D(uPaint, uv).b;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec4 data = texture2D(uPaint, uv);
  vec2 vel = data.rg;
  float mass = data.b + data.a * 0.6;

  // the vast majority of the screen has no paint on it - bail immediately
  if (mass < 0.0025) {
    outputColor = inputColor;
    return;
  }

  // central difference of the thickness field = the slope of the oil surface
  vec2 e = uPaintTexel;
  vec2 grad = vec2(
    filmAt(uv + vec2(e.x, 0.0)) - filmAt(uv - vec2(e.x, 0.0)),
    filmAt(uv + vec2(0.0, e.y)) - filmAt(uv - vec2(0.0, e.y))
  );

  vec2 offset = (grad * uMultiplier + vel * uAmount) * 0.02;

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
  float thickness = mass * uColorMultiplier
                  + length(vel) * 0.4
                  + dot(grad, grad) * 60.0;
  vec3 iridescence = 0.5 + 0.5 * cos(6.28318530718 *
      (thickness * vec3(1.0, 0.86, 0.71) + vec3(0.0, 0.28, 0.56)));

  float coverage = smoothstep(0.0, 0.3, mass);
  color = mix(color, color * (0.32 + 1.55 * iridescence) + iridescence * 0.05, coverage * uShade);

  // wet sheen off the film's normal
  vec3 normal = normalize(vec3(-grad * 32.0, 1.0));
  float sheen = pow(max(dot(normal, normalize(uLightDirection)), 0.0), 26.0);
  color += sheen * coverage * uShade * 0.4;

  outputColor = vec4(color, inputColor.a);
}
