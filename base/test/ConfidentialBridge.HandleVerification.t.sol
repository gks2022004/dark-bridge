// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {euint256, ebool, e, inco} from "@inco/lightning/Lib.sol";

import {ConfidentialBridge} from "../src/ConfidentialBridge.sol";
import {ConfidentialCrossChainERC20} from "../src/ConfidentialCrossChainERC20.sol";
import {CrossChainERC20Factory} from "../src/CrossChainERC20Factory.sol";
import {Pubkey} from "../src/libraries/SVMLib.sol";

/// @title ConfidentialBridgeHandleVerificationTest
/// @notice Fork tests specifically for handle verification security
/// @dev Tests the critical security feature that prevents handle swapping attacks
contract ConfidentialBridgeHandleVerificationTest is Test {
    using e for *;

    //////////////////////////////////////////////////////////////
    ///                       Constants                        ///
    //////////////////////////////////////////////////////////////

    address constant DEPLOYED_BRIDGE = 0x64567a9147fa89B1edc987e36Eb6f4b6db71656b;
    bytes32 constant TEST_SOLANA_MINT = 0x069be72ab836d4eacc02525b7350a78a395da2f1253a40ebafd6630000000000;
    bytes32 constant TEST_SOLANA_RECIPIENT = 0x6e0019e37547b086395a9a6834f731bab5b631004ac22a6c9102047301e40c77;
    uint256 constant TRANSFER_AMOUNT = 100 * 1e18;

    //////////////////////////////////////////////////////////////
    ///                       State                            ///
    //////////////////////////////////////////////////////////////

    ConfidentialBridge public confidentialBridge;
    ConfidentialCrossChainERC20 public confidentialToken;
    CrossChainERC20Factory public factory;
    
    address public deployer;
    address public alice;
    address public bob;
    address public attacker;

    bool public incoAvailable;

    //////////////////////////////////////////////////////////////
    ///                       Setup                            ///
    //////////////////////////////////////////////////////////////

    function setUp() public {
        string memory rpcUrl = vm.envOr("BASE_SEPOLIA_RPC", string("https://sepolia.base.org"));
        vm.createSelectFork(rpcUrl);

        deployer = makeAddr("deployer");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        attacker = makeAddr("attacker");

        vm.deal(deployer, 100 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(attacker, 10 ether);

        incoAvailable = _checkIncoAvailability();

        vm.startPrank(deployer);
        factory = new CrossChainERC20Factory(DEPLOYED_BRIDGE);
        confidentialBridge = new ConfidentialBridge(DEPLOYED_BRIDGE, address(factory), deployer);
        confidentialToken = new ConfidentialCrossChainERC20(address(confidentialBridge), deployer);
        
        // Note: Skipping initialize since implementation has _disableInitializers()
        // For testing bridge functions, we don't need full initialization
        
        confidentialBridge.registerConfidentialToken(
            address(confidentialToken),
            address(confidentialToken)
        );
        vm.stopPrank();

        // Fund contracts with ETH to pay Inco fees
        vm.deal(address(confidentialBridge), 50 ether);
        vm.deal(address(confidentialToken), 50 ether);
        vm.deal(DEPLOYED_BRIDGE, 50 ether); // Fund the deployed bridge for prank calls

        console2.log("=== Handle Verification Test Setup ===");
        console2.log("Inco Available:", incoAvailable);
        console2.log("Bridge:", address(confidentialBridge));
        console2.log("Token:", address(confidentialToken));
    }

    function _checkIncoAvailability() internal view returns (bool) {
        try inco.getFee() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function _mockEncryptedAmount(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(
            keccak256(abi.encodePacked("encrypted", amount)),
            keccak256(abi.encodePacked(amount, "value"))
        );
    }

    //////////////////////////////////////////////////////////////
    ///              Handle Verification Tests                 ///
    //////////////////////////////////////////////////////////////

    /// @notice Test that expectedHandles mapping is populated correctly
    function test_handleVerification_expectedHandleStored() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Mint to Alice
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        // Bridge to Solana
        bytes memory bridgeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );

        // Verify expected handle was stored
        uint256 nonce = confidentialBridge.confidentialNonce() - 1;
        bytes32 expectedHandle = confidentialBridge.getExpectedHandle(nonce);
        
        assertTrue(expectedHandle != bytes32(0), "Expected handle should be stored");
        console2.log("Stored Expected Handle:");
        console2.logBytes32(expectedHandle);
    }

    /// @notice Test successful receive with correct handle
    function test_handleVerification_correctHandleAccepted() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Setup: Mint and bridge
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        bytes memory bridgeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );

        uint256 nonce = confidentialBridge.confidentialNonce() - 1;
        
        // Simulate receiving the SAME amount back from Solana
        vm.prank(DEPLOYED_BRIDGE);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            nonce,
            address(confidentialToken),
            bob,
            bridgeAmount // Same encrypted amount
        );

        // Verify Bob received tokens
        euint256 bobBalance = confidentialToken.balanceOf(bob);
        assertTrue(euint256.unwrap(bobBalance) != bytes32(0), "Bob should have received tokens");
        
        console2.log("[OK] Correct handle accepted");
    }

    /// @notice Test that wrong handle is rejected (CRITICAL SECURITY TEST)
    function test_handleVerification_wrongHandleRejected() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Setup: Mint and bridge
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        bytes memory bridgeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );

        uint256 nonce = confidentialBridge.confidentialNonce() - 1;
        
        // Attacker tries to receive with DIFFERENT encrypted amount (wrong handle)
        bytes memory maliciousAmount = _mockEncryptedAmount(TRANSFER_AMOUNT * 100); // Different amount!
        
        vm.prank(DEPLOYED_BRIDGE);
        vm.expectRevert(ConfidentialBridge.HandleMismatch.selector);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            nonce,
            address(confidentialToken),
            attacker,
            maliciousAmount // Wrong encrypted amount - should revert
        );

        console2.log("[OK] Handle swapping attack prevented");
    }

    /// @notice Test that invalid nonce is rejected
    function test_handleVerification_invalidNonceRejected() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();
        bytes memory amount = _mockEncryptedAmount(TRANSFER_AMOUNT);

        // Try to receive with invalid nonce (9999)
        vm.prank(DEPLOYED_BRIDGE);
        vm.expectRevert(ConfidentialBridge.InvalidNonce.selector);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            9999,
            address(confidentialToken),
            bob,
            amount
        );

        console2.log("[OK] Invalid nonce rejected");
    }

    /// @notice Test that nonce cannot be reused (replay attack prevention)
    function test_handleVerification_nonceCannotBeReused() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Setup: Mint and bridge
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        bytes memory bridgeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );

        uint256 nonce = confidentialBridge.confidentialNonce() - 1;
        
        // First receive - should succeed
        vm.prank(DEPLOYED_BRIDGE);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            nonce,
            address(confidentialToken),
            bob,
            bridgeAmount
        );

        // Try to reuse the same nonce - should fail
        vm.prank(DEPLOYED_BRIDGE);
        vm.expectRevert(ConfidentialBridge.InvalidNonce.selector);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            nonce,
            address(confidentialToken),
            attacker, // Attacker tries to replay
            bridgeAmount
        );

        console2.log("[OK] Replay attack prevented");
    }

    /// @notice Test expected handle is cleared after successful receive
    function test_handleVerification_handleClearedAfterReceive() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Setup: Mint and bridge
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        bytes memory bridgeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );

        uint256 nonce = confidentialBridge.confidentialNonce() - 1;
        
        // Verify handle exists before receive
        bytes32 handleBefore = confidentialBridge.getExpectedHandle(nonce);
        assertTrue(handleBefore != bytes32(0), "Handle should exist before receive");
        
        // Receive
        vm.prank(DEPLOYED_BRIDGE);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            nonce,
            address(confidentialToken),
            bob,
            bridgeAmount
        );

        // Verify handle is cleared after receive
        bytes32 handleAfter = confidentialBridge.getExpectedHandle(nonce);
        assertEq(handleAfter, bytes32(0), "Handle should be cleared after receive");
        
        console2.log("[OK] Handle properly cleared");
    }

    /// @notice Test multiple bridges with different handles
    function test_handleVerification_multipleBridgesTracked() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Mint to both Alice and Bob
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(
            alice,
            _mockEncryptedAmount(TRANSFER_AMOUNT)
        );
        
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(
            bob,
            _mockEncryptedAmount(TRANSFER_AMOUNT)
        );

        // Alice bridges amount A
        bytes memory amountA = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            amountA
        );
        uint256 nonceA = confidentialBridge.confidentialNonce() - 1;
        bytes32 handleA = confidentialBridge.getExpectedHandle(nonceA);

        // Bob bridges amount B (different)
        bytes memory amountB = _mockEncryptedAmount(TRANSFER_AMOUNT / 3);
        vm.prank(bob);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            amountB
        );
        uint256 nonceB = confidentialBridge.confidentialNonce() - 1;
        bytes32 handleB = confidentialBridge.getExpectedHandle(nonceB);

        // Verify different handles stored
        assertTrue(handleA != handleB, "Different amounts should have different handles");

        // Receive Alice's amount with Alice's nonce - should succeed
        vm.prank(DEPLOYED_BRIDGE);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            nonceA,
            address(confidentialToken),
            alice,
            amountA
        );

        // Try to receive Alice's amount with Bob's nonce - should fail
        vm.prank(DEPLOYED_BRIDGE);
        vm.expectRevert(ConfidentialBridge.HandleMismatch.selector);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            nonceB,
            address(confidentialToken),
            bob,
            amountA // Wrong amount for Bob's nonce
        );

        console2.log("[OK] Multiple bridges tracked correctly");
    }

    /// @notice Test legacy function still works (but is less secure)
    function test_handleVerification_legacyFunctionWorks() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();
        bytes memory amount = _mockEncryptedAmount(TRANSFER_AMOUNT);

        // Legacy function should still work (for backward compatibility)
        vm.prank(DEPLOYED_BRIDGE);
        confidentialBridge.receiveFromSolanaLegacy{value: incoFee}(
            address(confidentialToken),
            bob,
            amount
        );

        // Verify Bob received tokens
        euint256 bobBalance = confidentialToken.balanceOf(bob);
        assertTrue(euint256.unwrap(bobBalance) != bytes32(0), "Bob should have received tokens");
        
        console2.log("[WARN] Legacy function works but lacks handle verification");
    }

    //////////////////////////////////////////////////////////////
    ///              Security Scenario Tests                   ///
    //////////////////////////////////////////////////////////////

    /// @notice Test sophisticated attack: Attacker intercepts and modifies amount
    function test_handleVerification_interceptAndModifyAttack() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Alice legitimately bridges 100 tokens
        bytes memory legitimateAmount = _mockEncryptedAmount(100 * 1e18);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, legitimateAmount);
        
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            legitimateAmount
        );
        uint256 nonce = confidentialBridge.confidentialNonce() - 1;

        // Attacker intercepts and tries to substitute with 1,000,000 tokens
        bytes memory maliciousAmount = _mockEncryptedAmount(1_000_000 * 1e18);
        
        // Attack should fail due to handle mismatch
        vm.prank(DEPLOYED_BRIDGE);
        vm.expectRevert(ConfidentialBridge.HandleMismatch.selector);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            nonce,
            address(confidentialToken),
            attacker,
            maliciousAmount
        );

        console2.log("[OK] Amount modification attack prevented");
    }

    /// @notice Test attack: Use handle from different bridge transaction
    function test_handleVerification_crossTransactionHandleSwap() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Alice bridges small amount
        bytes memory smallAmount = _mockEncryptedAmount(10 * 1e18);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, smallAmount);
        
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            smallAmount
        );
        uint256 smallNonce = confidentialBridge.confidentialNonce() - 1;

        // Bob bridges large amount
        bytes memory largeAmount = _mockEncryptedAmount(1000 * 1e18);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(bob, largeAmount);
        
        vm.prank(bob);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            largeAmount
        );
        uint256 largeNonce = confidentialBridge.confidentialNonce() - 1;

        // Attacker tries to use Bob's large amount with Alice's nonce
        vm.prank(DEPLOYED_BRIDGE);
        vm.expectRevert(ConfidentialBridge.HandleMismatch.selector);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            smallNonce,
            address(confidentialToken),
            attacker,
            largeAmount // Bob's large amount with Alice's nonce
        );

        console2.log("[OK] Cross-transaction handle swap prevented");
    }
}
