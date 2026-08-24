import { useCallback, useEffect, useRef } from 'react'
import AnimatedHeading from './AnimatedHeading.jsx'
import TiltButton from './TiltButton.jsx'
import { createFluidPool } from './createFluidPool'
import { useTiltControl } from './useTiltControl'
import './footer.css'

/*
 * The footer: a full-viewport pool of particle fluid on vivid blue, with
 * the "Let's work together!" heading floating above it. Ported from the
 * standalone fluid build with two deliberate changes:
 *
 *   - the nav bar is gone (this is a footer, not a page)
 *   - the simulation PAUSES while the footer is off-screen: the original
 *     was a single fixed page, but here the section lives at the end of
 *     a long scroll and must not burn GPU while invisible
 *
 * Everything else - the WebGL2 FLIP simulation, the tilt control, the
 * letter-cycling heading - is the original code, verbatim.
 */

export function Footer() {
  const wrapperRef = useRef(null)
  const canvasRef = useRef(null)
  const pillContainerRef = useRef(null)
  const sectionRef = useRef(null)
  const apiRef = useRef(null)
  const tilt = useTiltControl(apiRef)

  const handleApiReady = useCallback((api) => {
    apiRef.current = api
  }, [])

  useEffect(() => {
    const w = wrapperRef.current, c = canvasRef.current, pc = pillContainerRef.current
    if (!w || !c) return
    const api = createFluidPool(w, c, pc, undefined)
    apiRef.current = api
    handleApiReady(api)

    /* run only while the footer is (nearly) on screen */
    const io = new IntersectionObserver(
      ([entry]) => api.setPaused(!entry.isIntersecting),
      { rootMargin: '25% 0px' },
    )
    io.observe(sectionRef.current)

    return () => {
      io.disconnect()
      api.cleanup()
      apiRef.current = null
    }
  }, [handleApiReady])

  return (
    <footer className="fusion-footer" ref={sectionRef}>
      <div className="ft-fluid" ref={wrapperRef}>
        {/* pill overlay container - between canvas and wrapper */}
        <div className="ft-pills" ref={pillContainerRef} />
        {/* simulation canvas - CSS fills parent; JS only sets drawing buffer */}
        <canvas className="ft-canvas" ref={canvasRef} />
      </div>

      <div className="ft-overlay">
        <p className="ft-tagline">IS YOUR BIG IDEA READY TO GO WILD?</p>
        <AnimatedHeading />
        <TiltButton
          supported={tilt.supported}
          enabled={tilt.enabled}
          permissionDenied={tilt.permissionDenied}
          onRequest={tilt.requestEnable}
        />
      </div>
    </footer>
  )
}
