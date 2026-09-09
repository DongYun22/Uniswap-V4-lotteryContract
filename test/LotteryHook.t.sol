// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {EasyPosm} from "./utils/libraries/EasyPosm.sol";
import {BaseTest} from "./utils/BaseTest.sol";

import {LotteryHook} from "../src/LotteryHook.sol";
import {MockVRFCoordinatorV2Plus} from "../src/mocks/MockVRFCoordinatorV2Plus.sol";

/// @dev ETH(currency0) / TEST(currency1) 풀. ETH 를 넣는 exact-input 스왑이 참가 대상.
contract LotteryHookTest is BaseTest {
    using EasyPosm for IPositionManager;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint160 constant FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);

    MockERC20 token;
    Currency currency0; // ETH
    Currency currency1; // token
    PoolKey poolKey;
    PoolId poolId;
    LotteryHook hook;
    MockVRFCoordinatorV2Plus vrf;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    function setUp() public {
        deployArtifactsAndLabel();
        deal(address(this), 10_000 ether);

        token = deployToken();
        currency0 = Currency.wrap(address(0));
        currency1 = Currency.wrap(address(token));

        vrf = new MockVRFCoordinatorV2Plus();

        address flags = address(FLAGS ^ (0x4444 << 144));
        bytes memory constructorArgs =
            abi.encode(poolManager, address(vrf), uint256(1), bytes32(uint256(0xabc)), address(this));
        deployCodeTo("LotteryHook.sol:LotteryHook", constructorArgs, flags);
        hook = LotteryHook(payable(flags));

        poolKey = PoolKey(currency0, currency1, 3000, 60, IHooks(hook));
        poolId = poolKey.toId();
        poolManager.initialize(poolKey, Constants.SQRT_PRICE_1_1);

        int24 tickLower = TickMath.minUsableTick(60);
        int24 tickUpper = TickMath.maxUsableTick(60);
        uint128 liquidityAmount = 1000e18;
        (uint256 amount0, uint256 amount1) = LiquidityAmounts.getAmountsForLiquidity(
            Constants.SQRT_PRICE_1_1,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidityAmount
        );
        positionManager.mint(
            poolKey, tickLower, tickUpper, liquidityAmount, amount0 + 1, amount1 + 1, address(this), block.timestamp, Constants.ZERO_BYTES
        );

        hook.setAllowedPool(poolId, true);
        hook.setEpochDuration(1 hours);

        deal(alice, 10 ether);
        deal(bob, 10 ether);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------
    function _deposit(uint256 amount) internal {
        (bool ok,) = payable(address(hook)).call{value: amount}("");
        require(ok, "deposit failed");
    }

    /// @dev ETH → token exact-input. 티켓은 hookData 의 player 에게.
    function _swapEth(address player, uint256 amountIn) internal {
        swapRouter.swapExactTokensForTokens{value: amountIn}({
            amountIn: amountIn,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: poolKey,
            hookData: abi.encode(player),
            receiver: address(this),
            deadline: block.timestamp + 1
        });
    }

    function _endEpoch() internal {
        vm.warp(hook.currentEpoch().endTime + 1);
    }

    /// @dev alice 1 ETH(1000장, 0..999), bob 0.5 ETH(500장, 1000..1499) → 추첨 → 확정
    function _runDraw(uint256 randomWord) internal returns (uint256 epochId) {
        epochId = hook.currentEpochId();
        _swapEth(alice, 1 ether);
        _swapEth(bob, 0.5 ether);
        _endEpoch();
        hook.requestDraw();
        vrf.fulfill(hook.getEpoch(epochId).vrfRequestId, randomWord);
    }

    // ------------------------------------------------------------------
    // ownership
    // ------------------------------------------------------------------
    function test_owner_is_test_contract() public view {
        assertEq(hook.owner(), address(this));
    }

    function test_constructor_proposes_owner_when_deployer_differs() public {
        address deployer = makeAddr("deployer");
        address where = address(FLAGS ^ (0x5555 << 144));
        bytes memory initCode = abi.encodePacked(
            vm.getCode("LotteryHook.sol:LotteryHook"),
            abi.encode(poolManager, address(vrf), uint256(1), bytes32(uint256(1)), alice)
        );
        vm.etch(where, initCode);
        vm.prank(deployer);
        (bool ok, bytes memory runtime) = where.call("");
        require(ok, "ctor failed");
        vm.etch(where, runtime);

        LotteryHook h = LotteryHook(payable(where));
        assertEq(h.owner(), deployer);
        vm.prank(alice);
        h.acceptOwnership();
        assertEq(h.owner(), alice);
    }

    // ------------------------------------------------------------------
    // fee + tickets
    // ------------------------------------------------------------------
    function test_swap_takes_fee_and_mints_tickets() public {
        uint256 tokenBefore = token.balanceOf(address(this));
        _swapEth(alice, 1 ether);

        // 5% → pot, 1000장
        assertEq(hook.pot(), 0.05 ether);
        assertEq(address(hook).balance, 0.05 ether);
        assertEq(hook.ticketsOf(1, alice), 1000);
        assertEq(hook.currentEpoch().ticketCount, 1000);
        assertEq(hook.currentEpoch().entryCount, 1);
        assertGt(token.balanceOf(address(this)), tokenBefore); // 나머지 0.95 ETH 는 정상 스왑
    }

    function test_quote_matches_swap() public {
        (uint96 tickets, uint256 fee) = hook.quote(0.3 ether);
        assertEq(tickets, 300);
        assertEq(fee, 0.015 ether);
        _swapEth(alice, 0.3 ether);
        assertEq(hook.ticketsOf(1, alice), tickets);
        assertEq(hook.pot(), fee);
    }

    function test_tickets_floor_by_price_fee_on_gross() public {
        _swapEth(alice, 0.0015 ether); // 1.5장 → 1장, 수수료는 전체 금액 기준
        assertEq(hook.ticketsOf(1, alice), 1);
        assertEq(hook.pot(), 0.000075 ether);
    }

    function test_below_ticket_price_no_fee_no_ticket_no_revert() public {
        _swapEth(alice, 0.0009 ether);
        assertEq(hook.pot(), 0);
        assertEq(hook.currentEpoch().ticketCount, 0);
    }

    function test_token_to_eth_swap_not_eligible() public {
        swapRouter.swapExactTokensForTokens({
            amountIn: 1 ether,
            amountOutMin: 0,
            zeroForOne: false,
            poolKey: poolKey,
            hookData: abi.encode(alice),
            receiver: address(this),
            deadline: block.timestamp + 1
        });
        assertEq(hook.pot(), 0);
        assertEq(hook.currentEpoch().ticketCount, 0);
    }

    function test_exact_output_swap_not_eligible() public {
        swapRouter.swapTokensForExactTokens{value: 2 ether}({
            amountOut: 1 ether,
            amountInMax: 2 ether,
            zeroForOne: true,
            poolKey: poolKey,
            hookData: abi.encode(alice),
            receiver: address(this),
            deadline: block.timestamp + 1
        });
        assertEq(hook.pot(), 0);
        assertEq(hook.currentEpoch().ticketCount, 0);
    }

    function test_swap_on_unallowed_pool_passes_through() public {
        hook.setAllowedPool(PoolId.wrap(bytes32(uint256(0xdead))), true);
        _swapEth(alice, 1 ether);
        assertEq(hook.pot(), 0);
        assertEq(hook.currentEpoch().ticketCount, 0);
    }

    function test_swap_during_drawing_passes_through() public {
        _swapEth(alice, 1 ether);
        _endEpoch();
        hook.requestDraw();
        _swapEth(bob, 1 ether);
        assertEq(hook.ticketsOf(1, bob), 0);
        assertEq(hook.pot(), 0); // 추첨 중엔 수수료도 안 뗀다
    }

    function test_hookData_zero_address_falls_back_to_sender() public {
        _swapEth(address(0), 0.01 ether);
        assertEq(hook.ticketOwner(1, 0), address(swapRouter));
    }

    function test_ticketOwner_ranges() public {
        _swapEth(alice, 1 ether); // 0..999
        _swapEth(bob, 0.5 ether); // 1000..1499
        _swapEth(alice, 0.002 ether); // 1500..1501
        assertEq(hook.ticketOwner(1, 0), alice);
        assertEq(hook.ticketOwner(1, 999), alice);
        assertEq(hook.ticketOwner(1, 1000), bob);
        assertEq(hook.ticketOwner(1, 1499), bob);
        assertEq(hook.ticketOwner(1, 1501), alice);
        assertEq(hook.ticketsOf(1, alice), 1002);
        vm.expectRevert(LotteryHook.IndexOutOfRange.selector);
        hook.ticketOwner(1, 1502);
    }

    function test_setFeeBps_and_ticketPrice() public {
        hook.setFeeBps(1000);
        hook.setTicketPrice(0.01 ether);
        _swapEth(alice, 1 ether);
        assertEq(hook.pot(), 0.1 ether);
        assertEq(hook.ticketsOf(1, alice), 100);

        vm.expectRevert(LotteryHook.FeeTooHigh.selector);
        hook.setFeeBps(2001);
        vm.expectRevert(LotteryHook.InvalidTicketPrice.selector);
        hook.setTicketPrice(0);
    }

    function test_zero_fee_still_mints() public {
        hook.setFeeBps(0);
        _swapEth(alice, 1 ether);
        assertEq(hook.pot(), 0);
        assertEq(hook.ticketsOf(1, alice), 1000);
    }

    function test_external_deposit_adds_to_pot() public {
        _deposit(1 ether);
        _swapEth(alice, 1 ether);
        assertEq(hook.pot(), 1.05 ether);
    }

    // ------------------------------------------------------------------
    // draw / claim
    // ------------------------------------------------------------------
    function test_draw_and_claim() public {
        uint256 epochId = _runDraw(1000); // index 1000 → bob
        LotteryHook.Epoch memory e = hook.getEpoch(epochId);
        assertEq(uint8(e.phase), uint8(LotteryHook.Phase.Resolved));
        assertEq(e.winner, bob);
        assertEq(e.prize, 0.075 ether); // 1.5 ETH 의 5%
        assertEq(hook.pot(), 0);
        assertEq(hook.reserved(), 0.075 ether);

        uint256 before = bob.balance;
        vm.prank(bob);
        hook.claim(epochId);
        assertEq(bob.balance, before + 0.075 ether);
        assertEq(hook.reserved(), 0);
        assertEq(address(hook).balance, 0);
    }

    function test_winner_by_random_word() public {
        uint256 epochId = _runDraw(999); // → alice
        assertEq(hook.getEpoch(epochId).winner, alice);
    }

    function test_random_modulo_ticketCount() public {
        uint256 epochId = _runDraw(1500 * 7 + 1200); // 1200 → bob
        assertEq(hook.getEpoch(epochId).winner, bob);
    }

    function test_callback_opens_next_epoch_without_claim() public {
        uint256 epochId = _runDraw(0);
        assertEq(hook.currentEpochId(), epochId + 1);
        assertEq(uint8(hook.currentEpoch().phase), uint8(LotteryHook.Phase.Open));
    }

    function test_unclaimed_prize_is_not_double_counted() public {
        uint256 epoch1 = _runDraw(0); // alice, 0.075
        assertEq(hook.reserved(), 0.075 ether);
        assertEq(hook.pot(), 0);

        uint256 epoch2 = _runDraw(1000); // bob, 0.075 (새 스왑 수수료만)
        assertEq(hook.getEpoch(epoch2).prize, 0.075 ether);
        assertEq(hook.reserved(), 0.15 ether);

        vm.prank(bob);
        hook.claim(epoch2);
        assertEq(address(hook).balance, 0.075 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        hook.claim(epoch1);
        assertEq(alice.balance, before + 0.075 ether);
        assertEq(hook.reserved(), 0);
    }

    function test_claim_reverts_for_non_winner_and_double_claim() public {
        uint256 epochId = _runDraw(1000); // bob
        vm.prank(alice);
        vm.expectRevert(LotteryHook.NothingToClaim.selector);
        hook.claim(epochId);
        vm.prank(bob);
        hook.claim(epochId);
        vm.prank(bob);
        vm.expectRevert(LotteryHook.NothingToClaim.selector);
        hook.claim(epochId);
    }

    function test_requestDraw_reverts_before_end_for_non_owner() public {
        _swapEth(alice, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(LotteryHook.EpochNotEnded.selector);
        hook.requestDraw();
    }

    function test_owner_can_draw_early() public {
        _swapEth(alice, 1 ether);
        hook.requestDraw();
        assertEq(uint8(hook.currentEpoch().phase), uint8(LotteryHook.Phase.Drawing));
    }

    // ------------------------------------------------------------------
    // VRF timeout / retry / stale callback
    // ------------------------------------------------------------------
    function test_retryDraw_reverts_before_timeout() public {
        _swapEth(alice, 1 ether);
        _endEpoch();
        hook.requestDraw();
        vm.expectRevert(LotteryHook.DrawNotTimedOut.selector);
        hook.retryDraw();
    }

    function test_retryDraw_after_timeout_and_stale_callback_ignored() public {
        uint256 epochId = hook.currentEpochId();
        _swapEth(alice, 1 ether);
        _swapEth(bob, 0.5 ether);
        _endEpoch();
        hook.requestDraw();
        uint256 oldReq = hook.getEpoch(epochId).vrfRequestId;

        vm.warp(block.timestamp + hook.vrfTimeout() + 1);
        hook.retryDraw();
        uint256 newReq = hook.getEpoch(epochId).vrfRequestId;
        assertTrue(newReq != oldReq);

        vrf.fulfill(oldReq, 0);
        assertEq(uint8(hook.getEpoch(epochId).phase), uint8(LotteryHook.Phase.Drawing));

        vrf.fulfill(newReq, 1000);
        assertEq(hook.getEpoch(epochId).winner, bob);
        assertEq(hook.getEpoch(epochId).prize, 0.075 ether);
        assertEq(hook.reserved(), 0.075 ether);
    }

    function test_duplicate_callback_ignored() public {
        uint256 epochId = _runDraw(0);
        vrf.fulfill(hook.getEpoch(epochId).vrfRequestId, 1000);
        assertEq(hook.getEpoch(epochId).winner, alice);
    }

    // ------------------------------------------------------------------
    // skipEpoch
    // ------------------------------------------------------------------
    function test_skipEpoch_no_tickets_carries_pot() public {
        _deposit(1 ether);
        _endEpoch();
        hook.skipEpoch();
        assertEq(hook.currentEpochId(), 2);
        assertEq(hook.pot(), 1 ether);
        assertTrue(hook.getEpoch(1).claimed);
    }

    function test_skipEpoch_reverts_when_drawable() public {
        _swapEth(alice, 1 ether);
        _endEpoch();
        vm.expectRevert(LotteryHook.EpochNotSkippable.selector);
        hook.skipEpoch();
    }

    function test_skipEpoch_reverts_before_end_for_non_owner() public {
        vm.prank(stranger);
        vm.expectRevert(LotteryHook.EpochNotEnded.selector);
        hook.skipEpoch();
    }

    // ------------------------------------------------------------------
    // Automation
    // ------------------------------------------------------------------
    function test_checkUpkeep_false_before_epoch_end() public {
        _swapEth(alice, 1 ether);
        (bool needed,) = hook.checkUpkeep("");
        assertFalse(needed);
    }

    function test_performUpkeep_draws_after_end() public {
        _swapEth(alice, 1 ether);
        _endEpoch();
        (bool needed,) = hook.checkUpkeep("");
        assertTrue(needed);
        hook.performUpkeep("");
        assertEq(uint8(hook.currentEpoch().phase), uint8(LotteryHook.Phase.Drawing));
    }

    function test_performUpkeep_skips_empty_epoch() public {
        _endEpoch();
        hook.performUpkeep("");
        assertEq(hook.currentEpochId(), 2);
    }

    function test_performUpkeep_retries_on_timeout() public {
        _swapEth(alice, 1 ether);
        _endEpoch();
        hook.requestDraw();
        vm.warp(block.timestamp + hook.vrfTimeout() + 1);
        uint256 oldReq = hook.currentEpoch().vrfRequestId;
        hook.performUpkeep("");
        assertTrue(hook.currentEpoch().vrfRequestId != oldReq);
    }

    // ------------------------------------------------------------------
    // sweep / state
    // ------------------------------------------------------------------
    function test_sweepExcess_only_stray_eth() public {
        _swapEth(alice, 1 ether);
        vm.expectRevert(LotteryHook.NothingToSweep.selector);
        hook.sweepExcess(address(this));

        vm.deal(address(hook), address(hook).balance + 0.3 ether);
        uint256 before = stranger.balance;
        hook.sweepExcess(stranger);
        assertEq(stranger.balance, before + 0.3 ether);
        assertEq(address(hook).balance, 0.05 ether);
    }

    function test_sweepExcess_only_owner() public {
        vm.prank(stranger);
        vm.expectRevert("Only callable by owner");
        hook.sweepExcess(stranger);
    }

    function test_getState_snapshot() public {
        _swapEth(alice, 1 ether);
        LotteryHook.State memory s = hook.getState();
        assertEq(s.epochId, 1);
        assertEq(s.epoch.ticketCount, 1000);
        assertEq(s.pot, 0.05 ether);
        assertEq(s.feeBps, 500);
        assertEq(s.ticketPrice, 0.001 ether);
        assertEq(s.owner, address(this));
    }

    receive() external payable {}
}
