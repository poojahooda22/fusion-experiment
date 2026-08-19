import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { ScreenPaint } from './ScreenPaint.js'
import { OilWaterEffect } from './OilWaterEffect.js'

/* Module-level so the identity is stable and the configure() effect below does
 * not re-run on every React render. */
const DEFAULT_DISSIPATIONS = [0.9885, 0.9836, 0.9954]
const DEFAULT_LOW_DISSIPATIONS = [0.996, 0.9955, 0.9988]

/**
 * Drop this inside an <EffectComposer>. It owns the paint simulation, feeds
 * the pointer into it, and exposes the resulting buffer to the post effect.
 *
 * Place it AFTER <ToneMapping> so it distorts the finished image, which is
 * what the reference does - the effect is a page-level post pass, not a
 * material on any one object.
 */
/*
 * Defaults measured off the reference at 1288x937: a fresh smear is roughly
 * 160 px thick (17% of viewport height, so radius ~0.085 in screen-height
 * units) and 870 px long, and it is still visibly flowing two seconds later.
 * Getting that length requires the velocity deposit to be dt-correct - see
 * paint.frag.glsl - not a bigger brush.
 */
export function OilWater({
  // display
  amount = 1.5,             // flow velocity -> image displacement
  multiplier = 30.0,        // film slope -> image displacement (the "glass")
  rgbShift = 0.22,
  colorMultiplier = 0.85,
  shade = 0.95,
  // brush
  radius = 0.09,            // in screen-height units: 0.09 -> ~17% of height
  strength = 0.3,           // ink per 1/60 s of dwell
  pushStrength = 0.3,       // uv/s of velocity per uv/s of pointer travel
  // fields
  dissipations = DEFAULT_DISSIPATIONS,          // half-lives ~1.0 / 0.7 / 2.5 s
  lowDissipations = DEFAULT_LOW_DISSIPATIONS,   // the coarse field lasts far longer
  curlMain = 0.8,
  curlLow = 0.55,
  curlScale = 1.4,          // noise cell ~ 1/1.4 of screen height
  lowInfluence = 3.0,
  diffuse = 0.34,
  lowDiffuse = 0.5,
  lowRadiusScale = 2.4,
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
    paint.configure({
      curlMain, curlLow, curlScale, lowInfluence, radius, strength, pushStrength,
      dissipations, lowDissipations, diffuse, lowDiffuse, lowRadiusScale,
    })
  }, [paint, curlMain, curlLow, curlScale, lowInfluence, radius, strength, pushStrength,
      dissipations, lowDissipations, diffuse, lowDiffuse, lowRadiusScale])

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
      /* One capsule per frame, spanning from the last position the simulation
         consumed to the newest sample - so no travel is ever dropped, however
         fast the mouse polls. Intermediate samples would only matter for a
         curve tight enough to bend inside a single frame. */
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
