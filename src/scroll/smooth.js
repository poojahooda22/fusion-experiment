import Lenis from 'lenis'
import 'lenis/dist/lenis.css'

/**
 * Page-wide smooth scroll.
 *
 * The reference site virtualises scrolling completely (its body is one
 * viewport tall and a custom engine eases a scroll value that everything
 * reads). We keep NATIVE scroll - the browser owns scrollTop, sticky
 * positioning and rect measurement all keep working - and let Lenis
 * animate that native value instead. Wheel steps become one continuous
 * glide, which is what the tile springs and the ribbon read downstream.
 *
 * One instance per page, created at module scope on first import.
 * autoRaf: Lenis drives its own requestAnimationFrame; the tile overlay
 * and the hero keep their own loops and simply see a smoothly-changing
 * window.scrollY.
 */
export const lenis = typeof window === 'undefined' ? null : (window.__lenis ??= new Lenis({
  autoRaf: true,
  // ~0.09 works out to the reference's settle time (about a second of
  // glide after the wheel stops at 60fps)
  lerp: 0.09,
  // the reference travels close to a section per flick; stock wheel
  // deltas need the boost or every transition takes three flicks
  wheelMultiplier: 1.5,
}))
