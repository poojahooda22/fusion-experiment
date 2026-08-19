import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'

/**
 * A few degrees of pointer parallax. Cheap, but it is what stops the cluster
 * from reading as a pre-rendered video: moving the mouse reveals genuinely
 * different reflections because the ray directions change.
 */
export function CameraRig({ amount = 0.55, damping = 2.6 }) {
  const { camera } = useThree()
  const base = useRef(camera.position.clone())

  useFrame((state, delta) => {
    const k = 1 - Math.exp(-delta * damping)
    const tx = base.current.x + state.pointer.x * amount
    const ty = base.current.y + state.pointer.y * amount * 0.6
    camera.position.x += (tx - camera.position.x) * k
    camera.position.y += (ty - camera.position.y) * k
    camera.lookAt(0, 0, 0)
  }, -60)

  return null
}
