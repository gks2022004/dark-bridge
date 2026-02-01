#!/usr/bin/env bun
/**
 * Privacy Relayer: Base → Solana
 * 
 * Monitors ConfidentialBridgeInitiated events on Base and relays encrypted transfers to Solana.
 * This is the privacy-preserving counterpart to auto-relayer-base-sol.ts.
 * 
 * ARCHITECTURE NOTES:
 * ==================
 * The ideal cross-chain re-encryption flow requires the USER to sign a decrypt authorization
 * before bridging, because Inco's attestedDecrypt requires owner's signature.
 * 
 * e.allow(amount, relayer) grants on-chain computation access, NOT off-chain decryption.
 * 
 * CURRENT APPROACH (Demo Mode):
 * - Parse the bridge event to get the EVM handle
 * - Use a placeholder amount (the handle hash mapped to a demo value)
 * - This preserves the privacy of the actual amount in the demo
 * 
 * PRODUCTION APPROACH (TODO):
 * 1. Frontend asks user to pre-sign a decrypt authorization before bridging
 * 2. Authorization is included in bridge transaction or stored off-chain
 * 3. Relayer uses pre-signed authorization to call attestedDecrypt
 * 4. Relayer re-encrypts plaintext for Solana TEE
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts <BASE_TX_HASH>
 */

// IMPORTANT: Bypass TLS certificate verification for Inco KMS in development
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Demo mode: Set to false now that we have plaintext in the event
// The new bridgePrivateToSolanaPlaintext function emits plaintext amount directly
const USE_DEMO_MODE = false;
const DEMO_BRIDGE_AMOUNT = BigInt(5_000_000_000_000_000_000); // 5 tokens with 18 decimals

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
import { buildAndSendTransaction, getSolanaCliConfigKeypairSigner, getIdlConstant } from "@internal/sol";

// Inco SDKs for cross-chain re-encryption
import { Lightning } from "@inco/js/lite";
import { encryptValue } from "@inco/solana-sdk/encryption";
import { hexToBuffer } from "@inco/solana-sdk/utils";

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

// NEW DEPLOYED ADDRESSES (with bridgePrivateToSolanaPlaintext - production ready)
const CONFIDENTIAL_BRIDGE_ADDRESS = "0xD705858A979a4ab42e7a2e43e8CcC726Dbd87369" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xFBAD5A940d89e504C5f8C9e0fC3A976A82334565" as Address;

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
    "event ConfidentialBridgeInitiated(uint256 indexed nonce, address indexed localToken, bytes32 indexed remoteToken, bytes32 toSolana, bytes32 encryptedAmount)",
    "event ConfidentialBridgeInitiatedWithPlaintext(uint256 indexed nonce, address indexed localToken, bytes32 indexed remoteToken, bytes32 toSolana, uint256 plaintextAmount)",
]);

// Full ABI for decoding (includes both old and new events)
const CONFIDENTIAL_BRIDGE_FULL_ABI = [
    {
        type: "event",
        name: "ConfidentialBridgeInitiated",
        inputs: [
            { name: "nonce", type: "uint256", indexed: true },
            { name: "localToken", type: "address", indexed: true },
            { name: "remoteToken", type: "bytes32", indexed: true },
            { name: "toSolana", type: "bytes32", indexed: false },
            { name: "encryptedAmount", type: "bytes32", indexed: false },
        ],
    },
    {
        type: "event",
        name: "ConfidentialBridgeInitiatedWithPlaintext",
        inputs: [
            { name: "nonce", type: "uint256", indexed: true },
            { name: "localToken", type: "address", indexed: true },
            { name: "remoteToken", type: "bytes32", indexed: true },
            { name: "toSolana", type: "bytes32", indexed: false },
            { name: "plaintextAmount", type: "uint256", indexed: false },
        ],
    },
] as const;

// === TX Hash Mapping Store ===
// Maps Base TX hash -> Solana TX signature
const txHashMap: Map<string, string> = new Map();

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
    toSolana: Hex;
    encryptedAmount: Hex;
}

// NEW: Event with plaintext amount (no decryption needed)
interface ConfidentialBridgeInitiatedWithPlaintextEvent {
    nonce: bigint;
    localToken: Address;
    remoteToken: Hex;
    toSolana: Hex;
    plaintextAmount: bigint;
}

/**
 * Parse ConfidentialBridgeInitiatedWithPlaintext event from transaction receipt.
 * This is the new production event that includes plaintext amount directly.
 */
function parseConfidentialBridgeWithPlaintextEvent(
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]
): ConfidentialBridgeInitiatedWithPlaintextEvent | null {
    for (const log of logs) {
        if (log.address.toLowerCase() === CONFIDENTIAL_BRIDGE_ADDRESS.toLowerCase()) {
            try {
                const decoded = decodeEventLog({
                    abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                    data: log.data,
                    topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
                });

                if (decoded.eventName === "ConfidentialBridgeInitiatedWithPlaintext") {
                    const args = decoded.args as any;
                    return {
                        nonce: args.nonce,
                        localToken: args.localToken,
                        remoteToken: args.remoteToken,
                        toSolana: args.toSolana,
                        plaintextAmount: args.plaintextAmount,
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
 * Parse ConfidentialBridgeInitiated event from transaction receipt (legacy).
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
                        toSolana: args.toSolana,
                        encryptedAmount: args.encryptedAmount,
                    };
                }
            } catch (e) {
                // Not our event
            }
        }
    }
    return null;;
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
    console.log(`   Solana Payer: ${payer.address}`);

    // Use default token mint from config or from the token address
    // For the hackathon, we use a known token mint
    const tokenMintBytes = toBytes(("0x" + Buffer.from(CONFIDENTIAL_TOKEN_ADDRESS.slice(2).padStart(64, "0"), "hex").toString("hex")) as Hex);
    // Actually, we need the Solana token mint, not the EVM address
    // The Solana token mint should be stored somewhere or derived
    // For now, we'll use the default from the deployment
    const connection = new Connection(config.solana.rpcUrl, "confirmed");

    // Get the remote token from contract or use known deployment
    // Use the token mint that matches the user's initialized vault
    const SOLANA_TOKEN_MINT = new PublicKey("2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH");
    const tokenMint = SOLANA_TOKEN_MINT;
    console.log(`   Token Mint: ${tokenMint.toBase58()}`);

    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("confidential_vault"),
            recipientPubkey.toBuffer(),
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

    // Create instruction with accounts
    const payerKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(require("fs").readFileSync(
            require("os").homedir() + "/.config/solana/id.json", "utf-8"
        )))
    );

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
 * FLOW (using e.reveal + attestedReveal):
 * 1. Contract calls e.reveal(handle) to mark for public decryption
 * 2. Relayer uses attestedReveal() - NO user signature needed
 * 3. Re-encrypt plaintext for Solana TEE using encryptValue
 * 
 * NOTE: attestedDecrypt requires USER's wallet signature (not relayer's).
 *       attestedReveal works for handles marked with e.reveal() - no signature needed.
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

    // Step 2: Attested REVEAL on EVM TEE (for handles marked with e.reveal())
    // This does NOT require user's wallet signature - works for public reveals
    console.log(`      📤 Requesting attested REVEAL from EVM TEE...`);
    console.log(`      ℹ️ Using attestedReveal (no signature needed for e.reveal() handles)`);

    // Configure retries for async handle processing
    // Inco team recommends: 1-2 second base backoff for TEE sync delays
    const backoffConfig = {
        maxRetries: 15,
        baseDelayInMs: 1500, // Start at 1.5s as recommended by Inco
        backoffFactor: 1.5,  // 1.5s -> 2.25s -> 3.4s -> 5s -> 7.5s -> 10s (capped)
    };

    try {
        // Use attestedReveal instead of attestedDecrypt
        // attestedReveal is for handles that have been marked with e.reveal()
        console.log(`      ⏳ Calling attestedReveal...`);
        console.log(`      Handle (hex): ${evmHandle}`);
        console.log(`      Handle length: ${evmHandle.length} chars`);

        // Add timeout wrapper (90s max for retries)
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('attestedReveal timed out after 90s')), 90000);
        });

        const revealResults = await Promise.race([
            zap.attestedReveal([evmHandle], backoffConfig),
            timeoutPromise
        ]);

        console.log(`      Raw reveal results:`, JSON.stringify(revealResults, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v, 2));

        if (!revealResults || revealResults.length === 0) {
            throw new Error(`No results from attestedReveal for handle: ${evmHandle}`);
        }

        // The result structure for attestedReveal is { plaintext: value }
        let plaintext: bigint;
        const result = revealResults[0];

        if (typeof result === 'bigint') {
            plaintext = result;
        } else if (result && typeof result === 'object') {
            if ('plaintext' in result && result.plaintext !== undefined) {
                // plaintext could be { value: bigint } or just bigint
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

        console.log(`      ✅ Revealed plaintext: ${plaintext} (${Number(plaintext) / 1e18} tokens)`);

        // Step 3: Re-encrypt for Solana TEE
        console.log(`      📥 Re-encrypting for Solana TEE...`);
        const solanaCiphertext = await encryptValue(plaintext);
        const ciphertextBytes = hexToBuffer(solanaCiphertext);

        console.log(`      ✅ Solana ciphertext: ${solanaCiphertext.slice(0, 40)}...`);
        console.log(`      ✅ Ciphertext length: ${ciphertextBytes.length} bytes`);

        return new Uint8Array(ciphertextBytes);
    } catch (revealError: any) {
        console.error(`      ❌ Attested reveal failed:`, revealError.message);
        console.error(`      Full error:`, revealError);
        console.error(`      Cause:`, JSON.stringify(revealError.cause || {}, null, 2));

        // Check if handle was not marked with e.reveal()
        if (revealError.message?.includes('not revealed') || revealError.message?.includes('permission')) {
            console.error(`      💡 Handle may not be marked with e.reveal() in the contract`);
            console.error(`      💡 Ensure ConfidentialBridge calls e.reveal(amount) before emitting event`);
        }

        // Check if it's a certificate issue
        if (revealError.message?.includes('certificate') || revealError.message?.includes('CERT')) {
            console.error(`      💡 TLS certificate issue. NODE_TLS_REJECT_UNAUTHORIZED should be set to '0'`);
        }

        // Check if handle not found (may need time to be processed)
        if (revealError.message?.includes('not found') || revealError.message?.includes('pending')) {
            console.error(`      💡 Handle may still be processing. Wait and retry.`);
        }

        throw new Error(`Failed to reveal handle: ${revealError.message}`);
    }
}

/**
 * Relay a confidential bridge message from Base to Solana.
 */
async function relayConfidentialToSolana(txHash: string): Promise<boolean> {
    console.log(`\n=== Processing Base TX: ${txHash} ===`);

    try {
        // 1. Get transaction receipt
        const receipt = await basePublicClient.getTransactionReceipt({
            hash: txHash as Hash,
        });
        console.log(`   Block: ${receipt.blockNumber}`);

        // 2. FIRST try to parse the new plaintext event (production flow)
        const plaintextEvent = parseConfidentialBridgeWithPlaintextEvent(receipt.logs);

        if (plaintextEvent) {
            console.log(`   ✅ Found ConfidentialBridgeInitiatedWithPlaintext event (production flow):`);
            console.log(`      Nonce: ${plaintextEvent.nonce}`);
            console.log(`      Local Token: ${plaintextEvent.localToken}`);
            console.log(`      To Solana: ${plaintextEvent.toSolana}`);
            console.log(`      Plaintext Amount: ${plaintextEvent.plaintextAmount} (${Number(plaintextEvent.plaintextAmount) / 1e18} tokens)`);

            const recipientPubkey = bytes32ToPublicKey(plaintextEvent.toSolana);
            console.log(`   Recipient: ${recipientPubkey.toBase58()}`);

            // Re-encrypt plaintext for Solana TEE - no decryption needed!
            console.log(`   📥 Encrypting plaintext for Solana TEE...`);
            const solanaCiphertext = await encryptValue(plaintextEvent.plaintextAmount);
            const encryptedAmountBytes = new Uint8Array(hexToBuffer(solanaCiphertext));
            console.log(`      ✅ Solana ciphertext: ${solanaCiphertext.slice(0, 40)}...`);
            console.log(`      ✅ Ciphertext length: ${encryptedAmountBytes.length} bytes`);

            // Build and send Solana transaction - pass txHash to store mapping
            const baseSender = toBytes(evmAccount.address).slice(0, 20);
            const solSig = await sendRelayConfidentialReceive(
                recipientPubkey,
                encryptedAmountBytes,
                baseSender,
                txHash  // Pass Base TX hash to store mapping
            );
            return solSig !== null;
        }

        // 3. Fall back to legacy event (encrypted amount - requires attestedReveal)
        const legacyEvent = parseConfidentialBridgeInitiatedEvent(receipt.logs);

        if (!legacyEvent) {
            console.log("   No ConfidentialBridgeInitiated event found");
            return false;
        }

        console.log(`   ⚠️ Found legacy ConfidentialBridgeInitiated event (requires attestedReveal):`);
        console.log(`      Nonce: ${legacyEvent.nonce}`);
        console.log(`      Local Token: ${legacyEvent.localToken}`);
        console.log(`      To Solana: ${legacyEvent.toSolana}`);
        console.log(`      EVM Handle: ${legacyEvent.encryptedAmount}`);

        // 4. Cross-chain re-encryption: decrypt EVM handle → re-encrypt for Solana TEE
        // Relayer has e.allow() access granted by ConfidentialBridge.setBridgeRelayer()
        const recipientPubkey = bytes32ToPublicKey(legacyEvent.toSolana);
        const baseSender = toBytes(evmAccount.address).slice(0, 20);

        console.log(`   Recipient: ${recipientPubkey.toBase58()}`);

        // Use proper cross-chain re-encryption (attested reveal on EVM → encrypt for Solana)
        // Falls back to demo mode if attestedReveal fails
        let encryptedAmountBytes: Uint8Array;

        if (USE_DEMO_MODE) {
            console.log(`   ⚠️ DEMO MODE: Using fixed amount instead of attestedReveal`);
            console.log(`      Demo amount: ${DEMO_BRIDGE_AMOUNT} (${Number(DEMO_BRIDGE_AMOUNT) / 1e18} tokens)`);

            // Re-encrypt demo amount for Solana TEE
            const solanaCiphertext = await encryptValue(DEMO_BRIDGE_AMOUNT);
            encryptedAmountBytes = new Uint8Array(hexToBuffer(solanaCiphertext));
            console.log(`      ✅ Solana ciphertext: ${solanaCiphertext.slice(0, 40)}...`);
        } else {
            try {
                encryptedAmountBytes = await crossChainReencrypt(legacyEvent.encryptedAmount);
            } catch (err: any) {
                console.error(`   ❌ crossChainReencrypt failed: ${err.message}`);
                console.log(`   ⚠️ Falling back to DEMO MODE...`);

                // Fallback to demo amount
                const solanaCiphertext = await encryptValue(DEMO_BRIDGE_AMOUNT);
                encryptedAmountBytes = new Uint8Array(hexToBuffer(solanaCiphertext));
                console.log(`      Demo amount: ${DEMO_BRIDGE_AMOUNT} (${Number(DEMO_BRIDGE_AMOUNT) / 1e18} tokens)`);
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
                    console.log(`\n[${new Date().toISOString()}] New event in TX: ${log.transactionHash}`);

                    // Try to parse as ConfidentialBridgeInitiated or ConfidentialBridgeInitiatedWithPlaintext
                    try {
                        const decoded = decodeEventLog({
                            abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                            data: log.data,
                            topics: log.topics,
                        });

                        if (decoded.eventName === "ConfidentialBridgeInitiated") {
                            console.log("    ✅ Confidential bridge event detected (legacy)!");
                            await relayConfidentialToSolana(log.transactionHash!);
                        } else if (decoded.eventName === "ConfidentialBridgeInitiatedWithPlaintext") {
                            console.log("    ✅ Confidential bridge event detected (with plaintext)!");
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
        await relayConfidentialToSolana(arg);
    } else {
        console.log("\nUsage:");
        console.log("  Monitor mode:     bun run src/privacy-relayer-base-to-sol.ts --monitor");
        console.log("  Process TX:       bun run src/privacy-relayer-base-to-sol.ts <BASE_TX_HASH>");
        console.log("  Demo info:        bun run src/privacy-relayer-base-to-sol.ts --demo");
    }
}

main().catch(console.error);
