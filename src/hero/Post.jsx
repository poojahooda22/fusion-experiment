import * as THREE from 'three'
import {
  EffectComposer,
  Bloom,
  DepthOfField,
  Noise,
  Vignette,
  ToneMapping,
} from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode } from 'postprocessing'
import { OilWater } from '../oilwater/OilWater.jsx'

/**
 * The whole chain runs in linear HDR (half-float buffers) because the cross
 * material deliberately writes un-tonemapped values above 1.0. Order matters:
 * blur and bloom must see the raw highlights, and tonemapping must be the last
 * colour operation before grain and vignette.
 */
export function Post({ quality = 'high', oilWater = true }) {
  if (quality === 'off') return null
  const dof = quality === 'high'

  return (
    <EffectComposer
      multisampling={0}
      frameBufferType={THREE.HalfFloatType}
      enableNormalPass={false}
    >
      {dof ? (
        <DepthOfField
          // wide in-focus band on purpose: in the reference almost everything
          // is razor sharp and only the extreme near/far pieces go soft
          target={[0, 0, 0.2]}
          focalLength={0.14}
          bokehScale={1.8}
          height={720}
        />
      ) : (
        <></>
      )}
      <Bloom
        intensity={0.6}
        luminanceThreshold={0.8}
        luminanceSmoothing={0.28}
        mipmapBlur
        radius={0.7}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      {/* after tone mapping: the oil film distorts the finished image */}
      {oilWater ? <OilWater /> : <></>}
      <Noise premultiply blendFunction={BlendFunction.OVERLAY} opacity={0.022} />
      <Vignette offset={0.3} darkness={0.45} blendFunction={BlendFunction.NORMAL} />
    </EffectComposer>
  )
}
