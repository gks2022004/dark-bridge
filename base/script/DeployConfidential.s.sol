// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialCrossChainERC20} from "../src/ConfidentialCrossChainERC20.sol";
import {ConfidentialBridge} from "../src/ConfidentialBridge.sol";

/// @title DeployConfidential
/// @notice Deployment script for confidential bridge contracts on Base Sepolia.
/// @dev Run with: forge script script/DeployConfidential.s.sol --rpc-url base-sepolia --broadcast
contract DeployConfidential is Script {
    // Deployed bridge address on Base Sepolia
    address constant EXISTING_BRIDGE = 0x5CF8A12B48a221aCeD811602d0F0752CBe110fBe;
    
    // CrossChainERC20Factory address
    address constant FACTORY = 0xEeEBDDa1bfE1C0aF25A56A3beb73e495dbaE7DEB;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying confidential contracts...");
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy Confidential Bridge first (we need its address for the token)
        ConfidentialBridge confidentialBridge = new ConfidentialBridge(
            EXISTING_BRIDGE,
            FACTORY,
            deployer // owner (also gets guardian role)
        );
        console2.log("ConfidentialBridge:", address(confidentialBridge));

        // Deploy Confidential Token Implementation with the ConfidentialBridge as its bridge
        // This allows ConfidentialBridge to call confidentialBurnFromHandle
        ConfidentialCrossChainERC20 tokenImpl = new ConfidentialCrossChainERC20(
            address(confidentialBridge),
            deployer // authorized minter (relayer)
        );
        console2.log("ConfidentialCrossChainERC20 impl:", address(tokenImpl));

        vm.stopBroadcast();

        console2.log("\n=== Deployment Complete ===");
        console2.log("Token Implementation:", address(tokenImpl));
        console2.log("Confidential Bridge:", address(confidentialBridge));
        console2.log("Owner & Guardian:", deployer);
    }
}
