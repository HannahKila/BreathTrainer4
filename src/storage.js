// 本地保存:个人资料 + 历史训练记录(存在浏览器 localStorage 里)
const HISTORY_KEY = 'breathTrainer.history'
const PROFILE_KEY = 'breathTrainer.profile'
const MAX_HISTORY = 200

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储已满或被浏览器禁用时,忽略即可
  }
}

// 每条记录:{ id, date, length(秒), fluctuate(kPa), curve: [0~1 的高度] }
export function loadHistory() {
  return read(HISTORY_KEY, [])
}

export function addHistory(record) {
  const history = loadHistory().filter(item => item.id !== record.id)
  const next = [record, ...history].slice(0, MAX_HISTORY)
  write(HISTORY_KEY, next)
  return next
}

export function loadProfile() {
  return read(PROFILE_KEY, { name: '', avatar: null })
}

export function saveProfile(profile) {
  write(PROFILE_KEY, profile)
}

// 把结果曲线压缩成固定数量的点,用来画缩略图
export function downsampleCurve(heights, buckets = 64) {
  if (heights.length === 0) return []
  if (heights.length <= buckets) return heights.map(round)
  return Array.from({ length: buckets }, (_, i) => {
    const start = Math.floor((i / buckets) * heights.length)
    const end = Math.max(start + 1, Math.floor(((i + 1) / buckets) * heights.length))
    const slice = heights.slice(start, end)
    return round(slice.reduce((sum, v) => sum + v, 0) / slice.length)
  })
}

function round(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000
}

// 历史记录里的日期,例如 "Nov 20 · 14:05"
export function formatDate(timestamp) {
  const d = new Date(timestamp)
  const month = d.toLocaleString('en', { month: 'short' })
  const time = d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${month} ${d.getDate()} · ${time}`
}

// 稳定度百分比:波动(kPa)越小越高。波动 0.15 kPa → 85%。
// 想让分数整体更高或更低,改这里的 100 即可。
export function stabilityScore(fluctuate) {
  return Math.round(Math.max(0, Math.min(100, 100 - fluctuate * 100)))
}
