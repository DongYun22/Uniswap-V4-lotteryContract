import { Phase, type LotteryState } from '../lib/types'
import { fmtDuration, fmtEth, phaseColor, phaseLabel, short } from '../lib/format'
import { VRF_SUB_URL } from '../config/addresses'

export default function EpochPanel({ state, myTickets, now, mockVrf }: { state: LotteryState; myTickets: number; now: number; mockVrf?: boolean }) {
  const e = state.epoch
  const left = e.endTime - now
  const ended = left <= 0
  const color = phaseColor[e.phase]
  return (
    <section className="panel epoch">
      <div className="row between">
        <div className="eyebrow">EPOCH #{state.epochId}</div>
        <div className="pill" style={{ borderColor: color, color }}>
          <span className="dot" style={{ background: color }} />
          {phaseLabel[e.phase]}
        </div>
      </div>

      <div className="big-number">
        {e.phase === Phase.Open ? (ended ? '추첨 가능' : fmtDuration(left)) : e.phase === Phase.Drawing ? '난수 대기' : short(e.winner)}
      </div>
      <div className="muted small">
        {e.phase === Phase.Open && !ended && '회차 종료까지'}
        {e.phase === Phase.Open && ended && '누구나 requestDraw() 호출 가능'}
        {e.phase === Phase.Drawing && mockVrf && (
          <>
            mock 코디네이터 · 오른쪽 "난수 주입" 버튼으로 승자를 뽑습니다 · 요청 후{' '}
            <b className="mono">{fmtDuration(Math.max(0, now - e.drawRequestedAt))}</b> 경과
          </>
        )}
        {e.phase === Phase.Drawing && !mockVrf && (
          <>
            Chainlink VRF 콜백 대기 · 요청 후 <b className="mono">{fmtDuration(Math.max(0, now - e.drawRequestedAt))}</b> 경과
            <br />
            보통 1~2분, 노드 혼잡 시 더 걸립니다 ·{' '}
            <a href={VRF_SUB_URL} target="_blank" rel="noreferrer">
              구독 상태 보기 ↗
            </a>
          </>
        )}
        {e.phase === Phase.Resolved && '승자 확정 · claim 대기'}
      </div>

      <div className="stats">
        <div>
          <div className="label">누적 상금 · 스왑 수수료 (pot)</div>
          <div className="value">{fmtEth(e.phase === Phase.Open ? state.pot : e.prize)} ETH</div>
        </div>
        <div>
          <div className="label">티켓</div>
          <div className="value">{e.ticketCount}</div>
        </div>
        <div>
          <div className="label">내 티켓</div>
          <div className="value gold">{myTickets}</div>
        </div>
        <div>
          <div className="label">미수령 잠금 (reserved)</div>
          <div className="value">{fmtEth(state.reserved)} ETH</div>
        </div>
      </div>
      <div className="muted small">
        참가 스왑 {e.entryCount}건
        {e.ticketCount > 0 && myTickets > 0 && ` · 내 당첨 확률 ${((myTickets / e.ticketCount) * 100).toFixed(1)}%`}
      </div>
    </section>
  )
}
