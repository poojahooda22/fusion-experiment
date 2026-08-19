import { useCallback, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Scene } from './Scene.jsx'
import { PALETTES } from './palettes.js'
import { QUALITY_PRESETS, detectQuality } from './quality.js'
import './hero.css'

export function Hero({
  headline = 'Real-time reflections without a ray tracer. Every piece sees its eight nearest neighbours and lights itself from them',
  quality,
}) {
  const [resolvedQuality] = useState(() => quality ?? detectQuality())
  const preset = QUALITY_PRESETS[resolvedQuality] ?? QUALITY_PRESETS.high
  const [paletteIndex, setPaletteIndex] = useState(0)
  const palette = PALETTES[paletteIndex]

  const cyclePalette = useCallback(() => {
    setPaletteIndex((i) => (i + 1) % PALETTES.length)
  }, [])

  return (
    <section className="hero">
      <header className="hero__bar">
        <span className="hero__logo">FUSION</span>
        <p className="hero__headline">{headline}</p>
        <nav className="hero__nav">
          <button className="hero__pill hero__pill--dark" type="button">
            LET&apos;S TALK <i />
          </button>
          <button className="hero__pill" type="button">
            MENU <i />
            <i />
          </button>
        </nav>
      </header>

      <div
        className="hero__stage"
        id="hero-visual"
        style={{ '--stage-bg': palette.bg }}
      >
        <Canvas
          // percentage heights do not resolve inside an auto-height flex item,
          // so the canvas wrapper is pinned instead of sized at 100%
          style={{ position: 'absolute', inset: 0 }}
          flat
          dpr={[1, 2]}
          gl={{
            // irrelevant while the composer is active (the scene is rasterised
            // into an offscreen target), but correct for the `raw` preset which
            // renders straight to the canvas
            antialias: true,
            powerPreference: 'high-performance',
            alpha: false,
            stencil: false,
          }}
          camera={{ position: [0, 0, preset.cameraZ], fov: 46, near: 0.1, far: 60 }}
        >
          <Scene palette={palette} preset={preset} onPointerBurst={cyclePalette} />
        </Canvas>

        <div className="hero__hint">
          <span>MOVE TO SMEAR &middot; CLICK TO SCATTER</span>
          <span className="hero__swatch" style={{ background: palette.accent }} />
          <span>{palette.name}</span>
        </div>
      </div>

      <footer className="hero__foot">
        <span>+</span>
        <span>+</span>
        <span className="hero__scroll">SCROLL TO EXPLORE</span>
        <span>+</span>
        <span>+</span>
      </footer>
    </section>
  )
}
