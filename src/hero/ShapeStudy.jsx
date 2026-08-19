import { useMemo } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { buildCrossGeometry } from './lib/crossGeometry.js'
import { CROSS_BOUND } from './lib/crossSDF.js'
import { createCrossMaterial } from './material/crossMaterial.js'
import { makeMatcapTexture } from './lib/matcap.js'
import { makeBlueNoiseTexture } from './lib/blueNoise.js'

/**
 * ?debug=shape — three fixed orientations of a single cross, big, so the
 * silhouette can be measured against a reference frame. Not part of the hero.
 */
const VIEWS = [
  { label: 'axis', rotation: [0, 0, 0], color: '#d8d8de' },
  { label: 'three-quarter', rotation: [0.42, 0.62, 0.12], color: '#d8d8de' },
  { label: 'edge', rotation: [0, Math.PI / 4, 0], color: '#d0161c' },
]

export function ShapeStudy({ resolution = 64 }) {
  const geometry = useMemo(() => buildCrossGeometry({ resolution }), [resolution])
  const matcap = useMemo(() => makeMatcapTexture(256), [])
  const blueNoise = useMemo(() => makeBlueNoiseTexture(64), [])

  const materials = useMemo(
    () =>
      VIEWS.map((v) => {
        const m = createCrossMaterial({ matcap, blueNoise, color: v.color })
        m.uniforms.u_roughness.value = 0.12
        m.uniforms.u_specular.value = 1.2
        m.uniforms.u_exposure.value = 0.9
        m.uniforms.u_bgColor.value.set('#1a1a1e')
        m.uniforms.u_selfPositionRadius.value.set(0, 0, 0, CROSS_BOUND)
        return m
      }),
    [matcap, blueNoise]
  )

  return (
    <div style={{ background: '#141416', height: '100vh' }}>
      <Canvas flat orthographic camera={{ zoom: 150, position: [0, 0, 10], near: 0.1, far: 60 }}>
        {VIEWS.map((v, i) => (
          <group key={v.label} position={[(i - 1) * 2.6, 0, 0]}>
            <mesh geometry={geometry} material={materials[i]} rotation={v.rotation}>
              <primitive object={materials[i]} attach="material" />
            </mesh>
          </group>
        ))}
        {/* 1-unit reference ticks so the render can be measured in world units */}
        {[-1, 1].map((s) => (
          <mesh key={s} position={[-2.6, s * 1.0, 2]}>
            <boxGeometry args={[0.04, 0.02, 0.02]} />
            <meshBasicMaterial color="#ff00ff" />
          </mesh>
        ))}
      </Canvas>
    </div>
  )
}
