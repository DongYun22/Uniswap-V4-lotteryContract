import { NavLink } from 'react-router-dom'
import type { LotteryModel } from '../lib/types'
import { short } from '../lib/format'

export default function Nav({ model }: { model: LotteryModel }) {
  return (
    <header className="nav">
      <div className="nav-left">
        <div className="logo">
          <span className="logo-dot" />
          LotteryHook
        </div>
        <nav className="nav-links">
          <NavLink to="/" end>
            라이브
          </NavLink>
          <NavLink to="/how-it-works">작동 원리</NavLink>
        </nav>
      </div>
      <div className="nav-right">
        <span className={`badge mode-${model.mode}`}>{model.mode === 'live' ? (model.mockVrf ? 'Sepolia · mock VRF' : 'Ethereum Sepolia') : 'DEMO · 시뮬레이션'}</span>
        {model.account ? (
          <button className="btn ghost" onClick={model.disconnect}>
            {short(model.account)}
          </button>
        ) : (
          <button className="btn primary" onClick={model.connect}>
            지갑 연결
          </button>
        )}
      </div>
    </header>
  )
}
