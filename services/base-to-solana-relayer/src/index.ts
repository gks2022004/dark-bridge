/**
 * Base to Solana Relayer Service
 * 
 * Watches ConfidentialBridgeInitiated events on Base and mints tokens on Solana.
 * Uses polling with getLogs instead of websocket filters for public RPC compatibility.
 */

import {
    createPublicClient,
    http,
    parseAbi,
    type Address,
    type Log,
    decodeEventLog,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
    Connection,
    Keypair,
    PublicKey,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// Configuration
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x73055cefc13AdD067D76d6390F08E9B6Cb5f2FdF" as Address;
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const SOLANA_RPC = "https://api.devnet.solana.com";

// ABI for watching events - matches ConfidentialBridge.sol
const BRIDGE_ABI = parseAbi([
    "event ConfidentialBridgeInitiated(uint256 indexed nonce, address indexed localToken, bytes32 indexed remoteToken, bytes32 toSolana, bytes32 encryptedAmount)",
]);

// Load Solana keypair for signing
const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
let solanaWallet: Keypair;
try {
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    solanaWallet = Keypair.fromSecretKey(new Uint8Array(keypairData));
} catch (e) {
    console.error("Failed to load Solana keypair from", keypairPath);
    process.exit(1);
}

// Viem client
const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// Solana connection
const connection = new Connection(SOLANA_RPC, "confirmed");

// Track processed events to avoid duplicates
const processedTxHashes = new Set<string>();
let lastBlockNumber = 0n;

async function processEvent(log: Log) {
    const txHash = log.transactionHash;
    if (!txHash || processedTxHashes.has(txHash)) return;
    processedTxHashes.add(txHash);

    console.log(`\n[${new Date().toISOString()}] ConfidentialBridgeInitiated event detected`);
    console.log(`  Block: ${log.blockNumber}`);
    console.log(`  TX: ${txHash}`);
    console.log(`  Topics: ${log.topics.join(", ")}`);

    // Decode the indexed parameters
    // topic[0] = event signature
    // topic[1] = nonce (indexed)
    // topic[2] = localToken (indexed)
    // topic[3] = remoteToken (indexed)
    const nonce = log.topics[1];
    const localToken = log.topics[2];
    const remoteToken = log.topics[3];

    console.log(`  Nonce: ${nonce}`);
    console.log(`  LocalToken: ${localToken}`);
    console.log(`  RemoteToken: ${remoteToken}`);

    // Parse non-indexed data (toSolana, encryptedAmount)
    const data = log.data;
    if (data && data.length >= 130) {
        const toSolana = "0x" + data.slice(2, 66);
        const encryptedAmount = "0x" + data.slice(66, 130);

        // Convert toSolana bytes32 to Solana pubkey
        try {
            const pubkeyBuffer = Buffer.from(toSolana.slice(2), "hex");
            const destinationPubkey = new PublicKey(pubkeyBuffer);

            console.log(`  Destination Solana: ${destinationPubkey.toBase58()}`);
            console.log(`  Encrypted Amount Handle: ${encryptedAmount.slice(0, 20)}...`);
            console.log(`  Status: PENDING - Would mint tokens on Solana`);

            // TODO: Call Solana program to mint tokens
            // This requires decrypting the amount via Inco TEE attestedDecrypt (relayer has e.allow() access)
            // Then re-encrypting for Solana TEE and calling the bridge program

        } catch (e) {
            console.error(`  Error parsing destination:`, e);
        }
    } else {
        console.log(`  Data: ${data}`);
    }
}

async function pollEvents() {
    try {
        const currentBlock = await publicClient.getBlockNumber();

        if (lastBlockNumber === 0n) {
            // Start from 500 blocks ago on first run to catch recent events
            lastBlockNumber = currentBlock - 500n;
            console.log(`  Starting from block ${lastBlockNumber}`);
        }

        if (currentBlock <= lastBlockNumber) return;

        // Fetch logs in chunks to avoid RPC limits
        const fromBlock = lastBlockNumber + 1n;
        const toBlock = currentBlock;

        const logs = await publicClient.getLogs({
            address: CONFIDENTIAL_BRIDGE_ADDRESS,
            events: BRIDGE_ABI,
            fromBlock,
            toBlock,
        });

        if (logs.length > 0) {
            console.log(`  Found ${logs.length} events from blocks ${fromBlock} - ${toBlock}`);
        }

        for (const log of logs) {
            await processEvent(log);
        }

        lastBlockNumber = currentBlock;
    } catch (error) {
        console.error("Poll error:", error);
    }
}

async function startWatching() {
    console.log("=======================================================");
    console.log(" Base to Solana Relayer");
    console.log("=======================================================");
    console.log(`Bridge: ${CONFIDENTIAL_BRIDGE_ADDRESS}`);
    console.log(`Program: ${BRIDGE_PROGRAM_ID.toBase58()}`);
    console.log(`Relayer: ${solanaWallet.publicKey.toBase58()}`);
    console.log("");
    console.log("Polling for ConfidentialBridgeInitiated events...");
    console.log("");

    // Initial poll
    await pollEvents();

    // Poll every 5 seconds
    setInterval(async () => {
        await pollEvents();
    }, 5000);

    // Heartbeat every minute
    setInterval(() => {
        console.log(`[${new Date().toISOString()}] Relayer running, last block: ${lastBlockNumber}`);
    }, 60000);

    // Keep process running
    process.on("SIGINT", () => {
        console.log("\nShutting down...");
        process.exit(0);
    });
}

startWatching().catch((err) => {
    console.error("Failed to start relayer:", err);
    process.exit(1);
});
