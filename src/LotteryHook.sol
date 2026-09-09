// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title LotteryHook
/// @notice Uniswap V4 beforeSwap 훅 + Chainlink VRF v2.5 회차 추첨
/// @dev - ETH 를 넣는 exact-input 스왑에서 feeBps 만큼을 떼어 상금(pot)으로 쌓는다.
///      - 스왑 금액 / ticketPrice 장의 티켓을 발급한다 (누적 구간 저장, 스왑당 SSTORE 1회).
///      - 회차별 상금은 추첨 시점에 pot 에서 분리(reserved)되어 미수령 상금이 다음 회차에 섞이지 않는다.
///      - VRF 콜백이 오지 않으면 vrfTimeout 후 retryDraw 로 재요청할 수 있다.
///      - 티켓/상금이 없는 회차는 skipEpoch 로 닫는다.
///      - 훅은 어떤 경우에도 스왑을 revert 시키지 않는다(조건이 안 맞으면 수수료도 티켓도 없이 통과).

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

contract LotteryHook is BaseHook, VRFConsumerBaseV2Plus {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error EpochNotEnded();
    error EpochNotOpen();
    error EpochNotDrawing();
    error EpochNotSkippable();
    error DrawNotTimedOut();
    error NoTickets();
    error NoPrize();
    error NothingToClaim();
    error TransferFailed();
    error NothingToSweep();
    error FeeTooHigh();
    error InvalidTicketPrice();
    error IndexOutOfRange();

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------
    enum Phase {
        Open, // 티켓 판매 중
        Drawing, // VRF 요청함, 콜백 대기
        Resolved // 승자 확정(또는 skip), claim 가능
    }

    struct Epoch {
        address winner;
        uint64 endTime;
        uint32 entryCount; // 스왑(구간) 수
        Phase phase;
        bool claimed;
        uint64 drawRequestedAt;
        uint96 ticketCount; // 티켓 총 장수
        uint256 prize;
        uint256 vrfRequestId;
    }

    /// @dev 스왑 한 번 = 구간 하나. cumulative 는 이 구간까지의 누적 티켓 수(포함).
    struct Entry {
        address player;
        uint96 cumulative;
    }

    // ---------------------------------------------------------------------
    // Config
    // ---------------------------------------------------------------------
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 2_000; // 20%

    /// @notice restrictPool 이 true 면 allowedPoolId 풀의 스왑만 참가한다.
    PoolId public allowedPoolId;
    bool public restrictPool;

    uint64 public epochDuration = 1 hours;
    /// @notice VRF 콜백이 이 시간 안에 오지 않으면 재요청 허용
    uint64 public vrfTimeout = 1 days;

    /// @notice 스왑 입력 ETH 중 상금으로 떼는 비율 (bps). 500 = 5%
    uint256 public feeBps = 500;
    /// @notice 티켓 1장 가격. 스왑 금액(수수료 차감 전) / ticketPrice 장 발급
    uint256 public ticketPrice = 1e15; // 0.001 ETH

    uint256 public s_subscriptionId;
    bytes32 public keyHash;
    uint32 public callbackGasLimit = 120_000; // 실측 약 35k
    uint16 public requestConfirmations = 3;
    bool public nativePayment = false; // Sepolia 는 LINK 결제가 안전 (README 참고)

    // ---------------------------------------------------------------------
    // Prize accounting
    // ---------------------------------------------------------------------
    /// @notice 아직 어느 회차에도 배정되지 않은 상금
    uint256 public pot;
    /// @notice 추첨 중이거나 확정됐지만 아직 수령되지 않은 상금 합계
    uint256 public reserved;

    // ---------------------------------------------------------------------
    // Epoch state
    // ---------------------------------------------------------------------
    uint256 public currentEpochId;
    mapping(uint256 => Epoch) internal _epochs;
    /// @dev epochId => 구간 목록 (cumulative 오름차순)
    mapping(uint256 => Entry[]) internal _entries;
    /// @dev epochId => player => 티켓 수
    mapping(uint256 => mapping(address => uint96)) public ticketsOf;
    /// @dev VRF requestId => epochId
    mapping(uint256 => uint256) public requestToEpoch;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event TicketsMinted(
        uint256 indexed epochId, address indexed player, uint96 firstIndex, uint96 count, uint256 fee, PoolId poolId
    );
    event PrizeDeposited(address indexed from, uint256 amount, uint256 pot);
    event DrawRequested(uint256 indexed epochId, uint256 requestId, uint96 ticketCount, uint256 prize);
    event DrawRetried(uint256 indexed epochId, uint256 oldRequestId, uint256 newRequestId);
    event WinnerSelected(uint256 indexed epochId, address indexed winner, uint256 prize, uint256 randomWord);
    event EpochSkipped(uint256 indexed epochId, uint96 ticketCount, uint256 pot);
    event PrizeClaimed(uint256 indexed epochId, address indexed winner, uint256 prize);
    event EpochOpened(uint256 indexed epochId, uint64 endTime);
    event ExcessSwept(address indexed to, uint256 amount);
    event ConfigUpdated(uint256 feeBps, uint256 ticketPrice, uint64 epochDuration);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------
    /// @param _owner 실제 관리자. CREATE2 프록시로 배포하면 msg.sender 가 프록시라서
    ///               이 주소로 소유권을 제안한다. 배포 후 _owner 가 acceptOwnership() 을 호출해야 한다.
    constructor(
        IPoolManager _poolManager,
        address _vrfCoordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        address _owner
    ) BaseHook(_poolManager) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        s_subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        if (_owner != address(0) && _owner != msg.sender) {
            transferOwnership(_owner);
        }
        _openEpoch(1);
    }

    /// @dev 스왑 수수료(poolManager.take)와 외부 예치 모두 pot 으로 들어온다.
    receive() external payable {
        pot += msg.value;
        if (msg.sender != address(poolManager)) {
            emit PrizeDeposited(msg.sender, msg.value, pot);
        }
    }

    // ---------------------------------------------------------------------
    // Hook permissions — beforeSwap + returnDelta
    // ---------------------------------------------------------------------
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------------
    // beforeSwap: ETH exact-input 스왑이면 feeBps 를 떼어 pot 에 넣고 티켓 발급.
    // 그 외(토큰→ETH, exact-output, 회차 닫힘, 금액 미달)는 수수료 없이 그대로 통과.
    // sender 는 보통 SwapRouter. 실제 플레이어는 hookData = abi.encode(address) 로 전달.
    // ---------------------------------------------------------------------
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        if (restrictPool && PoolId.unwrap(poolId) != PoolId.unwrap(allowedPoolId)) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        // ETH(currency0) 를 넣는 exact-input 스왑만 참가 대상
        if (!key.currency0.isAddressZero() || !params.zeroForOne || params.amountSpecified >= 0) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        if (e.phase != Phase.Open) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 count = amountIn / ticketPrice;
        if (count == 0) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 fee = (amountIn * feeBps) / BPS;
        if (fee > 0) {
            // 스왑되기 전에 입력 ETH 의 fee 만큼을 훅이 가져간다. receive() 가 pot 에 더한다.
            poolManager.take(key.currency0, address(this), fee);
        }

        address player = _resolvePlayer(sender, hookData);
        _mintTickets(epochId, player, uint96(count), fee, poolId);

        return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(int128(uint128(fee)), 0), 0);
    }

    // ---------------------------------------------------------------------
    // Chainlink Automation
    // ---------------------------------------------------------------------
    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory) {
        Epoch storage e = _epochs[currentEpochId];
        if (e.phase == Phase.Open) {
            upkeepNeeded = block.timestamp >= e.endTime;
        } else if (e.phase == Phase.Drawing) {
            upkeepNeeded = block.timestamp >= e.drawRequestedAt + vrfTimeout;
        }
        return (upkeepNeeded, bytes(""));
    }

    function performUpkeep(bytes calldata) external {
        Epoch storage e = _epochs[currentEpochId];
        if (e.phase == Phase.Open) {
            if (e.ticketCount > 0 && pot > 0) {
                requestDraw();
            } else {
                skipEpoch();
            }
        } else if (e.phase == Phase.Drawing) {
            retryDraw();
        }
    }

    // ---------------------------------------------------------------------
    // Draw
    // ---------------------------------------------------------------------
    /// @notice 회차 종료 후 누구나 호출. owner 는 종료 전에도 호출 가능.
    function requestDraw() public {
        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        if (e.phase != Phase.Open) revert EpochNotOpen();
        if (block.timestamp < e.endTime && msg.sender != owner()) revert EpochNotEnded();
        if (e.ticketCount == 0) revert NoTickets();
        if (pot == 0) revert NoPrize();

        uint256 prize = pot;
        pot = 0;
        reserved += prize;

        e.phase = Phase.Drawing;
        e.prize = prize;
        e.drawRequestedAt = uint64(block.timestamp);

        uint256 requestId = _requestRandomWord();
        e.vrfRequestId = requestId;
        requestToEpoch[requestId] = epochId;
        emit DrawRequested(epochId, requestId, e.ticketCount, prize);
    }

    /// @notice VRF 콜백이 vrfTimeout 안에 오지 않았을 때 재요청. 이전 requestId 의 콜백은 무시된다.
    function retryDraw() public {
        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        if (e.phase != Phase.Drawing) revert EpochNotDrawing();
        if (block.timestamp < e.drawRequestedAt + vrfTimeout) revert DrawNotTimedOut();

        uint256 oldRequestId = e.vrfRequestId;
        uint256 requestId = _requestRandomWord();
        e.vrfRequestId = requestId;
        e.drawRequestedAt = uint64(block.timestamp);
        requestToEpoch[requestId] = epochId;
        emit DrawRetried(epochId, oldRequestId, requestId);
    }

    /// @notice 티켓이 없거나 상금이 없어 추첨할 수 없는 회차를 닫고 다음 회차를 연다. pot 은 이월.
    function skipEpoch() public {
        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        if (e.phase != Phase.Open) revert EpochNotOpen();
        if (block.timestamp < e.endTime && msg.sender != owner()) revert EpochNotEnded();
        if (e.ticketCount > 0 && pot > 0) revert EpochNotSkippable();

        e.phase = Phase.Resolved;
        e.claimed = true;
        emit EpochSkipped(epochId, e.ticketCount, pot);
        _openEpoch(epochId + 1);
    }

    /// @dev VRF 콜백. revert 하면 재시도되지 않으므로 상태만 확정한다.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 epochId = requestToEpoch[requestId];
        Epoch storage e = _epochs[epochId];

        if (e.phase != Phase.Drawing || e.vrfRequestId != requestId || e.ticketCount == 0) {
            return;
        }

        uint256 word = randomWords.length > 0 ? randomWords[0] : uint256(keccak256(abi.encode(requestId)));
        uint96 winningIndex = uint96(word % e.ticketCount);
        address winner = _ownerOfTicket(epochId, winningIndex);

        e.winner = winner;
        e.phase = Phase.Resolved;
        emit WinnerSelected(epochId, winner, e.prize, word);

        if (epochId == currentEpochId) {
            _openEpoch(epochId + 1);
        }
    }

    function claim(uint256 epochId) external {
        Epoch storage e = _epochs[epochId];
        if (e.phase != Phase.Resolved || e.claimed) revert NothingToClaim();
        if (msg.sender != e.winner) revert NothingToClaim();

        e.claimed = true;
        uint256 prize = e.prize;
        reserved -= prize;

        (bool ok,) = payable(msg.sender).call{value: prize}("");
        if (!ok) revert TransferFailed();
        emit PrizeClaimed(epochId, msg.sender, prize);
    }

    /// @notice 콜백에서 다음 회차가 열리지 못한 경우를 위한 수동 오픈
    function openNextEpoch() external {
        Epoch storage e = _epochs[currentEpochId];
        if (e.phase != Phase.Resolved) revert EpochNotOpen();
        _openEpoch(currentEpochId + 1);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------
    function setAllowedPool(PoolId poolId, bool restrict) external onlyOwner {
        allowedPoolId = poolId;
        restrictPool = restrict;
    }

    function setEpochDuration(uint64 duration) external onlyOwner {
        epochDuration = duration;
        emit ConfigUpdated(feeBps, ticketPrice, epochDuration);
    }

    function setVrfTimeout(uint64 timeout) external onlyOwner {
        vrfTimeout = timeout;
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = _feeBps;
        emit ConfigUpdated(feeBps, ticketPrice, epochDuration);
    }

    function setTicketPrice(uint256 price) external onlyOwner {
        if (price == 0) revert InvalidTicketPrice();
        ticketPrice = price;
        emit ConfigUpdated(feeBps, ticketPrice, epochDuration);
    }

    function setVrfConfig(uint256 subId, bytes32 _keyHash, uint32 gasLimit, uint16 confirmations, bool _nativePayment)
        external
        onlyOwner
    {
        s_subscriptionId = subId;
        keyHash = _keyHash;
        callbackGasLimit = gasLimit;
        requestConfirmations = confirmations;
        nativePayment = _nativePayment;
    }

    /// @notice pot / reserved 에 잡히지 않은 잔액만 회수한다. 플레이어 상금은 owner 도 꺼낼 수 없다.
    function sweepExcess(address to) external onlyOwner {
        uint256 excess = address(this).balance - pot - reserved;
        if (excess == 0) revert NothingToSweep();
        (bool ok,) = payable(to).call{value: excess}("");
        if (!ok) revert TransferFailed();
        emit ExcessSwept(to, excess);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    /// @notice 프론트엔드용 스냅샷. RPC 한 번으로 화면에 필요한 값을 모두 가져온다.
    struct State {
        uint256 epochId;
        Epoch epoch;
        uint256 pot;
        uint256 reserved;
        uint64 epochDuration;
        uint64 vrfTimeout;
        uint256 feeBps;
        uint256 ticketPrice;
        uint256 timestamp;
        address owner;
    }

    function getState() external view returns (State memory s) {
        s.epochId = currentEpochId;
        s.epoch = _epochs[currentEpochId];
        s.pot = pot;
        s.reserved = reserved;
        s.epochDuration = epochDuration;
        s.vrfTimeout = vrfTimeout;
        s.feeBps = feeBps;
        s.ticketPrice = ticketPrice;
        s.timestamp = block.timestamp;
        s.owner = owner();
    }

    function getEpoch(uint256 epochId) external view returns (Epoch memory) {
        return _epochs[epochId];
    }

    function currentEpoch() external view returns (Epoch memory) {
        return _epochs[currentEpochId];
    }

    /// @notice 티켓 인덱스의 소유자 (이진 탐색)
    function ticketOwner(uint256 epochId, uint96 index) external view returns (address) {
        if (index >= _epochs[epochId].ticketCount) revert IndexOutOfRange();
        return _ownerOfTicket(epochId, index);
    }

    function getEntries(uint256 epochId) external view returns (Entry[] memory) {
        return _entries[epochId];
    }

    /// @notice 주어진 스왑 금액으로 받을 티켓 수와 수수료
    function quote(uint256 amountIn) external view returns (uint96 tickets, uint256 fee) {
        tickets = uint96(amountIn / ticketPrice);
        fee = tickets == 0 ? 0 : (amountIn * feeBps) / BPS;
    }

    /// @notice 다음 추첨에 걸리는 상금
    function prizeBalance() external view returns (uint256) {
        return pot;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------
    function _requestRandomWord() internal returns (uint256) {
        return s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: s_subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
    }

    function _openEpoch(uint256 id) internal {
        currentEpochId = id;
        Epoch storage e = _epochs[id];
        e.phase = Phase.Open;
        e.endTime = uint64(block.timestamp + epochDuration);
        emit EpochOpened(id, e.endTime);
    }

    function _mintTickets(uint256 epochId, address player, uint96 count, uint256 fee, PoolId poolId) internal {
        Epoch storage e = _epochs[epochId];
        uint96 first = e.ticketCount;
        uint96 cumulative = first + count;
        _entries[epochId].push(Entry({player: player, cumulative: cumulative}));
        e.ticketCount = cumulative;
        e.entryCount += 1;
        ticketsOf[epochId][player] += count;
        emit TicketsMinted(epochId, player, first, count, fee, poolId);
    }

    /// @dev cumulative > index 인 첫 구간의 player
    function _ownerOfTicket(uint256 epochId, uint96 index) internal view returns (address) {
        Entry[] storage list = _entries[epochId];
        uint256 lo = 0;
        uint256 hi = list.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (list[mid].cumulative > index) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        return list[lo].player;
    }

    function _resolvePlayer(address sender, bytes calldata hookData) internal pure returns (address) {
        if (hookData.length == 32) {
            address player = abi.decode(hookData, (address));
            if (player != address(0)) return player;
        }
        return sender;
    }
}
