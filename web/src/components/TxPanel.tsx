import type { LotteryModel } from '../lib/types'
import {
  HOOK_ADDRESS,
  POOL_ID,
  SWAP_ROUTER,
  TOKEN_ADDRESS,
  VRF_SUB_URL,
  addrUrl,
  tokenUrl,
  txUrl,
} from '../config/addresses'

const ago = (at: number, now: number) => {
  const d = Math.max(0, now - at)
  if (d < 60) return `${d}초 전`
  if (d < 3600) return `${Math.floor(d / 60)}분 전`
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`
  return `${Math.floor(d / 86400)}일 전`
}

const MARK = { pending: '⏳', success: '✓', failed: '✕' } as const

export default function TxPanel({ model, now }: { model: LotteryModel; now: number }) {
  const live = model.mode === 'live'
  return (
    <section className="panel txpanel">
      <div className="eyebrow">내 트랜잭션</div>
      <ul className="list txlist">
        {model.txs.length === 0 && (
          <li className="muted small">스왑이나 추첨을 실행하면 여기에 쌓이고, 각 항목에서 이더스캔으로 갈 수 있습니다.</li>
        )}
        {model.txs.map((t, i) => {
          const row = (
            <>
              <span className={`txmark ${t.status}`}>{MARK[t.status]}</span>
              <span className="txlabel">{t.label}</span>
              {t.detail && <span className="mono gold">{t.detail}</span>}
              <span className="mono muted tiny">{ago(t.at, now)}</span>
            </>
          )
          return (
            <li key={t.hash ?? `${t.at}-${i}`} className="txrow">
              {t.hash ? (
                <a className="txlink" href={txUrl(t.hash)} target="_blank" rel="noreferrer" title={t.hash}>
                  {row}
                  <span className="muted tiny">↗</span>
                </a>
              ) : (
                <span className="txlink">
                  {row}
                  <span className="muted tiny">데모</span>
                </span>
              )}
            </li>
          )
        })}
      </ul>

      <div className="eyebrow contracts-title">컨트랙트</div>
      <div className="contracts">
        {live && HOOK_ADDRESS && (
          <a href={addrUrl(HOOK_ADDRESS)} target="_blank" rel="noreferrer">
            LotteryHook ↗
          </a>
        )}
        {live && TOKEN_ADDRESS && (
          <a href={tokenUrl(TOKEN_ADDRESS, model.account)} target="_blank" rel="noreferrer">
            {model.token.symbol} 토큰 ↗
          </a>
        )}
        {live && (
          <a href={addrUrl(SWAP_ROUTER)} target="_blank" rel="noreferrer">
            V4SwapRouter ↗
          </a>
        )}
        {live && (
          <a href={VRF_SUB_URL} target="_blank" rel="noreferrer">
            VRF 구독 ↗
          </a>
        )}
        {!live && <span className="muted small">데모 모드에서는 온체인 주소가 없습니다.</span>}
      </div>
      {live && POOL_ID && (
        <div className="muted tiny mono poolid" title={POOL_ID}>
          poolId {POOL_ID.slice(0, 10)}…{POOL_ID.slice(-6)}
        </div>
      )}
    </section>
  )
}
