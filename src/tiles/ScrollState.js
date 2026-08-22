/**
 * Smoothed scroll state, shared by the tile overlay and the DOM.
 *
 * Native scrolling stays native (the reference virtualises the whole page;
 * we keep the browser's scroll and only smooth the DERIVED signals). Every
 * frame it produces:
 *
 *   velocity  - css px/s, exponentially smoothed
 *   bend      - the tile-flex amount: velocity shaped + clamped
 *   skew      - a small shear for DOM text, written to a CSS variable
 *
 * The skew is applied by CSS (`[data-skew]` sections read --scroll-skew),
 * which is exactly the subtle "text leans while you scroll" the reference
 * shows; it costs one style write per frame.
 */
export class ScrollState {
  constructor() {
    this.y = typeof window !== 'undefined' ? window.scrollY : 0
    this.velocity = 0
    this.bend = 0
    this._lastY = this.y
  }

  update(dt) {
    this.y = window.scrollY
    const raw = (this.y - this._lastY) / Math.max(dt, 1e-4) // px/s
    this._lastY = this.y

    // ~90 ms half-life: quick to react, quick to settle
    const k = 1 - Math.pow(0.0005, dt)
    this.velocity += (raw - this.velocity) * k

    // px/s -> bend factor; sub-pixel-per-frame scrolling should not wobble
    const shaped = this.velocity * 0.00012
    this.bend = Math.max(-0.09, Math.min(0.09, shaped))

    const skewDeg = Math.max(-1.2, Math.min(1.2, this.velocity * 0.0016))
    document.documentElement.style.setProperty('--scroll-skew', skewDeg.toFixed(4) + 'deg')
  }
}
