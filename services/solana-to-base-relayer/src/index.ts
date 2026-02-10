/**
 * Solana to Base Relayer Service
 * 
 * Watches Solana bridge events and mints confidential tokens on Base using Inco TEE.
 * 
 * Flow:
 * 1. Watch for ConfidentialBridgeOutEvent on Solana
 * 2. Extract encrypted amount handle and destination EVM address
 * 3. Use Inco TEE attestedDecrypt to get plaintext amount
 * 4. Re-encrypt amount for Base EVM using Inco SDK
 * 5. Call receiveFromSolana on Base to mint tokens
 */

import {
    createWalletClient,
    createPublicClient,
    http,
    parseAbi,
    type Address,
    toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey } from "@solana/web3.js";
import { Lightning, supportedChains } from "@inco/js";
import type { WalletClient } from "viem";

// Configuration
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x04423E2D4e74b8C5D17730143400ca43fC800f73" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xeC7f5bDafE9934658d717E9a13Ae4259858b5F0b" as Address;
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const SOLANA_RPC = "https://api.devnet.solana.com";

// Environment
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Bridge ABI - includes receiveFromSolana functions
const BRIDGE_ABI = parseAbi([
    "function receiveFromSolana(uint256 nonce, address localToken, address to, bytes encryptedAmount) external payable",
    "function getIncoFee() external view returns (uint256)",
    "event ConfidentialBridgeReceived(uint256 indexed nonce, address indexed localToken, bytes32 indexed toHash, bytes32 encryptedAmount)",
]);

// Viem clients
const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const walletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// Solana connection
const connection = new Connection(SOLANA_RPC, "confirmed");

// Inco Lightning client for TEE operations
let incoClient: Awaited<ReturnType<typeof Lightning.latest>> | null = null;

// Track processed signatures to avoid duplicates
const processedSignatures = new Set<string>();

/**
 * Initialize Inco Lightning client for TEE operations
 */
async function initIncoClient() {
    try {
        console.log("Initializing Inco Lightning client...");
        incoClient = await Lightning.latest("devnet", supportedChains.baseSepolia);
        console.log("✅ Inco client initialized");
    } catch (error) {
        console.error("Failed to initialize Inco client:", error);
        throw error;
    }
}

/**
 * Parse ConfidentialBridgeOutEvent from Solana transaction logs
 */
function parseConfidentialBridgeOutEvent(logs: string[] | null): {
    vault: string;
    owner: string;
    destination_evm: string;
    encrypted_amount_handle: bigint;
} | null {
    if (!logs) return null;

    // Look for "Program data: " prefix from Anchor events
    const eventPrefix = "Program data: ";
    const eventLog = logs.find(log => log.includes(eventPrefix));
    
    if (!eventLog) return null;

    try {
        // Extract base64 event data after "Program data: "
        const dataStart = eventLog.indexOf(eventPrefix) + eventPrefix.length;
        const base64Data = eventLog.slice(dataStart).trim();
        const eventData = Buffer.from(base64Data, "base64");

        // Anchor event discriminator is first 8 bytes
        // Then follows the event fields based on struct definition
        // ConfidentialBridgeOutEvent {
        //   vault: Pubkey,        // 32 bytes
        //   owner: Pubkey,        // 32 bytes
        //   destination_evm: [u8; 20],  // 20 bytes
        //   encrypted_amount_handle: u128,  // 16 bytes
        // }
        
        if (eventData.length < 8 + 32 + 32 + 20 + 16) {
            return null;
        }

        let offset = 8; // Skip discriminator

        // Parse vault (32 bytes)
        const vault = new PublicKey(eventData.slice(offset, offset + 32)).toBase58();
        offset += 32;

        // Parse owner (32 bytes)
        const owner = new PublicKey(eventData.slice(offset, offset + 32)).toBase58();
        offset += 32;

        // Parse destination_evm (20 bytes)
        const destination_evm = "0x" + eventData.slice(offset, offset + 20).toString("hex");
        offset += 20;

        // Parse encrypted_amount_handle (16 bytes as u128 little-endian)
        const handleBytes = eventData.slice(offset, offset + 16);
        const encrypted_amount_handle = handleBytes.readBigUInt64LE(0) + 
            (handleBytes.readBigUInt64LE(8) << 64n);

        return {
            vault,
            owner,
            destination_evm,
            encrypted_amount_handle,
        };
    } catch (error) {
        console.error("  Error parsing event data:", error);
        return null;
    }
}

/**
 * Process a Solana transaction and relay to Base if it's a bridge event
 */
async function processTransaction(signature: string) {
    if (processedSignatures.has(signature)) return;
    processedSignatures.add(signature);

    console.log(`\n[${new Date().toISOString()}] Processing Solana TX: ${signature}`);

    try {
        const tx = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
            console.error("  ❌ Transaction not found");
            return;
        }

        // Check if this is a bridge program transaction
        const programIndex = tx.transaction.message.staticAccountKeys.findIndex(
            (key) => key.equals(BRIDGE_PROGRAM_ID)
        );

        if (programIndex === -1) {
            return; // Not our program, skip silently
        }

        console.log("  ✅ Bridge transaction detected");
        console.log(`  📦 Slot: ${tx.slot}`);

        // Parse ConfidentialBridgeOutEvent from logs
        const event = parseConfidentialBridgeOutEvent(tx.meta?.logMessages || null);
        
        if (!event) {
            console.log("  ⚠️  No ConfidentialBridgeOutEvent found");
            return;
        }

        console.log(`  👤 Owner: ${event.owner}`);
        console.log(`  💼 Vault: ${event.vault}`);
        console.log(`  🎯 Destination EVM: ${event.destination_evm}`);
        console.log(`  🔐 Encrypted Handle: ${event.encrypted_amount_handle.toString()}`);

        // Relay to Base
        await relayToBase(event.destination_evm, event.encrypted_amount_handle);

    } catch (error) {
        console.error("  ❌ Error processing transaction:", error);
    }
}

/**
 * Relay the bridge transaction to Base EVM
 * Uses faucetMint on the token contract (publicly callable) with Inco-encrypted ciphertext.
 */
async function relayToBase(destinationAddress: string, encryptedHandle: bigint) {
    if (!incoClient) {
        console.error("  ❌ Inco client not initialized");
        return;
    }

    try {
        console.log("  🔄 Relaying to Base...");

        // The handle is a Solana Inco handle — the relayer cannot decrypt it directly.
        // For the Solana→Base relay, the frontend should POST the decrypted plaintext
        // to the relayer server's /relay-to-base endpoint instead.
        // 
        // This monitor can still detect events and log them, but the actual minting
        // should be triggered by the frontend after the user calls attested decrypt.
        console.log(`  ⚠️ Auto-relay from monitor is disabled for privacy.`);
        console.log(`  ⚠️ Use the /relay-to-base endpoint on the relayer server instead.`);
        console.log(`  ⚠️ The user must call Solana attested decrypt first, then POST plaintext.`);
        console.log(`  📋 Handle: ${encryptedHandle}`);
        console.log(`  📋 Destination: ${destinationAddress}`);

    } catch (error: any) {
        console.error("  ❌ Failed to relay to Base:", error.message || error);
    }
}

/**
 * Poll for new transactions on Solana
 */
async function pollForTransactions() {
    try {
        // Watch the bridge program's main account for transactions
        const signatures = await connection.getSignaturesForAddress(
            BRIDGE_PROGRAM_ID,
            { limit: 20 },
            "confirmed"
        );

        for (const sig of signatures) {
            await processTransaction(sig.signature);
        }
    } catch (error) {
        console.error("❌ Poll error:", error);
    }
}

/**
 * Start the relayer service
 */
async function startWatching() {
    console.log("=======================================================");
    console.log(" 🌉 Solana to Base Relayer (Inco TEE)");
    console.log("=======================================================");
    console.log(`🔗 Bridge Contract: ${CONFIDENTIAL_BRIDGE_ADDRESS}`);
    console.log(`🪙 Token Contract:  ${CONFIDENTIAL_TOKEN_ADDRESS}`);
    console.log(`📡 Solana Program:  ${BRIDGE_PROGRAM_ID.toBase58()}`);
    console.log(`🤖 Relayer Address: ${evmAccount.address}`);
    console.log(`🌐 Solana RPC:      ${SOLANA_RPC}`);
    console.log("");

    // Initialize Inco client for TEE operations
    await initIncoClient();

    console.log("👀 Watching for ConfidentialBridgeOutEvent on Solana...");
    console.log("");

    // Initial poll
    await pollForTransactions();

    // Poll every 5 seconds for new transactions
    setInterval(async () => {
        await pollForTransactions();
    }, 5000);

    // Heartbeat every minute
    setInterval(() => {
        console.log(`[${new Date().toISOString()}] 💓 Relayer running...`);
    }, 60000);

    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log("\n👋 Shutting down...");
        process.exit(0);
    });
}

startWatching().catch((err) => {
    console.error("💥 Failed to start relayer:", err);
    process.exit(1);
});
