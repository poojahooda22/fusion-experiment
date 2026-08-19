import * as THREE from 'three'
import vertexShader from './cross.vert.glsl'
import fragmentShader from './cross.frag.glsl'
import { CROSS, CROSS_BOUND } from '../lib/crossSDF.js'

/**
 * How many neighbours each cross is allowed to see. This is the single biggest
 * quality/perf dial in the whole effect:
 *   4  -> reflections start missing obvious nearby crosses
 *   8  -> sweet spot, matches what the reference site does
 *   12 -> marginally better in dense clusters, ~40% more fragment cost
 */
export const NEIGHBOUR_COUNT = 8

/** Proxy dimensions expressed as a fraction of the bounding radius, so the
 *  shader can derive world-space arm sizes from `boundingRadius` alone. */
export const ARM_RATIO = new THREE.Vector2(
  CROSS.armHalfLength / CROSS_BOUND,
  CROSS.armRadius / CROSS_BOUND
)

const emptyVec4Array = (n, w = 0) =>
  Array.from({ length: n }, () => new THREE.Vector4(0, 0, 0, w))

export function createCrossMaterial({
  frosted = false,
  matcap,
  color = '#ffffff',
  bgColor = '#0a0a0a',
} = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    defines: {
      NEIGHBOUR_COUNT,
      ...(frosted ? { FROSTED: '' } : {}),
    },
    uniforms: {
      // --- identity
      u_selfPositionRadius: { value: new THREE.Vector4(0, 0, 0, 1) },
      u_selfRotation: { value: new THREE.Vector4(0, 0, 0, 1) },
      // --- neighbourhood
      u_nearPositionRadiusList: { value: emptyVec4Array(NEIGHBOUR_COUNT) },
      u_nearRotationList: { value: emptyVec4Array(NEIGHBOUR_COUNT, 1) },
      u_nearColorList: {
        value: Array.from({ length: NEIGHBOUR_COUNT }, () => new THREE.Color(0, 0, 0)),
      },
      u_nearTransparencyLumaList: {
        value: Array.from({ length: NEIGHBOUR_COUNT }, () => new THREE.Vector2(0, 0)),
      },
      u_armRatio: { value: ARM_RATIO },
      // --- material
      u_color: { value: new THREE.Color(color) },
      u_bgColor: { value: new THREE.Color(bgColor) },
      u_roughness: { value: 0.08 },
      u_metalness: { value: 0.0 },
      u_reflectivity: { value: 1.0 },
      u_specular: { value: 1.0 },
      u_sss: { value: 0.0 },
      u_sssColor: { value: new THREE.Color('#ffffff') },
      u_aoStrength: { value: 0.85 },
      u_exposure: { value: 1.02 },
      /* Stable, object-space surface grain. Matte pieces on the reference have
       * a fine flocked texture; this supplies it as a material property rather
       * than as screen-space noise, so it tumbles with the piece. */
      u_microTexture: { value: 0.0 },
      u_microScale: { value: 95.0 },
      u_opacity: { value: 1.0 },
      u_selfTransmission: { value: 0.0 },
      // --- lighting
      u_lightPosition: { value: new THREE.Vector3(6, 9, 6) },
      // penumbra tightness for the analytic sphere shadow; larger = harder
      u_shadowSoftness: { value: 5.0 },
      u_matcap: { value: matcap },
      u_time: { value: 0 },
      // --- refraction (frosted only, but harmless when unused)
      u_refractionTexture: { value: null },
      u_resolution: { value: new THREE.Vector2(1, 1) },
      u_ior: { value: 1.32 },
      u_refractionStrength: { value: 0.34 },
      u_refractionLod: { value: 2.2 },
      u_refractionSpread: { value: 0.004 },
    },
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
  })

  material.userData.frosted = frosted
  return material
}
