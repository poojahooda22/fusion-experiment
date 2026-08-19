import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { ScreenPaint } from './ScreenPaint.js'
import { OilWaterEffect } from './OilWaterEffect.js'

/**
 * Drop this inside an <EffectComposer>. It owns the paint simulation, feeds
 * the pointer into it, and exposes the resulting buffer to the post effect.
 *
 * Place it AFTER <ToneMapping> so it distorts the finished image, which is
 * what the reference does - the effect is a page-level post pass, not a
 * material on any one object.
 */
export function OilWater({
  amount = 1.6,
  multiplier = 44.0,
  rgbShift = 0.26,
  colorMultiplier = 1.5,
  shade = 0.85,
  radius = 0.07,
  strength = 0.7,
  pushStrength = 1.5,
  dissipations = [0.94, 0.9, 0.975],
  curlMain = 2.4,
  curlLow = 1.2,
  lowInfluence = 2.2,
  resolutionScale = 0.5,
}) {
  const { gl, size } = useThree()

  const paint = useMemo(
    () => new ScreenPaint(gl, { scale: resolutionScale, radius, strength, pushStrength }),
    [gl, resolutionScale] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const effect = useMemo(
    () => new OilWaterEffect({ amount, multiplier, rgbShift, colorMultiplier, shade }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // live-tune without rebuilding anything
  useEffect(() => {
    paint.configure({ curlMain, curlLow, lowInfluence, radius, strength, pushStrength, dissipations })
  }, [paint, curlMain, curlLow, lowInfluence, radius, strength, pushStrength, dissipations])

  useEffect(() => {
    const u = effect.uniforms
    u.get('uAmount').value = amount
    u.get('uMultiplier').value = multiplier
    u.get('uRgbShift').value = rgbShift
    u.get('uColorMultiplier').value = colorMultiplier
    u.get('uShade').value = shade
  }, [effect, amount, multiplier, rgbShift, colorMultiplier, shade])

  useEffect(() => {
    const dpr = Math.min(gl.getPixelRatio(), 2)
    paint.setSize(size.width * dpr, size.height * dpr)
    effect.setPaintSize(paint.width, paint.height)
  }, [gl, paint, effect, size])

  // the pointer is tracked on window, not on the canvas, so a stroke that
  // starts outside the section still enters it with the right velocity
  useEffect(() => {
    const el = gl.domElement
    const onMove = (event) => {
      const rect = el.getBoundingClientRect()
      paint.pointer(
        (event.clientX - rect.left) / rect.width,
        1 - (event.clientY - rect.top) / rect.height
      )
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [gl, paint])

  useEffect(() => () => paint.dispose(), [paint])

  useFrame((_, delta) => {
    paint.update(delta)
    effect.paintTexture = paint.texture
  }, -20)

  return <primitive object={effect} dispose={null} />
}
