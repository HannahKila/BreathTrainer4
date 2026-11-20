
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const MAX_POINTS = 250
const CHART_RANGE = 8
const CHART_WIDTH = 350
const BASELINE_Y = 115

function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [isTraining, setIsTraining] = useState(false)
  const [status, setStatus] = useState('Disconnected')
  const [voltage, setVoltage] = useState(null)
  const [duration, setDuration] = useState(0)
  const [samples, setSamples] = useState([])
  const [error, setError] = useState('')
  const [showRanking, setShowRanking] = useState(false)
  const [activeTab, setActiveTab] = useState('Activity')

  const portRef = useRef(null)
  const readerRef = useRef(null)
  const startedAtRef = useRef(null)
  const activeRef = useRef(false)
  const sessionTimerRef = useRef(null)

  async function connectSerial() {
    if (!('serial' in navigator)) {
      setError('Web Serial is not supported. Please use Chrome.')
      return
    }

    try {
      setError('')
      setStatus('Choose your device...')

      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: 115200 })

      portRef.current = port
      setIsConnected(true)
      setStatus('Connected · Waiting for data')

      const reader = port.readable.getReader()
      readerRef.current = reader

      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const parsed = Number(line.trim())

            if (line.trim() === '' || !Number.isFinite(parsed)) {
              continue
            }

            setVoltage(parsed)
            setStatus('Connected · Receiving data')

            setSamples(previous => [
              ...previous,
              { time: Date.now(), value: parsed }
            ].slice(-MAX_POINTS))
          }
        }
      } finally {
        reader.releaseLock()
        readerRef.current = null
      }
    } catch (err) {
      if (
        err.name !== 'NotFoundError' &&
        err.name !== 'AbortError'
      ) {
        setError(err.message || 'Serial connection failed.')
      }
    } finally {
      const port = portRef.current
      portRef.current = null

      if (port?.readable) {
        try {
          await port.close()
        } catch {
          // Port may already be closed.
        }
      }

      setIsConnected(false)
      setStatus('Disconnected')
    }
  }

  async function disconnectSerial() {
    try {
      await readerRef.current?.cancel()
    } catch {
      // Reader may already be stopped.
    }
  }

  useEffect(() => {
    if (!isTraining) return undefined

    sessionTimerRef.current = window.setInterval(() => {
      if (startedAtRef.current) {
        setDuration(
          (Date.now() - startedAtRef.current) / 1000
        )
      }
    }, 100)

    return () => window.clearInterval(sessionTimerRef.current)
  }, [isTraining])

  function toggleTraining() {
    if (activeRef.current) {
      activeRef.current = false
      setIsTraining(false)

      setDuration(
        startedAtRef.current
          ? (Date.now() - startedAtRef.current) / 1000
          : 0
      )
      return
    }

    activeRef.current = true
    setIsTraining(true)
    startedAtRef.current = Date.now()
    setDuration(0)
    setSamples([])
  }

  useEffect(() => {
    return () => {
      activeRef.current = false
      readerRef.current?.cancel().catch(() => {})
      window.clearInterval(sessionTimerRef.current)
    }
  }, [])

  // Smooth sensor noise while preserving breathing changes.
  const smoothSamples = useMemo(() => {
    return samples.map((sample, index) => {
      const start = Math.max(0, index - 14)
      const windowSamples = samples.slice(start, index + 1)

      let weightedSum = 0
      let totalWeight = 0

      windowSamples.forEach((item, i) => {
        const weight = (i + 1) ** 2
        weightedSum += item.value * weight
        totalWeight += weight
      })

      return {
        ...sample,
        value: weightedSum / totalWeight
      }
    })
  }, [samples])

  // Keep a five-second rolling window.
  const coords = smoothSamples.map((sample, index) => {
    const x =
      smoothSamples.length <= 1
        ? CHART_WIDTH
        : (index / (MAX_POINTS - 1)) * CHART_WIDTH

    const clamped = Math.max(
      -CHART_RANGE,
      Math.min(CHART_RANGE, sample.value)
    )

    return {
      x,
      y: BASELINE_Y - (clamped / CHART_RANGE) * 70
    }
  })

  // Smooth Bezier interpolation.
  function makeSmoothPath(points) {
    if (!points.length) return ''

    return points.reduce((path, point, i, all) => {
      if (i === 0) {
        return `M ${point.x} ${point.y}`
      }

      const prev = all[i - 1]
      const before = all[Math.max(0, i - 2)]
      const next = all[Math.min(all.length - 1, i + 1)]

      const c1x = prev.x + (point.x - before.x) / 6
      const c1y = prev.y + (point.y - before.y) / 6
      const c2x = point.x - (next.x - prev.x) / 6
      const c2y = point.y - (next.y - prev.y) / 6

      return `${path} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${point.x} ${point.y}`
    }, '')
  }

  const chartPath = makeSmoothPath(coords)

  // Generate contours inside the space between the baseline
  // and the real pressure waveform.
  // Each layer has its own gentle undulation.
  const rippleLevels = [
    0.12, 0.22, 0.32, 0.42,
    0.52, 0.62, 0.72, 0.82, 0.92
  ]

  const ripplePaths = rippleLevels.map((level, layerIndex) => {
    const layerPoints = coords.map(point => {
      const distance = point.y - BASELINE_Y

      const phase = layerIndex * 0.72

      const oscillation =
        Math.sin(point.x * 0.045 + phase) * 2.0 +
        Math.sin(point.x * 0.083 - phase) * 0.8

      // Ripples spread through the gap rather than duplicating
      // the original waveform at fixed vertical offsets.
      const rippleAmount = Math.sin(level * Math.PI)

      return {
        x: point.x,
        y:
          BASELINE_Y +
          distance * level +
          oscillation * rippleAmount
      }
    })

    return {
      path: makeSmoothPath(layerPoints),
      level,
      index: layerIndex
    }
  })

  // Close the area from the actual waveform back to baseline.
  const areaPath = coords.length > 1
    ? `${chartPath} L ${coords[coords.length - 1].x} ${BASELINE_Y} L ${coords[0].x} ${BASELINE_Y} Z`
    : ''

  const referencePath =
    `M 0 ${BASELINE_Y} L ${CHART_WIDTH} ${BASELINE_Y}`

  const recent = smoothSamples.slice(-20).map(s => s.value)

  const fluctuation = recent.length > 1
    ? Math.max(...recent) - Math.min(...recent)
    : 0

  const pressureKpa = voltage === null
    ? null
    : Math.min(2.0, Math.abs(voltage) / CHART_RANGE * 0.7)

  const blowing = voltage !== null && Math.abs(voltage) > 2

  const lastBreathStart = (() => {
    if (!blowing) return null

    let start = samples.length - 1

    while (
      start > 0 &&
      Math.abs(samples[start - 1].value) > 2
    ) {
      start--
    }

    return samples[start]?.time ?? Date.now()
  })()

  const blowLength =
    blowing && lastBreathStart
      ? (Date.now() - lastBreathStart) / 1000
      : 0

  const fmtSeconds = n =>
    `${Math.floor(Math.max(0, n))}s`

  return (
    <main className="app">
      <div className="status-bar" aria-hidden="true">
        <span>9:41</span>
        <span className="status-icons">
          <i />
          <i />
          <b />
        </span>
      </div>

      <header className="page-heading">
        <h1>Breathe Trainer</h1>
        <p>stability</p>
      </header>

      <section
        className="chart-section"
        aria-label="Live breath stability chart"
      >
        <div className="chart-wrap">
          <svg
            className="chart-svg"
            viewBox="0 0 350 230"
            preserveAspectRatio="none"
            role="img"
            aria-label="Live breath waveform"
          >
            <defs>
              <linearGradient
                id="liquidFill"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="#78dba0"
                  stopOpacity="0.42"
                />
                <stop
                  offset="48%"
                  stopColor="#2eaa87"
                  stopOpacity="0.20"
                />
                <stop
                  offset="100%"
                  stopColor="#087a73"
                  stopOpacity="0.015"
                />
              </linearGradient>

              <linearGradient
                id="rippleStroke"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="#a2f0b1"
                  stopOpacity="0.95"
                />
                <stop
                  offset="100%"
                  stopColor="#239b82"
                  stopOpacity="0.20"
                />
              </linearGradient>

              <linearGradient
                id="mainWaveStroke"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="#fffaf3" />
                <stop offset="100%" stopColor="#f0c2b7" />
              </linearGradient>

              <filter
                id="waveGlow"
                x="-30%"
                y="-100%"
                width="160%"
                height="300%"
              >
                <feGaussianBlur stdDeviation="3" />
              </filter>
            </defs>

            {Array.from({ length: 17 }, (_, i) => (
              <line
                key={`v${i}`}
                x1={10 + i * 20}
                y1="0"
                x2={10 + i * 20}
                y2="200"
                className="grid-line"
              />
            ))}

            {Array.from({ length: 11 }, (_, i) => (
              <line
                key={`h${i}`}
                x1="0"
                y1={7 + i * 20}
                x2="350"
                y2={7 + i * 20}
                className="grid-line"
              />
            ))}

            {/* Baseline */}
            <path
              d={referencePath}
              className="reference-line"
            />

            {coords.length > 1 && (
              <g>
                {/* Translucent surface spreading from baseline
                    to the real waveform. */}
                <path
                  d={areaPath}
                  fill="url(#liquidFill)"
                  stroke="none"
                />

                {/* Nine individually shaped contours.
                    Their position is interpolated between
                    baseline and the live sensor curve. */}
                {ripplePaths.map(ripple => (
                  <path
                    key={`ripple-${ripple.index}`}
                    d={ripple.path}
                    fill="none"
                    stroke="url(#rippleStroke)"
                    strokeWidth={0.65 + ripple.level * 0.7}
                    strokeOpacity={0.16 + ripple.level * 0.62}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}

                {/* Soft halo behind the live waveform */}
                <path
                  d={chartPath}
                  fill="none"
                  stroke="#f5c9bd"
                  strokeWidth="8"
                  strokeOpacity="0.38"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter="url(#waveGlow)"
                />

                {/* Real pressure waveform */}
                <path
                  d={chartPath}
                  fill="none"
                  stroke="url(#mainWaveStroke)"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />

                {/* Surface highlight */}
                <path
                  d={chartPath}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="0.8"
                  strokeOpacity="0.85"
                  strokeLinecap="round"
                  transform="translate(0 -0.8)"
                />
              </g>
            )}
          </svg>

          <div className="x-labels">
            <span>−5s</span>
            <span>−4s</span>
            <span>−3s</span>
            <span>−2s</span>
            <span>Now</span>
          </div>
        </div>
      </section>

      <button
        className="ranking-button"
        onClick={() => setShowRanking(v => !v)}
      >
        {showRanking
          ? 'Your stability ranking'
          : 'See the ranking'}
      </button>

      {showRanking && (
        <div className="ranking-note">
          Keep breathing steadily to build your stability score.
        </div>
      )}

      <section
        className="metrics-grid"
        aria-label="Breathing measurements"
      >
        <article className="metric-card">
          <span>length</span>
          <strong>
            {fmtSeconds(blowing ? blowLength : 0)}
          </strong>
        </article>

        <article className="metric-card">
          <span>pressure</span>
          <strong>
            {pressureKpa === null
              ? '0.7'
              : pressureKpa.toFixed(1)}kPa
          </strong>
        </article>

        <article className="metric-card">
          <span>fluctuate</span>
          <strong>
            ±{(fluctuation / 2).toFixed(1)}
          </strong>
        </article>

        <article className="metric-card">
          <span>length</span>
          <strong>
            {fmtSeconds(
              blowing
                ? blowLength
                : isTraining
                  ? duration
                  : 15
            )}
          </strong>
        </article>
      </section>

      <div className="connection-controls">
        {!isConnected ? (
          <button
            onClick={connectSerial}
            className="connect-button"
          >
            Connect sensor
          </button>
        ) : (
          <button
            onClick={disconnectSerial}
            className="connect-button"
          >
            Disconnect sensor
          </button>
        )}

        <button
          onClick={toggleTraining}
          className="session-button"
          disabled={!isConnected}
        >
          {isTraining ? 'End session' : 'Begin session'}
        </button>

        {error && <p className="error-text">{error}</p>}
      </div>

      <nav className="bottom-nav" aria-label="Main navigation">
        <button
          className={activeTab === 'Plan' ? 'selected' : ''}
          onClick={() => setActiveTab('Plan')}
        >
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <rect x="4" y="5" width="32" height="30" rx="1" />
            <path d="M11 14h3m5 0h10M11 21h3m5 0h10M11 28h3m5 0h10" />
          </svg>
          <span>Plan</span>
        </button>

        <button
          className={activeTab === 'Activity' ? 'selected' : ''}
          onClick={() => setActiveTab('Activity')}
        >
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <path d="M3 23h6l4-19c.5-2 3-2 3.5 0L21 35c.4 2 3 2 3.5 0L29 12c.4-2 3-2 3.5 0L35 23h3" />
          </svg>
          <span>Activity</span>
        </button>

        <button
          className={activeTab === 'Home' ? 'selected' : ''}
          onClick={() => setActiveTab('Home')}
        >
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="12" r="8" />
            <path d="M5 35c1-9 7-14 15-14s14 5 15 14" />
          </svg>
          <span>Home</span>
        </button>
      </nav>

      <div className="status-hidden" aria-live="polite">
        {status} · {isConnected
          ? 'sensor connected'
          : 'sensor disconnected'}
      </div>
    </main>
  )
}

export default App
