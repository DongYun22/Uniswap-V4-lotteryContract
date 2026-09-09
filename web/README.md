# LotteryHook Web

Vite + React + TypeScript. Three.js(react-three-fiber) 추첨 드럼 씬과 컨트랙트 흐름 온보딩 페이지.

## 실행

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

`.env` 가 없거나 `VITE_HOOK_ADDRESS` 가 비어 있으면 **데모 모드**로 뜹니다.
브라우저 안에서 컨트랙트와 같은 규칙으로 회차를 시뮬레이션하므로 배포 전에도 화면을 확인할 수 있습니다.

## Base Sepolia 연결

```bash
cp .env.example .env
```

| 변수 | 값 |
|---|---|
| `VITE_HOOK_ADDRESS` | 배포된 LotteryHook 주소 |
| `VITE_TOKEN_ADDRESS` | 풀의 currency1 (테스트 ERC20). currency0 은 네이티브 ETH 고정 |
| `VITE_POOL_FEE` / `VITE_POOL_TICK_SPACING` | 풀 생성 때 쓴 값 (기본 3000 / 60) |
| `VITE_SWAP_ROUTER` | hookmate V4SwapRouter. Base Sepolia 는 기본값 그대로 |
| `VITE_DEPLOY_BLOCK` | 훅 배포 블록. 이벤트 로그 조회 시작점 |
| `VITE_RPC_URL` | 기본 `https://sepolia.base.org` |

지갑은 브라우저 injected(MetaMask 등)만 지원합니다. WalletConnect 는 projectId 가 필요해서 넣지 않았습니다.

## 구조

```
src/
├── config/        addresses.ts(env 파싱, poolKey), wagmi.ts, abi/
├── lib/           types.ts(Phase, LotteryModel 인터페이스), format.ts
├── state/         demo.ts(시뮬레이션), live.ts(wagmi/viem), useLottery.ts(모드 선택)
├── three/         LotteryScene.tsx — 드럼, 티켓 공, 코어, bloom
├── components/    Nav, EpochPanel, ActionPanel, History, FlowDiagram
└── pages/         Live.tsx, HowItWorks.tsx
```

`state/` 가 `LotteryModel` 하나로 UI 에 상태와 액션을 넘기므로, UI 는 데모/라이브를 구분하지 않습니다.

## ABI 갱신

컨트랙트를 바꾸면 루트에서:

```bash
cd web && npm run abi
```
