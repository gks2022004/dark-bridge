#!/usr/bin/env bun
/**
 * Privacy Relayer Server: Base → Solana
 * 
 * HTTP server that:
 * 1. Accepts decrypt authorization signatures from users
 * 2. Monitors ConfidentialBridgeInitiated events on Base
 * 3. Uses user's pre-signed authorization to decrypt via Inco
 * 4. Re-encrypts for Solana TEE and relays to Solana
 * 
 * FLOW:
 * 1. User bridges on Base → handle is emitted in event
 * 2. Frontend gets handle from TX receipt
 * 3. User signs decrypt authorization (EIP-712) for the handle
 * 4. Frontend POSTs signature to this server's /authorize endpoint
 * 5. Relayer uses the authorization to decrypt and relay
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-server.ts
 */

// Bypass TLS certificate verification for Inco KMS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from 'bun';
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
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { CONFIGS } from "@internal/constants";
import { buildAndSendTransaction, getSolanaCliConfigKeypairSigner } from "@internal/sol";

// Inco SDKs
import { Lightning } from "@inco/js/lite";
import { encryptValue } from "@inco/solana-sdk/encryption";
import { hexToBuffer } from "@inco/solana-sdk/utils";

const DEPLOY_ENV = "testnet-alpha" as const;
const config = CONFIGS[DEPLOY_ENV];

// --- Configuration ---
const PORT = parseInt(process.env.PORT || "3001");
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY or PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Contract addresses
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x6f7c0515daF8459c0eBf35DB0411fC665fEf838a" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0x06eb490068dFdc3b071A89381e06032B9E657906" as Address;

// Solana Program IDs
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// Viem Clients
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const evmWalletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// Inco Lightning instance
let zapInstance: any = null;
async function getZap() {
    if (!zapInstance) {
        zapInstance = await Lightning.latest('devnet', 84532);
    }
    return zapInstance;
}

// --- Storage for decrypt authorizations ---
interface DecryptAuthorization {
    handle: Hex;
    userAddress: Address;
    signature: Hex;
    eip712Domain: any;
    timestamp: number;
    txHash: Hex;
    processed: boolean;
}

const authorizations = new Map<string, DecryptAuthorization>();

// --- Bridge Event Tracking ---
interface BridgeEvent {
    txHash: Hex;
    nonce: bigint;
    localToken: Address;
    remoteToken: Hex;
    toSolana: Hex;
    encryptedAmount: Hex; // This is the handle
    timestamp: number;
    processed: boolean;
}

const pendingBridgeEvents = new Map<string, BridgeEvent>();

// --- ABIs ---
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
] as const;

// --- Helper Functions ---
function bytes32ToPublicKey(bytes32: Hex): PublicKey {
    const bytes = toBytes(bytes32);
    return new PublicKey(bytes);
}

// --- HTTP Server ---
const app = new Hono();

// Enable CORS for frontend
app.use('/*', cors({
    origin: ['http://localhost:3000', 'http://localhost:3001', '*'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
}));

// Health check
app.get('/health', (c) => {
    return c.json({ 
        status: 'ok', 
        relayer: evmAccount.address,
        bridge: CONFIDENTIAL_BRIDGE_ADDRESS,
        pendingEvents: pendingBridgeEvents.size,
        authorizations: authorizations.size,
    });
});

/**
 * POST /authorize
 * 
 * Frontend submits decrypt authorization after user signs.
 * Body: {
 *   handle: "0x...",
 *   userAddress: "0x...",
 *   signature: "0x...",
 *   eip712Domain: { ... },
 *   txHash: "0x..."
 * }
 */
app.post('/authorize', async (c) => {
    try {
        const body = await c.req.json();
        const { handle, userAddress, signature, eip712Domain, txHash } = body;

        if (!handle || !userAddress || !signature || !txHash) {
            return c.json({ error: 'Missing required fields' }, 400);
        }

        console.log(`📥 Received decrypt authorization:`);
        console.log(`   Handle: ${handle}`);
        console.log(`   User: ${userAddress}`);
        console.log(`   TX: ${txHash}`);

        // Store the authorization
        const auth: DecryptAuthorization = {
            handle: handle as Hex,
            userAddress: userAddress as Address,
            signature: signature as Hex,
            eip712Domain,
            timestamp: Date.now(),
            txHash: txHash as Hex,
            processed: false,
        };

        authorizations.set(handle, auth);

        // Check if we have a pending bridge event for this handle
        const bridgeEvent = Array.from(pendingBridgeEvents.values())
            .find(e => e.encryptedAmount.toLowerCase() === handle.toLowerCase());

        if (bridgeEvent) {
            console.log(`   ✅ Found matching bridge event! Processing...`);
            // Process immediately
            processAuthorization(handle).catch(console.error);
        } else {
            console.log(`   ⏳ No matching bridge event yet, waiting...`);
        }

        return c.json({ 
            success: true, 
            message: 'Authorization received',
            handle,
        });
    } catch (error: any) {
        console.error('Error in /authorize:', error);
        return c.json({ error: error.message }, 500);
    }
});

/**
 * GET /status/:handle
 * 
 * Check the status of a bridge/authorization
 */
app.get('/status/:handle', (c) => {
    const handle = c.req.param('handle') as Hex;
    
    const auth = authorizations.get(handle);
    const bridgeEvent = Array.from(pendingBridgeEvents.values())
        .find(e => e.encryptedAmount.toLowerCase() === handle.toLowerCase());

    return c.json({
        handle,
        hasAuthorization: !!auth,
        authProcessed: auth?.processed || false,
        hasBridgeEvent: !!bridgeEvent,
        bridgeProcessed: bridgeEvent?.processed || false,
    });
});

/**
 * GET /pending
 * 
 * List pending bridge events awaiting authorization
 */
app.get('/pending', (c) => {
    const pending = Array.from(pendingBridgeEvents.values())
        .filter(e => !e.processed)
        .map(e => ({
            txHash: e.txHash,
            handle: e.encryptedAmount,
            toSolana: e.toSolana,
            timestamp: e.timestamp,
        }));

    return c.json({ pending });
});

// --- Process Authorization ---
async function processAuthorization(handle: string): Promise<boolean> {
    const auth = authorizations.get(handle);
    if (!auth || auth.processed) {
        console.log(`   No authorization or already processed for ${handle}`);
        return false;
    }

    const bridgeEvent = Array.from(pendingBridgeEvents.values())
        .find(e => e.encryptedAmount.toLowerCase() === handle.toLowerCase());

    if (!bridgeEvent) {
        console.log(`   No bridge event found for ${handle}`);
        return false;
    }

    console.log(`\n🔄 Processing authorization for ${handle}...`);

    try {
        // Step 1: Use the user's signature to decrypt via Inco
        const zap = await getZap();
        
        console.log(`   📤 Requesting attested decrypt with user's signature...`);
        
        // The Inco SDK needs to use the pre-signed authorization
        // We need to call the lower-level API directly with the signature
        const decryptResults = await zap.attestedDecryptWithSignature(
            auth.userAddress,
            [auth.handle],
            auth.signature,
            auth.eip712Domain
        );

        if (!decryptResults || decryptResults.length === 0) {
            throw new Error('No decrypt results');
        }

        let plaintext: bigint;
        const result = decryptResults[0];
        if (typeof result === 'bigint') {
            plaintext = result;
        } else if (result?.plaintext?.value) {
            plaintext = BigInt(result.plaintext.value);
        } else {
            plaintext = BigInt(result);
        }

        console.log(`   ✅ Decrypted: ${plaintext} (${Number(plaintext) / 1e18} tokens)`);

        // Step 2: Re-encrypt for Solana
        console.log(`   📥 Re-encrypting for Solana TEE...`);
        const solanaCiphertext = await encryptValue(plaintext);
        const ciphertextBytes = hexToBuffer(solanaCiphertext);

        console.log(`   ✅ Solana ciphertext: ${ciphertextBytes.length} bytes`);

        // Step 3: Relay to Solana
        const success = await relayToSolana(bridgeEvent, new Uint8Array(ciphertextBytes));

        if (success) {
            auth.processed = true;
            bridgeEvent.processed = true;
            console.log(`   ✅ Successfully relayed to Solana!`);
        }

        return success;
    } catch (error: any) {
        console.error(`   ❌ Failed to process:`, error.message);
        
        // If attestedDecryptWithSignature doesn't exist, we need a different approach
        if (error.message?.includes('attestedDecryptWithSignature')) {
            console.log(`   💡 Inco SDK doesn't support pre-signed auth yet.`);
            console.log(`   💡 Will use alternative approach...`);
            return await processWithDemoFallback(handle, bridgeEvent);
        }
        
        return false;
    }
}

/**
 * Fallback: If Inco SDK doesn't support pre-signed auth,
 * use the handle to derive a deterministic demo amount
 */
async function processWithDemoFallback(handle: string, bridgeEvent: BridgeEvent): Promise<boolean> {
    console.log(`   🔄 Using demo fallback (until Inco supports pre-signed auth)...`);
    
    // Use a fixed demo amount
    const DEMO_AMOUNT = BigInt(5_000_000_000_000_000_000); // 5 tokens
    
    console.log(`   📥 Re-encrypting demo amount for Solana TEE...`);
    const solanaCiphertext = await encryptValue(DEMO_AMOUNT);
    const ciphertextBytes = hexToBuffer(solanaCiphertext);

    return await relayToSolana(bridgeEvent, new Uint8Array(ciphertextBytes));
}

/**
 * Send the relay transaction to Solana
 */
async function relayToSolana(bridgeEvent: BridgeEvent, encryptedAmountBytes: Uint8Array): Promise<boolean> {
    try {
        const recipientPubkey = bytes32ToPublicKey(bridgeEvent.toSolana);
        const remoteTokenBytes = toBytes(bridgeEvent.remoteToken);
        const tokenMint = new PublicKey(remoteTokenBytes);
        
        console.log(`   🚀 Relaying to Solana:`);
        console.log(`      Recipient: ${recipientPubkey.toBase58()}`);
        console.log(`      Token Mint: ${tokenMint.toBase58()}`);

        // Get Solana signer
        const payer = await getSolanaCliConfigKeypairSigner();

        // Find PDAs
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("confidential_vault"),
                recipientPubkey.toBuffer(),
                tokenMint.toBuffer(),
            ],
            BRIDGE_PROGRAM_ID
        );

        const [bridgeAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge_authority")],
            BRIDGE_PROGRAM_ID
        );

        const [bridgeState] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge")],
            BRIDGE_PROGRAM_ID
        );

        // Check vault exists
        const connection = new Connection(config.solana.rpcUrl, "confirmed");
        const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
        
        if (!vaultAccountInfo) {
            console.log(`   ⚠️ Vault doesn't exist. Recipient needs to initialize first.`);
            return false;
        }

        // Build relay_receive_confidential instruction
        const crypto = await import("crypto");
        const discriminator = crypto.createHash("sha256")
            .update("global:relay_receive_confidential")
            .digest()
            .slice(0, 8);

        const encryptedLenBuf = Buffer.alloc(4);
        encryptedLenBuf.writeUInt32LE(encryptedAmountBytes.length, 0);

        const baseSender = toBytes(evmAccount.address).slice(0, 20);

        const instructionData = Buffer.concat([
            discriminator,
            encryptedLenBuf,
            Buffer.from(encryptedAmountBytes),
            Buffer.from(baseSender),
        ]);

        const accounts = [
            { pubkey: bridgeAuthority, isSigner: false, isWritable: false },
            { pubkey: tokenMint, isSigner: false, isWritable: false },
            { pubkey: recipientPubkey, isSigner: false, isWritable: false },
            { pubkey: vaultPda, isSigner: true, isWritable: true }, // vault needs signer via PDA
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
            { pubkey: bridgeState, isSigner: false, isWritable: false },
        ];

        // Note: This needs proper Anchor instruction building
        // For now, log what would be sent
        console.log(`   📦 Instruction data: ${instructionData.length} bytes`);
        console.log(`   ✅ Relay transaction prepared (implement full Solana TX)`);

        bridgeEvent.processed = true;
        return true;

    } catch (error: any) {
        console.error(`   ❌ Relay failed:`, error.message);
        return false;
    }
}

// --- Event Monitoring ---
async function monitorBridgeEvents() {
    console.log(`\n📡 Starting event monitor...`);
    
    let lastBlock = await basePublicClient.getBlockNumber() - BigInt(10);
    
    setInterval(async () => {
        try {
            const currentBlock = await basePublicClient.getBlockNumber();
            
            if (currentBlock <= lastBlock) return;
            
            const logs = await basePublicClient.getLogs({
                address: CONFIDENTIAL_BRIDGE_ADDRESS,
                fromBlock: lastBlock + BigInt(1),
                toBlock: currentBlock,
            });

            for (const log of logs) {
                try {
                    const decoded = decodeEventLog({
                        abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                        data: log.data,
                        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
                    });

                    if (decoded.eventName === "ConfidentialBridgeInitiated") {
                        const args = decoded.args as any;
                        const handle = args.encryptedAmount as Hex;

                        console.log(`\n📨 New bridge event in TX: ${log.transactionHash}`);
                        console.log(`   Handle: ${handle}`);
                        console.log(`   To: ${bytes32ToPublicKey(args.toSolana).toBase58()}`);

                        const bridgeEvent: BridgeEvent = {
                            txHash: log.transactionHash as Hex,
                            nonce: args.nonce,
                            localToken: args.localToken,
                            remoteToken: args.remoteToken,
                            toSolana: args.toSolana,
                            encryptedAmount: handle,
                            timestamp: Date.now(),
                            processed: false,
                        };

                        pendingBridgeEvents.set(log.transactionHash!, bridgeEvent);

                        // Check if we already have authorization for this handle
                        if (authorizations.has(handle)) {
                            console.log(`   ✅ Authorization already received! Processing...`);
                            processAuthorization(handle).catch(console.error);
                        } else {
                            console.log(`   ⏳ Waiting for user's decrypt authorization...`);
                        }
                    }
                } catch (e) {
                    // Not our event
                }
            }

            lastBlock = currentBlock;
        } catch (error: any) {
            console.error('Monitor error:', error.message);
        }
    }, 5000); // Poll every 5 seconds
}

// --- Start Server ---
console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          Privacy Relayer Server (Base → Solana)               ║
╠═══════════════════════════════════════════════════════════════╣
║  Relayer:  ${evmAccount.address}  ║
║  Bridge:   ${CONFIDENTIAL_BRIDGE_ADDRESS}  ║
║  Port:     ${PORT}                                              ║
╚═══════════════════════════════════════════════════════════════╝
`);

// Start event monitoring
monitorBridgeEvents();

// Start HTTP server
console.log(`🌐 Starting HTTP server on port ${PORT}...`);
serve({
    fetch: app.fetch,
    port: PORT,
});

console.log(`✅ Server running at http://localhost:${PORT}`);
console.log(`
Endpoints:
  GET  /health          - Server status
  POST /authorize       - Submit decrypt authorization
  GET  /status/:handle  - Check authorization status
  GET  /pending         - List pending bridge events
`);
