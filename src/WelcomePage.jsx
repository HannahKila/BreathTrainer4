import { useState } from 'react'

const LEAVE_MS = 650

// 初始欢迎页:点 Start 后淡出,进入 Train 页
export default function WelcomePage({ onStart }) {
  const [leaving, setLeaving] = useState(false)

  function handleStart() {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(onStart, LEAVE_MS)
  }

  return (
    <section className={`welcome${leaving ? ' leaving' : ''}`} aria-label="Welcome">
      {/* 背景:浅桃色底 + 深陶土色水团 + 两侧的白色光晕,都在缓慢浮动 */}
      <div className="welcome-bg" aria-hidden="true">
        <span className="welcome-blob" />
        <span className="welcome-glow welcome-glow-left" />
        <span className="welcome-glow welcome-glow-right" />
        <span className="welcome-grain" />
      </div>

      <div className="status-bar welcome-status" aria-hidden="true">
        <span>9:41</span>
        <span className="status-icons">
          <i />
          <i />
          <b />
        </span>
      </div>

      <div className="welcome-title">
        <p>Welcome to</p>
        <h1>BreatheTrainer</h1>
      </div>

      <button type="button" className="welcome-start" onClick={handleStart}>
        Start
      </button>
    </section>
  )
}
