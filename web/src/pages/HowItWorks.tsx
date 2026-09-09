import { useEffect, useState } from 'react'
import FlowDiagram, { type EdgeId, type NodeId } from '../components/FlowDiagram'

interface Sim {
  epoch: number
  phase: 'Open' | 'Drawing' | 'Resolved'
  tickets: number
  pot: string
  reserved: string
  winner: string
}

interface Step {
  title: string
  actor: string
  nodes: NodeId[]
  edges: EdgeId[]
  what: string[]
  code: string
  state: Sim
}

const STEPS: Step[] = [
  {
    title: '1. 스왑 → 수수료 + 티켓',
    actor: '사용자',
    nodes: ['user', 'router', 'pm', 'hook', 'vault'],
    edges: ['user-router', 'router-pm', 'pm-hook', 'hook-vault'],
    what: [
      '사용자는 V4SwapRouter 에 ETH → 토큰 스왑을 보낸다. hookData 에 자기 주소를 abi.encode 해서 실어 보낸다.',
      'PoolManager 가 스왑 직전에 훅의 beforeSwap 을 호출한다. 훅은 입력 ETH 의 feeBps(기본 5%)를 poolManager.take 로 먼저 가져간다. 이 ETH 가 receive() 를 거쳐 pot 에 쌓인다.',
      '풀은 남은 95% 만 교환한다. BeforeSwapDelta 로 "훅이 이만큼 가져갔다" 고 PoolManager 에 알린다.',
      '티켓은 스왑 금액(수수료 차감 전) ÷ ticketPrice(기본 0.001 ETH) 장. 스왑 한 번이 누적 구간 하나로 저장돼 SSTORE 1회로 끝난다.',
      'ETH 를 넣는 exact-input 스왑만 참가한다. 토큰 → ETH, exact-output, 회차 닫힘, 금액 미달이면 수수료도 티켓도 없이 그대로 통과한다. 절대 revert 하지 않는다.',
    ],
    code: `function _beforeSwap(address sender, PoolKey calldata key,
    SwapParams calldata params, bytes calldata hookData)
    internal override returns (bytes4, BeforeSwapDelta, uint24)
{
    // ETH(currency0) 를 넣는 exact-input 만
    if (!key.currency0.isAddressZero() || !params.zeroForOne || params.amountSpecified >= 0)
        return (SEL, ZERO_DELTA, 0);
    if (_epochs[currentEpochId].phase != Phase.Open) return (SEL, ZERO_DELTA, 0);

    uint256 amountIn = uint256(-params.amountSpecified);
    uint256 count = amountIn / ticketPrice;
    if (count == 0) return (SEL, ZERO_DELTA, 0);

    uint256 fee = amountIn * feeBps / BPS;
    poolManager.take(key.currency0, address(this), fee);   // → receive() → pot
    _mintTickets(currentEpochId, _resolvePlayer(sender, hookData), uint96(count), fee, key.toId());
    return (SEL, toBeforeSwapDelta(int128(uint128(fee)), 0), 0);
}`,
    state: { epoch: 1, phase: 'Open', tickets: 1000, pot: '0.05', reserved: '0', winner: '—' },
  },
  {
    title: '2. 스왑이 쌓인다',
    actor: '여러 사용자',
    nodes: ['user', 'hook', 'vault'],
    edges: ['user-router', 'router-pm', 'pm-hook', 'hook-vault'],
    what: [
      '회차(epochDuration) 동안 스왑이 들어올 때마다 pot 과 티켓이 함께 늘어난다. 상금은 참가자들이 낸 수수료로만 만들어진다.',
      '누구나 훅 주소로 ETH 를 보내 상금을 보탤 수도 있다(receive). 초기 상금이나 스폰서용이고 필수는 아니다.',
      '티켓 소유는 누적 구간으로 저장된다. 예: alice 1000장(0~999), bob 500장(1000~1499). 당첨 인덱스는 이진 탐색으로 주인을 찾는다.',
    ],
    code: `struct Entry { address player; uint96 cumulative; } // 이 구간까지의 누적 티켓 수
mapping(uint256 => Entry[]) _entries;                  // epochId → 구간 목록

function _mintTickets(uint256 epochId, address player, uint96 count, uint256 fee, PoolId poolId) internal {
    uint96 first = e.ticketCount;
    _entries[epochId].push(Entry(player, first + count));
    e.ticketCount = first + count;
    ticketsOf[epochId][player] += count;
    emit TicketsMinted(epochId, player, first, count, fee, poolId);
}`,
    state: { epoch: 1, phase: 'Open', tickets: 1500, pot: '0.075', reserved: '0', winner: '—' },
  },
  {
    title: '3. 회차 종료 → 추첨 요청',
    actor: '누구나 (종료 후) · owner (언제나) · Automation',
    nodes: ['user', 'hook', 'vault', 'vrf'],
    edges: ['anyone-hook', 'hook-vault', 'hook-vrf'],
    what: [
      'endTime 이 지나면 누구나 requestDraw() 를 호출할 수 있다. Chainlink Automation 을 붙이면 자동으로 호출된다.',
      '이 순간 pot 전체가 이번 회차 상금으로 확정되어 reserved 로 옮겨진다. 이후 들어오는 수수료는 다음 회차 pot 이 된다.',
      '회차는 Drawing 으로 바뀌고 더 이상 수수료도 티켓도 받지 않는다.',
      '훅은 Chainlink VRF 코디네이터에 난수 1개를 요청한다. 비용은 구독 잔액(ETH)에서 빠진다.',
    ],
    code: `function requestDraw() public {
    Epoch storage e = _epochs[currentEpochId];
    if (e.phase != Phase.Open) revert EpochNotOpen();
    if (block.timestamp < e.endTime && msg.sender != owner()) revert EpochNotEnded();
    if (e.ticketCount == 0) revert NoTickets();
    if (pot == 0) revert NoPrize();

    uint256 prize = pot;  pot = 0;  reserved += prize;   // 상금 잠금
    e.phase = Phase.Drawing;  e.prize = prize;
    e.drawRequestedAt = uint64(block.timestamp);

    uint256 requestId = _requestRandomWord();            // Chainlink VRF
    e.vrfRequestId = requestId;
    requestToEpoch[requestId] = currentEpochId;
}`,
    state: { epoch: 1, phase: 'Drawing', tickets: 1500, pot: '0', reserved: '0.075', winner: '—' },
  },
  {
    title: '4. VRF 콜백 → 승자 확정',
    actor: 'Chainlink VRF (몇 블록 뒤)',
    nodes: ['vrf', 'hook'],
    edges: ['vrf-hook'],
    what: [
      'Chainlink 노드가 난수와 증명을 만들어 코디네이터를 통해 rawFulfillRandomWords 를 호출한다. 코디네이터만 호출할 수 있다.',
      '난수 % 티켓수 로 당첨 인덱스를 고르고, 누적 구간을 이진 탐색해 주인을 winner 로 기록한다.',
      'retryDraw 로 대체된 오래된 요청이거나 이미 확정된 회차면 조용히 무시한다. 콜백은 revert 하면 재시도되지 않기 때문이다.',
      '승자 확정 직후 다음 회차를 연다. 승자가 claim 하지 않아도 로또는 계속 돌아간다.',
    ],
    code: `function fulfillRandomWords(uint256 requestId, uint256[] calldata words) internal override {
    uint256 epochId = requestToEpoch[requestId];
    Epoch storage e = _epochs[epochId];
    if (e.phase != Phase.Drawing || e.vrfRequestId != requestId) return; // stale

    uint96 idx = uint96(words[0] % e.ticketCount);
    e.winner = _ownerOfTicket(epochId, idx);       // 누적 구간 이진 탐색
    e.phase = Phase.Resolved;
    emit WinnerSelected(epochId, e.winner, e.prize, words[0]);

    if (epochId == currentEpochId) _openEpoch(epochId + 1);   // 다음 회차
}`,
    state: { epoch: 2, phase: 'Open', tickets: 0, pot: '0', reserved: '0.075', winner: '0x9a3c…e1f2 (#1)' },
  },
  {
    title: '5. 상금 수령',
    actor: '승자',
    nodes: ['hook', 'winner', 'vault'],
    edges: ['hook-winner'],
    what: [
      '승자가 claim(epochId) 를 호출하면 reserved 에서 그 회차 상금만큼 빼고 ETH 를 보낸다.',
      '미수령 상금은 reserved 에 남아 있으므로 다음 회차 pot 과 섞이지 않는다. 늦게 찾아가도 안전하다.',
      'owner 는 pot 과 reserved 에 잡힌 ETH 를 꺼낼 수 없다. sweepExcess 는 회계 밖으로 흘러들어온 잔액만 회수한다.',
    ],
    code: `function claim(uint256 epochId) external {
    Epoch storage e = _epochs[epochId];
    if (e.phase != Phase.Resolved || e.claimed) revert NothingToClaim();
    if (msg.sender != e.winner) revert NothingToClaim();

    e.claimed = true;
    reserved -= e.prize;
    (bool ok,) = payable(msg.sender).call{value: e.prize}("");
    if (!ok) revert TransferFailed();
}`,
    state: { epoch: 2, phase: 'Open', tickets: 0, pot: '0', reserved: '0', winner: '수령 완료' },
  },
]

const EXCEPTIONS = [
  {
    t: 'VRF 콜백이 안 올 때',
    fn: 'retryDraw()',
    d: 'drawRequestedAt + vrfTimeout(기본 1일) 이 지나면 누구나 재요청할 수 있다. 새 requestId 로 바뀌고 이전 콜백은 무시된다. 상금은 다시 잠기지 않는다.',
  },
  {
    t: '티켓이나 상금이 없는 회차',
    fn: 'skipEpoch()',
    d: '추첨할 수 없는 회차를 Resolved 로 닫고 다음 회차를 연다. pot 은 그대로 이월된다.',
  },
  {
    t: '회계 밖의 ETH',
    fn: 'sweepExcess(to)',
    d: 'balance − pot − reserved 만 owner 가 회수한다. 플레이어 상금에는 손댈 수 없다.',
  },
  {
    t: '배포 시 owner',
    fn: 'acceptOwnership()',
    d: 'CREATE2 프록시로 배포하면 msg.sender 가 프록시라서, 생성자가 지정한 _owner 에게 소유권을 제안한다. _owner 가 accept 해야 관리자 함수를 쓸 수 있다.',
  },
]

export default function HowItWorks() {
  const [i, setI] = useState(0)
  const [auto, setAuto] = useState(false)
  const step = STEPS[i]

  useEffect(() => {
    if (!auto) return
    const id = window.setInterval(() => setI((x) => (x + 1) % STEPS.length), 4200)
    return () => window.clearInterval(id)
  }, [auto])

  return (
    <div className="how">
      <div className="how-head">
        <h1>스왑 한 번이 어떻게 로또 티켓이 되나</h1>
        <p className="muted">
          Uniswap V4 훅이 ETH 스왑마다 5% 를 상금 풀에 넣고 0.001 ETH 당 티켓 1장을 발급합니다. 회차가 끝나면 Chainlink
          VRF 가 승자를 뽑습니다. 상금은 참가자들이 낸 수수료로만 만들어집니다. 아래 단계를 눌러 어떤 컨트랙트가 무엇을
          호출하고 상태가 어떻게 바뀌는지 따라가 보세요.
        </p>
      </div>

      <div className="how-grid">
        <div className="panel diagram">
          <FlowDiagram nodes={step.nodes} edges={step.edges} />
          <div className="stepper">
            {STEPS.map((s, k) => (
              <button key={k} className={`step ${k === i ? 'on' : ''} ${k < i ? 'done' : ''}`} onClick={() => setI(k)}>
                <span className="n">{k + 1}</span>
                {s.title.replace(/^\d+\.\s/, '')}
              </button>
            ))}
            <button className={`btn ghost small ${auto ? 'on' : ''}`} onClick={() => setAuto((a) => !a)}>
              {auto ? '⏸ 자동 재생 중' : '▶ 자동 재생'}
            </button>
          </div>
        </div>

        <div className="panel detail">
          <div className="eyebrow">{step.actor}</div>
          <h2>{step.title}</h2>
          <ul className="bullets">
            {step.what.map((w, k) => (
              <li key={k}>{w}</li>
            ))}
          </ul>

          <div className="state-box">
            <div className="eyebrow">이 단계가 끝난 뒤 상태</div>
            <div className="state-grid">
              <div>
                <span className="label">epoch</span>
                <span className="mono">#{step.state.epoch}</span>
              </div>
              <div>
                <span className="label">phase</span>
                <span className={`mono phase-${step.state.phase}`}>{step.state.phase}</span>
              </div>
              <div>
                <span className="label">tickets</span>
                <span className="mono">{step.state.tickets}</span>
              </div>
              <div>
                <span className="label">pot</span>
                <span className="mono">{step.state.pot} ETH</span>
              </div>
              <div>
                <span className="label">reserved</span>
                <span className="mono">{step.state.reserved} ETH</span>
              </div>
              <div>
                <span className="label">winner</span>
                <span className="mono">{step.state.winner}</span>
              </div>
            </div>
          </div>

          <pre className="code">
            <code>{step.code}</code>
          </pre>

          <div className="row between">
            <button className="btn ghost" disabled={i === 0} onClick={() => setI(i - 1)}>
              ← 이전
            </button>
            <button className="btn primary" disabled={i === STEPS.length - 1} onClick={() => setI(i + 1)}>
              다음 →
            </button>
          </div>
        </div>
      </div>

      <div className="how-head">
        <h2>예외 상황은 이렇게 처리한다</h2>
      </div>
      <div className="exceptions">
        {EXCEPTIONS.map((x) => (
          <div className="panel exc" key={x.fn}>
            <div className="eyebrow mono">{x.fn}</div>
            <h3>{x.t}</h3>
            <p className="muted small">{x.d}</p>
          </div>
        ))}
      </div>

      <div className="how-head">
        <h2>비용은 어디서 나가나</h2>
        <ul className="bullets muted">
          <li>스왑 수수료: 입력 ETH 의 5% 가 상금 풀로 간다. 이게 유일한 상금 재원이다.</li>
          <li>스왑 가스: 사용자가 낸다. beforeSwap 의 수수료 인출과 티켓 발급 가스가 스왑 가스에 포함된다.</li>
          <li>VRF: 요청마다 Chainlink 구독(ETH 또는 LINK)에서 콜백 가스 + 검증 가스 + 프리미엄이 빠진다. 테스트넷은 faucet 으로 무료.</li>
          <li>requestDraw / claim 가스: 호출한 사람이 낸다. Automation 을 붙이면 Automation 구독에서 대신 빠진다.</li>
        </ul>
      </div>
    </div>
  )
}
