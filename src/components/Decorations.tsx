import { useId } from 'react'

/*
 * Purely decorative 3D-style accents drawn as inline SVG.
 * Everything here is aria-hidden and ignores pointer events.
 */

type CubeTone = 'blue' | 'copper' | 'lavender' | 'mint'

// [top, left, right] face colours — light from above-left.
const cubeFaces: Record<CubeTone, [string, string, string]> = {
  blue: ['#8fb4ff', '#3d6ef0', '#1f3fae'],
  copper: ['#f6cdb8', '#d99a80', '#a8675a'],
  lavender: ['#e2d6ff', '#b39cf5', '#7d63d1'],
  mint: ['#c9f3e1', '#7fd9b4', '#3ea983'],
}

type Point = [x: number, y: number, z: number]

interface CubeClusterProps {
  /** Lattice positions; x runs right-down, y left-down, z up. */
  cubes: Point[]
  tone: CubeTone
  /** Edge length of one cube in SVG units. */
  unit?: number
  className?: string
}

export function CubeCluster({ cubes, tone, unit = 24, className }: CubeClusterProps) {
  const w = unit * 0.866
  const h = unit / 2
  const [top, left, right] = cubeFaces[tone]

  // Painter's order: back-to-front, bottom-to-top.
  const ordered = [...cubes].sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[2] - b[2])

  const projected = ordered.map(([x, y, z]) => ({
    key: `${x}-${y}-${z}`,
    cx: (x - y) * w,
    cy: (x + y) * h - z * unit,
  }))

  const xs = projected.flatMap((p) => [p.cx - w, p.cx + w])
  const ys = projected.flatMap((p) => [p.cy - unit, p.cy + unit])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const width = Math.max(...xs) - minX
  const height = Math.max(...ys) - minY

  return (
    <svg
      className={className}
      viewBox={`${minX - 1} ${minY - 1} ${width + 2} ${height + 2}`}
      aria-hidden="true"
      focusable="false"
    >
      {projected.map(({ key, cx, cy }) => (
        <g key={key} stroke="rgba(255,255,255,0.35)" strokeWidth={0.6} strokeLinejoin="round">
          <polygon fill={top} points={`${cx},${cy} ${cx - w},${cy - h} ${cx},${cy - unit} ${cx + w},${cy - h}`} />
          <polygon fill={left} points={`${cx},${cy} ${cx - w},${cy - h} ${cx - w},${cy + h} ${cx},${cy + unit}`} />
          <polygon fill={right} points={`${cx},${cy} ${cx + w},${cy - h} ${cx + w},${cy + h} ${cx},${cy + unit}`} />
        </g>
      ))}
    </svg>
  )
}

/** Faceted diamond inspired by the folded-paper shape in the reference. */
export function Gem({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd9c7" />
          <stop offset="1" stopColor="#d48d7a" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2b9a3" />
          <stop offset="1" stopColor="#9e5d55" />
        </linearGradient>
      </defs>
      <polygon points="50,4 4,50 50,50" fill={`url(#${id}-a)`} />
      <polygon points="50,4 96,50 50,50" fill={`url(#${id}-b)`} />
      <polygon points="4,50 50,96 50,50" fill={`url(#${id}-b)`} opacity="0.9" />
      <polygon points="96,50 50,96 50,50" fill={`url(#${id}-a)`} opacity="0.85" />
    </svg>
  )
}

/** Colourful DomainDesk logo mark: a globe inside a gradient tile. */
export function LogoMark({ size = 36 }: { size?: number }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b8cff" />
          <stop offset="0.55" stopColor="#9b7bff" />
          <stop offset="1" stopColor="#ff8f7a" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill={`url(#${id})`} />
      <g fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
        <circle cx="20" cy="20" r="10" />
        <path d="M10 20h20" />
        <path d="M20 10a15 15 0 0 1 0 20a15 15 0 0 1 0-20" />
      </g>
      <circle cx="31" cy="9" r="3.5" fill="#ffd23f" stroke="#fff" strokeWidth="1.5" />
    </svg>
  )
}
