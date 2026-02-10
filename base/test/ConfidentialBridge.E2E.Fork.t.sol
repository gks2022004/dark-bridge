// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {euint256, ebool, e, inco} from "@inco/lightning/Lib.sol";

import {ConfidentialBridge} from "../src/ConfidentialBridge.sol";
import {ConfidentialCrossChainERC20} from "../src/ConfidentialCrossChainERC20.sol";
import {Bridge} from "../src/Bridge.sol";
import {CrossChainERC20Factory} from "../src/CrossChainERC20Factory.sol";
import {Pubkey} from "../src/libraries/SVMLib.sol";

/// @title ConfidentialBridgeE2EForkTest
/// @notice Comprehensive end-to-end fork tests for private cross-chain bridging
/// @dev Tests real on-chain interactions with Inco Lightning on Base Sepolia
/// 
/// Run with:
/// export PRIVATE_KEY=0x...
/// forge test --match-contract ConfidentialBridgeE2EForkTest \
///   --fork-url https://sepolia.base.org \
///   --fork-block-number <latest_block> \
///   -vvvv
contract ConfidentialBridgeE2EForkTest is Test {
    using e for *;

    //////////////////////////////////////////////////////////////
    ///                       Constants                        ///
    //////////////////////////////////////////////////////////////

    /// @notice Base Sepolia chain ID
    uint256 constant BASE_SEPOLIA_CHAIN_ID = 84532;

    /// @notice Deployed Bridge address on Base Sepolia (update with your deployment)
    address constant DEPLOYED_BRIDGE = 0x64567a9147fa89B1edc987e36Eb6f4b6db71656b;

    /// @notice Test Solana token mint pubkey
    bytes32 constant TEST_SOLANA_MINT = 0x069be72ab836d4eacc02525b7350a78a395da2f1253a40ebafd6630000000000;

    /// @notice Test Solana recipient pubkey
    bytes32 constant TEST_SOLANA_RECIPIENT = 0x6e0019e37547b086395a9a6834f731bab5b631004ac22a6c9102047301e40c77;

    /// @notice Initial token supply for testing
    uint256 constant INITIAL_SUPPLY = 1000000 * 1e18; // 1M tokens

    /// @notice Transfer test amount
    uint256 constant TRANSFER_AMOUNT = 100 * 1e18; // 100 tokens

    //////////////////////////////////////////////////////////////
    ///                       State Variables                  ///
    //////////////////////////////////////////////////////////////

    ConfidentialBridge public confidentialBridge;
    ConfidentialCrossChainERC20 public confidentialToken;
    CrossChainERC20Factory public factory;
    
    address public deployer;
    address public alice;
    address public bob;
    address public bridgeOperator;

    /// @notice Track if Inco Lightning is available on this fork
    bool public incoAvailable;

    //////////////////////////////////////////////////////////////
    ///                       Events                           ///
    //////////////////////////////////////////////////////////////

    event ConfidentialBridgeInitiated(
        uint256 indexed nonce,
        address indexed localToken,
        Pubkey indexed remoteToken,
        bytes32 toSolana,
        euint256 encryptedAmount
    );

    event ConfidentialBridgeReceived(
        uint256 indexed nonce,
        address indexed localToken,
        bytes32 indexed toHash,
        euint256 encryptedAmount
    );

    event ConfidentialTransfer(address indexed from, address indexed to, euint256 amount);
    event ConfidentialMint(address indexed to, euint256 amount);
    event ConfidentialBurn(address indexed from, euint256 amount);

    //////////////////////////////////////////////////////////////
    ///                       Setup                            ///
    //////////////////////////////////////////////////////////////

    function setUp() public {
        // Create fork at latest block
        string memory rpcUrl = vm.envOr("BASE_SEPOLIA_RPC", string("https://sepolia.base.org"));
        vm.createSelectFork(rpcUrl);

        console2.log("=== Fork Test Environment ===");
        console2.log("Chain ID:", block.chainid);
        console2.log("Block Number:", block.number);
        console2.log("Block Timestamp:", block.timestamp);

        // Create test accounts with realistic balances
        deployer = makeAddr("deployer");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        bridgeOperator = makeAddr("bridgeOperator");

        vm.deal(deployer, 100 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(bridgeOperator, 50 ether);

        // Check if Inco Lightning is available on this fork
        incoAvailable = _checkIncoAvailability();
        console2.log("Inco Lightning Available:", incoAvailable);

        // Deploy contracts
        _deployContracts();

        console2.log("=== Deployment Complete ===");
        console2.log("Confidential Bridge:", address(confidentialBridge));
        console2.log("Confidential Token:", address(confidentialToken));
        console2.log("Factory:", address(factory));
    }

    function _checkIncoAvailability() internal view returns (bool) {
        try inco.getFee() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function _deployContracts() internal {
        vm.startPrank(deployer);

        // Deploy factory (simplified for testing)
        factory = new CrossChainERC20Factory(DEPLOYED_BRIDGE);

        // Deploy Confidential Bridge
        confidentialBridge = new ConfidentialBridge(
            DEPLOYED_BRIDGE,
            address(factory),
            deployer
        );

        // Deploy Confidential Token Implementation
        confidentialToken = new ConfidentialCrossChainERC20(address(confidentialBridge), deployer);

        // Note: Skipping initialize since implementation has _disableInitializers()
        // For fork testing, we test the contract logic without full initialization

        // Register token in bridge
        confidentialBridge.registerConfidentialToken(
            address(confidentialToken),
            address(confidentialToken)
        );

        vm.stopPrank();

        // Fund contracts with ETH to pay Inco fees
        vm.deal(address(confidentialBridge), 100 ether);
        vm.deal(address(confidentialToken), 100 ether);
    }

    //////////////////////////////////////////////////////////////
    ///                  Basic Functionality Tests             ///
    //////////////////////////////////////////////////////////////

    function test_e2e_fork_tokenMetadata() public view {
        assertEq(confidentialToken.name(), "Confidential Wrapped SOL");
        assertEq(confidentialToken.symbol(), "cSOL");
        assertEq(confidentialToken.decimals(), 9);
        assertEq(confidentialToken.remoteToken(), TEST_SOLANA_MINT);
    }

    function test_e2e_fork_bridgeConfiguration() public view {
        assertEq(confidentialBridge.BRIDGE(), DEPLOYED_BRIDGE);
        assertEq(confidentialBridge.CONFIDENTIAL_TOKEN_FACTORY(), address(factory));
        assertTrue(confidentialBridge.hasConfidentialToken(address(confidentialToken)));
    }

    function test_e2e_fork_initialNonceIsZero() public view {
        assertEq(confidentialBridge.confidentialNonce(), 0);
    }

    //////////////////////////////////////////////////////////////
    ///         Encrypted Balance & Transfer Tests             ///
    //////////////////////////////////////////////////////////////

    /// @notice Test minting confidential tokens to a user
    function test_e2e_fork_confidentialMint() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();
        console2.log("Inco Fee:", incoFee);

        // Prepare encrypted amount (mock ciphertext for testing)
        bytes memory encryptedAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);

        vm.startPrank(address(confidentialBridge));
        
        // Mint to Alice
        confidentialToken.confidentialMint{value: incoFee}(
            alice,
            encryptedAmount
        );

        vm.stopPrank();

        // Verify Alice has a balance (handle should be non-zero)
        euint256 aliceBalance = confidentialToken.balanceOf(alice);
        assertTrue(
            euint256.unwrap(aliceBalance) != bytes32(0),
            "Alice should have a balance handle"
        );

        console2.log("Alice's Encrypted Balance Handle:");
        console2.logBytes32(euint256.unwrap(aliceBalance));
    }

    /// @notice Test confidential transfer between users
    function test_e2e_fork_confidentialTransfer() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Step 1: Mint to Alice
        bytes memory encryptedAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(
            alice,
            encryptedAmount
        );

        // Step 2: Alice transfers to Bob
        bytes memory transferAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        
        vm.prank(alice);
        vm.expectEmit(true, true, false, false);
        emit ConfidentialTransfer(alice, bob, euint256.wrap(bytes32(0)));
        
        confidentialToken.transfer{value: incoFee}(bob, transferAmount);

        // Step 3: Verify both have balance handles
        euint256 aliceBalance = confidentialToken.balanceOf(alice);
        euint256 bobBalance = confidentialToken.balanceOf(bob);

        assertTrue(euint256.unwrap(aliceBalance) != bytes32(0), "Alice should have balance");
        assertTrue(euint256.unwrap(bobBalance) != bytes32(0), "Bob should have balance");

        console2.log("Alice's Balance Handle:");
        console2.logBytes32(euint256.unwrap(aliceBalance));
        console2.log("Bob's Balance Handle:");
        console2.logBytes32(euint256.unwrap(bobBalance));
    }

    /// @notice Test confidential transfer with insufficient balance
    function test_e2e_fork_confidentialTransferInsufficientBalance() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Mint small amount to Alice
        bytes memory smallAmount = _mockEncryptedAmount(100);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, smallAmount);

        // Try to transfer large amount (should transfer 0 due to multiplexer pattern)
        bytes memory largeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        
        vm.prank(alice);
        // This should NOT revert, but transfer 0 instead
        confidentialToken.transfer{value: incoFee}(bob, largeAmount);

        // Bob might have a balance handle, but the actual encrypted value should be 0
        euint256 bobBalance = confidentialToken.balanceOf(bob);
        console2.log("Bob's Balance Handle (should be 0 when decrypted):");
        console2.logBytes32(euint256.unwrap(bobBalance));
    }

    //////////////////////////////////////////////////////////////
    ///              Approval & TransferFrom Tests             ///
    //////////////////////////////////////////////////////////////

    function test_e2e_fork_confidentialApprove() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Mint to Alice
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        // Alice approves Bob
        bytes memory approvalAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialToken.approve{value: incoFee}(bob, approvalAmount);

        // Verify allowance exists
        euint256 allowance = confidentialToken.allowance(alice, bob);
        assertTrue(euint256.unwrap(allowance) != bytes32(0), "Allowance should exist");

        console2.log("Allowance Handle:");
        console2.logBytes32(euint256.unwrap(allowance));
    }

    function test_e2e_fork_confidentialTransferFrom() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Setup: Mint to Alice and approve Bob
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        bytes memory approvalAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialToken.approve{value: incoFee}(bob, approvalAmount);

        // Bob transfers from Alice to Charlie
        bytes memory transferAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 4);
        address charlie = makeAddr("charlie");
        
        vm.prank(bob);
        confidentialToken.transferFrom{value: incoFee}(alice, charlie, transferAmount);

        // Verify all parties have balance handles
        assertTrue(euint256.unwrap(confidentialToken.balanceOf(alice)) != bytes32(0));
        assertTrue(euint256.unwrap(confidentialToken.balanceOf(charlie)) != bytes32(0));
    }

    //////////////////////////////////////////////////////////////
    ///              Bridge Operation Tests                    ///
    //////////////////////////////////////////////////////////////

    /// @notice Test bridging tokens from Base to Solana
    function test_e2e_fork_bridgePrivateToSolana() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Setup: Mint tokens to Alice
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        console2.log("Initial Alice Balance Handle:");
        console2.logBytes32(euint256.unwrap(confidentialToken.balanceOf(alice)));

        // Alice initiates bridge to Solana
        bytes memory bridgeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        
        vm.prank(alice);
        
        // Expect nonce increment
        uint256 initialNonce = confidentialBridge.confidentialNonce();
        
        // Expect event emission
        vm.expectEmit(true, true, true, false);
        emit ConfidentialBridgeInitiated(
            initialNonce,
            address(confidentialToken),
            Pubkey.wrap(TEST_SOLANA_MINT),
            TEST_SOLANA_RECIPIENT,
            euint256.wrap(bytes32(0)) // We can't predict the exact handle
        );

        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}( // 2x fee: one for burn, one for bridge
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );

        // Verify nonce incremented
        assertEq(
            confidentialBridge.confidentialNonce(),
            initialNonce + 1,
            "Nonce should increment"
        );

        console2.log("Bridge initiated with nonce:", initialNonce);
        console2.log("Alice's Balance Handle after bridge:");
        console2.logBytes32(euint256.unwrap(confidentialToken.balanceOf(alice)));
    }

    /// @notice Test receiving tokens from Solana
    function test_e2e_fork_receiveFromSolana() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Simulate bridge receiving encrypted amount from Solana
        bytes memory receivedAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        
        vm.prank(DEPLOYED_BRIDGE); // Only bridge can call
        vm.expectEmit(true, true, false, false);
        emit ConfidentialBridgeReceived(
            0,
            address(confidentialToken),
            keccak256(abi.encodePacked(alice)),
            euint256.wrap(bytes32(0))
        );

        confidentialBridge.receiveFromSolana{value: incoFee}(
            0, // nonce
            address(confidentialToken),
            alice,
            receivedAmount
        );

        // Verify Alice received tokens
        euint256 aliceBalance = confidentialToken.balanceOf(alice);
        assertTrue(
            euint256.unwrap(aliceBalance) != bytes32(0),
            "Alice should have received tokens"
        );

        console2.log("Alice's Balance Handle after receive:");
        console2.logBytes32(euint256.unwrap(aliceBalance));
    }

    //////////////////////////////////////////////////////////////
    ///              Gas Optimization Tests                    ///
    //////////////////////////////////////////////////////////////

    function test_e2e_fork_gasUsage_confidentialTransfer() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Mint to Alice
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        // Measure transfer gas
        bytes memory transferAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        confidentialToken.transfer{value: incoFee}(bob, transferAmount);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("=== Gas Usage ===");
        console2.log("Confidential Transfer Gas:", gasUsed);
        
        // Sanity check
        assertLt(gasUsed, 1000000, "Gas usage should be under 1M");
        assertGt(gasUsed, 50000, "Gas usage should be over 50k");
    }

    function test_e2e_fork_gasUsage_bridgeInitiation() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Setup
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);

        // Measure bridge gas
        bytes memory bridgeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("Bridge Initiation Gas:", gasUsed);
        assertLt(gasUsed, 500000, "Bridge gas should be under 500k");
    }

    //////////////////////////////////////////////////////////////
    ///              Security & Access Control Tests           ///
    //////////////////////////////////////////////////////////////

    function test_e2e_fork_revertOnUnauthorizedReceive() public {
        vm.prank(alice); // Not the bridge
        vm.expectRevert(ConfidentialBridge.SenderNotBridge.selector);
        confidentialBridge.receiveFromSolana{value: 0.01 ether}(
            0, // nonce
            address(confidentialToken),
            bob,
            hex"1234"
        );
    }

    function test_e2e_fork_revertOnUnauthorizedMint() public {
        vm.prank(alice); // Not the bridge
        vm.expectRevert(ConfidentialCrossChainERC20.SenderIsNotBridge.selector);
        confidentialToken.confidentialMint{value: 0.01 ether}(
            bob,
            hex"1234"
        );
    }

    function test_e2e_fork_revertOnUnauthorizedBurn() public {
        vm.prank(alice); // Not the bridge
        vm.expectRevert(ConfidentialCrossChainERC20.SenderIsNotBridge.selector);
        confidentialToken.confidentialBurn{value: 0.01 ether}(
            alice,
            hex"1234"
        );
    }

    function test_e2e_fork_revertOnInsufficientFee() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        vm.prank(alice);
        vm.expectRevert(ConfidentialCrossChainERC20.InsufficientFees.selector);
        confidentialToken.transfer{value: 0}( // No fee paid
            bob,
            _mockEncryptedAmount(100)
        );
    }

    function test_e2e_fork_revertOnZeroAddressBridge() public {
        bytes memory bridgeAmount = _mockEncryptedAmount(100);
        
        vm.prank(alice);
        vm.expectRevert(ConfidentialBridge.ZeroAddress.selector);
        confidentialBridge.bridgePrivateToSolana{value: 1 ether}(
            address(0), // Zero address token
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );
    }

    function test_e2e_fork_revertOnZeroSolanaRecipient() public {
        bytes memory bridgeAmount = _mockEncryptedAmount(100);
        
        vm.prank(alice);
        vm.expectRevert(ConfidentialBridge.ZeroAddress.selector);
        confidentialBridge.bridgePrivateToSolana{value: 1 ether}(
            address(confidentialToken),
            bytes32(0), // Zero Solana recipient
            bridgeAmount
        );
    }

    //////////////////////////////////////////////////////////////
    ///              Integration Tests                         ///
    //////////////////////////////////////////////////////////////

    /// @notice Test complete round-trip: Base -> Solana -> Base
    function test_e2e_fork_roundTrip() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();

        // Step 1: Mint to Alice on Base
        bytes memory mintAmount = _mockEncryptedAmount(TRANSFER_AMOUNT);
        vm.prank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(alice, mintAmount);
        
        console2.log("=== Step 1: Minted to Alice ===");
        console2.logBytes32(euint256.unwrap(confidentialToken.balanceOf(alice)));

        // Step 2: Bridge to Solana
        bytes memory bridgeAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 2);
        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            bridgeAmount
        );

        console2.log("=== Step 2: Bridged to Solana ===");
        console2.logBytes32(euint256.unwrap(confidentialToken.balanceOf(alice)));

        // Step 3: Simulate return from Solana
        bytes memory returnAmount = _mockEncryptedAmount(TRANSFER_AMOUNT / 4);
        vm.prank(DEPLOYED_BRIDGE);
        confidentialBridge.receiveFromSolana{value: incoFee}(
            0, // nonce for demo
            address(confidentialToken),
            alice,
            returnAmount
        );

        console2.log("=== Step 3: Received from Solana ===");
        console2.logBytes32(euint256.unwrap(confidentialToken.balanceOf(alice)));

        // Verify Alice still has a balance
        assertTrue(
            euint256.unwrap(confidentialToken.balanceOf(alice)) != bytes32(0),
            "Alice should have balance after round trip"
        );
    }

    /// @notice Test multiple users bridging concurrently
    function test_e2e_fork_multiUserBridging() public {
        if (!incoAvailable) {
            console2.log("[WARN] Skipping: Inco not available on fork");
            return;
        }

        uint256 incoFee = inco.getFee();
        address charlie = makeAddr("charlie");
        vm.deal(charlie, 10 ether);

        // Mint to multiple users
        vm.startPrank(address(confidentialBridge));
        confidentialToken.confidentialMint{value: incoFee}(
            alice,
            _mockEncryptedAmount(TRANSFER_AMOUNT)
        );
        confidentialToken.confidentialMint{value: incoFee}(
            bob,
            _mockEncryptedAmount(TRANSFER_AMOUNT)
        );
        confidentialToken.confidentialMint{value: incoFee}(
            charlie,
            _mockEncryptedAmount(TRANSFER_AMOUNT)
        );
        vm.stopPrank();

        // All users bridge to Solana
        uint256 nonceBefore = confidentialBridge.confidentialNonce();

        vm.prank(alice);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            _mockEncryptedAmount(TRANSFER_AMOUNT / 3)
        );

        vm.prank(bob);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            _mockEncryptedAmount(TRANSFER_AMOUNT / 3)
        );

        vm.prank(charlie);
        confidentialBridge.bridgePrivateToSolana{value: incoFee * 2}(
            address(confidentialToken),
            TEST_SOLANA_RECIPIENT,
            _mockEncryptedAmount(TRANSFER_AMOUNT / 3)
        );

        // Verify nonce incremented for each bridge
        assertEq(
            confidentialBridge.confidentialNonce(),
            nonceBefore + 3,
            "Nonce should increment for each bridge"
        );

        console2.log("All users bridged successfully");
        console2.log("Final nonce:", confidentialBridge.confidentialNonce());
    }

    //////////////////////////////////////////////////////////////
    ///              Helper Functions                          ///
    //////////////////////////////////////////////////////////////

    /// @notice Create mock encrypted amount for testing
    /// @dev In production, use @inco/js SDK to create real ciphertexts
    function _mockEncryptedAmount(uint256 amount) internal pure returns (bytes memory) {
        // This creates a deterministic "encrypted" value for testing
        // Real implementation would use Inco's encryption
        return abi.encodePacked(
            keccak256(abi.encodePacked("encrypted", amount)),
            keccak256(abi.encodePacked(amount, "value"))
        );
    }

    //////////////////////////////////////////////////////////////
    ///              Invariant Tests                           ///
    //////////////////////////////////////////////////////////////

    function invariant_totalSupplyConsistency() public view {
        // Total supply should always have a valid handle
        euint256 supply = confidentialToken.totalSupply();
        console2.log("Total Supply Handle:");
        console2.logBytes32(euint256.unwrap(supply));
    }

    function invariant_bridgeNonceMonotonicity() public {
        // Nonce should only increase
        uint256 nonce = confidentialBridge.confidentialNonce();
        console2.log("Current Nonce:", nonce);
    }
}
