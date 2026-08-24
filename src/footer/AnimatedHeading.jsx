import { useEffect, useRef } from 'react'
import gsap from 'gsap'

/* "Let's work together!" with a perpetual letter-cycle: every few seconds
 * three random letters slide up out of their clip, teleport below, and
 * slide back into place. Ported 1:1 from the fluid footer build; only the
 * class names changed (plain CSS instead of utility classes). */

const LINE1 = "Let's work"
const LINE2 = 'together!'
const FULL_TEXT = `${LINE1} ${LINE2}`

function renderLine(line, startIndex, charRefs) {
  return line.split('').map((char, i) => {
    const idx = startIndex + i
    if (char === ' ') {
      return (
        <span key={idx} className="ft-char-clip" aria-hidden="true">
          {' '}
        </span>
      )
    }
    return (
      <span key={idx} className="ft-char-clip" aria-hidden="true">
        <span
          ref={(el) => { charRefs.current[idx] = el }}
          className="ft-char"
        >
          {char}
        </span>
      </span>
    )
  })
}

export default function AnimatedHeading() {
  const charRefs = useRef([])
  const containerRef = useRef(null)

  useEffect(() => {
    const allChars = LINE1 + ' ' + LINE2

    const ctx = gsap.context(() => {
      const animatableIndices = []
      allChars.split('').forEach((char, i) => {
        if (char !== ' ') animatableIndices.push(i)
      })

      const runCycle = () => {
        // pick 3 unique random indices via partial Fisher-Yates shuffle
        const shuffled = [...animatableIndices]
        for (let i = shuffled.length - 1; i > shuffled.length - 4 && i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        const picked = shuffled.slice(-3)

        const targets = picked
          .map((i) => charRefs.current[i])
          .filter((el) => el !== null && el !== undefined)

        if (targets.length === 0) return

        const tl = gsap.timeline({
          onComplete: () => {
            gsap.delayedCall(2.0 + Math.random() * 1.0, runCycle)
          },
        })

        targets.forEach((el, i) => {
          const staggerDelay = i * 0.12
          const exitDur = 0.3
          const enterDur = 0.3

          tl.to(el, { yPercent: -100, duration: exitDur, ease: 'power2.in' }, staggerDelay)
          tl.set(el, { yPercent: 100 }, staggerDelay + exitDur)
          tl.to(el, { yPercent: 0, duration: enterDur, ease: 'power2.out' }, staggerDelay + exitDur)
        })
      }

      gsap.delayedCall(3.0, runCycle)
    }, containerRef)

    return () => ctx.revert()
  }, [])

  const line2Start = LINE1.length + 1

  return (
    <h1 ref={containerRef} aria-label={FULL_TEXT} className="ft-heading">
      <span className="ft-heading-line">
        {renderLine(LINE1, 0, charRefs)}
      </span>
      <span className="ft-heading-line ft-heading-line--big">
        {renderLine(LINE2, line2Start, charRefs)}
      </span>
    </h1>
  )
}
