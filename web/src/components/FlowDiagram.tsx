/** 컨트랙트 간 호출 흐름 SVG. active 에 포함된 노드/간선만 밝게 표시 */
export type NodeId = 'user' | 'router' | 'pm' | 'hook' | 'vrf' | 'vault' | 'winner'
export type EdgeId = 'user-router' | 'router-pm' | 'pm-hook' | 'hook-vault' | 'user-vault' | 'hook-vrf' | 'vrf-hook' | 'hook-winner' | 'anyone-hook'

const NODES: Record<NodeId, { x: number; y: number; label: string; sub: string }> = {
  user: { x: 90, y: 200, label: '사용자', sub: 'EOA · 스왑 요청' },
  router: { x: 275, y: 200, label: 'V4SwapRouter', sub: 'hookmate' },
  pm: { x: 460, y: 200, label: 'PoolManager', sub: 'Uniswap V4' },
  hook: { x: 660, y: 200, label: 'LotteryHook', sub: 'beforeSwap · VRF consumer' },
  vrf: { x: 660, y: 60, label: 'VRF Coordinator', sub: 'Chainlink v2.5' },
  vault: { x: 660, y: 340, label: 'pot / reserved', sub: 'ETH 회계 (훅 내부)' },
  winner: { x: 870, y: 200, label: '승자', sub: 'claim()' },
}

const EDGES: Record<EdgeId, { from: NodeId; to: NodeId; label: string; curve?: number }> = {
  'user-router': { from: 'user', to: 'router', label: 'swap(hookData=me)' },
  'router-pm': { from: 'router', to: 'pm', label: 'swap()' },
  'pm-hook': { from: 'pm', to: 'hook', label: 'afterSwap()' },
  'hook-vault': { from: 'hook', to: 'vault', label: 'pot → reserved' },
  'user-vault': { from: 'user', to: 'vault', label: 'ETH 전송 (receive)', curve: 120 },
  'hook-vrf': { from: 'hook', to: 'vrf', label: 'requestRandomWords()' },
  'vrf-hook': { from: 'vrf', to: 'hook', label: 'rawFulfillRandomWords()' },
  'hook-winner': { from: 'hook', to: 'winner', label: 'ETH' },
  'anyone-hook': { from: 'user', to: 'hook', label: 'requestDraw()', curve: -120 },
}

export default function FlowDiagram({ nodes, edges }: { nodes: NodeId[]; edges: EdgeId[] }) {
  const path = (e: (typeof EDGES)[EdgeId]) => {
    const a = NODES[e.from]
    const b = NODES[e.to]
    if (e.curve) {
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2 + e.curve
      return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`
    }
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  }
  return (
    <svg className="flow" viewBox="0 0 960 420" role="img" aria-label="contract flow">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {(Object.keys(EDGES) as EdgeId[]).map((id) => {
        const e = EDGES[id]
        const on = edges.includes(id)
        return (
          <g key={id} className={`edge ${on ? 'on' : ''}`}>
            <path d={path(e)} markerEnd="url(#arrow)" />
            {on && (
              <text>
                <textPath href={`#p-${id}`} startOffset="50%" textAnchor="middle">
                  {e.label}
                </textPath>
              </text>
            )}
            <path id={`p-${id}`} d={path(e)} fill="none" stroke="none" />
          </g>
        )
      })}
      {(Object.keys(NODES) as NodeId[]).map((id) => {
        const n = NODES[id]
        const on = nodes.includes(id)
        return (
          <g key={id} className={`node ${on ? 'on' : ''} ${id}`} transform={`translate(${n.x},${n.y})`}>
            <rect x={-82} y={-30} width={164} height={60} rx={14} />
            <text y={-5} textAnchor="middle" className="t">
              {n.label}
            </text>
            <text y={15} textAnchor="middle" className="s">
              {n.sub}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
