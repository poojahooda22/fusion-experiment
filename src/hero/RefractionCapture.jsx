import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

/**
 * One extra half-resolution pass per frame, drawn with the frosted crosses
 * hidden. Its mipmap chain becomes the "blurred scene" that the frosted
 * material refracts - the same idea as three's own transmission pass, and the
 * same idea behind the reference site's u_blurredTextures.
 *
 * Runs at useFrame priority -10: after physics (-100) and after the neighbour
 * solve (-50), but before the post-processing composer (+1) renders the frame
 * the user actually sees.
 */
export function RefractionCapture({ registryRef, resolutionScale = 0.5 }) {
  const { gl, scene, camera, size } = useThree()

  const target = useMemo(() => {
    const rt = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      depthBuffer: true,
      stencilBuffer: false,
    })
    rt.texture.colorSpace = THREE.NoColorSpace
    return rt
  }, [])

  useEffect(() => () => target.dispose(), [target])

  useEffect(() => {
    const dpr = Math.min(gl.getPixelRatio(), 2)
    target.setSize(
      Math.max(4, Math.floor(size.width * dpr * resolutionScale)),
      Math.max(4, Math.floor(size.height * dpr * resolutionScale))
    )
  }, [gl, size, target, resolutionScale])

  const drawing = useMemo(() => new THREE.Vector2(), [])

  useFrame(() => {
    const items = registryRef.current
    if (!items || !items.length) return

    let hasFrosted = false
    for (const it of items) {
      if (it.frosted && it.mesh) {
        it.mesh.visible = false
        hasFrosted = true
      }
    }
    if (!hasFrosted) return

    const previous = gl.getRenderTarget()
    gl.setRenderTarget(target)
    gl.render(scene, camera)
    gl.setRenderTarget(previous)

    gl.getDrawingBufferSize(drawing)

    for (const it of items) {
      if (!it.frosted) continue
      if (it.mesh) it.mesh.visible = true
      const u = it.material.uniforms
      u.u_refractionTexture.value = target.texture
      u.u_resolution.value.copy(drawing)
    }
  }, -10)

  return null
}
