/**
 * Each click swaps the whole scene to the next palette. A palette is one
 * saturated accent plus the fixed black / grey / white neutrals, and a very
 * dark tint of the accent for the box background - which is why the "black"
 * background visibly shifts hue between clicks on the reference site.
 */
export const PALETTES = [
  { name: 'crimson', accent: '#d8151b', accentAlt: '#ff3a2f', bg: '#250d0f' },
  { name: 'violet', accent: '#7a15e6', accentAlt: '#a855f7', bg: '#1b0f2a' },
  { name: 'ultramarine', accent: '#1414cd', accentAlt: '#3b5bff', bg: '#0e1230' },
  { name: 'acid', accent: '#8bce12', accentAlt: '#b6f13a', bg: '#17210a' },
  { name: 'amber', accent: '#f2a90a', accentAlt: '#ffd23f', bg: '#241a0c' },
  { name: 'cyan', accent: '#0ec3d6', accentAlt: '#5ce7f5', bg: '#0a2028' },
]

export const NEUTRALS = {
  black: '#08080a',
  charcoal: '#121214',
  grey: '#7c7c88',
  white: '#d4d4dc',
}

/**
 * The seven material recipes that make up a cluster. Roughly a third accent,
 * a third black, a third light, with a few frosted pieces sprinkled in - match
 * these weights and the cluster reads correctly even before the shading does.
 */
export const RECIPES = [
  {
    id: 'accentGloss',
    weight: 16,
    swatch: 'accent',
    uniforms: { u_roughness: 0.05, u_specular: 1.5, u_reflectivity: 1.0, u_metalness: 0.0, u_microTexture: 0.0 },
  },
  {
    id: 'accentAltGloss',
    weight: 7,
    swatch: 'accentAlt',
    uniforms: { u_roughness: 0.08, u_specular: 1.3, u_reflectivity: 0.95, u_metalness: 0.0, u_microTexture: 0.0 },
  },
  {
    id: 'accentMatte',
    weight: 8,
    swatch: 'accent',
    uniforms: { u_roughness: 0.46, u_specular: 0.3, u_reflectivity: 0.62, u_metalness: 0.0, u_microTexture: 0.12 },
  },
  {
    id: 'blackGloss',
    weight: 8,
    swatch: 'black',
    uniforms: { u_roughness: 0.04, u_specular: 1.6, u_reflectivity: 1.0, u_metalness: 0.1, u_microTexture: 0.0 },
  },
  {
    id: 'blackRubber',
    weight: 10,
    swatch: 'charcoal',
    uniforms: { u_roughness: 0.58, u_specular: 0.18, u_reflectivity: 0.5, u_metalness: 0.0, u_microTexture: 0.13 },
  },
  {
    id: 'lightMatte',
    weight: 20,
    swatch: 'grey',
    uniforms: { u_roughness: 0.4, u_specular: 0.38, u_reflectivity: 0.68, u_metalness: 0.0, u_microTexture: 0.085 },
  },
  {
    id: 'lightGloss',
    weight: 11,
    swatch: 'white',
    uniforms: { u_roughness: 0.07, u_specular: 1.35, u_reflectivity: 0.9, u_metalness: 0.0, u_microTexture: 0.0 },
  },
  {
    id: 'frosted',
    weight: 5,
    swatch: 'white',
    frosted: true,
    uniforms: {
      u_roughness: 0.22,
      u_specular: 0.9,
      u_microTexture: 0.05,
      u_reflectivity: 0.75,
      u_sss: 1.15,
      u_selfTransmission: 0.55,
      u_ior: 1.28,
    },
  },
  {
    id: 'frostedAccent',
    weight: 2,
    swatch: 'accent',
    frosted: true,
    uniforms: {
      u_roughness: 0.24,
      u_specular: 0.85,
      u_microTexture: 0.05,
      u_reflectivity: 0.7,
      u_sss: 1.0,
      u_selfTransmission: 0.5,
      u_ior: 1.3,
    },
  },
]

/** Deterministic weighted pick so the cluster looks the same on every reload. */
export function pickRecipe(rand) {
  const total = RECIPES.reduce((s, r) => s + r.weight, 0)
  let t = rand * total
  for (const r of RECIPES) {
    t -= r.weight
    if (t <= 0) return r
  }
  return RECIPES[0]
}

export function swatchColor(swatch, palette) {
  if (swatch === 'accent') return palette.accent
  if (swatch === 'accentAlt') return palette.accentAlt
  return NEUTRALS[swatch] ?? '#ffffff'
}
