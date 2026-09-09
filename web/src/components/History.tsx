import type { LotteryModel } from '../lib/types'
import { fmtEth, short } from '../lib/format'

export default function History({ model }: { model: LotteryModel }) {
  return (
    <section className="panel history">
      <div className="row between">
        <div className="eyebrow">지난 당첨</div>
        <div className="eyebrow">최근 티켓</div>
      </div>
      <div className="cols">
        <ul className="list">
          {model.winners.length === 0 && <li className="muted small">아직 추첨된 회차가 없습니다.</li>}
          {model.winners.slice(0, 6).map((w) => (
            <li key={w.epochId}>
              <span className="mono">#{w.epochId}</span>
              <span className={model.account && w.winner.toLowerCase() === model.account.toLowerCase() ? 'gold' : ''}>
                {short(w.winner)}
              </span>
              <span className="mono">{fmtEth(w.prize)} ETH</span>
              <span className={`tag ${w.claimed ? 'ok' : ''}`}>{w.claimed ? '수령' : '미수령'}</span>
            </li>
          ))}
        </ul>
        <ul className="list">
          {model.tickets.length === 0 && <li className="muted small">스왑이 발생하면 여기에 표시됩니다.</li>}
          {model.tickets.slice(0, 6).map((t) => (
            <li key={`${t.epochId}-${t.firstIndex}`}>
              <span className="mono">#{t.epochId}</span>
              <span className={model.account && t.player.toLowerCase() === model.account.toLowerCase() ? 'gold' : ''}>
                {short(t.player)}
              </span>
              <span className="mono">×{t.count}</span>
              <span className="mono muted">+{fmtEth(t.fee, 4)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
