import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { Physics } from '@react-three/rapier'

import { Crosses, PHYSICS_STEP } from './Crosses.jsx'
import { CameraRig } from './CameraRig.jsx'
import { RefractionCapture } from './RefractionCapture.jsx'
import { Post } from './Post.jsx'
import { makeMatcapTexture } from './lib/matcap.js'
import { makeBlueNoiseTexture } from './lib/blueNoise.js'

export function Scene({ palette, preset, onPointerBurst }) {
  const registryRef = useRef([])
  const scene = useThree((s) => s.scene)

  // debug hook: open with ?stats=1 and read window.__hero in the console
  const three = useThree()
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('stats')) {
      window.__hero = three
    }
  }, [three])

  const matcap = useMemo(() => makeMatcapTexture(256), [])
  const blueNoise = useMemo(() => makeBlueNoiseTexture(64), [])

  useEffect(() => {
    scene.background = new THREE.Color(palette.bg)
    return () => {
      scene.background = null
      matcap.dispose()
      blueNoise.dispose()
    }
    // palette.bg is only the *initial* value; Crosses eases it every frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, matcap, blueNoise])

  return (
    <>
      <CameraRig />

      {/*
        gravity is zero: the cluster is held together by a spring toward the
        origin instead, which is what keeps it composed in frame no matter how
        hard you hit it.
      */}
      <Physics gravity={[0, 0, 0]} timeStep={PHYSICS_STEP} updatePriority={-100} interpolate>
        <Crosses
          palette={palette}
          matcap={matcap}
          blueNoise={blueNoise}
          registryRef={registryRef}
          onPointerBurst={onPointerBurst}
          count={preset.count}
          resolution={preset.resolution}
        />
      </Physics>

      {preset.refractionScale > 0 && (
        <RefractionCapture registryRef={registryRef} resolutionScale={preset.refractionScale} />
      )}
      <Post quality={preset.post} />
    </>
  )
}
