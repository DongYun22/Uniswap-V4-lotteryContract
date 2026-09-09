// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IVRFSubscriptionV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFSubscriptionV2Plus.sol";

import {Deployers} from "../test/utils/Deployers.sol";
import {LotteryHook} from "../src/LotteryHook.sol";

/// @notice 테스트넷 원샷 배포: 토큰 → 훅(CREATE2) → ETH/토큰 풀 + 유동성 → 훅 연결 → 상금 예치 → VRF consumer 등록
/// @dev  forge script script/DeploySepolia.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY -vvv
///       Uniswap 주소는 hookmate AddressConstants 가 chainid 로 고른다 (Sepolia / Base Sepolia / Arbitrum Sepolia ...).
contract DeploySepolia is Script, Deployers {
    using PoolIdLibrary for PoolKey;

    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant HOOK_FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
    uint24 constant FEE = 3000;
    int24 constant TICK_SPACING = 60;
    uint160 constant START_PRICE = 2 ** 96; // 1 ETH = 1 token

    struct Cfg {
        address vrfCoordinator;
        uint256 subId;
        bytes32 keyHash;
        uint64 epochDuration;
        uint256 liquidityEth;
        uint256 prizeEth;
        bool addConsumer;
    }

    function run() external {
        deployArtifacts(); // PoolManager / PositionManager / SwapRouter / Permit2 주소 결정

        Cfg memory c = Cfg({
            vrfCoordinator: vm.envAddress("VRF_COORDINATOR"),
            subId: vm.envUint("VRF_SUBSCRIPTION_ID"),
            keyHash: vm.envBytes32("VRF_KEY_HASH"),
            epochDuration: uint64(vm.envOr("EPOCH_DURATION", uint256(10 minutes))),
            liquidityEth: vm.envOr("LIQUIDITY_ETH", uint256(0.05 ether)),
            prizeEth: vm.envOr("PRIZE_ETH", uint256(0.01 ether)),
            addConsumer: vm.envOr("VRF_ADD_CONSUMER", true)
        });

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // 1. 테스트 토큰
        MockERC20 token = new MockERC20("Lottery Test Token", "LTT", 18);
        token.mint(deployer, 1_000_000 ether);

        // 2. 훅
        LotteryHook hook = _deployHook(c, deployer);

        // 3. ETH / 토큰 풀 + 유동성
        PoolKey memory key = _createPool(token, hook, deployer, c.liquidityEth);

        // 4. 훅에 풀 연결
        hook.setAllowedPool(key.toId(), true);

        // 5. 첫 상금
        if (c.prizeEth > 0) {
            (bool ok,) = address(hook).call{value: c.prizeEth}("");
            require(ok, "prize deposit failed");
        }

        // 6. VRF consumer 등록 (배포자가 구독 owner 일 때)
        if (c.addConsumer) {
            IVRFSubscriptionV2Plus(c.vrfCoordinator).addConsumer(c.subId, address(hook));
        }
        vm.stopBroadcast();

        string memory path = _writeJson(hook, token, key, c, deployer);

        console.log("");
        console.log("=== LotteryHook deployed ===");
        console.log("chainId        :", block.chainid);
        console.log("hook           :", address(hook));
        console.log("token (LTT)    :", address(token));
        console.log("poolManager    :", address(poolManager));
        console.log("swapRouter     :", address(swapRouter));
        console.log("owner          :", hook.owner());
        console.log("epochDuration  :", c.epochDuration);
        console.log("pot (wei)      :", hook.pot());
        console.log("written        :", path);
        if (!c.addConsumer) {
            console.log("!! register the hook as a consumer at vrf.chain.link (VRF_ADD_CONSUMER=false)");
        }
        console.log("next           : cd web && npm run sync-env && npm run dev");
    }

    /// @dev BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA 플래그 주소를 CREATE2 로 채굴해 배포하고 소유권을 받는다
    function _deployHook(Cfg memory c, address deployer) internal returns (LotteryHook hook) {
        bytes memory ctorArgs = abi.encode(poolManager, c.vrfCoordinator, c.subId, c.keyHash, deployer);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, HOOK_FLAGS, type(LotteryHook).creationCode, ctorArgs);
        hook = new LotteryHook{salt: salt}(poolManager, c.vrfCoordinator, c.subId, c.keyHash, deployer);
        require(address(hook) == hookAddr, "hook address mismatch");
        hook.acceptOwnership(); // CREATE2 프록시가 초기 owner 라서 제안된 소유권을 받는다
        hook.setEpochDuration(c.epochDuration);
    }

    /// @dev ETH/token 풀을 초기화하고 1:1 가격 주변에 유동성을 넣는다
    function _createPool(MockERC20 token, LotteryHook hook, address deployer, uint256 liquidityEth)
        internal
        returns (PoolKey memory key)
    {
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        token.approve(address(permit2), type(uint256).max);
        permit2.approve(address(token), address(positionManager), type(uint160).max, type(uint48).max);

        int24 tick = TickMath.getTickAtSqrtPrice(START_PRICE);
        int24 tickLower = ((tick - 750 * TICK_SPACING) / TICK_SPACING) * TICK_SPACING;
        int24 tickUpper = ((tick + 750 * TICK_SPACING) / TICK_SPACING) * TICK_SPACING;
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            START_PRICE,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidityEth,
            liquidityEth
        );

        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP), uint8(Actions.SWEEP)
        );
        bytes[] memory mintParams = new bytes[](4);
        mintParams[0] =
            abi.encode(key, tickLower, tickUpper, liquidity, liquidityEth + 1, liquidityEth + 1, deployer, bytes(""));
        mintParams[1] = abi.encode(key.currency0, key.currency1);
        mintParams[2] = abi.encode(key.currency0, deployer);
        mintParams[3] = abi.encode(key.currency1, deployer);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(positionManager.initializePool.selector, key, START_PRICE);
        calls[1] = abi.encodeWithSelector(
            positionManager.modifyLiquidities.selector, abi.encode(actions, mintParams), block.timestamp + 3600
        );
        positionManager.multicall{value: liquidityEth + 1}(calls);
    }

    function _writeJson(LotteryHook hook, MockERC20 token, PoolKey memory key, Cfg memory c, address deployer)
        internal
        returns (string memory path)
    {
        string memory j = "deploy";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "hook", address(hook));
        vm.serializeAddress(j, "token", address(token));
        vm.serializeAddress(j, "poolManager", address(poolManager));
        vm.serializeAddress(j, "positionManager", address(positionManager));
        vm.serializeAddress(j, "swapRouter", address(swapRouter));
        vm.serializeAddress(j, "vrfCoordinator", c.vrfCoordinator);
        vm.serializeUint(j, "subscriptionId", c.subId);
        vm.serializeUint(j, "fee", FEE);
        vm.serializeInt(j, "tickSpacing", TICK_SPACING);
        vm.serializeBytes32(j, "poolId", PoolId.unwrap(key.toId()));
        vm.serializeAddress(j, "owner", deployer);
        string memory out = vm.serializeUint(j, "deployBlock", block.number);
        path = string.concat("./deployments/", _chainName(), ".json");
        vm.writeJson(out, path);
    }

    /// @dev anvil(31337) 에서만 Permit2 를 etch 해 로컬 검증을 가능하게 한다
    function _etch(address target, bytes memory bytecode) internal override {
        if (block.chainid == 31337) {
            vm.etch(target, bytecode); // 시뮬레이션 EVM
            vm.rpc("anvil_setCode", string.concat('["', vm.toString(target), '","', vm.toString(bytecode), '"]')); // 실제 노드
        } else {
            revert("Permit2 missing on this chain");
        }
    }

    function _chainName() internal view returns (string memory) {
        if (block.chainid == 11155111) return "sepolia";
        if (block.chainid == 84532) return "base-sepolia";
        if (block.chainid == 421614) return "arbitrum-sepolia";
        if (block.chainid == 31337) return "anvil";
        return vm.toString(block.chainid);
    }
}
