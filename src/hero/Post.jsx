import * as THREE from 'three'
import {
  EffectComposer,
  Bloom,
  Noise,
  Vignette,
  ToneMapping,
} from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode } from 'postprocessing'
import { OilWater } from '../oilwater/OilWater.jsx'

/**
 * The whole chain runs in linear HDR (half-float buffers) because the cross
 * material deliberately writes un-tonemapped values above 1.0. Order matters:
 * bloom must see the raw highlights, and tonemapping must be the last colour
 * operation before grain and vignette.
 *
 * There is deliberately NO depth of field. It was the single largest source of
 * softness in this scene, for two reasons that are easy to miss:
 *
 *   1. `focalLength` in postprocessing 6.3x is an alias for `focusRange` in
 *      WORLD units, not the normalised 0..1 value it was in older versions.
 *      0.14 gave a 0.28-unit-deep in-focus shell around a cluster that spans
 *      more than four units, so ~90% of every surface sat at maximum circle of
 *      confusion. No value fixes it either: the CoC ramp is
 *      `smoothstep(0.0, focusRange, ...)`, which has no flat in-focus plateau.
 *   2. The `height` prop sizes the effect's internal bokeh buffers, and where
 *      the far CoC saturates the composite DISCARDS the full-resolution input
 *      and replaces it with the upsampled 720p version.
 *
 * Removing it is also a straight speedup: it was eight fullscreen passes.
 * `<Post dof />` puts it back with sane values if the look is ever wanted.
 */
export function Post({ quality = 'high', msaa = 4, oilWater = false, dof = false }) {
  if (quality === 'off') return null

  return (
    <EffectComposer
      // the only antialiasing switch that is actually wired up once the
      // composer owns rendering; `antialias` on the canvas is a no-op here
      multisampling={msaa}
      frameBufferType={THREE.HalfFloatType}
      enableNormalPass={false}
    >
      <Bloom
        intensity={0.4}
        luminanceThreshold={1.0}
        luminanceSmoothing={0.25}
        mipmapBlur
        levels={6}
        radius={0.5}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      {/* After tone mapping: the oil film distorts the finished image - which
          means it distorts the crosses too, by design. Off by default so the
          material can be judged on its own; turn it on with <Post oilWater />
          or ?oil=1. */}
      {oilWater ? <OilWater /> : <></>}
      <Noise premultiply blendFunction={BlendFunction.OVERLAY} opacity={0.016} />
      <Vignette offset={0.32} darkness={0.42} blendFunction={BlendFunction.NORMAL} />
    </EffectComposer>
  )
}
