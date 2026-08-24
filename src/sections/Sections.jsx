import { useEffect } from 'react'
import { MediaTiles } from '../tiles/MediaTiles.js'
import { lenis } from '../scroll/smooth.js'
import './sections.css'

/*
 * The two sections under the hero, following the reference's structure:
 * a statement section with one media card, then a two-column project
 * gallery under a display-size heading.
 *
 * All layout and text is real DOM. The images are NOT: each `.media-slot`
 * is an empty box whose rect is chased by a soft-body WebGL sheet drawn
 * on the fixed overlay by MediaTiles (corner springs, velocity bow,
 * cursor ripple all happen there). data attributes carry the per-tile
 * settings:
 *
 *   data-media     texture url
 *   data-radius    corner radius, css px
 *   data-delay     entry stagger, seconds
 *   data-expand    "1": this tile morphs into the full-width showreel
 *
 * Statement text is NOT static: like the reference, each block drifts
 * against the scroll at its own rate (measured off the reference:
 * title 5%, paragraph ~14%, button ~12% of the scroll distance), so
 * the section shears apart gently as you move through it. The layout
 * boxes never move - only visual transforms - so the WebGL anchor
 * rects stay truthful.
 */

const PROJECTS = [
  { name: 'Helix Grid', meta: 'CONCEPT • WEB • DESIGN • 3D • ANIMATION', src: '/media/tile-1.webp', delay: 0 },
  { name: 'Slate Motion', meta: 'CONCEPT • WEB • DEVELOPMENT • 3D', src: '/media/tile-2.webp', delay: 0.12 },
  { name: 'Nimbus Lab', meta: 'WEB • DESIGN • DEVELOPMENT • 3D', src: '/media/tile-3.webp', delay: 0.06 },
  { name: 'Iron Grove', meta: 'WEB • DESIGN • 3D • ANIMATION', src: '/media/tile-4.webp', delay: 0.18 },
]

/* the reference frames its reel with two rows of five crosses, spread
   0/25/50/75/100% across the slot; MediaTiles spins them in as the
   sheet reaches full width */
function CrossRow({ position }) {
  return (
    <div className={`reel-crosses reel-crosses--${position}`} aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => <i className="reel-cross" key={i} />)}
    </div>
  )
}

/* per-character split for the masked rise; the wrapper h2 is the
   overflow-hidden box the letters climb out of */
function MaskedTitle({ text, className }) {
  let charIndex = 0
  return (
    <h2 className={className} aria-label={text}>
      {text.split(' ').map((word, w, words) => (
        <span key={w} aria-hidden="true">
          <span className={`${className}-word`}>
            {[...word].map((ch) => (
              <span
                className={`${className}-char`}
                key={charIndex}
                style={{ transitionDelay: `${charIndex++ * 35}ms` }}
              >
                {ch}
              </span>
            ))}
          </span>
          {w < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </h2>
  )
}

export function Sections() {
  useEffect(() => {
    const tiles = new MediaTiles()
    return () => tiles.dispose()
  }, [])

  /* scroll-linked text drift, driven off the same smoothed native scroll
     Lenis animates (its 'scroll' event fires once per animation frame).
     Rates are the reference's, measured against page scroll: the title
     climbs at 5% of the scroll speed, the paragraph at 14.2%, the CTA at
     11.8% - three layers separating as the page moves. */
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const title = document.querySelector('.statement__title')
    const copy = document.querySelector('.statement__copy p')
    const cta = document.querySelector('.statement__ctaWrap')
    if (!title || !copy || !cta) return
    const onScroll = () => {
      const y = window.scrollY
      /* far below the statement nothing is visible - stop writing styles */
      if (y > window.innerHeight * 5) return
      title.style.transform = `translate3d(0, ${(-0.05 * y).toFixed(1)}px, 0)`
      copy.style.transform = `translate3d(0, ${(-0.142 * y).toFixed(1)}px, 0)`
      cta.style.transform = `translate3d(0, ${(-0.118 * y).toFixed(1)}px, 0)`
    }
    onScroll()
    if (lenis) lenis.on('scroll', onScroll)
    else window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (lenis) lenis.off('scroll', onScroll)
      else window.removeEventListener('scroll', onScroll)
    }
  }, [])

  /* the gallery heading reveals ONCE, when it first enters the lower
     part of the viewport - the reference never replays it */
  useEffect(() => {
    const title = document.querySelector('.gallery__title')
    if (!title) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          title.classList.add('is-revealed')
          io.disconnect()
        }
      },
      { rootMargin: '0% 0% -12% 0%' },
    )
    io.observe(title)
    return () => io.disconnect()
  }, [])

  return (
    <>
      {/* data-ribbon: the scroll-drawn line anchors its path to this section */}
      <section className="statement" data-ribbon>
        {/* the reference indents the FIRST line by two grid columns
            (~15vw) - the "shifted right" step the title is known for */}
        <h2 className="statement__title">
          <span className="statement__title-line statement__title-line--1">Built to move,</span>
          <span className="statement__title-line">made to stay</span>
        </h2>

        <div className="statement__row">
          {/* the SMALL endpoint of the showreel morph. Layout only - the
              pixels are drawn by the WebGL sheet, which springs its rect
              from this box to the full-width slot inside the stage below.
              NO transform ever lands here: the morph reads this rect. */}
          <div className="statement__reel" data-expand-anchor aria-hidden="true" />
          <div className="statement__copy">
            <p>
              Interfaces, film and simulation, assembled into pages that react
              like physical things. Every surface here is drawn in one WebGL
              pass: the text you can select, everything else you can push.
            </p>
            <div className="statement__ctaWrap">
              <button className="statement__cta" type="button">
                <i /> OUR APPROACH
              </button>
            </div>
          </div>
        </div>

        {/* the showreel's scroll runway: one approach viewport of scroll
            morphs the sheet, then the sticky inner pins for a real hold
            beat. MediaTiles SNAPS the page through the morph zone - a
            nudge in either direction commits to full/collapsed, so the
            sheet can never rest half-unfurled. */}
        <div className="reel-stage">
          <div className="reel-sticky">
            <div className="reel-frame">
              <CrossRow position="top" />
              <div
                className="media-slot reel-slot"
                data-media="/media/reel.webp"
                data-expand="1"
                data-radius="20"
                aria-label="showreel"
              />
              <CrossRow position="bottom" />
            </div>
          </div>
        </div>
      </section>

      <section className="gallery">
        <header className="gallery__head">
          <MaskedTitle text="Featured work" className="gallery__title" />
          <p className="gallery__blurb">
            A selection of interactive experiences created for ambitious
            brands and forward thinking teams.
          </p>
        </header>

        <div className="gallery__grid">
          {PROJECTS.map((p) => (
            <article className="gallery__card" key={p.name}>
              <div
                className="media-slot gallery__media"
                data-media={p.src}
                data-radius="15"
                data-delay={p.delay}
                aria-label={p.name}
              />
              <p className="gallery__meta">{p.meta}</p>
              {/* per-letter spans: the hover wave (see .gallery__char) */}
              <h3 className="gallery__name">
                <span className="gallery__arrow" aria-hidden="true">{'→'}</span>
                {[...p.name].map((ch, i) => (
                  <span
                    className="gallery__char"
                    key={i}
                    style={{ transitionDelay: `${i * 16}ms` }}
                  >
                    {ch === ' ' ? ' ' : ch}
                  </span>
                ))}
              </h3>
            </article>
          ))}
        </div>

        <footer className="gallery__foot">
          <button className="gallery__all" type="button">
            <i /> SEE ALL PROJECTS
          </button>
        </footer>
      </section>
    </>
  )
}
