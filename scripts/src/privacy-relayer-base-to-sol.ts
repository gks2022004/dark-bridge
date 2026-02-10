#!/usr/bin/env bun
/**
 * Privacy Relayer: Base → Solana
 * 
 * Monitors ConfidentialBridgeInitiated events on Base and relays encrypted transfers to Solana.
 * This is the privacy-preserving counterpart to auto-relayer-base-sol.ts.
 * 
 * ARCHITECTURE NOTES:
 * ==================
 * attestedDecrypt requires the USER's wallet signature (EIP-712). The relayer cannot
 * call attestedDecrypt server-side — only the user (the address granted e.allow()) can.
 * 
 * CORRECT FLOW:
 * 1. User bridges on Base → TX confirmed, handle emitted
 * 2. User calls attestedDecrypt in the frontend → gets plaintext
 * 3. Frontend POSTs plaintext to relayer server (/relay endpoint)
 * 4. Relayer re-encrypts for Solana TEE and relays to Solana
 * 
 * This monitor file is a FALLBACK that can process single TX hashes if the plaintext
 * is provided via --amount flag. For the normal flow, use privacy-relayer-server.ts.
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts <BASE_TX_HASH> --amount <PLAINTEXT_WEI>
 */

// IMPORTANT: Bypass TLS certificate verification for Inco KMS in development
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import {
    createSolanaRpc,
    getProgramDerivedAddress,
    getU64Encoder,
    Endian,
    type Address as SolanaAddress,
    AccountRole,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
    createPublicClient,
    createWalletClient,
    http,
    toBytes,
    type Address,
    type Hash,
    type Hex,
    parseAbi,
    decodeEventLog,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey, Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { CONFIGS } from "@internal/constants";
import { buildAndSendTransaction, getSolanaCliConfigKeypairSigner, getIdlConstant, getSolanaWeb3Keypair } from "@internal/sol";

// Inco SDKs for cross-chain re-encryption
import { Lightning } from "@inco/js/lite";
import { encryptValue } from "@inco/solana-sdk/encryption";
import { hexToBuffer } from "@inco/solana-sdk/utils";

// Node.js modules for persistent storage
import * as fs from "fs";
import * as path from "path";

const DEPLOY_ENV = "testnet-alpha" as const;
const config = CONFIGS[DEPLOY_ENV];

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY or PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Create wallet client for attested decrypt on EVM (relayer has e.allow() access)
const evmWalletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// Initialize Inco Lightning for EVM attested decrypt
let zapInstance: any = null;
async function getZap() {
    if (!zapInstance) {
        // 'devnet' pepper matches deployed contracts on Base Sepolia
        zapInstance = await Lightning.latest('devnet', 84532);
    }
    return zapInstance;
}

// Deployed contract addresses
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x04423E2D4e74b8C5D17730143400ca43fC800f73" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xeC7f5bDafE9934658d717E9a13Ae4259858b5F0b" as Address;

// Bridge Program ID
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

// Inco Lightning Program ID
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// --- Viem Client ---
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// --- ABIs ---
const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "event ConfidentialBridgeInitiated(uint256 indexed nonce, address indexed localToken, bytes32 indexed remoteToken, bytes32 toSolanaHash, bytes32 encryptedAmount)",
]);

// Full ABI for decoding
const CONFIDENTIAL_BRIDGE_FULL_ABI = [
    {
        type: "event",
        name: "ConfidentialBridgeInitiated",
        inputs: [
            { name: "nonce", type: "uint256", indexed: true },
            { name: "localToken", type: "address", indexed: true },
            { name: "remoteToken", type: "bytes32", indexed: true },
            { name: "toSolanaHash", type: "bytes32", indexed: false },
            { name: "encryptedAmount", type: "bytes32", indexed: false },
        ],
    },
] as const;

// === TX Hash Mapping Store ===
// Maps Base TX hash -> Solana TX signature
const txHashMap: Map<string, string> = new Map();

// Persistent storage for TX hash mappings (prevents duplicate relays across restarts)
const TX_MAPPING_FILE = path.join(process.cwd(), ".relayer-tx-mappings.json");

/**
 * Load TX hash mappings from persistent storage.
 */
function loadTxMappings() {
    try {
        if (fs.existsSync(TX_MAPPING_FILE)) {
            const data = fs.readFileSync(TX_MAPPING_FILE, "utf-8");
            const mappings = JSON.parse(data);
            Object.entries(mappings).forEach(([baseTx, solTx]) => {
                txHashMap.set(baseTx.toLowerCase(), solTx as string);
            });
            console.log(`📂 Loaded ${txHashMap.size} existing TX mappings from disk`);
        }
    } catch (e: any) {
        console.warn(`⚠️  Failed to load TX mappings: ${e.message}`);
    }
}

/**
 * Save TX hash mappings to persistent storage.
 */
function saveTxMappings() {
    try {
        const mappings = Object.fromEntries(txHashMap);
        fs.writeFileSync(TX_MAPPING_FILE, JSON.stringify(mappings, null, 2));
    } catch (e: any) {
        console.error(`❌ Failed to save TX mappings: ${e.message}`);
    }
}

// Load existing mappings on startup
loadTxMappings();

// === Processed TX Deduplication ===
// Tracks Base TX hashes we've already processed to prevent duplicates
const processedTxHashes: Set<string> = new Set();

// HTTP Server to serve TX hash mappings
const HTTP_PORT = 3456;

function startHttpServer() {
    const server = Bun.serve({
        port: HTTP_PORT,
        fetch(req) {
            const url = new URL(req.url);
            
            // CORS headers
            const headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Content-Type": "application/json",
            };
            
            if (req.method === "OPTIONS") {
                return new Response(null, { headers });
            }
            
            // GET /tx/:baseTxHash - Get Solana TX for a Base TX
            if (url.pathname.startsWith("/tx/")) {
                const baseTxHash = url.pathname.slice(4).toLowerCase();
                const solanaTxHash = txHashMap.get(baseTxHash);
                
                if (solanaTxHash) {
                    return new Response(JSON.stringify({ solanaTxHash }), { headers });
                } else {
                    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
                }
            }
            
            // GET /all - List all mappings
            if (url.pathname === "/all") {
                const mappings = Object.fromEntries(txHashMap);
                return new Response(JSON.stringify(mappings), { headers });
            }
            
            return new Response(JSON.stringify({ status: "ok", mappings: txHashMap.size }), { headers });
        },
    });
    
    console.log(`📡 HTTP server running on http://localhost:${HTTP_PORT}`);
    console.log(`   Query: GET /tx/<baseTxHash> -> { solanaTxHash: "..." }`);
    return server;
}

console.log("=== Privacy Relayer (Base → Solana) ===");
console.log(`EVM Signer: ${evmAccount.address}`);
console.log(`Confidential Bridge: ${CONFIDENTIAL_BRIDGE_ADDRESS}`);

// --- Event Parsing ---
interface ConfidentialBridgeInitiatedEvent {
    nonce: bigint;
    localToken: Address;
    remoteToken: Hex;
    toSolanaHash: Hex;  // PRIVACY: keccak256(toSolana) — raw pubkey NOT on-chain
    encryptedAmount: Hex;
}

/**
 * Parse ConfidentialBridgeInitiated event from transaction receipt.
 */
function parseConfidentialBridgeInitiatedEvent(
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]
): ConfidentialBridgeInitiatedEvent | null {
    for (const log of logs) {
        if (log.address.toLowerCase() === CONFIDENTIAL_BRIDGE_ADDRESS.toLowerCase()) {
            try {
                const decoded = decodeEventLog({
                    abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                    data: log.data,
                    topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
                });

                if (decoded.eventName === "ConfidentialBridgeInitiated") {
                    const args = decoded.args as any;
                    return {
                        nonce: args.nonce,
                        localToken: args.localToken,
                        remoteToken: args.remoteToken,
                        toSolanaHash: args.toSolanaHash,
                        encryptedAmount: args.encryptedAmount,
                    };
                }
            } catch (e) {
                // Not our event
            }
        }
    }
    return null;
}

/**
 * Convert bytes32 (solana pubkey) to Solana PublicKey.
 */
function bytes32ToPublicKey(bytes32: Hex): PublicKey {
    const bytes = toBytes(bytes32);
    return new PublicKey(bytes);
}

/**
 * Send relay_receive_confidential instruction to Solana.
 * Factored out to avoid code duplication between plaintext and legacy event flows.
 * Returns the Solana signature on success, null on failure.
 * If baseTxHash is provided, stores the mapping in txHashMap.
 */
async function sendRelayConfidentialReceive(
    recipientPubkey: PublicKey,
    encryptedAmountBytes: Uint8Array,
    baseSender: Uint8Array,
    baseTxHash?: string
): Promise<string | null> {
    const config = CONFIGS["testnet-alpha"];
    const rpc = createSolanaRpc(config.solana.rpcUrl);
    const payer = await getSolanaCliConfigKeypairSigner();
    if (payer) {
        console.log(`   Solana Payer: ${payer.address}`);
    }

    // Use default token mint from config or from the token address
    // For the hackathon, we use a known token mint
    const tokenMintBytes = toBytes(("0x" + Buffer.from(CONFIDENTIAL_TOKEN_ADDRESS.slice(2).padStart(64, "0"), "hex").toString("hex")) as Hex);
    // Actually, we need the Solana token mint, not the EVM address
    // The Solana token mint should be stored somewhere or derived
    // For now, we'll use the default from the deployment
    const connection = new Connection(config.solana.rpcUrl, "confirmed");

    // Get the remote token from contract or use known deployment
    // Use the token mint that matches the user's initialized vault
    const SOLANA_TOKEN_MINT = new PublicKey("3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V");
    const tokenMint = SOLANA_TOKEN_MINT;
    console.log(`   Token Mint: ${tokenMint.toBase58()}`);

    // Hash owner with keccak256 for privacy-preserving PDA (matches Rust program)
    const { keccak256 } = await import("viem");
    const ownerHash = Buffer.from(keccak256(new Uint8Array(recipientPubkey.toBuffer())).slice(2), "hex");

    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("confidential_vault"),
            ownerHash,
            tokenMint.toBuffer(),
        ],
        BRIDGE_PROGRAM_ID
    );
    console.log(`   Vault PDA: ${vaultPda.toBase58()}`);

    // Find the bridge authority PDA
    const [bridgeAuthority, bridgeAuthBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_authority")],
        BRIDGE_PROGRAM_ID
    );
    console.log(`   Bridge Authority: ${bridgeAuthority.toBase58()}`);

    // Find the bridge state PDA
    const [bridgeState, bridgeBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge")],
        BRIDGE_PROGRAM_ID
    );
    console.log(`   Bridge State: ${bridgeState.toBase58()}`);

    // Check if vault exists
    const vaultAccountInfo = await connection.getAccountInfo(vaultPda);

    if (!vaultAccountInfo) {
        console.log(`\n   Vault does not exist for recipient!`);
        console.log(`   The recipient needs to initialize a ConfidentialVault first.`);
        console.log(`   Vault PDA: ${vaultPda.toBase58()}`);
        console.log(`   Owner: ${recipientPubkey.toBase58()}`);
        console.log(`   Token Mint: ${tokenMint.toBase58()}`);
        console.log(`\n   To initialize, call initialize_confidential_vault on Solana.`);
        return null;
    }

    // CRITICAL FIX: Check if this Base TX was already relayed to prevent duplicates
    // This is important because processedTxHashes is in-memory and gets cleared on restart
    if (baseTxHash) {
        const existingSolSig = txHashMap.get(baseTxHash.toLowerCase());
        if (existingSolSig) {
            console.log(`\n   ⚠️  Base TX already relayed!`);
            console.log(`   Base TX: ${baseTxHash}`);
            console.log(`   Solana TX: ${existingSolSig}`);
            console.log(`   Skipping to prevent duplicate relay.`);
            return existingSolSig; // Return existing signature
        }
    }

    // Build the relay_receive_confidential instruction
    const crypto = await import("crypto");
    const discriminator = crypto.createHash("sha256")
        .update("global:relay_receive_confidential")
        .digest()
        .slice(0, 8);

    // Instruction data: discriminator + encrypted_amount (Vec<u8>) + base_sender ([u8; 20])
    const encryptedLenBuf = Buffer.alloc(4);
    encryptedLenBuf.writeUInt32LE(encryptedAmountBytes.length, 0);

    const instructionData = Buffer.concat([
        discriminator,
        encryptedLenBuf,
        Buffer.from(encryptedAmountBytes),
        Buffer.from(baseSender),
    ]);

    console.log(`\n   Building relay_receive_confidential instruction:`);
    console.log(`      Discriminator: ${discriminator.toString("hex")}`);
    console.log(`      Encrypted amount: ${encryptedAmountBytes.length} bytes`);
    console.log(`      Base sender: 0x${Buffer.from(baseSender).toString("hex")}`);

    // Create instruction with accounts - use getSolanaWeb3Keypair() which handles SOLANA_PRIVATE_KEY
    const payerKeypair = getSolanaWeb3Keypair();
    console.log(`   🔑 Using Solana payer: ${payerKeypair.publicKey.toBase58()}`);

    const instruction = new TransactionInstruction({
        programId: BRIDGE_PROGRAM_ID,
        keys: [
            { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },  // relayer
            { pubkey: bridgeState, isSigner: false, isWritable: false },            // bridge
            { pubkey: bridgeAuthority, isSigner: false, isWritable: true },         // bridge_authority
            { pubkey: vaultPda, isSigner: false, isWritable: true },                // vault
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },      // inco_lightning_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data: instructionData,
    });

    console.log(`\n   Sending Solana transaction...`);

    const { Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(instruction);

    try {
        const signature = await sendAndConfirmTransaction(
            connection,
            tx,
            [payerKeypair],
            { commitment: "confirmed" }
        );

        console.log(`   Transaction confirmed!`);
        console.log(`   Signature: ${signature}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
        
        // Store the mapping if baseTxHash was provided
        if (baseTxHash) {
            txHashMap.set(baseTxHash.toLowerCase(), signature);
            saveTxMappings(); // Persist to disk immediately
            console.log(`   📋 Stored mapping: ${baseTxHash.slice(0, 20)}... -> ${signature.slice(0, 20)}...`);
        }
        
        return signature;
    } catch (txError: any) {
        console.error(`   Transaction failed: ${txError.message}`);
        if (txError.logs) {
            console.error(`   Logs:`);
            txError.logs.forEach((log: string) => console.error(`      ${log}`));
        }
        return null;
    }
}

/**
 * Cross-chain re-encrypt: decrypt EVM handle → re-encrypt for Solana TEE.
 * 
 * FLOW (using e.allow + attestedDecrypt):
 * 1. Contract calls e.allow(handle, bridgeRelayer) to grant relayer decrypt access
 * 2. Relayer uses attestedDecrypt(walletClient, [handle]) with its own wallet signature
 * 3. Re-encrypt plaintext for Solana TEE using encryptValue
 * 
 * attestedDecrypt requires the caller's wallet signature. The relayer is authorized
 * via e.allow() in the contract, so it can decrypt using its own wallet.
 * 
 * @param evmHandle - The encrypted handle (bytes32) from EVM
 * @returns Ciphertext bytes encrypted for Solana TEE
 */
async function crossChainReencrypt(evmHandle: Hex): Promise<Uint8Array> {
    console.log(`   🔐 Cross-chain re-encryption:`);
    console.log(`      EVM Handle: ${evmHandle}`);

    // Step 1: Get the Inco Lightning instance for EVM
    const zap = await getZap();
    console.log(`      Inco SDK initialized for chain ${zap.chainId}`);

    // Parse handle to understand its format
    const handleBigInt = BigInt(evmHandle);
    console.log(`      Handle as BigInt: ${handleBigInt}`);

    // Check the handle type indicator (last byte)
    const handleBytes = toBytes(evmHandle);
    const typeIndicator = handleBytes[handleBytes.length - 1];
    console.log(`      Handle type indicator: ${typeIndicator} (0 = euint256, 8 = euint128, etc)`);

    // Step 2: Attested DECRYPT using relayer's wallet (authorized via e.allow())
    console.log(`      📤 Requesting attested DECRYPT from EVM TEE...`);
    console.log(`      ℹ️ Using attestedDecrypt (relayer authorized via e.allow() in contract)`);
    console.log(`      ℹ️ Relayer address: ${evmAccount.address}`);

    // Configure retries for async handle processing
    // Inco team recommends: 1-2 second base backoff for TEE sync delays
    const backoffConfig = {
        maxRetries: 15,
        baseDelayInMs: 1500, // Start at 1.5s as recommended by Inco
        backoffFactor: 1.5,  // 1.5s -> 2.25s -> 3.4s -> 5s -> 7.5s -> 10s (capped)
    };

    try {
        // Use attestedDecrypt with relayer's wallet client
        // The relayer is granted access via e.allow(amount, bridgeRelayer) in ConfidentialBridge
        console.log(`      ⏳ Calling attestedDecrypt...`);
        console.log(`      Handle (hex): ${evmHandle}`);
        console.log(`      Handle length: ${evmHandle.length} chars`);

        // Add timeout wrapper (90s max for retries)
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('attestedDecrypt timed out after 90s')), 90000);
        });

        const decryptResults = await Promise.race([
            zap.attestedDecrypt(evmWalletClient, [evmHandle], backoffConfig),
            timeoutPromise
        ]);

        console.log(`      Raw decrypt results:`, JSON.stringify(decryptResults, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v, 2));

        if (!decryptResults || decryptResults.length === 0) {
            throw new Error(`No results from attestedDecrypt for handle: ${evmHandle}`);
        }

        // The result structure for attestedDecrypt is { plaintext: { value: bigint } }
        let plaintext: bigint;
        const result = decryptResults[0];

        if (typeof result === 'bigint') {
            plaintext = result;
        } else if (result && typeof result === 'object') {
            if ('plaintext' in result && result.plaintext !== undefined) {
                // plaintext is { value: bigint }
                const pt = result.plaintext as any;
                plaintext = BigInt(pt.value !== undefined ? pt.value : pt);
            } else if ('value' in result) {
                plaintext = BigInt((result as any).value);
            } else {
                plaintext = BigInt(result.toString());
            }
        } else {
            plaintext = BigInt(result);
        }

        console.log(`      ✅ Decrypted plaintext: ${plaintext} (${Number(plaintext) / 1e18} tokens)`);

        // Step 3: Re-encrypt for Solana TEE
        console.log(`      📥 Re-encrypting for Solana TEE...`);
        const solanaCiphertext = await encryptValue(plaintext);
        const ciphertextBytes = hexToBuffer(solanaCiphertext);

        console.log(`      ✅ Solana ciphertext: ${solanaCiphertext.slice(0, 40)}...`);
        console.log(`      ✅ Ciphertext length: ${ciphertextBytes.length} bytes`);

        return new Uint8Array(ciphertextBytes);
    } catch (decryptError: any) {
        console.error(`      ❌ Attested decrypt failed:`, decryptError.message);
        console.error(`      Full error:`, decryptError);
        console.error(`      Cause:`, JSON.stringify(decryptError.cause || {}, null, 2));

        // Check if relayer is not authorized (e.allow() not called or wrong relayer address)
        if (decryptError.message?.includes('not allowed') || decryptError.message?.includes('permission') || decryptError.message?.includes('unauthorized')) {
            console.error(`      💡 Relayer may not be authorized to decrypt this handle`);
            console.error(`      💡 Ensure ConfidentialBridge calls e.allow(amount, bridgeRelayer)`);
            console.error(`      💡 And that bridgeRelayer matches: ${evmAccount.address}`);
        }

        // Check if it's a certificate issue
        if (decryptError.message?.includes('certificate') || decryptError.message?.includes('CERT')) {
            console.error(`      💡 TLS certificate issue. NODE_TLS_REJECT_UNAUTHORIZED should be set to '0'`);
        }

        // Check if handle not found (may need time to be processed)
        if (decryptError.message?.includes('not found') || decryptError.message?.includes('pending')) {
            console.error(`      💡 Handle may still be processing. Wait and retry.`);
        }

        throw new Error(`Failed to decrypt handle: ${decryptError.message}`);
    }
}

/**
 * Relay a confidential bridge message from Base to Solana.
 * @param txHash - The Base transaction hash
 * @param plaintextAmountWei - Optional plaintext amount (provided by user via frontend or --amount flag)
 */
async function relayConfidentialToSolana(txHash: string, plaintextAmountWei?: string, toSolanaOverride?: string): Promise<boolean> {
    console.log(`\n=== Processing Base TX: ${txHash} ===`);

    try {
        // 1. Get transaction receipt
        const receipt = await basePublicClient.getTransactionReceipt({
            hash: txHash as Hash,
        });
        console.log(`   Block: ${receipt.blockNumber}`);

        // 2. Parse the encrypted event
        const bridgeEvent = parseConfidentialBridgeInitiatedEvent(receipt.logs);

        if (!bridgeEvent) {
            console.log("   No ConfidentialBridgeInitiated event found");
            return false;
        }

        console.log(`   ✅ Found ConfidentialBridgeInitiated event:`);
        console.log(`      Nonce: ${bridgeEvent.nonce}`);
        console.log(`      Local Token: ${bridgeEvent.localToken}`);
        console.log(`      To Solana Hash: ${bridgeEvent.toSolanaHash}`);
        console.log(`      EVM Handle: ${bridgeEvent.encryptedAmount}`);

        // PRIVACY: Event only has keccak256(toSolana). We need the plaintext from:
        // - CLI --to flag, or
        // - /relay endpoint (frontend sends it)
        if (!toSolanaOverride) {
            console.log(`   ❌ Cannot relay: event only has toSolanaHash (privacy).`);
            console.log(`   💡 Use: bun run src/privacy-relayer-base-to-sol.ts ${txHash} --amount <WEI> --to <SOLANA_PUBKEY>`);
            console.log(`   💡 Or use privacy-relayer-server.ts with the /relay endpoint.`);
            return false;
        }

        const recipientPubkey = new PublicKey(toSolanaOverride);
        const baseSender = toBytes(evmAccount.address).slice(0, 20);
        console.log(`   Recipient: ${recipientPubkey.toBase58()}`);

        let encryptedAmountBytes: Uint8Array;

        if (plaintextAmountWei) {
            // 3a. User provided plaintext amount (from frontend attestedDecrypt or CLI --amount)
            console.log(`   📥 Using provided plaintext amount: ${plaintextAmountWei}`);
            const plaintext = BigInt(plaintextAmountWei);
            console.log(`      Amount: ${plaintext} (${Number(plaintext) / 1e18} tokens)`);

            console.log(`      Re-encrypting for Solana TEE...`);
            const solanaCiphertext = await encryptValue(plaintext);
            const ciphertextBytes = hexToBuffer(solanaCiphertext);
            encryptedAmountBytes = new Uint8Array(ciphertextBytes);
            console.log(`      ✅ Solana ciphertext: ${encryptedAmountBytes.length} bytes`);
        } else {
            // 3b. Try attestedDecrypt server-side (may fail — user should use /relay endpoint instead)
            console.log(`   ⚠️ No plaintext provided. Attempting server-side attestedDecrypt (may fail)...`);
            console.log(`   💡 For reliable operation, use privacy-relayer-server.ts with the /relay endpoint.`);
            try {
                encryptedAmountBytes = await crossChainReencrypt(bridgeEvent.encryptedAmount);
            } catch (err: any) {
                console.error(`   ❌ crossChainReencrypt failed: ${err.message}`);
                console.error(`   ❌ attestedDecrypt requires the USER's wallet signature.`);
                console.error(`   💡 Use: bun run src/privacy-relayer-base-to-sol.ts ${txHash} --amount <PLAINTEXT_WEI>`);
                console.error(`   💡 Or run privacy-relayer-server.ts and have the frontend POST to /relay`);
                return false;
            }
        }

        console.log(`   ✅ Solana ciphertext ready: ${encryptedAmountBytes.length} bytes`);

        // Use the helper function for sending to Solana - pass txHash to store mapping
        const solSig = await sendRelayConfidentialReceive(
            recipientPubkey,
            encryptedAmountBytes,
            baseSender,
            txHash  // Pass Base TX hash to store mapping
        );
        return solSig !== null;

    } catch (error: any) {
        console.error(`   Error: ${error.message}`);
        if (error.cause) {
            console.error(`   Cause: ${JSON.stringify(error.cause)}`);
        }
        return false;
    }
}

/**
 * Monitor mode - watch for new confidential bridge events on Base.
 */
async function monitorMode() {
    console.log("\n=== Monitor Mode ===");
    console.log("Watching for ConfidentialBridgeInitiated events on Base...\n");

    // Start HTTP server for TX hash lookups
    startHttpServer();

    let lastBlock = await basePublicClient.getBlockNumber();
    console.log(`Starting from block: ${lastBlock}`);

    while (true) {
        try {
            const currentBlock = await basePublicClient.getBlockNumber();

            if (currentBlock > lastBlock) {
                // Get logs for ConfidentialBridge
                const logs = await basePublicClient.getLogs({
                    address: CONFIDENTIAL_BRIDGE_ADDRESS,
                    fromBlock: lastBlock + 1n,
                    toBlock: currentBlock,
                });

                for (const log of logs) {
                    const txHash = log.transactionHash!.toLowerCase();
                    
                    // Skip if already processed
                    if (processedTxHashes.has(txHash)) {
                        console.log(`[${new Date().toISOString()}] Skipping already processed TX: ${txHash.slice(0, 20)}...`);
                        continue;
                    }

                    console.log(`\n[${new Date().toISOString()}] New event in TX: ${log.transactionHash}`);

                    // Try to parse as ConfidentialBridgeInitiated
                    try {
                        const decoded = decodeEventLog({
                            abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                            data: log.data,
                            topics: log.topics,
                        });

                        if (decoded.eventName === "ConfidentialBridgeInitiated") {
                            console.log("    ✅ Confidential bridge event detected!");
                            processedTxHashes.add(txHash);  // Mark as processed BEFORE relaying
                            await relayConfidentialToSolana(log.transactionHash!);
                        }
                    } catch (decodeError: any) {
                        console.log(`   Failed to decode event: ${decodeError.message}`);
                    }
                }

                lastBlock = currentBlock;
            }

            console.log(`[${new Date().toISOString()}] Block: ${currentBlock}`);
            await new Promise((r) => setTimeout(r, 15000)); // 15 second polling (Base block time ~2s)

        } catch (error: any) {
            console.error(`Monitor error: ${error.message}`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

/**
 * Demo mode - show what this relayer does.
 */
async function demoMode() {
    console.log("\n=== Privacy Bridge Demo (Base → Solana) ===");
    console.log(`
This relayer monitors ConfidentialBridgeInitiated events on Base and relays them to Solana.

Flow:
1. User encrypts amount on Base using @inco/js
2. User calls bridgePrivateToSolana() on Base ConfidentialBridge
3. This burns encrypted tokens and emits ConfidentialBridgeInitiated
4. Relayer picks up event and calls receive_confidential_in() on Solana
5. Solana bridge mints encrypted tokens to recipient's ConfidentialVault

Important Notes:
- euint256 (32 bytes) on EVM ↔ Euint128 (16 bytes) on SVM
- Handle conversion takes lower 128 bits
- Recipient must have initialized a ConfidentialVault on Solana

To test:
1. Get some test ETH on Base Sepolia
2. Bridge private tokens with ConfidentialBridge.bridgePrivateToSolana()
3. Run this relayer in monitor mode
4. Check recipient's vault on Solana
`);

    console.log("\nDeployed Contract Addresses:");
    console.log(`  ConfidentialBridge (Base): ${CONFIDENTIAL_BRIDGE_ADDRESS}`);
    console.log(`  ConfidentialToken (Base): ${CONFIDENTIAL_TOKEN_ADDRESS}`);
    console.log(`  Bridge Program (Solana): ${BRIDGE_PROGRAM_ID.toBase58()}`);
    console.log(`  Inco Lightning (Solana): ${INCO_LIGHTNING_ID.toBase58()}`);
}

// --- Main ---
async function main() {
    const arg = process.argv[2];

    if (arg === "--monitor") {
        await monitorMode();
    } else if (arg === "--demo") {
        await demoMode();
    } else if (arg && arg.startsWith("0x")) {
        // Check for --amount and --to flags
        const amountIdx = process.argv.indexOf("--amount");
        const plaintextAmount = amountIdx !== -1 ? process.argv[amountIdx + 1] : undefined;
        const toIdx = process.argv.indexOf("--to");
        const toSolana = toIdx !== -1 ? process.argv[toIdx + 1] : undefined;
        await relayConfidentialToSolana(arg, plaintextAmount, toSolana);
    } else {
        console.log("\nUsage:");
        console.log("  Monitor mode:     bun run src/privacy-relayer-base-to-sol.ts --monitor");
        console.log("  Process TX:       bun run src/privacy-relayer-base-to-sol.ts <BASE_TX_HASH> --amount <PLAINTEXT_WEI> --to <SOLANA_PUBKEY>");
        console.log("  Demo info:        bun run src/privacy-relayer-base-to-sol.ts --demo");
        console.log("");
        console.log("  NOTE: The on-chain event only has keccak256(toSolana) for privacy.");
        console.log("  You must provide --to <SOLANA_PUBKEY> when processing a single TX.");
        console.log("  For the full flow, use privacy-relayer-server.ts with the /relay endpoint.");
    }
}

main().catch(console.error);
