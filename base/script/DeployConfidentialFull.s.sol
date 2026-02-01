// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialCrossChainERC20} from "../src/ConfidentialCrossChainERC20.sol";
import {ConfidentialBridge} from "../src/ConfidentialBridge.sol";

/// @title DeployConfidentialFull
/// @notice Full deployment script for confidential bridge with proper setup.
/// @dev Deploys ConfidentialBridge, cDARK token, initializes, and registers.
/// @dev Uses e.reveal() in bridgePrivateToSolana so attestedReveal works without user signature.
/// 
/// Usage:
///   PRIVATE_KEY=0x... forge script script/DeployConfidentialFull.s.sol \
///     --rpc-url base-sepolia --broadcast --verify
contract DeployConfidentialFull is Script {
    // Existing infrastructure on Base Sepolia
    address constant EXISTING_BRIDGE = 0x5CF8A12B48a221aCeD811602d0F0752CBe110fBe;
    address constant FACTORY = 0xEeEBDDa1bfE1C0aF25A56A3beb73e495dbaE7DEB;
    
    // Solana token mint for cDARK (in bytes32 format)
    // 2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH in base58
    bytes32 constant SOLANA_TOKEN_MINT = 0x1cd8d28fb7697151a7202ba6f1aee1df7b201b5bce634fe0d48e0aadc8435fde;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("=== Deploying Confidential Bridge (Full Setup with e.reveal) ===");
        console2.log("Deployer:", deployer);
        console2.log("");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy ConfidentialBridge
        console2.log("1. Deploying ConfidentialBridge...");
        ConfidentialBridge confidentialBridge = new ConfidentialBridge(
            EXISTING_BRIDGE,
            FACTORY,
            deployer // owner (also gets guardian role)
        );
        console2.log("   ConfidentialBridge:", address(confidentialBridge));

        // 2. Deploy cDARK token (ConfidentialCrossChainERC20)
        console2.log("2. Deploying cDARK token...");
        ConfidentialCrossChainERC20 cDark = new ConfidentialCrossChainERC20(
            address(confidentialBridge)
        );
        console2.log("   cDARK token:", address(cDark));

        // 3. Initialize the cDARK token
        console2.log("3. Initializing cDARK token...");
        cDark.initialize(
            SOLANA_TOKEN_MINT,  // remoteToken (Solana mint address)
            "Confidential DARK",
            "cDARK",
            18  // decimals
        );
        console2.log("   Token initialized with remoteToken:", vm.toString(SOLANA_TOKEN_MINT));

        // 4. Register the token with the bridge
        console2.log("4. Registering token with bridge...");
        confidentialBridge.registerConfidentialToken(
            address(cDark),  // localToken
            address(cDark)   // confidentialToken (same in this case)
        );
        console2.log("   Token registered");

        // NOTE: No bridgeRelayer needed! The contract now uses e.reveal() 
        // so the relayer can use attestedReveal() without user signature.

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Complete ===");
        console2.log("ConfidentialBridge:", address(confidentialBridge));
        console2.log("cDARK Token:", address(cDark));
        console2.log("Owner/Guardian:", deployer);
        console2.log("");
        console2.log("=== How It Works ===");
        console2.log("1. User calls bridgePrivateToSolana() with encrypted amount");
        console2.log("2. Contract burns tokens and calls e.reveal(amount)");
        console2.log("3. Relayer uses attestedReveal() - no user signature needed");
        console2.log("4. Relayer re-encrypts for Solana TEE and relays");
        console2.log("");
        console2.log("=== Next Steps ===");
        console2.log("1. Update frontend/src/lib/constants.ts with new addresses");
        console2.log("2. Update scripts/src/privacy-relayer-*.ts with new addresses");
        console2.log("3. Run the privacy relayer");
        console2.log("4. Test the bridge flow in frontend");
    }
}
