// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialCrossChainERC20} from "../src/ConfidentialCrossChainERC20.sol";
import {ConfidentialBridge} from "../src/ConfidentialBridge.sol";

/// @title SetupConfidentialToken
/// @notice Creates and registers cDARK token with an existing ConfidentialBridge.
/// @dev Uses the already-deployed ConfidentialBridge with e.reveal() support.
/// 
/// Usage:
///   PRIVATE_KEY=0x... forge script script/SetupConfidentialToken.s.sol \
///     --rpc-url base-sepolia --broadcast --verify
contract SetupConfidentialToken is Script {
    // The new ConfidentialBridge (with plaintext event support)
    address constant CONFIDENTIAL_BRIDGE = 0xD705858A979a4ab42e7a2e43e8CcC726Dbd87369;
    
    // Solana token mint for cDARK (in bytes32 format)
    // 2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH in base58
    bytes32 constant SOLANA_TOKEN_MINT = 0x1cd8d28fb7697151a7202ba6f1aee1df7b201b5bce634fe0d48e0aadc8435fde;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("=== Setting Up cDARK Token ===");
        console2.log("Deployer:", deployer);
        console2.log("ConfidentialBridge:", CONFIDENTIAL_BRIDGE);
        console2.log("");

        ConfidentialBridge confidentialBridge = ConfidentialBridge(payable(CONFIDENTIAL_BRIDGE));

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy cDARK token (ConfidentialCrossChainERC20)
        console2.log("1. Deploying cDARK token...");
        ConfidentialCrossChainERC20 cDark = new ConfidentialCrossChainERC20(
            CONFIDENTIAL_BRIDGE
        );
        console2.log("   cDARK token:", address(cDark));

        // 2. Initialize the cDARK token
        console2.log("2. Initializing cDARK token...");
        cDark.initialize(
            SOLANA_TOKEN_MINT,  // remoteToken (Solana mint address)
            "Confidential DARK",
            "cDARK",
            18  // decimals
        );
        console2.log("   Token initialized with remoteToken:", vm.toString(SOLANA_TOKEN_MINT));

        // 3. Register the token with the bridge
        console2.log("3. Registering token with bridge...");
        confidentialBridge.registerConfidentialToken(
            address(cDark),  // localToken
            address(cDark)   // confidentialToken (same in this case)
        );
        console2.log("   Token registered");

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Setup Complete ===");
        console2.log("cDARK Token:", address(cDark));
        console2.log("ConfidentialBridge:", CONFIDENTIAL_BRIDGE);
        console2.log("");
        console2.log("=== Update These Files ===");
        console2.log("frontend/src/lib/constants.ts:");
        console2.log("  CONFIDENTIAL_TOKEN_ADDRESS =", vm.toString(address(cDark)));
        console2.log("");
        console2.log("scripts/src/privacy-relayer-base-to-sol.ts:");
        console2.log("  CONFIDENTIAL_TOKEN_ADDRESS =", vm.toString(address(cDark)));
    }
}
