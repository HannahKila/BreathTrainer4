import { useState } from 'react'
import CurveThumb from './CurveThumb.jsx'
import { stabilityScore } from './storage.js'

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'all', label: 'All Time' }
]

// 演示用的其他玩家。目前没有服务器,排行榜里的其他人是写死的示例数据;
// 接入后端后,把这里换成从服务器取回的数据即可。
const DEMO_PLAYERS = [
  { name: 'Alex', scores: { today: 93, week: 94, all: 95 }, seed: 1 },
  { name: 'John', scores: { today: 91, week: 90, all: 92 }, seed: 2 },
  { name: 'May', scores: { today: 88, week: 89, all: 90 }, seed: 3 },
  { name: 'Philip', scores: { today: 81, week: 84, all: 86 }, seed: 4 },
  { name: 'Lina', scores: { today: 76, week: 80, all: 83 }, seed: 5 }
]

// 根据种子生成一条稳定的示例曲线(每次渲染都一样)
function demoCurve(seed, score) {
  const wobble = (100 - score) / 100
  return Array.from({ length: 32 }, (_, i) => {
    const t = i / 31
    return 0.5 +
      Math.sin(t * 6 + seed * 1.7) * wobble * 0.9 +
      Math.sin(t * 13 + seed) * wobble * 0.35
  })
}

function periodStart(key) {
  const now = new Date()
  if (key === 'today') {
    now.setHours(0, 0, 0, 0)
    return now.getTime()
  }
  if (key === 'week') {
    now.setHours(0, 0, 0, 0)
    now.setDate(now.getDate() - ((now.getDay() + 6) % 7))
    return now.getTime()
  }
  return 0
}

// 曲线图:这段时间里每次练习的稳定度,按时间先后排列
const CHART_W = 340
const CHART_H = 130
const PAD_L = 10

function trendPath(values) {
  if (values.length === 0) return ''
  const maxIndex = Math.max(20, values.length)
  const points = values.map((v, i) => ({
    x: PAD_L + ((i + 1) / maxIndex) * (CHART_W - PAD_L - 8),
    y: CHART_H - 8 - (v / 100) * (CHART_H - 16)
  }))
  if (points.length === 1) {
    const p = points[0]
    return `M ${PAD_L} ${p.y} L ${p.x} ${p.y}`
  }
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const mx = (a.x + b.x) / 2
    d += ` C ${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`
  }
  return d
}

export default function RankPage({ history, profile, onStart }) {
  const [period, setPeriod] = useState('today')
  const since = periodStart(period)
  const sessions = history
    .filter(item => item.date >= since)
    .sort((a, b) => a.date - b.date)

  const scores = sessions.map(item => stabilityScore(item.fluctuate))
  const best = sessions.reduce(
    (top, item) => (!top || item.fluctuate < top.fluctuate ? item : top),
    null
  )

  const me = best && {
    name: profile.name.trim() || 'You',
    score: stabilityScore(best.fluctuate),
    curve: best.curve,
    isMe: true
  }

  const rows = [
    ...DEMO_PLAYERS.map(player => ({
      name: player.name,
      score: player.scores[period],
      curve: demoCurve(player.seed, player.scores[period])
    })),
    ...(me ? [me] : [])
  ].sort((a, b) => b.score - a.score)

  const maxIndex = Math.max(20, scores.length)
  const ticks = [5, 10, 15, 20].map(n => Math.round((n / 20) * maxIndex))

  return (
    <section className="rank-page" aria-label="Stability ranking">
      <header className="rank-header">
        <div>
          <h1>Breathe Trainer</h1>
          <p>Stability Ranking</p>
        </div>
        <button type="button" className="icon-button" onClick={onStart} aria-label="Go to training">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12h15M13 6l6 6-6 6" />
          </svg>
        </button>
      </header>

      <div className="segmented" role="tablist" aria-label="Ranking period">
        {PERIODS.map(item => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={period === item.key}
            className={period === item.key ? 'active' : ''}
            onClick={() => setPeriod(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="trend-chart">
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => (
            <line
              key={`v${i}`}
              className="trend-grid"
              x1={PAD_L + (i / 11) * (CHART_W - PAD_L - 8)}
              x2={PAD_L + (i / 11) * (CHART_W - PAD_L - 8)}
              y1="0"
              y2={CHART_H}
            />
          ))}
          {Array.from({ length: 5 }, (_, i) => (
            <line
              key={`h${i}`}
              className="trend-grid"
              x1="0"
              x2={CHART_W}
              y1={(i / 4) * (CHART_H - 2) + 1}
              y2={(i / 4) * (CHART_H - 2) + 1}
            />
          ))}
          <path className="trend-line" d={trendPath(scores)} />
        </svg>
        <div className="trend-ticks">
          {ticks.map(tick => (
            <span key={tick} style={{ left: `${(tick / maxIndex) * 100}%` }}>{tick}</span>
          ))}
        </div>
        {scores.length === 0 && (
          <p className="trend-empty">No sessions {period === 'all' ? 'yet' : 'in this period'}</p>
        )}
      </div>

      <ol className="rank-list">
        {rows.map((row, index) => (
          <li key={row.name + (row.isMe ? '-me' : '')} className={`rank-row${row.isMe ? ' me glass' : ''}`}>
            <span className="rank-pos">{index + 1}</span>
            <span className="rank-name">{row.name}</span>
            <span className="rank-score">{row.score}%</span>
            <CurveThumb curve={row.curve} id={`rank-${index}`} plain />
          </li>
        ))}
      </ol>
      {!me && (
        <p className="empty-note">Finish a session {period === 'today' ? 'today' : period === 'week' ? 'this week' : ''} to join the ranking.</p>
      )}
    </section>
  )
}
