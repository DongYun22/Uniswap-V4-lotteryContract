import { IS_LIVE } from '../config/addresses'
import { useDemoLottery } from './demo'
import { useLiveLottery } from './live'

/** 모드는 빌드 시점에 고정되므로 훅을 조건부로 골라도 훅 규칙을 어기지 않는다 */
export const useLottery = IS_LIVE ? useLiveLottery : useDemoLottery
