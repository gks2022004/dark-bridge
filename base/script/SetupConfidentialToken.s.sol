// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialCrossChainERC20} from "../src/ConfidentialCrossChainERC20.sol";
import {ConfidentialBridge} from "../src/ConfidentialBridge.sol";

/// @title SetupConfidentialToken
/// @notice Creates and registers cDARK token with an existing ConfidentialBridge.
/// @dev Uses the already-deployed ConfidentialBridge with e.allow() support.
/// 
/// Usage:
///   PRIVATE_KEY=0x... forge script script/SetupConfidentialToken.s.sol \
///     --rpc-url base-sepolia --broadcast --verify
contract SetupConfidentialToken is Script {
    // The ConfidentialBridge (with e.allow() for relayer-only decrypt)
    address constant CONFIDENTIAL_BRIDGE = 0x04423E2D4e74b8C5D17730143400ca43fC800f73;
    
    // Solana token mint for cDARK (in bytes32 format)
    // 3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V in base58
    bytes32 constant SOLANA_TOKEN_MINT = 0x223403719246903aaf8dc5029034932739e7641a28e51c89c199ab62e27d5598;

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
            CONFIDENTIAL_BRIDGE,
            deployer // authorized minter (relayer)
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
