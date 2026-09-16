import { useEffect, useRef, useState } from 'react'
import LotteryScene from '../three/LotteryScene'
import EpochPanel from '../components/EpochPanel'
import ActionPanel from '../components/ActionPanel'
import History from '../components/History'
import TxPanel from '../components/TxPanel'
import { Phase, type LotteryModel } from '../lib/types'
import { fmtEth, nowSec, short } from '../lib/format'

export default function Live({ model }: { model: LotteryModel }) {
  const [now, setNow] = useState(nowSec())
  const [celebrate, setCelebrate] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const lastWinner = useRef<number | null>(null)

  useEffect(() => {
    const id = window.setInterval(() => setNow(nowSec()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // 새 당첨이 나오면 잠깐 축하 연출
  useEffect(() => {
    const w = model.winners[0]
    if (!w) return
    if (lastWinner.current === null) {
      lastWinner.current = w.epochId
      return
    }
    if (w.epochId !== lastWinner.current) {
      lastWinner.current = w.epochId
      setCelebrate(true)
      setToast(`#${w.epochId} 당첨: ${short(w.winner)} · ${fmtEth(w.prize)} ETH`)
      const id = window.setTimeout(() => {
        setCelebrate(false)
        setToast(null)
      }, 7000)
      return () => window.clearTimeout(id)
    }
  }, [model.winners])

  const s = model.state
  const phase = celebrate ? Phase.Resolved : (s?.epoch.phase ?? Phase.Open)

  return (
    <div className="live">
      <div className="scene">
        <LotteryScene phase={phase} ticketCount={s?.epoch.ticketCount ?? 0} myTickets={model.myTickets} celebrate={celebrate} />
      </div>
      <div className="overlay">
        <div className="col left">
          {s ? <EpochPanel state={s} myTickets={model.myTickets} now={now} mockVrf={model.mockVrf} /> : <section className="panel">상태 불러오는 중…</section>}
          <History model={model} />
          <TxPanel model={model} now={now} />
        </div>
        <div className="col right">
          <ActionPanel model={model} now={now} />
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
