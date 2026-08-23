/**
 * Smoothed scroll state, shared by the tile overlay and the DOM.
 *
 * Native scrolling stays native (the reference virtualises the whole page;
 * we keep the browser's scroll and only smooth the DERIVED signals). Every
 * frame it produces:
 *
 *   velocity  - css px/s, exponentially smoothed
 *   bend      - the tile-flex amount: velocity shaped + clamped
 *
 * DOM text stays perfectly still - the reference moves only its media,
 * so all motion here feeds the WebGL sheets, never a CSS transform.
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
  }
}
