import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { RigidBody, CapsuleCollider } from '@react-three/rapier'

import { buildCrossGeometry } from './lib/crossGeometry.js'
import { CROSS, CROSS_BOUND } from './lib/crossSDF.js'
import { createCrossMaterial, NEIGHBOUR_COUNT } from './material/crossMaterial.js'
import { updateNeighbours } from './lib/neighbours.js'
import { pickRecipe, swatchColor } from './palettes.js'

const CLUSTER = new THREE.Vector3(2.15, 1.35, 1.5) // half-extents of the field
const BOUNDS_RADIUS = 4.0

/* Drag tuning. The cluster spans BOUNDS_RADIUS, so a 2.2 reach moves a local
   handful rather than shoving the whole ball - which is what makes it read as
   a hand pushed through objects instead of dragging one rigid mass. These are
   deliberately strong: each cross is sprung to its own home slot at k=3.2, so
   a gentle force is simply absorbed and nothing appears to happen. */
const DRAG_RADIUS = 2.2
const DRAG_SWEEP = 26       // carried along with the cursor, scales with speed
const DRAG_PUSH = 20        // parted outward, so they move aside
const DRAG_MAX_SPEED = 14   // world units/sec, ceiling on a fast flick
/* Screen px of travel before a press stops being a tap and becomes a drag. */
const TAP_SLOP = 6

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/*
 * Rapier is configured with a fixed timeStep, so it advances exactly this much
 * simulation time per frame regardless of how long the frame actually took.
 * Force impulses must therefore be integrated against the *simulation* step,
 * not the wall-clock delta - otherwise a slow machine under-integrates the
 * restoring spring and the cluster never pulls itself back together.
 */
export const PHYSICS_STEP = 1 / 60

/* deterministic PRNG so reloads give the same cluster */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

export function Crosses({
  palette,
  matcap,
  registryRef,
  onPointerBurst,
  count = 52,
  resolution = 48,
}) {
  const { gl, camera, raycaster } = useThree()

  const geometry = useMemo(() => buildCrossGeometry({ resolution }), [resolution])

  /* ---- one-time layout of the cluster ------------------------------- */
  const specs = useMemo(() => {
    const rand = mulberry32(20260819)

    /*
     * Home positions come from a stratified (jittered-grid) sample of the
     * field, not from pure random placement, and each cross is sprung toward
     * its OWN home rather than toward the origin.
     *
     * A single central attractor looks obvious but does not work here: big
     * crosses interlock, jam, and arch into a hollow shell with an empty
     * middle. Giving every cross its own slot guarantees the frame stays
     * evenly covered, and the collisions still supply all the jostling.
     */
    const nz = Math.max(2, Math.round(Math.cbrt(count / 2.6)))
    const perLayer = Math.ceil(count / nz)
    const nx = Math.ceil(Math.sqrt(perLayer * 1.55))
    const ny = Math.ceil(perLayer / nx)

    const slots = []
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          slots.push([
            ((x + 0.5) / nx) * 2 - 1,
            ((y + 0.5) / ny) * 2 - 1,
            ((z + 0.5) / nz) * 2 - 1,
          ])
        }
      }
    }
    // shuffle so colours and sizes do not land in grid-shaped patterns
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[slots[i], slots[j]] = [slots[j], slots[i]]
    }

    return Array.from({ length: count }, (_, i) => {
      const recipe = pickRecipe(rand())
      const scale = 0.58 + rand() * 0.3
      const slot = slots[i % slots.length]
      const jitter = 0.62
      const home = [
        (slot[0] + (rand() * 2 - 1) * jitter / nx) * CLUSTER.x,
        (slot[1] + (rand() * 2 - 1) * jitter / ny) * CLUSTER.y,
        (slot[2] + (rand() * 2 - 1) * jitter / nz) * CLUSTER.z,
      ]
      return {
        id: i,
        recipe,
        scale,
        home,
        // each home wanders on its own slow lissajous so nothing sits still
        drift: [
          0.17 + rand() * 0.16,
          0.13 + rand() * 0.16,
          0.11 + rand() * 0.13,
          rand() * Math.PI * 2,
        ],
        position: home,
        rotation: [rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2],
      }
    })
  }, [count])

  /* ---- materials, one per cross (they each carry their own neighbour
         list, so they cannot be shared) ------------------------------- */
  const items = useMemo(() => {
    return specs.map((spec) => {
      const material = createCrossMaterial({
        frosted: !!spec.recipe.frosted,
        matcap,
      })
      for (const [key, value] of Object.entries(spec.recipe.uniforms)) {
        if (material.uniforms[key]) material.uniforms[key].value = value
      }
      const color = new THREE.Color(swatchColor(spec.recipe.swatch, palette))
      material.uniforms.u_color.value.copy(color)

      return {
        spec,
        material,
        body: null,
        mesh: null,
        radius: spec.scale * CROSS_BOUND,
        color, // current, linear
        targetColor: color.clone(),
        transmission: material.uniforms.u_selfTransmission.value,
        luma: luminance(color),
        frosted: !!spec.recipe.frosted,
        px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
        _bestD: new Float32Array(NEIGHBOUR_COUNT),
        _bestI: new Int32Array(NEIGHBOUR_COUNT),
      }
    })
  }, [specs, matcap])

  useEffect(() => {
    registryRef.current = items
    return () => {
      registryRef.current = []
      items.forEach((i) => i.material.dispose())
    }
  }, [items, registryRef])

  /* ---- palette swap: retarget every colour, then lerp --------------- */
  useEffect(() => {
    for (const item of items) {
      item.targetColor.set(swatchColor(item.spec.recipe.swatch, palette))
    }
  }, [palette, items])

  const bodies = useRef([])
  const bgCurrent = useRef(new THREE.Color(palette.bg))
  const bgTarget = useRef(new THREE.Color(palette.bg))
  useEffect(() => {
    bgTarget.current.set(palette.bg)
  }, [palette])

  /* ---- pointer: move sweeps, tap scatters -------------------------- */
  /*
   * The cursor is always a hand moving through the cluster - no button
   * required. Moving the mouse over the canvas pushes the pieces it passes;
   * a tap is a separate one-shot impulse on every body.
   *
   * The force follows the cursor's SPEED, not its presence, so a mouse that
   * comes to rest stops pushing and the cluster settles back. That is why the
   * recorded velocity is bled off every frame below: pointermove stops firing
   * the moment the mouse stops, so a stale velocity would otherwise shove
   * forever.
   *
   * The drag force cannot live in the move handler: pointermove fires at the
   * mouse's polling rate, which is neither the render rate nor the fixed
   * physics step, so integrating there would tie push strength to the user's
   * hardware. The handler only records where the cursor is and how fast it is
   * travelling; the frame loop applies the force against PHYSICS_STEP.
   */
  const drag = useRef({
    active: false,     // a button is held (only used to tell a tap from a drag)
    over: false,       // the cursor is on the canvas - this is what gates force
    x: 0, y: 0,        // cursor on the z=0 plane, world units
    vx: 0, vy: 0,      // world units per second, smoothed
    prevX: 0, prevY: 0, prevT: 0,
    hasPrev: false,
    moved: false,
    downX: 0, downY: 0,
    burstAt: new THREE.Vector3(),
  })

  useEffect(() => {
    const el = gl.domElement
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const hit = new THREE.Vector3()
    const ndc = new THREE.Vector2()
    const dir = new THREE.Vector3()

    /* Screen point -> the z=0 plane the cluster is centred on. */
    const toPlane = (event) => {
      const rect = el.getBoundingClientRect()
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      )
      raycaster.setFromCamera(ndc, camera)
      return raycaster.ray.intersectPlane(plane, hit) ? hit : null
    }

    const onMove = (event) => {
      const d = drag.current
      const p = toPlane(event)
      if (!p) return
      d.over = true

      if (d.active && !d.moved &&
          Math.hypot(event.clientX - d.downX, event.clientY - d.downY) > TAP_SLOP) {
        d.moved = true
      }

      const now = event.timeStamp || performance.now()
      if (d.hasPrev) {
        const dtp = Math.max((now - d.prevT) / 1000, 1 / 240)
        /* Exponential smoothing: one mouse sample is mostly jitter, and an
           unsmoothed velocity makes the sweep strength flicker. */
        d.vx += ((p.x - d.prevX) / dtp - d.vx) * 0.35
        d.vy += ((p.y - d.prevY) / dtp - d.vy) * 0.35
      }
      d.x = p.x; d.y = p.y
      d.prevX = p.x; d.prevY = p.y; d.prevT = now
      d.hasPrev = true
    }

    /* Ends the BUTTON gesture only. The hover sweep is independent and keeps
       running, so letting go mid-move does not stall the cluster. */
    const endDrag = () => {
      drag.current.active = false
    }

    const onLeave = () => {
      const d = drag.current
      d.over = false; d.hasPrev = false; d.vx = 0; d.vy = 0
    }

    const burst = (centre) => {
      for (const item of items) {
        const body = item.body
        if (!body) continue
        const t = body.translation()
        dir.set(t.x - hit.x, t.y - hit.y, t.z - hit.z)
        const d = Math.max(dir.length(), 0.4)
        dir.divideScalar(d)
        const falloff = 1 / (1 + d * d * 0.5)
        const mass = body.mass() || 1
        const power = 7.5 * falloff * mass
        body.applyImpulse({ x: dir.x * power, y: dir.y * power, z: dir.z * power * 0.6 }, true)
        body.applyTorqueImpulse(
          {
            x: (Math.random() - 0.5) * 0.5 * falloff * mass,
            y: (Math.random() - 0.5) * 0.5 * falloff * mass,
            z: (Math.random() - 0.5) * 0.5 * falloff * mass,
          },
          true
        )
      }
      onPointerBurst?.()
    }

    const onDown = (event) => {
      const p = toPlane(event)
      if (!p) return
      const d = drag.current
      d.active = true
      d.hasPrev = false
      d.moved = false
      d.vx = 0; d.vy = 0
      d.x = p.x; d.y = p.y
      d.downX = event.clientX; d.downY = event.clientY
      d.burstAt.copy(p)
      /* Capture, so a drag that leaves the canvas keeps steering rather than
         stopping dead at the edge. */
      if (event.pointerId !== undefined) el.setPointerCapture?.(event.pointerId)
    }

    /*
     * Tap and drag separate on RELEASE, not on press. Bursting on pointerdown
     * meant every drag opened with an explosion that drowned out the sweep it
     * was supposed to precede - you could never feel the drag because the
     * cluster was already flying apart.
     */
    const onUp = () => {
      const d = drag.current
      const wasTap = d.active && !d.moved
      endDrag()
      if (wasTap) burst(d.burstAt)
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', endDrag)
    el.addEventListener('pointerleave', onLeave)
    /* A button released outside the window never sends pointerup here. */
    window.addEventListener('blur', endDrag)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', endDrag)
      el.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('blur', endDrag)
    }
  }, [gl, camera, raycaster, items, onPointerBurst])

  /* ---- per-frame: forces, colour lerp, neighbour solve -------------- */

  useFrame((state, rawDelta) => {
    const dt = PHYSICS_STEP
    const t = state.clock.elapsedTime

    /* Bleed the cursor velocity toward zero on a wall-clock time constant.
       pointermove stops firing the instant the mouse stops, so without this
       the last recorded velocity would keep pushing for ever. rawDelta, not
       the fixed physics dt, so the fade is the same at any frame rate. */
    const dr = drag.current
    const fade = Math.exp(-Math.min(rawDelta, 0.1) / 0.09)
    dr.vx *= fade
    dr.vy *= fade
    /* Force follows SPEED: a resting cursor pushes nothing, a moving one
       parts the cluster in proportion to how fast it travels. */
    const dragGain = dr.over ? Math.min(Math.hypot(dr.vx, dr.vy) / 1.5, 1) : 0

    /* Spring each body toward its own slowly wandering home slot. */
    const HOME_DRIFT = 0.42
    for (const item of items) {
      const body = item.body
      if (!body) continue
      const p = body.translation()
      const mass = body.mass() || 1
      const sp = item.spec
      const [dax, day, daz, ph] = sp.drift

      const hx = sp.home[0] + Math.sin(t * dax + ph) * HOME_DRIFT
      const hy = sp.home[1] + Math.cos(t * day + ph * 1.7) * HOME_DRIFT * 0.8
      const hz = sp.home[2] + Math.sin(t * daz + ph * 2.3) * HOME_DRIFT

      const k = 3.2 * mass * dt
      let fx = (hx - p.x) * k
      let fy = (hy - p.y) * k
      let fz = (hz - p.z) * k * 0.8

      /* drag: the cursor as a hand pushed through the cluster. A sweep along
         the direction of travel carries pieces with it; a radial push parts
         them around it so they do not pile up on the leading edge. Both fall
         off with distance, so only the local neighbourhood reacts. */
      if (dragGain > 0.002) {
        const rx = p.x - dr.x
        const ry = p.y - dr.y
        /* z squashed: the cursor is a point on a plane but the cluster is a
           slab, so a true sphere would barely reach the front and back. */
        const rr = Math.hypot(rx, ry, p.z * 0.6)
        if (rr < DRAG_RADIUS) {
          const fall = 1 - rr / DRAG_RADIUS
          const w = fall * fall * mass * dt
          /* Clamped so a fast flick cannot inject more energy than the home
             springs can recover from. */
          fx += clamp(dr.vx, -DRAG_MAX_SPEED, DRAG_MAX_SPEED) * DRAG_SWEEP * w
          fy += clamp(dr.vy, -DRAG_MAX_SPEED, DRAG_MAX_SPEED) * DRAG_SWEEP * w
          /* The parting push is scaled by speed too, so a cursor left sitting
             in the cluster does not slowly hollow out a permanent crater. */
          const inv = (1 / Math.max(rr, 0.3)) * DRAG_PUSH * dragGain
          fx += rx * inv * w
          fy += ry * inv * w
          fz += p.z * inv * w * 0.5
        }
      }

      const dist = Math.hypot(p.x, p.y, p.z)
      if (dist > BOUNDS_RADIUS) {
        const push = 14 * mass * dt * ((dist - BOUNDS_RADIUS) / dist)
        fx -= p.x * push
        fy -= p.y * push
        fz -= p.z * push
      }

      body.applyImpulse({ x: fx, y: fy, z: fz }, false)
      // a whisper of torque keeps every cross slowly tumbling
      body.applyTorqueImpulse(
        {
          x: Math.sin(t * 0.31 + ph) * 0.014 * mass * dt,
          y: Math.cos(t * 0.27 + ph * 1.4) * 0.014 * mass * dt,
          z: Math.sin(t * 0.23 + ph * 0.8) * 0.012 * mass * dt,
        },
        false
      )
    }

    /* colour + background easing */
    const ease = 1 - Math.exp(-rawDelta * 5.0)
    bgCurrent.current.lerp(bgTarget.current, ease)

    for (const item of items) {
      item.color.lerp(item.targetColor, ease)
      item.luma = luminance(item.color)
      const u = item.material.uniforms
      u.u_color.value.copy(item.color)
      u.u_bgColor.value.copy(bgCurrent.current)
      u.u_time.value = t
    }

    if (state.scene.background) state.scene.background.copy(bgCurrent.current)

    /* the actual neighbourhood solve */
    updateNeighbours(items, NEIGHBOUR_COUNT)
  }, -50)

  /* ---- rigid bodies ------------------------------------------------- */
  const armHalf = CROSS.armHalfLength
  const armR = CROSS.armRadius

  return (
    <>
      {items.map((item, i) => {
        const s = item.spec
        const r = armR * s.scale
        const hh = Math.max((armHalf - armR) * s.scale, 0.01)
        return (
          <RigidBody
            key={s.id}
            ref={(ref) => {
              item.body = ref
              bodies.current[i] = ref
            }}
            colliders={false}
            position={s.position}
            rotation={s.rotation}
            linearDamping={1.05}
            angularDamping={0.75}
            canSleep={false}
            restitution={0.22}
            friction={0.35}
          >
            {/* three capsules = the physical cross */}
            <CapsuleCollider args={[hh, r]} density={1.6} />
            <CapsuleCollider args={[hh, r]} rotation={[0, 0, Math.PI / 2]} density={1.6} />
            <CapsuleCollider args={[hh, r]} rotation={[Math.PI / 2, 0, 0]} density={1.6} />

            <mesh
              ref={(m) => {
                item.mesh = m
              }}
              geometry={geometry}
              material={item.material}
              scale={s.scale}
              frustumCulled={false}
              userData={{ frosted: item.frosted }}
            />
          </RigidBody>
        )
      })}
    </>
  )
}
