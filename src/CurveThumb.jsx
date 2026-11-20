// 历史记录里的曲线缩略图
const W = 100
const H = 36

function smoothPath(points) {
  if (points.length < 2) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2
    const midY = (points[i].y + points[i + 1].y) / 2
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`
  }
  const last = points[points.length - 1]
  return `${d} L ${last.x} ${last.y}`
}

// plain:只画一条细线(排行榜里用),不画填充
export default function CurveThumb({ curve, id, plain = false }) {
  const values = curve && curve.length > 1 ? curve : [0, 0]
  const points = values.map((v, i) => ({
    x: (i / (values.length - 1)) * W,
    y: H - 2 - v * (H - 6)
  }))
  const line = smoothPath(points)
  const area = `${line} L ${W} ${H} L 0 ${H} Z`
  const gradientId = `thumb-fill-${id}`

  return (
    <svg
      className="curve-thumb"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d9674a" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#f3c9b5" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      {!plain && <path d={area} fill={`url(#${gradientId})`} />}
      <path
        d={line}
        fill="none"
        stroke={plain ? '#3b2a24' : '#d9674a'}
        strokeWidth={plain ? 1.1 : 1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
