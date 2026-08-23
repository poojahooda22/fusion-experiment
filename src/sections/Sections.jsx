import { useEffect } from 'react'
import { MediaTiles } from '../tiles/MediaTiles.js'
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
 */

const PROJECTS = [
  { name: 'Helix Grid', meta: 'CONCEPT • WEB • DESIGN • 3D • ANIMATION', src: '/media/tile-1.webp', delay: 0 },
  { name: 'Slate Motion', meta: 'CONCEPT • WEB • DEVELOPMENT • 3D', src: '/media/tile-2.webp', delay: 0.12 },
  { name: 'Nimbus Lab', meta: 'WEB • DESIGN • DEVELOPMENT • 3D', src: '/media/tile-3.webp', delay: 0.06 },
  { name: 'Iron Grove', meta: 'WEB • DESIGN • 3D • ANIMATION', src: '/media/tile-4.webp', delay: 0.18 },
]

export function Sections() {
  useEffect(() => {
    const tiles = new MediaTiles()
    return () => tiles.dispose()
  }, [])

  return (
    <>
      {/* data-ribbon: the scroll-drawn line anchors its path to this section */}
      <section className="statement" data-ribbon>
        <h2 className="statement__title">
          Built to move,
          <br />
          made to stay
        </h2>

        <div className="statement__row">
          {/* the SMALL endpoint of the showreel morph. Layout only - the
              pixels are drawn by the WebGL sheet, which springs its rect
              from this box to the full-width slot inside the stage below. */}
          <div className="statement__reel" data-expand-anchor aria-hidden="true" />
          <div className="statement__copy">
            <p>
              Interfaces, film and simulation, assembled into pages that react
              like physical things. Every surface here is drawn in one WebGL
              pass: the text you can select, everything else you can push.
            </p>
            <button className="statement__cta" type="button">
              <i /> OUR APPROACH
            </button>
          </div>
        </div>

        {/* the showreel's scroll runway: one approach viewport of
            scroll grows the sheet while the sticky inner pins, then a short
            hold before it releases */}
        <div className="reel-stage">
          <div className="reel-sticky">
            <div
              className="media-slot reel-slot"
              data-media="/media/reel.webp"
              data-expand="1"
              data-radius="20"
              aria-label="showreel"
            />
          </div>
        </div>
      </section>

      <section className="gallery">
        <header className="gallery__head">
          <h2 className="gallery__title">Featured work</h2>
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
