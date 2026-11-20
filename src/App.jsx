import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import HomePage from './HomePage.jsx'
import RankPage from './RankPage.jsx'
import {
  addHistory,
  downsampleCurve,
  loadHistory,
  loadProfile,
  saveProfile
} from './storage.js'

const CHART_RANGE = 8 // 如果传感器数值经常超过 8,请调大(例如 20)
// 气压 → 高度 (0~1)。前 70% 是线性的,之后平滑地逼近 1,
// 所以曲线永远不会超过 WAVE_HEIGHT(栅格的 4/5),也不会被硬性截平。
// 曲线整体太矮就调小 FULL_SCALE,太容易接近上限就调大。
const FULL_SCALE = 5.5
const KNEE = 0.7
const pressureToHeight = pressure => {
  const x = Math.max(0, pressure) / FULL_SCALE
  if (x <= KNEE) return x
  return KNEE + (1 - KNEE) * (1 - Math.exp(-(x - KNEE) / (1 - KNEE)))
}

// 2. 波浪感:对高度做高斯平滑,数值越大越平滑(单位:采样点)
const WAVE_SMOOTH_SIGMA = 6

// 不吹气时,最高值虚线回落到当前曲线高度的速度(毫秒,越大回落越慢)
const PEAK_DECAY_MS = 1500
// 练习结束:实时曲线淡出的时长,之后再显现整场练习的结果曲线
const FADE_OUT_MS = 700

// 训练中的波点动画:行数和列数
const DOT_ROWS = 4
const DOT_COLS = 9

// 5. 自动归零:不吹气时缓慢跟踪传感器的静止读数,抵消零点漂移
const BASELINE_TRACK_BAND = 1.5 // 和静止值相差小于这个数时,视为没在吹气
const BASELINE_TRACK_RATE = 0.02
// 读数在 RESTING_WINDOW_MS 内的波动小于 RESTING_RANGE,说明气压稳定没在变化
// (没在吹气,只是传感器零点漂移了),此时直接把零点拉到当前读数。
const RESTING_WINDOW_MS = 1200
const RESTING_RANGE = 0.5
const RESTING_REZERO_RATE = 0.08
const CHART_WIDTH = 350
const BASELINE_Y = 207 // 零线 = 最底部的栅格线,下面不再有负数区域

// Breathing detection settings
const BLOW_START_THRESHOLD = 2.0

// 传感器读数 → kPa
const toKpa = value => (Math.abs(value) / CHART_RANGE) * 0.7
const BLOW_END_THRESHOLD = 1.2
const START_CONFIRM_SAMPLES = 4
const END_CONFIRM_SAMPLES = 8

// Waveform appearance
const GRID_HEIGHT = 200 // 栅格总高度 (y=7 到 y=207)
const WAVE_HEIGHT = GRID_HEIGHT * 0.8 // 最高只到栅格的 4/5
const WINDOW_MS = 5000

function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [isTraining, setIsTraining] = useState(false)
  const [sessionComplete, setSessionComplete] = useState(false)
  // 结束练习后、结果曲线显现前的淡出阶段
  const [finishing, setFinishing] = useState(false)
  const [status, setStatus] = useState('Disconnected')
  const [duration, setDuration] = useState(0)
  const [samples, setSamples] = useState([])
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('Train')
  const [profile, setProfile] = useState(loadProfile)
  const [history, setHistory] = useState(loadHistory)
  // 已保存过的那次练习(用开始时间标识),避免重复保存
  const savedSessionRef = useRef(null)

  const portRef = useRef(null)
  const readerRef = useRef(null)
  const startedAtRef = useRef(null)
  const activeRef = useRef(false)
  const sessionTimerRef = useRef(null)

  // Track the current session and its inactivity timeout.
  const sessionCompleteRef = useRef(false)
  const hasBlownRef = useRef(false)
  const lastBlowAtRef = useRef(null)
  const firstBlowAtRef = useRef(null)
  // 最高值虚线的高度:只升不降,直到开始新一次练习才重置
  const peakHoldRef = useRef(0)
  // 传感器静止时的读数(零点),以及 x 轴计时的起点
  const baselineRef = useRef(null)
  const timeOriginRef = useRef(null)
  const peakDecayAtRef = useRef(null)
  const finishTimerRef = useRef(null)
  // 连续几次读到吹气就自动开始练习(过滤单个噪声尖峰)
  const autoStartCountRef = useRef(0)
  // 平滑后的气压大小,用来判断是否还在吹气(过滤单个噪声尖峰)
  const recentReadingsRef = useRef([])

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
      baselineRef.current = null
      recentReadingsRef.current = []
      timeOriginRef.current = Date.now()
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
            const reading = Number(line.trim())

            if (line.trim() === '' || !Number.isFinite(reading)) {
              continue
            }

            const now = Date.now()

            // 记录最近一段时间的读数,判断气压是否稳定不变
            const recent = recentReadingsRef.current
            recent.push({ time: now, value: reading })
            while (recent.length > 0 && recent[0].time < now - RESTING_WINDOW_MS) {
              recent.shift()
            }
            const recentValues = recent.map(r => r.value)
            const isResting =
              recent.length >= 5 &&
              recent[recent.length - 1].time - recent[0].time >= RESTING_WINDOW_MS * 0.8 &&
              Math.max(...recentValues) - Math.min(...recentValues) < RESTING_RANGE

            // 减去静止零点:
            // - 读数接近零点 → 缓慢跟踪(抵消小漂移)
            // - 读数稳定不动(没在吹,只是零点漂到别处) → 较快地重新归零
            if (baselineRef.current === null) baselineRef.current = reading
            const offset = reading - baselineRef.current
            if (isResting) {
              baselineRef.current += offset * RESTING_REZERO_RATE
            } else if (Math.abs(offset) < BASELINE_TRACK_BAND) {
              baselineRef.current += offset * BASELINE_TRACK_RATE
            }
            const parsed = reading - baselineRef.current

            setStatus('Connected · Receiving data')

            // 记录第一次和最后一次吹气的时间,结束时用来裁掉首尾的空白
            if (
              activeRef.current &&
              !isResting &&
              Math.abs(parsed) >= BLOW_START_THRESHOLD
            ) {
              if (!hasBlownRef.current) firstBlowAtRef.current = now
              hasBlownRef.current = true
              lastBlowAtRef.current = now
            }

            // 还没开始练习时,一吹气就自动开始(结果页上不会自动开始,
            // 以免把刚出来的结果冲掉,要用 Begin session 重新开始)
            if (!activeRef.current && !sessionCompleteRef.current) {
              const blowingNow = !isResting && Math.abs(parsed) >= BLOW_START_THRESHOLD
              autoStartCountRef.current = blowingNow ? autoStartCountRef.current + 1 : 0
              if (autoStartCountRef.current >= START_CONFIRM_SAMPLES) {
                startSession({ keepRecent: true })
              }
            }

            setSamples(previous => {
              // Keep the completed session frozen until the next session starts.
              if (sessionCompleteRef.current) return previous

              const next = [
                ...previous,
                { time: now, value: parsed }
              ]

              // Keep all samples during a session so the final result can show
              // the complete curve. Outside a session, only keep the live window.
              // 按时间保留(窗口 + 2 秒余量),这样平滑算法的"起步段"落在
              // 画面左边之外,曲线移到左边缘时不会自己往下掉。
              return activeRef.current
                ? next
                : next.filter(s => s.time >= now - WINDOW_MS - 2000)
            })
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

  // 统一的结束逻辑:Finish 按钮和 End session 都走这里。
  // 先冻结并淡出实时曲线,FADE_OUT_MS 之后再显现整场练习的结果曲线。
  function finishSession() {
    if (!activeRef.current) return

    activeRef.current = false
    sessionCompleteRef.current = true // 冻结数据,淡出期间曲线不再移动

    setIsTraining(false)
    setFinishing(true)
    setStatus('Session complete')

    const first = firstBlowAtRef.current
    const last = lastBlowAtRef.current
    const startedAt = startedAtRef.current ?? Date.now()
    const endedAt = Date.now()

    window.clearTimeout(finishTimerRef.current)
    finishTimerRef.current = window.setTimeout(() => {
      if (first !== null && last !== null) {
        // 裁掉开头的空等和结尾的 3 秒平线,只保留真正的练习部分。
        const from = Math.max(first - 600, startedAt)
        const to = last + 800

        setSamples(previous => {
          const trimmed = previous.filter(
            s => s.time >= from && s.time <= to
          )
          return trimmed.length > 1 ? trimmed : previous
        })
        setDuration((to - from) / 1000)
      } else {
        setDuration((endedAt - startedAt) / 1000)
      }

      setFinishing(false)
      setSessionComplete(true)
    }, FADE_OUT_MS)
  }

  // 开始一次新练习。keepRecent:保留最近 1 秒的数据,
  // 这样吹气自动开始时,这一口气的开头也会画进曲线里。
  function startSession({ keepRecent = false } = {}) {
    const now = Date.now()
    window.clearTimeout(finishTimerRef.current)
    setFinishing(false)
    activeRef.current = true
    sessionCompleteRef.current = false
    hasBlownRef.current = keepRecent
    lastBlowAtRef.current = keepRecent ? now : null
    firstBlowAtRef.current = keepRecent ? now : null
    startedAtRef.current = keepRecent ? now - 1000 : now
    timeOriginRef.current = startedAtRef.current
    peakHoldRef.current = 0
    autoStartCountRef.current = 0

    setSessionComplete(false)
    setIsTraining(true)
    setDuration(0)
    setSamples(previous =>
      keepRecent ? previous.filter(s => s.time >= now - 1000) : []
    )
    setStatus('Ready to breathe')
  }

  function toggleTraining() {
    if (activeRef.current) {
      finishSession()
      return
    }
    startSession()
  }

  useEffect(() => {
    return () => {
      activeRef.current = false
      readerRef.current?.cancel().catch(() => {})
      window.clearInterval(sessionTimerRef.current)
      window.clearTimeout(finishTimerRef.current)
    }
  }, [])

  // 1. Smooth breathing waveform with noise filtering and gentle transitions.
  const smoothSamples = useMemo(() => {
    if (samples.length === 0) return []

    const NOISE_THRESHOLD = 1.8
    const DEAD_BAND = 0.45
    const VARIATION_SCALE = 0.6 // 越大,强弱吹气的高度差越明显
    const WINDOW_SIZE = 9

    let filteredValue = 0
    let wasBlowing = false

    return samples.map((sample, index) => {
      const raw = sample.value

      // 2. Smooth the local input with a moving average.
      const start = Math.max(0, index - WINDOW_SIZE + 1)
      const windowSamples = samples.slice(start, index + 1)

      const average =
        windowSamples.reduce((sum, item) => sum + item.value, 0) /
        windowSamples.length

      const avgMagnitude = Math.abs(average)

      let smoothedTarget = 0

      if (avgMagnitude > NOISE_THRESHOLD) {
        const excess = Math.max(0, avgMagnitude - NOISE_THRESHOLD)

        smoothedTarget =
          Math.sign(average) *
          (NOISE_THRESHOLD + DEAD_BAND + excess * VARIATION_SCALE)
      }

      // 3. Ease into and out of blowing instead of snapping.
      const isBlowingNow = Math.abs(smoothedTarget) > 0

      const alpha = isBlowingNow
        ? (wasBlowing ? 0.24 : 0.12)
        : (wasBlowing ? 0.10 : 0.06)

      filteredValue += (smoothedTarget - filteredValue) * alpha

      // 4. Keep the resting line perfectly flat.
      if (
        Math.abs(raw) < NOISE_THRESHOLD * 0.65 &&
        Math.abs(filteredValue) < NOISE_THRESHOLD
      ) {
        filteredValue = 0
      }

      wasBlowing = isBlowingNow

      return {
        ...sample,
        value: filteredValue,
      }
    })
  }, [samples])

  // 2. Detect a real blowing event, build the waveform points,
  // and track the highest drawn height (peakDelta) for the guide line.
  const fullSessionView = sessionComplete

  const fmtSeconds = n =>
    `${Math.floor(Math.max(0, n))}s`

  const latestTime = smoothSamples.length > 0
    ? smoothSamples[smoothSamples.length - 1].time
    : Date.now()

  // Live mode scrolls through a five-second window. Once finished,
  // spread the complete session across the chart for review.
  const timeToX = time =>
    CHART_WIDTH - ((latestTime - time) / WINDOW_MS) * CHART_WIDTH

  const { points: coords, peakDelta, currentDelta, blowingNow } = (() => {
    let isBlowing = false
    let aboveCount = 0
    let belowCount = 0
    let envelope = 0

    // 先算出每个采样点的原始高度
    const rawDeltas = smoothSamples.map(sample => {
      const pressure = Math.abs(sample.value)

      if (!isBlowing) {
        if (pressure >= BLOW_START_THRESHOLD) aboveCount++
        else aboveCount = 0

        if (aboveCount >= START_CONFIRM_SAMPLES) {
          isBlowing = true
          belowCount = 0
        }
      } else {
        if (pressure <= BLOW_END_THRESHOLD) belowCount++
        else belowCount = 0

        if (belowCount >= END_CONFIRM_SAMPLES) {
          isBlowing = false
          aboveCount = 0
        }
      }

      // Ease into and out of the wave so it never snaps on abruptly.
      const target = isBlowing ? 1 : 0
      envelope += (target - envelope) * (target ? 0.12 : 0.10)

      return envelope < 0.008
        ? 0
        : pressureToHeight(pressure) * WAVE_HEIGHT * envelope
    })

    // 高斯平滑,让曲线像柔和的波浪
    const radius = Math.ceil(WAVE_SMOOTH_SIGMA * 2.5)
    const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) =>
      Math.exp(-((i - radius) ** 2) / (2 * WAVE_SMOOTH_SIGMA ** 2))
    )
    const deltas = rawDeltas.map((_, index) => {
      let sum = 0
      let weight = 0
      for (let k = -radius; k <= radius; k++) {
        const j = index + k
        if (j < 0 || j >= rawDeltas.length) continue
        const w = kernel[k + radius]
        sum += rawDeltas[j] * w
        weight += w
      }
      return weight > 0 ? sum / weight : 0
    })

    let maxDelta = 0
    const points = smoothSamples.map((sample, index) => {
      const x = fullSessionView
        ? (smoothSamples.length <= 1
            ? CHART_WIDTH
            : (index / (smoothSamples.length - 1)) * CHART_WIDTH)
        : timeToX(sample.time)

      const delta = deltas[index]
      if (delta > maxDelta) maxDelta = delta

      return { x, y: BASELINE_Y - delta }
    })

    const tail = {
      peakDelta: maxDelta,
      currentDelta: deltas.length > 0 ? deltas[deltas.length - 1] : 0,
      blowingNow: isBlowing
    }

    if (fullSessionView) return { points, ...tail }

    // 1. 曲线一直延伸到最左边,不再在左侧淡出到 0:
    // 保留窗口内的点,再多留一个窗口外的点,让线条从边缘外接进来。
    const firstVisible = points.findIndex(point => point.x >= 0)
    return {
      points: firstVisible === -1
        ? []
        : points.slice(Math.max(0, firstVisible - 1)),
      ...tail
    }
  })()

  // 4. 实时模式下,竖向栅格和 x 轴刻度跟着曲线一起向左滚动
  const timeOrigin = timeOriginRef.current ?? latestTime
  const movingGridX = []
  const timeTicks = []
  if (!fullSessionView) {
    const windowStart = latestTime - WINDOW_MS
    const GRID_STEP_MS = 250
    for (
      let t = Math.ceil((windowStart - timeOrigin) / GRID_STEP_MS) * GRID_STEP_MS;
      t <= latestTime - timeOrigin;
      t += GRID_STEP_MS
    ) {
      movingGridX.push(timeToX(timeOrigin + t))
    }
    for (
      let sec = Math.ceil((windowStart - timeOrigin) / 1000);
      sec <= Math.floor((latestTime - timeOrigin) / 1000);
      sec++
    ) {
      if (sec < 0) continue
      timeTicks.push({ key: sec, x: timeToX(timeOrigin + sec * 1000), label: `${sec}s` })
    }
  }
  const xLabels = fullSessionView
    ? [
        'Start',
        fmtSeconds(duration * 0.25),
        fmtSeconds(duration * 0.5),
        fmtSeconds(duration * 0.75),
        'End'
      ].map((label, i) => ({ key: i, x: (i / 4) * CHART_WIDTH, label }))
    : timeTicks

  // 最高值虚线:曲线超过它时同步上升;吹气中保持在最高位置;
  // 不吹气时慢慢回落到当前曲线高度。结果页显示整场练习的最高值。
  if (!fullSessionView && !finishing) {
    let hold = peakHoldRef.current
    const lastAt = peakDecayAtRef.current ?? latestTime
    if (currentDelta >= hold) {
      hold = currentDelta
    } else if (!blowingNow) {
      const dt = Math.max(0, latestTime - lastAt)
      hold = currentDelta + (hold - currentDelta) * Math.exp(-dt / PEAK_DECAY_MS)
    }
    peakHoldRef.current = hold
    peakDecayAtRef.current = latestTime
  }
  const peakLineDelta = fullSessionView ? peakDelta : peakHoldRef.current

  // 3. Smooth quadratic curves avoid the overshoot that can
  // occur with aggressive cubic Bezier control points.
  function makeSmoothPath(points) {
    if (points.length === 0) return ''

    if (points.length === 1) {
      return `M ${points[0].x} ${points[0].y}`
    }

    let path = `M ${points[0].x} ${points[0].y}`

    for (let i = 1; i < points.length - 1; i++) {
      const current = points[i]
      const next = points[i + 1]

      const midX = (current.x + next.x) / 2
      const midY = (current.y + next.y) / 2

      path +=
        ` Q ${current.x} ${current.y}` +
        ` ${midX} ${midY}`
    }

    const last = points[points.length - 1]

    path += ` Q ${last.x} ${last.y} ${last.x} ${last.y}`

    return path
  }

  const chartPath = makeSmoothPath(coords)

  // 上一次尝试的曲线(半透明虚线),给这一次做参考。
  // 时间对齐:两次都从"第一次吹气前 0.6 秒"算起,和结果裁剪的起点一致,
  // 所以同一时刻两条线可以直接比较高低。
  const reference = history.find(item => item.id !== startedAtRef.current) ?? null
  const ghostPath = (() => {
    if (!reference || !reference.curve || reference.curve.length < 2) return ''
    const curve = reference.curve
    const refLengthMs = reference.length * 1000
    // 在上一次曲线里按时间取高度(线性插值)
    const heightAt = t => {
      const pos = (t / refLengthMs) * (curve.length - 1)
      const i = Math.floor(pos)
      const frac = pos - i
      return curve[i] + ((curve[i + 1] ?? curve[i]) - curve[i]) * frac
    }
    const points = []

    if (fullSessionView) {
      // 结果页:按同样的时间比例铺在整个图上
      const durationMs = Math.max(duration * 1000, 1)
      const steps = 160
      for (let k = 0; k <= steps; k++) {
        const t = (k / steps) * Math.min(refLengthMs, durationMs)
        points.push({
          x: (t / durationMs) * CHART_WIDTH,
          y: BASELINE_Y - heightAt(t) * WAVE_HEIGHT
        })
      }
    } else {
      // 实时:等这一次开始吹气后,上一次的曲线和它同步滚动
      if (!isTraining || firstBlowAtRef.current === null) return ''
      const origin = Math.max(firstBlowAtRef.current - 600, startedAtRef.current ?? 0)
      const steps = 120
      for (let k = 0; k <= steps; k++) {
        const time = latestTime - WINDOW_MS - 200 + (k / steps) * (WINDOW_MS + 200)
        const t = time - origin
        if (t < 0 || t > refLengthMs) continue
        points.push({ x: timeToX(time), y: BASELINE_Y - heightAt(t) * WAVE_HEIGHT })
      }
    }
    return makeSmoothPath(points)
  })()

  // 4. Liquid contours spread through the space between
  // the baseline and the real pressure waveform.
  // Every layer has a different ripple profile.
  const rippleLevels = [
    0.12, 0.22, 0.32, 0.42,
    0.52, 0.62, 0.72, 0.82, 0.92
  ]

  const ripplePaths = rippleLevels.map((level, layerIndex) => {
    const layerPoints = coords.map(point => {
      const distance = point.y - BASELINE_Y
      const phase = layerIndex * 0.72

      const oscillation =
        Math.sin(point.x * 0.045 + phase) * 1.5 +
        Math.sin(point.x * 0.083 - phase) * 0.6

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

  // Fill the area between the actual waveform and baseline.
  const areaPath = coords.length > 1
    ? `${chartPath} L ${coords[coords.length - 1].x} ${BASELINE_Y} L ${coords[0].x} ${BASELINE_Y} Z`
    : ''

  const referencePath =
    `M 0 ${BASELINE_Y} L ${CHART_WIDTH} ${BASELINE_Y}`

  // 训练中:波点动画随当前气息强弱放大(0~1)
  const breathLevel = Math.min(1, currentDelta / WAVE_HEIGHT)

  // 结束后的结果:练习时长 + 吹气时气压的波动(标准差,kPa)
  const resultStats = (() => {
    if (!sessionComplete) return null
    const blowingKpa = smoothSamples
      .map(sample => toKpa(sample.value))
      .filter(kpa => kpa >= toKpa(BLOW_START_THRESHOLD))
    const n = blowingKpa.length || 1
    const mean = blowingKpa.reduce((sum, v) => sum + v, 0) / n
    const variance = blowingKpa.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n
    const fluctuateKpa = Math.sqrt(variance)
    return {
      lengthSec: duration,
      fluctuateKpa,
      hasBlown: blowingKpa.length > 0,
      length: `${duration.toFixed(1)}s`,
      fluctuate: `±${fluctuateKpa.toFixed(2)}`
    }
  })()

  // 练习结束、结果出来后,把这次练习存进历史记录(Home 和 Rank 页用)
  useEffect(() => {
    if (!sessionComplete || !resultStats?.hasBlown) return
    const id = startedAtRef.current
    if (id === null || savedSessionRef.current === id) return
    savedSessionRef.current = id

    const heights = coords.map(point => (BASELINE_Y - point.y) / WAVE_HEIGHT)
    setHistory(addHistory({
      id,
      date: Date.now(),
      length: Math.round(resultStats.lengthSec * 10) / 10,
      fluctuate: Math.round(resultStats.fluctuateKpa * 1000) / 1000,
      curve: downsampleCurve(heights, 160)
    }))
    // 只在结果出现的那一刻保存;结果数据和 sessionComplete 在同一次渲染里更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionComplete])

  function updateProfile(next) {
    setProfile(next)
    saveProfile(next)
  }


  // 下方区域:还没有结果时一直显示波点动画;结束后才显示结果卡片
  const showBreathPanel = !sessionComplete

  return (
    <main className="app">
      {/* 背景:缓慢漂浮的模糊"果冻",像流动的水 */}
      <div className={`jelly-bg page-${activeTab.toLowerCase()}`} aria-hidden="true">
        <span className="jelly jelly-1" />
        <span className="jelly jelly-2" />
        <span className="jelly jelly-3" />
        <span className="jelly jelly-4" />
      </div>

      <div className="status-bar" aria-hidden="true">
        <span>9:41</span>
        <span className="status-icons">
          <i />
          <i />
          <b />
        </span>
      </div>

      {activeTab === 'Home' && (
        <HomePage
          profile={profile}
          onProfileChange={updateProfile}
          history={history}
          onStart={() => setActiveTab('Train')}
        />
      )}

      {activeTab === 'Rank' && (
        <RankPage
          history={history}
          profile={profile}
          onStart={() => setActiveTab('Train')}
        />
      )}

      {activeTab === 'Train' && (<>
      <header className="page-heading">
        <h1>Breathe Trainer</h1>
        <p>Stability</p>
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
                  stopColor="#d9674a"
                  stopOpacity="0.38"
                />
                <stop
                  offset="48%"
                  stopColor="#e8936f"
                  stopOpacity="0.18"
                />
                <stop
                  offset="100%"
                  stopColor="#f3c9b5"
                  stopOpacity="0.02"
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
                  stopColor="#d9674a"
                  stopOpacity="0.85"
                />
                <stop
                  offset="100%"
                  stopColor="#f0b49c"
                  stopOpacity="0.15"
                />
              </linearGradient>

              <linearGradient
                id="mainWaveStroke"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="#c9553a" />
                <stop offset="100%" stopColor="#e8876a" />
              </linearGradient>

              {/* 实时曲线在最左边只做透明度淡出,高度不变 */}
              <linearGradient
                id="edgeFadeGradient"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1="0"
                x2="56"
                y2="0"
              >
                <stop offset="0%" stopColor="#000" />
                <stop offset="100%" stopColor="#fff" />
              </linearGradient>
              <mask
                id="edgeFadeMask"
                maskUnits="userSpaceOnUse"
                x="-20"
                y="-60"
                width="400"
                height="320"
              >
                <rect
                  x="-20"
                  y="-60"
                  width="400"
                  height="320"
                  fill="url(#edgeFadeGradient)"
                />
              </mask>

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

            {(fullSessionView
              ? Array.from({ length: 17 }, (_, i) => 10 + i * 20)
              : movingGridX
            ).map((x, i) => (
              <line
                key={`v${i}`}
                x1={x}
                y1="7"
                x2={x}
                y2={BASELINE_Y}
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

            <path
              d={referencePath}
              className="reference-line"
            />

            {/* 半透明虚线:始终停在本次练习的最高波峰,只升不降 */}
            {peakLineDelta > 1 && (
              <g
                style={{
                  transform: `translateY(${-peakLineDelta}px)`
                }}
              >
                <line
                  x1="0"
                  x2={CHART_WIDTH}
                  y1={BASELINE_Y}
                  y2={BASELINE_Y}
                  stroke="#c9553a"
                  strokeWidth="1.4"
                  strokeDasharray="3.5 5"
                  strokeOpacity="0.6"
                />
              </g>
            )}

            {ghostPath && (
              <g
                key={sessionComplete ? 'ghost-result' : 'ghost-live'}
                mask={sessionComplete ? undefined : 'url(#edgeFadeMask)'}
                className={sessionComplete ? 'result-reveal' : finishing ? 'live-fade-out' : ''}
              >
                <path
                  d={ghostPath}
                  className="ghost-line"
                />
              </g>
            )}

            {coords.length > 1 && (
              <g
                key={sessionComplete ? 'result' : 'live'}
                mask={sessionComplete ? undefined : 'url(#edgeFadeMask)'}
              >
              <g
                className={
                  sessionComplete
                    ? 'result-reveal'
                    : finishing
                      ? 'live-fade-out'
                      : ''
                }
              >
                <path
                  d={areaPath}
                  fill="url(#liquidFill)"
                  stroke="none"
                />

                {ripplePaths.map(ripple => (
                  <path
                    key={`ripple-${ripple.index}`}
                    d={ripple.path}
                    fill="none"
                    stroke="url(#rippleStroke)"
                    strokeWidth={0.65 + ripple.level * 0.7}
                    strokeOpacity={
                      0.16 + ripple.level * 0.62
                    }
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}

                <path
                  d={chartPath}
                  fill="none"
                  stroke="#e8876a"
                  strokeWidth="8"
                  strokeOpacity="0.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter="url(#waveGlow)"
                />

                <path
                  d={chartPath}
                  fill="none"
                  stroke="url(#mainWaveStroke)"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />

                <path
                  d={chartPath}
                  fill="none"
                  stroke="#fff3ec"
                  strokeWidth="0.8"
                  strokeOpacity="0.6"
                  strokeLinecap="round"
                  transform="translate(0 -0.8)"
                />
              </g>
              </g>
            )}
          </svg>

          <div
            key={sessionComplete ? 'result-labels' : 'live-labels'}
            className={`x-labels${finishing ? ' live-fade-out' : ''}${sessionComplete ? ' labels-reveal' : ''}`}
          >
            {xLabels.map(tick => (
              <span
                key={tick.key}
                style={{
                  left: `${(tick.x / CHART_WIDTH) * 100}%`,
                  // 刻度从左右边缘进出时淡入淡出
                  opacity: Math.max(0, Math.min(1, tick.x / 20, (CHART_WIDTH - tick.x) / 20 + 0.6))
                }}
              >
                {tick.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      <button
        className="ranking-button"
        onClick={() => (sessionComplete ? startSession() : finishSession())}
        disabled={!isTraining && !sessionComplete}
      >
        {sessionComplete ? 'Try again' : 'Finish'}
      </button>

      {showBreathPanel ? (
        <section
          className={`breath-panel${finishing ? ' panel-fade-out' : ''}`}
          aria-label="Breathe out"
          style={{ '--breath': breathLevel }}
        >
          <div className="dot-field" aria-hidden="true">
            {Array.from({ length: DOT_ROWS * DOT_COLS }, (_, i) => {
              const row = Math.floor(i / DOT_COLS)
              const col = i % DOT_COLS
              // 到中心的距离,决定波纹从中间向外扩散的先后
              const d = Math.hypot(
                (col - (DOT_COLS - 1) / 2) / ((DOT_COLS - 1) / 2),
                (row - (DOT_ROWS - 1) / 2) / ((DOT_ROWS - 1) / 2)
              )
              return (
                <span key={i} className="dot-cell" style={{ '--d': d }}>
                  <i className="dot" />
                </span>
              )
            })}
          </div>
          <p className="breathe-text">breathe out</p>
        </section>
      ) : (
        <section
          className="result-grid result-cards-reveal"
          aria-label="Session result"
        >
          <article className="metric-card">
            <span>length</span>
            <strong>{resultStats.length}</strong>
          </article>

          <article className="metric-card">
            <span>fluctuate</span>
            <strong>
              {resultStats.fluctuate}
              <small> kPa</small>
            </strong>
          </article>
        </section>
      )}

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
      </>)}

      <nav className="bottom-nav" aria-label="Main navigation">
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

        <button
          className={activeTab === 'Train' ? 'selected' : ''}
          onClick={() => setActiveTab('Train')}
        >
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <path d="M3 23h6l4-19c.5-2 3-2 3.5 0L21 35c.4 2 3 2 3.5 0L29 12c.4-2 3-2 3.5 0L35 23h3" />
          </svg>
          <span>Train</span>
        </button>

        <button
          className={activeTab === 'Rank' ? 'selected' : ''}
          onClick={() => setActiveTab('Rank')}
        >
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <path d="M5 35V22h9v13M15.5 35V9h9v26M26 35V16h9v19M3 35h34" />
          </svg>
          <span>Rank</span>
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