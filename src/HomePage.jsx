import { useRef, useState } from 'react'
import CurveThumb from './CurveThumb.jsx'
import { formatDate } from './storage.js'

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

// Courses 卡片(大小交错的排列,和设计稿一致)
const COURSES = [
  { title: 'Steady Breath', note: 'Keep the line flat', size: 'wide' },
  { title: 'Long Exhale', note: '10s', size: 'narrow' },
  { title: 'Warm-up', note: '3 min', size: 'narrow' },
  { title: 'Wave Control', note: 'Rise and fall smoothly', size: 'wide' }
]

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

// 本周一到周日的日期
function currentWeek(today = new Date()) {
  const monday = new Date(today)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  return WEEKDAYS.map((label, i) => {
    const date = new Date(monday)
    date.setDate(monday.getDate() + i)
    return { label, date }
  })
}

// 把选择的头像图片缩小到 160px 再保存,避免占满 localStorage
function resizeImage(file, size = 160) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => {
      const img = new Image()
      img.onerror = reject
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        const side = Math.min(img.width, img.height)
        ctx.drawImage(
          img,
          (img.width - side) / 2,
          (img.height - side) / 2,
          side,
          side,
          0,
          0,
          size,
          size
        )
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

export default function HomePage({ profile, onProfileChange, history, onStart }) {
  const fileRef = useRef(null)
  const [editingName, setEditingName] = useState(false)
  const name = profile.name.trim()

  const today = new Date()
  const week = currentWeek(today).map(day => ({
    ...day,
    isToday: sameDay(day.date, today),
    trained: history.some(item => sameDay(new Date(item.date), day.date))
  }))

  async function handleAvatar(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const avatar = await resizeImage(file)
      onProfileChange({ ...profile, avatar })
    } catch {
      // 图片读取失败时保持原头像
    }
  }

  return (
    <section className="home-page" aria-label="Home">
      <header className="home-header">
        {editingName ? (
          <input
            className="greeting-input"
            autoFocus
            value={profile.name}
            placeholder="Your name"
            maxLength={20}
            onChange={event => onProfileChange({ ...profile, name: event.target.value })}
            onBlur={() => setEditingName(false)}
            onKeyDown={event => event.key === 'Enter' && setEditingName(false)}
            aria-label="Your name"
          />
        ) : (
          <button
            type="button"
            className="greeting"
            onClick={() => setEditingName(true)}
            title="Tap to edit your name"
          >
            Hi, {name || 'there'}
          </button>
        )}

        <button
          type="button"
          className="home-avatar"
          onClick={() => fileRef.current?.click()}
          aria-label="Change avatar"
        >
          {profile.avatar && <img src={profile.avatar} alt="" />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={handleAvatar}
        />
      </header>

      {/* 本周:练习过的日子高亮 */}
      <div className="week-strip" role="list" aria-label="This week">
        {week.map(day => (
          <div
            key={day.label}
            role="listitem"
            className={`week-day${day.trained ? ' trained' : ''}${day.isToday ? ' today' : ''}`}
          >
            <span className="week-label">{day.label}</span>
            <span className="week-date glass">{day.date.getDate()}</span>
          </div>
        ))}
      </div>

      <button type="button" className="start-button" onClick={onStart}>
        Start Training!
      </button>

      <h2 className="section-title">Courses</h2>
      <div className="courses-grid">
        {COURSES.map(course => (
          <article key={course.title} className={`course-card glass ${course.size}`}>
            <strong>{course.title}</strong>
            <span>{course.note}</span>
          </article>
        ))}
      </div>

      <h2 className="section-title">History</h2>
      {history.length === 0 ? (
        <p className="empty-note">
          No sessions yet. Finish a training session and it will show up here.
        </p>
      ) : (
        <ul className="history-list">
          {history.map(item => (
            <li key={item.id} className="history-item glass">
              <div className="history-meta">
                <span className="history-date">{formatDate(item.date)}</span>
                <span className="history-values">
                  <b>{item.length.toFixed(1)}s</b>
                  <i>·</i>
                  <b>±{item.fluctuate.toFixed(2)}</b> kPa
                </span>
              </div>
              <CurveThumb curve={item.curve} id={item.id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
