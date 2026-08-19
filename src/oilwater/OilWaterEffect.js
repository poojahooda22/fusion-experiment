import { Effect, EffectAttribute, BlendFunction } from 'postprocessing'
import { Uniform, Vector2, Vector3 } from 'three'
import fragmentShader from './glsl/oilWater.frag.glsl'

export class OilWaterEffect extends Effect {
  constructor({
    paintTexture = null,
    amount = 1.0,
    multiplier = 26.0,
    rgbShift = 0.34,
    colorMultiplier = 2.4,
    shade = 1.0,
    lightDirection = new Vector3(0.35, 0.55, 0.75),
  } = {}) {
    super('OilWaterEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      // it samples inputBuffer at offset coordinates, so it must not be merged
      // into a shared pass with the other effects
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uPaint', new Uniform(paintTexture)],
        ['uPaintTexel', new Uniform(new Vector2(1 / 512, 1 / 512))],
        ['uAmount', new Uniform(amount)],
        ['uMultiplier', new Uniform(multiplier)],
        ['uRgbShift', new Uniform(rgbShift)],
        ['uColorMultiplier', new Uniform(colorMultiplier)],
        ['uShade', new Uniform(shade)],
        ['uLightDirection', new Uniform(lightDirection)],
      ]),
    })
  }

  set paintTexture(texture) {
    this.uniforms.get('uPaint').value = texture
  }

  setPaintSize(width, height) {
    this.uniforms.get('uPaintTexel').value.set(1 / width, 1 / height)
  }
}
