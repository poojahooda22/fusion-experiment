import { useEffect } from 'react'
import { MediaTiles } from '../tiles/MediaTiles.js'
import './sections.css'

/*
 * The two sections under the hero, following the reference's structure:
 * a statement section with one media card, then a 2x2 project gallery.
 *
 * All layout and text is real DOM. The images are NOT: each `.media-slot`
 * is an empty box whose rect is drawn on the fixed WebGL overlay by
 * MediaTiles (reveal, duotone, scroll flex, cursor ripple all happen
 * there). data attributes carry the per-tile settings:
 *
 *   data-media     texture url
 *   data-tint      duotone floor colour
 *   data-keep-tint "1" keeps the tile duotone after reveal (the showreel)
 *   data-radius    corner radius, css px
 *   data-origin    uv point the reveal radiates from
 *   data-delay     reveal stagger, seconds
 */

const PROJECTS = [
  { name: 'Helix Grid', meta: 'CONCEPT • WEB • DESIGN • 3D • ANIMATION', year: '2026', src: '/media/tile-1.webp', delay: 0 },
  { name: 'Slate Motion', meta: 'CONCEPT • WEB • DEVELOPMENT • 3D', year: '2026', src: '/media/tile-2.webp', delay: 0.12 },
  { name: 'Nimbus Lab', meta: 'WEB • DESIGN • DEVELOPMENT • 3D', year: '2025', src: '/media/tile-3.webp', delay: 0.06 },
  { name: 'Iron Grove', meta: 'WEB • DESIGN • 3D • ANIMATION', year: '2025', src: '/media/tile-4.webp', delay: 0.18 },
]

export function Sections() {
  useEffect(() => {
    const tiles = new MediaTiles()
    return () => tiles.dispose()
  }, [])

  return (
    <>
      {/* data-ribbon: the scroll-drawn line anchors its path to this section */}
      <section className="statement" data-skew data-ribbon>
        <h2 className="statement__title">
          Built to move,
          <br />
          made to stay
        </h2>

        <div className="statement__row">
          {/* the SMALL endpoint of the showreel morph. Layout only - the
              pixels are drawn by the WebGL tile, which lerps its rect from
              this box to the full-width slot inside the stage below. */}
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

        {/* the showreel's scroll runway: ~1.3 extra viewport-heights of
            scroll are consumed while the sticky inner pins and the tile
            grows from the anchor above into this full-width slot */}
        <div className="reel-stage">
          <div className="reel-sticky">
            <div
              className="media-slot reel-slot"
              data-media="/media/reel.webp"
              data-tint="#3230ee"
              data-expand="1"
              data-radius="26"
              data-origin="0.5,0.6"
              aria-label="showreel"
            />
            <button className="reel-play" type="button" aria-label="play showreel">
              <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                <path d="M6 4.2v11.6L16 10 6 4.2z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      </section>

      <section className="gallery" data-skew>
        <header className="gallery__head">
          <p className="gallery__eyebrow">
            <i /> FEATURED WORK <span>(0{PROJECTS.length})</span>
          </p>
          <h2 className="gallery__title">Selected projects</h2>
        </header>

        <div className="gallery__grid">
          {PROJECTS.map((p, i) => (
            <article className="gallery__card" key={p.name}>
              <div
                className="media-slot gallery__media"
                data-media={p.src}
                data-tint="#3230ee"
                data-radius="22"
                data-origin="0.5,0.65"
                data-delay={p.delay}
                aria-label={p.name}
              />
              <div className="gallery__row">
                <p className="gallery__meta">{p.meta}</p>
                <span className="gallery__year">{p.year}</span>
              </div>
              <h3 className="gallery__name">
                <span className="gallery__index">0{i + 1}</span>
                <span className="gallery__arrow">{'→'}</span>
                {p.name}
              </h3>
            </article>
          ))}
        </div>

        <footer className="gallery__foot">
          <button className="gallery__all" type="button">
            <i /> VIEW ALL PROJECTS
          </button>
        </footer>
      </section>
    </>
  )
}
