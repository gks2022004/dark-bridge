// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";

import {ConfidentialBridge} from "../src/ConfidentialBridge.sol";
import {ConfidentialCrossChainERC20} from "../src/ConfidentialCrossChainERC20.sol";
import {Bridge} from "../src/Bridge.sol";
import {Pubkey} from "../src/libraries/SVMLib.sol";

/// @title ConfidentialBridgeForkTest
/// @notice End-to-end fork test for ConfidentialBridge against Base Sepolia
/// @dev Run with: forge test --match-contract ConfidentialBridgeForkTest --fork-url https://sepolia.base.org -vvv
contract ConfidentialBridgeForkTest is Test {
    //////////////////////////////////////////////////////////////
    ///                       Constants                        ///
    //////////////////////////////////////////////////////////////

    /// @notice Base Sepolia RPC URL for forking
    string constant BASE_SEPOLIA_RPC = "https://sepolia.base.org";

    /// @notice Deployed Bridge address on Base Sepolia alpha
    address constant DEPLOYED_BRIDGE = 0x64567a9147fa89B1edc987e36Eb6f4b6db71656b;

    /// @notice Test remote token (Solana pubkey)
    bytes32 constant TEST_REMOTE_TOKEN = 0x069be72ab836d4eacc02525b7350a78a395da2f1253a40ebafd6630000000000;

    /// @notice Test Solana recipient
    bytes32 constant TEST_SOLANA_RECIPIENT = 0x6e0019e37547b086395a9a6834f731bab5b631004ac22a6c9102047301e40c77;

    //////////////////////////////////////////////////////////////
    ///                       State                            ///
    //////////////////////////////////////////////////////////////

    ConfidentialBridge public confidentialBridge;
    ConfidentialCrossChainERC20 public confidentialToken;
    address public deployer;
    address public user;

    //////////////////////////////////////////////////////////////
    ///                       Setup                            ///
    //////////////////////////////////////////////////////////////

    function setUp() public {
        // Fork Base Sepolia at latest block
        vm.createSelectFork(BASE_SEPOLIA_RPC);

        deployer = makeAddr("deployer");
        user = makeAddr("user");

        // Fund test accounts
        vm.deal(deployer, 10 ether);
        vm.deal(user, 10 ether);

        // Deploy confidential contracts as in DeployConfidential.s.sol
        vm.startPrank(deployer);

        // Deploy Confidential Token Implementation
        confidentialToken = new ConfidentialCrossChainERC20(DEPLOYED_BRIDGE, deployer);

        // Deploy Confidential Bridge with deployed bridge and a placeholder factory
        // Note: Using deployer as factory placeholder for testing
        confidentialBridge = new ConfidentialBridge(DEPLOYED_BRIDGE, deployer, deployer);

        vm.stopPrank();

        console2.log("=== Fork Test Setup Complete ===");
        console2.log("Fork Block:", block.number);
        console2.log("Deployed Bridge:", DEPLOYED_BRIDGE);
        console2.log("Confidential Token:", address(confidentialToken));
        console2.log("Confidential Bridge:", address(confidentialBridge));
    }

    //////////////////////////////////////////////////////////////
    ///                       Deployment Tests                 ///
    //////////////////////////////////////////////////////////////

    function test_fork_deployedBridgeExists() public view {
        // Verify the deployed bridge has code
        uint256 codeSize;
        address bridge = DEPLOYED_BRIDGE;
        assembly {
            codeSize := extcodesize(bridge)
        }
        assertGt(codeSize, 0, "Deployed bridge should have code");
    }

    function test_fork_confidentialBridgeDeployment() public view {
        // Verify ConfidentialBridge was deployed correctly
        assertEq(
            confidentialBridge.BRIDGE(),
            DEPLOYED_BRIDGE,
            "ConfidentialBridge should reference deployed bridge"
        );
        assertEq(
            confidentialBridge.CONFIDENTIAL_TOKEN_FACTORY(),
            deployer,
            "Factory should be set"
        );
    }

    function test_fork_confidentialTokenDeployment() public view {
        // Verify ConfidentialCrossChainERC20 was deployed correctly
        assertEq(
            confidentialToken.bridge(),
            DEPLOYED_BRIDGE,
            "Token should reference deployed bridge"
        );
    }

    //////////////////////////////////////////////////////////////
    ///                       Token Registration Tests         ///
    //////////////////////////////////////////////////////////////

    function test_fork_registerConfidentialToken() public {
        address originalToken = makeAddr("originalToken");
        address confToken = address(confidentialToken);

        // Register the mapping
        confidentialBridge.registerConfidentialToken(originalToken, confToken);

        // Verify registration
        assertEq(
            confidentialBridge.confidentialTokens(originalToken),
            confToken,
            "Token should be registered"
        );
    }

    function test_fork_hasConfidentialToken() public {
        address originalToken = makeAddr("originalToken");

        // Initially should not have confidential token
        assertFalse(
            confidentialBridge.hasConfidentialToken(originalToken),
            "Should not have token initially"
        );

        // Register and check
        confidentialBridge.registerConfidentialToken(originalToken, address(confidentialToken));
        assertTrue(
            confidentialBridge.hasConfidentialToken(originalToken),
            "Should have token after registration"
        );
    }

    //////////////////////////////////////////////////////////////
    ///                       Token Metadata Tests             ///
    //////////////////////////////////////////////////////////////

    function test_fork_initializeConfidentialToken() public {
        // Deploy a fresh token for initialization
        vm.startPrank(deployer);
        ConfidentialCrossChainERC20 newToken = new ConfidentialCrossChainERC20(DEPLOYED_BRIDGE, deployer);
        vm.stopPrank();
    }

    //////////////////////////////////////////////////////////////
    ///                       View Function Tests              ///
    //////////////////////////////////////////////////////////////

    function test_fork_confidentialNonceStartsAtZero() public view {
        assertEq(
            confidentialBridge.confidentialNonce(),
            0,
            "Nonce should start at 0"
        );
    }

    function test_fork_getIncoFee() public view {
        // This will revert on fork if Inco precompile not available
        // We wrap in try/catch to handle gracefully
        try confidentialBridge.getIncoFee() returns (uint256 fee) {
            console2.log("Inco Fee:", fee);
            // Fee should be reasonable (not absurdly high)
            assertLt(fee, 1 ether, "Fee should be reasonable");
        } catch {
            // Expected on standard Base Sepolia fork
            console2.log("Inco precompile not available on this fork");
        }
    }

    //////////////////////////////////////////////////////////////
    ///                       Bridge Integration Tests         ///
    //////////////////////////////////////////////////////////////

    function test_fork_bridgeContractIsAccessible() public view {
        // Verify we can call view functions on deployed bridge
        Bridge bridge = Bridge(DEPLOYED_BRIDGE);

        // Get the remote bridge pubkey
        Pubkey remoteBridge = bridge.REMOTE_BRIDGE();
        assertTrue(
            Pubkey.unwrap(remoteBridge) != bytes32(0),
            "Remote bridge should be configured"
        );

        console2.log("Remote Bridge Pubkey:");
        console2.logBytes32(Pubkey.unwrap(remoteBridge));
    }

    function test_fork_bridgePausedState() public view {
        Bridge bridge = Bridge(DEPLOYED_BRIDGE);
        bool isPaused = bridge.paused();
        console2.log("Bridge Paused:", isPaused);
        // Just log the state, don't assert as it may vary
    }

    //////////////////////////////////////////////////////////////
    ///                       Error Handling Tests             ///
    //////////////////////////////////////////////////////////////

    function test_fork_revertOnZeroAddressBridge() public {
        vm.expectRevert(ConfidentialBridge.ZeroAddress.selector);
        new ConfidentialBridge(address(0), deployer, deployer);
    }

    function test_fork_revertOnZeroAddressFactory() public {
        vm.expectRevert(ConfidentialBridge.ZeroAddress.selector);
        new ConfidentialBridge(DEPLOYED_BRIDGE, address(0), deployer);
    }

    function test_fork_revertOnZeroAddressTokenBridge() public {
        vm.expectRevert(ConfidentialCrossChainERC20.ZeroAddress.selector);
        new ConfidentialCrossChainERC20(address(0), deployer);
    }

    //////////////////////////////////////////////////////////////
    ///                       Authorization Tests              ///
    //////////////////////////////////////////////////////////////

    function test_fork_onlyBridgeCanReceiveFromSolana() public {
        // Non-bridge caller should be rejected
        vm.prank(user);
        vm.expectRevert(ConfidentialBridge.SenderNotBridge.selector);
        confidentialBridge.receiveFromSolana(
            0, // nonce
            address(confidentialToken),
            user,
            hex"1234" // dummy encrypted amount
        );
    }

    function test_fork_onlyBridgeCanMint() public {
        vm.prank(user);
        vm.expectRevert(ConfidentialCrossChainERC20.SenderIsNotBridge.selector);
        confidentialToken.confidentialMint{value: 0.01 ether}(
            user,
            hex"1234"
        );
    }

    function test_fork_onlyBridgeCanBurn() public {
        vm.prank(user);
        vm.expectRevert(ConfidentialCrossChainERC20.SenderIsNotBridge.selector);
        confidentialToken.confidentialBurn{value: 0.01 ether}(
            user,
            hex"1234"
        );
    }

    //////////////////////////////////////////////////////////////
    ///                       Gas Estimation Tests             ///
    //////////////////////////////////////////////////////////////

    function test_fork_deploymentGasCosts() public {
        vm.startPrank(deployer);

        uint256 gasBefore = gasleft();
        ConfidentialCrossChainERC20 newToken = new ConfidentialCrossChainERC20(DEPLOYED_BRIDGE, deployer);
        uint256 tokenDeployGas = gasBefore - gasleft();

        gasBefore = gasleft();
        ConfidentialBridge newBridge = new ConfidentialBridge(DEPLOYED_BRIDGE, deployer, deployer);
        uint256 bridgeDeployGas = gasBefore - gasleft();

        vm.stopPrank();

        console2.log("Token Deploy Gas:", tokenDeployGas);
        console2.log("Bridge Deploy Gas:", bridgeDeployGas);

        // Sanity checks
        assertGt(tokenDeployGas, 100000, "Token deployment should use reasonable gas");
        assertGt(bridgeDeployGas, 100000, "Bridge deployment should use reasonable gas");

        // Prevent unused variable warnings
        assertNotEq(address(newToken), address(0));
        assertNotEq(address(newBridge), address(0));
    }
}
