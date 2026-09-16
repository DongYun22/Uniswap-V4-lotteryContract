import { useMemo, useState } from 'react'
import { parseEther } from 'viem'
import { Phase, type LotteryModel } from '../lib/types'
import { fmtEth } from '../lib/format'
import { tokenUrl, txUrl } from '../config/addresses'

export default function ActionPanel({ model, now }: { model: LotteryModel; now: number }) {
  const [amount, setAmount] = useState('0.001')
  const [depositAmt, setDepositAmt] = useState('0.01')
  const s = model.state
  const ticketPrice = s?.ticketPrice ?? 0n
  const feeBps = s?.feeBps ?? 0

  // 컨트랙트 quote() 와 같은 계산. 훅은 early return 보다 앞에 있어야 한다.
  const q = useMemo(() => {
    try {
      if (ticketPrice === 0n) return { tickets: 0, fee: 0n, wei: 0n }
      const wei = parseEther(amount || '0')
      const tickets = Number(wei / ticketPrice)
      const fee = tickets === 0 ? 0n : (wei * BigInt(feeBps)) / 10000n
      return { tickets, fee, wei }
    } catch {
      return { tickets: 0, fee: 0n, wei: 0n }
    }
  }, [amount, ticketPrice, feeBps])

  if (!s) return null
  const e = s.epoch
  const ended = now >= e.endTime
  const canDraw = e.phase === Phase.Open && e.ticketCount > 0 && s.pot > 0n && (ended || model.isOwner)
  const canSkip = e.phase === Phase.Open && (e.ticketCount === 0 || s.pot === 0n) && (ended || model.isOwner)
  const canRetry = e.phase === Phase.Drawing && now >= e.drawRequestedAt + s.vrfTimeout
  const myWins = model.winners.filter((w) => model.account && w.winner.toLowerCase() === model.account.toLowerCase() && !w.claimed)
  const disabled = Boolean(model.busy)

  const guard = (fn: () => Promise<void>) => () => fn().catch(() => {})

  /** 주소·심볼·소수점을 컨트랙트 값 그대로 지갑에 등록한다 (수동 입력 실수 방지) */
  async function addToWallet() {
    const eth = (window as any).ethereum
    if (!eth || !model.token.address) return
    try {
      await eth.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: model.token.address,
            symbol: model.token.symbol,
            decimals: model.token.decimals,
          },
        },
      })
    } catch {
      /* 사용자가 취소한 경우 무시 */
    }
  }

  return (
    <section className="panel actions">
      <div className="eyebrow">참여</div>
      <div className="field">
        <label>스왑 금액 (ETH → 토큰)</label>
        <div className="row">
          <input value={amount} onChange={(x) => setAmount(x.target.value)} inputMode="decimal" />
          <button className="btn primary" disabled={disabled || !model.account} onClick={guard(() => model.actions.buyTicket(amount))}>
            스왑하고 티켓 받기
          </button>
        </div>
        <div className="quote">
          <span>
            티켓 <b className="gold">{q.tickets}</b>장
          </span>
          <span>
            상금 풀로 <b>{fmtEth(q.fee, 5)}</b> ETH ({s.feeBps / 100}%)
          </span>
          <span>
            실제 스왑 <b>{fmtEth(q.wei - q.fee, 5)}</b> ETH
          </span>
        </div>
        <div className="muted tiny">
          {fmtEth(s.ticketPrice)} ETH 당 1장 · ETH 를 넣는 방향만 참가 · hookData 에 내 주소가 실려 감
        </div>
        <div className="row between balance">
          <span className="muted tiny">
            받은 토큰 잔액
            {model.token.address && (
              <button className="linkbtn" onClick={addToWallet} title="지갑에 토큰 추가">
                지갑에 추가
              </button>
            )}
          </span>
          {model.token.address ? (
            <a className="mono" href={tokenUrl(model.token.address, model.account)} target="_blank" rel="noreferrer">
              {fmtEth(model.token.balance, 5)} {model.token.symbol} ↗
            </a>
          ) : (
            <span className="mono">
              {fmtEth(model.token.balance, 5)} {model.token.symbol}
            </span>
          )}
        </div>
      </div>

      <div className="field">
        <label>회차 진행</label>
        <div className="row wrap">
          <button className="btn accent" disabled={disabled || !canDraw || !model.account} onClick={guard(model.actions.requestDraw)}>
            추첨 요청 (VRF)
          </button>
          {canSkip && (
            <button className="btn ghost" disabled={disabled || !model.account} onClick={guard(model.actions.skipEpoch)}>
              빈 회차 스킵
            </button>
          )}
          {canRetry && (
            <button className="btn ghost" disabled={disabled || !model.account} onClick={guard(model.actions.retryDraw)}>
              VRF 재요청
            </button>
          )}
        </div>
        {e.phase === Phase.Open && !ended && !model.isOwner && (
          <div className="muted tiny">회차가 끝나면 누구나 추첨을 요청할 수 있습니다.</div>
        )}
        {model.isOwner && <div className="muted tiny gold">owner 는 회차 종료 전에도 추첨할 수 있습니다.</div>}
        {model.mockVrf && e.phase === Phase.Drawing && model.actions.mockFulfill && (
          <div className="mock-box">
            <div className="tiny">
              <b>데모 모드</b> · 훅이 Chainlink 대신 mock 코디네이터를 보고 있습니다. 실제 VRF 대신 브라우저가 만든 난수를 직접
              주입해 콜백을 실행합니다.
            </div>
            <button className="btn gold" disabled={disabled || !model.account} onClick={guard(model.actions.mockFulfill!)}>
              🎲 난수 주입하고 승자 뽑기
            </button>
          </div>
        )}
      </div>

      <div className="field">
        <label>상금 보태기 (선택)</label>
        <div className="row">
          <input value={depositAmt} onChange={(x) => setDepositAmt(x.target.value)} inputMode="decimal" />
          <button className="btn ghost" disabled={disabled || !model.account} onClick={guard(() => model.actions.deposit(depositAmt))}>
            pot 에 ETH 넣기
          </button>
        </div>
      </div>

      {myWins.length > 0 && (
        <div className="field win">
          <label>🎉 내가 당첨된 회차</label>
          {myWins.map((w) => (
            <div className="row between" key={w.epochId}>
              <span>
                #{w.epochId} · {fmtEth(w.prize)} ETH
              </span>
              <button className="btn gold" disabled={disabled} onClick={guard(() => model.actions.claim(w.epochId))}>
                수령
              </button>
            </div>
          ))}
        </div>
      )}

      {model.busy && (
        <div className="status">
          <span className="spinner" /> {model.busy}
        </div>
      )}
      {model.error && <div className="status error">{model.error}</div>}
      {model.lastTx && (
        <a className="muted tiny" href={txUrl(model.lastTx)} target="_blank" rel="noreferrer">
          방금 보낸 트랜잭션 보기 ↗
        </a>
      )}
    </section>
  )
}
