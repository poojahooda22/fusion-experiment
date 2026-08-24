/* Mobile-only affordance: device tilt steers the fluid's gravity. Renders
 * nothing on desktop or once tilt is enabled. Ported 1:1; class names only. */
export default function TiltButton({ supported, enabled, permissionDenied, onRequest }) {
  const isTouchDevice = 'ontouchstart' in window
    || window.matchMedia('(pointer: coarse)').matches

  if (!isTouchDevice || !supported || enabled) return null

  return (
    <button
      type="button"
      onClick={onRequest}
      disabled={permissionDenied}
      className="ft-tilt-btn"
    >
      {permissionDenied ? 'Tilt Permission Denied' : 'Enable Tilt Controls'}
    </button>
  )
}
