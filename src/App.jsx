import { Hero } from './hero/Hero.jsx'
import { ShapeStudy } from './hero/ShapeStudy.jsx'

export default function App() {
  const params =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null

  // ?debug=shape renders the cross on its own, at three fixed orientations,
  // for comparing the silhouette against a reference frame.
  if (params?.get('debug') === 'shape') return <ShapeStudy />

  // ?quality=raw|low|medium|high overrides the auto-detected preset.
  return <Hero />
}
