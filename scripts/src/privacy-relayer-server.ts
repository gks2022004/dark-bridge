#!/usr/bin/env bun
/**
 * Privacy Relayer Server: Base ↔ Solana
 * 
 * HTTP server that handles bidirectional cross-chain bridging:
 * 
 * BASE → SOLANA:
 * 1. User bridges on Base → encrypted handle emitted on-chain
 * 2. Frontend sends known plaintext amount to POST /relay
 * 3. Relayer re-encrypts for Solana TEE and relays to Solana program
 * 
 * SOLANA → BASE:
 * 1. User bridges on Solana → encrypted handle emitted on-chain
 * 2. Frontend calls Solana attested decrypt to get plaintext
 * 3. Frontend sends plaintext to POST /relay-to-base
 * 4. Relayer re-encrypts for EVM (Inco) and calls faucetMint
 * 
 * TRUST MODEL:
 * The relayer sees the plaintext amount during cross-chain re-encryption.
 * This is architecturally necessary — Inco FHE handles cannot transfer between
 * EVM and Solana without decrypt → re-encrypt. For production, this relayer
 * should run inside a TEE (e.g., AWS Nitro Enclaves, Intel SGX) so even the
 * operator cannot read the plaintext from memory.
 * 
 * PRIVACY GUARANTEES:
 * - On-chain: All amounts are encrypted (euint256 on EVM, Euint128 on Solana)
 * - From public observers: No one can see amounts, balances, or vault owners
 * - Total supply: Fully encrypted (no e.reveal)
 * - From the relayer: The relayer learns plaintext amounts (unavoidable for now)
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
import { buildAndSendTransaction, getSolanaCliConfigKeypairSigner, getSolanaWeb3Keypair } from "@internal/sol";

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
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x04423E2D4e74b8C5D17730143400ca43fC800f73" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xeC7f5bDafE9934658d717E9a13Ae4259858b5F0b" as Address;

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

// Inco Lightning — create fresh instances per-request to avoid stale state
async function createZap() {
    return Lightning.latest('devnet', 84532);
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
    toSolana: Hex;       // Plaintext from /relay API (NOT from event)
    toSolanaHash: Hex;   // keccak256(toSolana) from on-chain event
    encryptedAmount: Hex; // This is the handle
    timestamp: number;
    processed: boolean;
}

const pendingBridgeEvents = new Map<string, BridgeEvent>();

// Map Base TX hash → Solana TX hash (for /tx/:hash polling)
const completedRelays = new Map<string, { solanaTxHash: string; baseTxHash: string; timestamp: number }>();
// Map Base TX hash → Base mint TX hash (for /relay-to-base polling)
const completedBaseMints = new Map<string, { baseMintTxHash: string; solanaTxHash: string; timestamp: number }>();

// --- ABIs ---
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
 * POST /relay
 * 
 * Frontend sends the decrypted plaintext amount (user already called attestedDecrypt)
 * along with bridge details. Relayer re-encrypts for Solana TEE and relays.
 * 
 * Body: {
 *   baseTxHash: "0x...",
 *   plaintextAmount: "1000000000000000000",  // string bigint
 *   toSolana: "0x...",    // bytes32 Solana pubkey
 *   localToken: "0x...",  // EVM token address
 * }
 */
app.post('/relay', async (c) => {
    try {
        const body = await c.req.json();
        const { baseTxHash, plaintextAmount, toSolana, localToken } = body;

        if (!baseTxHash || !plaintextAmount || !toSolana) {
            return c.json({ error: 'Missing required fields: baseTxHash, plaintextAmount, toSolana' }, 400);
        }

        console.log(`\n📥 Received relay request from frontend:`);
        console.log(`   Base TX: ${baseTxHash}`);
        console.log(`   Plaintext Amount: ${plaintextAmount}`);
        console.log(`   To Solana: ${toSolana}`);

        // Check if already processed
        const existingEvent = Array.from(pendingBridgeEvents.values())
            .find(e => e.txHash.toLowerCase() === baseTxHash.toLowerCase());
        if (existingEvent?.processed) {
            console.log(`   ⚠️ Already processed, skipping`);
            return c.json({ success: true, message: 'Already relayed', alreadyProcessed: true });
        }

        // Re-encrypt the plaintext for Solana TEE
        console.log(`   📥 Re-encrypting for Solana TEE...`);
        const plaintext = BigInt(plaintextAmount);
        const solanaCiphertext = await encryptValue(plaintext);
        const ciphertextBytes = hexToBuffer(solanaCiphertext);
        console.log(`   ✅ Solana ciphertext: ${ciphertextBytes.length} bytes`);

        // Build the bridge event from the request
        const { keccak256: keccak256Hash } = await import("viem");
        const bridgeEvent: BridgeEvent = {
            txHash: baseTxHash as Hex,
            nonce: 0n,
            localToken: (localToken || CONFIDENTIAL_TOKEN_ADDRESS) as Address,
            remoteToken: '0x0' as Hex,
            toSolana: toSolana as Hex,
            toSolanaHash: keccak256Hash(toSolana as Hex),
            encryptedAmount: '0x0' as Hex,
            timestamp: Date.now(),
            processed: false,
        };

        // Relay to Solana
        const solanaTxHash = await relayToSolana(bridgeEvent, new Uint8Array(ciphertextBytes));

        if (solanaTxHash) {
            bridgeEvent.processed = true;
            pendingBridgeEvents.set(baseTxHash, bridgeEvent);
            // Store completed relay for /tx/:hash polling
            completedRelays.set(baseTxHash.toLowerCase(), {
                solanaTxHash,
                baseTxHash,
                timestamp: Date.now(),
            });
            console.log(`   ✅ Successfully relayed to Solana!`);
            return c.json({ success: true, message: 'Relayed to Solana', solanaTxHash });
        } else {
            return c.json({ error: 'Failed to relay to Solana' }, 500);
        }
    } catch (error: any) {
        console.error('Error in /relay:', error);
        return c.json({ error: error.message }, 500);
    }
});

/**
 * POST /relay-bridge-to-solana
 * 
 * SENDER PRIVACY for Base → Solana bridging.
 * 
 * Instead of the user calling bridgePrivateToSolana directly (which exposes their
 * EVM address as tx.from on BaseScan), the user signs the bridge parameters off-chain
 * using personal_sign. The relayer submits the tx via bridgePrivateToSolanaViaRelayer,
 * so only the RELAYER's address appears as tx.from.
 * 
 * After the Base TX confirms, the relayer also re-encrypts the plaintext for Solana
 * and relays to the Solana program (same as /relay).
 * 
 * Body: {
 *   localToken: "0x...",           // EVM token address
 *   toSolana: "0x...",             // bytes32 Solana pubkey
 *   encryptedAmount: "0x...",      // Inco-encrypted ciphertext (hex)
 *   sender: "0x...",               // User's EVM address (for contract validation)
 *   senderNonce: "0",              // User's nonce (string)
 *   deadline: "1234567890",        // Unix timestamp (string)
 *   signature: "0x...",            // personal_sign signature
 *   plaintextAmount: "1000...",    // Plaintext amount for Solana relay
 * }
 */
app.post('/relay-bridge-to-solana', async (c) => {
    try {
        const body = await c.req.json();
        const { localToken, toSolana, encryptedAmount, sender, senderNonce, deadline, signature, plaintextAmount } = body;

        if (!localToken || !toSolana || !encryptedAmount || !sender || senderNonce === undefined || !deadline || !signature) {
            return c.json({ error: 'Missing required fields' }, 400);
        }

        console.log(`\n📥 Received relay-bridge-to-solana request (SENDER PRIVACY):`);
        console.log(`   Sender: ${sender}`);
        console.log(`   To Solana: ${toSolana}`);
        console.log(`   Nonce: ${senderNonce}`);
        console.log(`   Deadline: ${deadline}`);

        // Step 1: Get Inco fee from the contract
        const BRIDGE_VIEW_ABI = parseAbi([
            "function getIncoFee() external view returns (uint256)",
        ]);
        let incoFee: bigint;
        try {
            incoFee = await basePublicClient.readContract({
                address: CONFIDENTIAL_BRIDGE_ADDRESS,
                abi: BRIDGE_VIEW_ABI,
                functionName: "getIncoFee",
            });
        } catch {
            incoFee = BigInt("100000000000000"); // 0.0001 ETH fallback
        }
        console.log(`   💰 Inco fee: ${incoFee} wei`);

        // Step 2: Call bridgePrivateToSolanaViaRelayer on the contract
        // The relayer (evmAccount) is tx.from — user's address is only in calldata
        const RELAYER_BRIDGE_ABI = parseAbi([
            "function bridgePrivateToSolanaViaRelayer(address localToken, bytes32 toSolana, bytes encryptedAmount, address sender, uint256 senderNonce, uint256 deadline, bytes signature) external payable",
        ]);

        console.log(`   📤 Calling bridgePrivateToSolanaViaRelayer...`);
        console.log(`   🔑 Relayer (tx.from): ${evmAccount.address}`);

        const hash = await evmWalletClient.writeContract({
            address: CONFIDENTIAL_BRIDGE_ADDRESS,
            abi: RELAYER_BRIDGE_ABI,
            functionName: "bridgePrivateToSolanaViaRelayer",
            args: [
                localToken as `0x${string}`,
                toSolana as `0x${string}`,
                encryptedAmount as `0x${string}`,
                sender as `0x${string}`,
                BigInt(senderNonce),
                BigInt(deadline),
                signature as `0x${string}`,
            ],
            value: incoFee,
        });

        console.log(`   ⏳ Base TX sent: ${hash}`);
        const receipt = await basePublicClient.waitForTransactionReceipt({ hash });

        if (receipt.status !== "success") {
            console.log(`   ❌ Base TX reverted`);
            return c.json({ error: 'Bridge transaction reverted on Base' }, 500);
        }

        console.log(`   ✅ Base TX confirmed: ${hash}`);
        console.log(`   🔒 Only relayer ${evmAccount.address} is visible as tx.from on BaseScan!`);

        // Step 3: Now relay the plaintext to Solana (same logic as /relay)
        if (plaintextAmount) {
            console.log(`   📥 Re-encrypting for Solana TEE...`);
            const plaintext = BigInt(plaintextAmount);
            const solanaCiphertext = await encryptValue(plaintext);
            const ciphertextBytes = hexToBuffer(solanaCiphertext);
            console.log(`   ✅ Solana ciphertext: ${ciphertextBytes.length} bytes`);

            const { keccak256: keccak256Hash } = await import("viem");
            const bridgeEvent: BridgeEvent = {
                txHash: hash,
                nonce: 0n,
                localToken: localToken as Address,
                remoteToken: '0x0' as Hex,
                toSolana: toSolana as Hex,
                toSolanaHash: keccak256Hash(toSolana as Hex),
                encryptedAmount: '0x0' as Hex,
                timestamp: Date.now(),
                processed: false,
            };

            const solanaTxHash = await relayToSolana(bridgeEvent, new Uint8Array(ciphertextBytes));

            if (solanaTxHash) {
                bridgeEvent.processed = true;
                pendingBridgeEvents.set(hash, bridgeEvent);
                completedRelays.set(hash.toLowerCase(), {
                    solanaTxHash,
                    baseTxHash: hash,
                    timestamp: Date.now(),
                });
                console.log(`   ✅ Relayed to Solana: ${solanaTxHash}`);
                return c.json({ success: true, baseTxHash: hash, solanaTxHash, message: 'Bridged via relayer (sender privacy preserved)' });
            }
        }

        // Return Base TX hash even if Solana relay hasn't happened yet
        return c.json({ success: true, baseTxHash: hash, message: 'Base TX confirmed, Solana relay pending' });

    } catch (error: any) {
        console.error('Error in /relay-bridge-to-solana:', error);
        return c.json({ error: error.message }, 500);
    }
});

/**
 * POST /relay-to-base
 * 
 * Frontend sends the decrypted plaintext amount (user already called Solana attested decrypt)
 * along with bridge details. Relayer re-encrypts for EVM using Inco zap.encrypt() and calls
 * faucetMint on the token contract.
 * 
 * Body: {
 *   solanaTxHash: "...",
 *   plaintextAmount: "1000000000000000000",  // string bigint
 *   destinationEvm: "0x...",    // EVM address to mint to
 *   localToken: "0x...",        // EVM token address
 * }
 */
app.post('/relay-to-base', async (c) => {
    try {
        const body = await c.req.json();
        const { solanaTxHash, plaintextAmount, destinationEvm, localToken } = body;

        if (!solanaTxHash || !plaintextAmount || !destinationEvm) {
            return c.json({ error: 'Missing required fields: solanaTxHash, plaintextAmount, destinationEvm' }, 400);
        }

        const tokenAddress = (localToken || CONFIDENTIAL_TOKEN_ADDRESS) as `0x${string}`;
        const destination = destinationEvm as `0x${string}`;
        const amount = BigInt(plaintextAmount);

        console.log(`\n📥 Received relay-to-base request:`);
        console.log(`   Solana TX: ${solanaTxHash}`);
        console.log(`   Plaintext Amount: ${plaintextAmount} (${Number(amount) / 1e18} tokens)`);
        console.log(`   Destination EVM: ${destination}`);
        console.log(`   Token: ${tokenAddress}`);

        // Step 1: Encrypt the plaintext for EVM using Inco zap.encrypt()
        // IMPORTANT: Create a FRESH zap instance each time to avoid stale state
        console.log(`   🔐 Encrypting for EVM via Inco...`);
        const { handleTypes } = await import("@inco/js");
        const zap = await Lightning.latest('devnet', 84532);

        const rawCiphertext = await zap.encrypt(amount, {
            accountAddress: evmAccount.address,
            dappAddress: tokenAddress,
            handleType: handleTypes.euint256,
        });

        // Normalize ciphertext to hex string for viem
        let ciphertext: `0x${string}`;
        if (typeof rawCiphertext === 'string') {
            ciphertext = (rawCiphertext.startsWith('0x')
                ? rawCiphertext
                : `0x${rawCiphertext}`) as `0x${string}`;
        } else if (typeof rawCiphertext === 'object' && rawCiphertext !== null && 'length' in rawCiphertext) {
            // Uint8Array or Buffer-like
            ciphertext = `0x${Buffer.from(rawCiphertext as any).toString('hex')}` as `0x${string}`;
        } else {
            throw new Error(`Unexpected ciphertext type: ${typeof rawCiphertext}`);
        }

        // Validate ciphertext format — expected ~288 bytes (576 hex chars + 0x prefix)
        const ctByteLength = (ciphertext.length - 2) / 2;
        console.log(`   ✅ EVM ciphertext ready (${ctByteLength} bytes, hex length: ${ciphertext.length})`);
        if (ctByteLength < 100 || ctByteLength > 1000) {
            console.warn(`   ⚠️ WARNING: Ciphertext size ${ctByteLength} bytes is outside expected range (100-1000). Expected ~288 bytes.`);
        }

        // Step 2: Inco fee — fixed at 0.001 ETH (matches contract's inco.getFee())
        const incoFee = BigInt("1000000000000000"); // 0.001 ETH
        console.log(`   💰 Inco fee: ${incoFee} wei`);

        // Step 3: Call faucetMint on the token contract
        // faucetMint is publicly callable and accepts Inco-encrypted ciphertext
        console.log(`   📤 Calling faucetMint on ${tokenAddress}...`);
        console.log(`   📝 Ciphertext preview: ${ciphertext.slice(0, 42)}...${ciphertext.slice(-10)}`);
        
        const FAUCET_MINT_ABI = parseAbi([
            "function faucetMint(address to, bytes encryptedAmount) external payable",
        ]);

        const hash = await evmWalletClient.writeContract({
            address: tokenAddress,
            abi: FAUCET_MINT_ABI,
            functionName: "faucetMint",
            args: [destination, ciphertext],
            value: incoFee,
        });

        console.log(`   ⏳ TX sent: ${hash}`);
        const receipt = await basePublicClient.waitForTransactionReceipt({ hash });

        if (receipt.status === "success") {
            console.log(`   ✅ Minted on Base! TX: ${hash}`);
            console.log(`   📍 Block: ${receipt.blockNumber}`);
            // Store completed mint for /tx/:hash polling
            completedBaseMints.set(solanaTxHash.toLowerCase(), {
                baseMintTxHash: hash,
                solanaTxHash,
                timestamp: Date.now(),
            });
            return c.json({ success: true, txHash: hash, message: 'Minted on Base' });
        } else {
            console.log(`   ❌ Transaction reverted`);
            return c.json({ error: 'Mint transaction reverted' }, 500);
        }
    } catch (error: any) {
        console.error('Error in /relay-to-base:', error);
        return c.json({ error: error.message }, 500);
    }
});

/**
 * POST /relay-bridge-out
 * 
 * SENDER PRIVACY for Solana → Base bridging.
 * 
 * Instead of the user calling bridge_confidential_out directly (which exposes their
 * wallet as the signer/fee payer), the user signs an off-chain Ed25519 message and
 * sends it to this endpoint. The relayer constructs a relay_bridge_confidential_out
 * transaction with an Ed25519 pre-instruction for on-chain signature verification.
 * 
 * Only the RELAYER's address appears on-chain as the signer — complete sender privacy!
 * 
 * Body: {
 *   ownerPubkey: "base58...",       // User's Solana pubkey
 *   tokenMint: "base58...",         // Token mint
 *   destinationEvm: "0x...",        // EVM destination
 *   encryptedAmount: "hex...",      // Encrypted amount (from @inco/solana-sdk)
 *   signature: "base64...",         // Ed25519 signature from signMessage
 *   nonce: number,                  // Replay protection
 *   deadline: number,               // Expiration timestamp
 *   plaintextAmount: "string",      // For relay-to-base step
 * }
 */
app.post('/relay-bridge-out', async (c) => {
    try {
        const body = await c.req.json();
        const { ownerPubkey, tokenMint, destinationEvm, encryptedAmount, signature, nonce, deadline, plaintextAmount } = body;

        if (!ownerPubkey || !destinationEvm || !encryptedAmount || !signature || !nonce || !deadline) {
            return c.json({ error: 'Missing required fields' }, 400);
        }

        console.log(`\n📥 Received relay-bridge-out request (SENDER PRIVACY):`);
        console.log(`   Owner: ${ownerPubkey}`);
        console.log(`   Destination EVM: ${destinationEvm}`);
        console.log(`   Nonce: ${nonce}`);
        console.log(`   Deadline: ${deadline}`);

        const ownerKey = new PublicKey(ownerPubkey);
        const mintKey = new PublicKey(tokenMint || "3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V");
        
        // Decode the Ed25519 signature from base64
        const signatureBytes = Buffer.from(signature, "base64");
        if (signatureBytes.length !== 64) {
            return c.json({ error: `Invalid signature length: ${signatureBytes.length}, expected 64` }, 400);
        }

        // Reconstruct the message that the user signed
        const evmAddressClean = destinationEvm.startsWith("0x")
            ? destinationEvm.slice(2)
            : destinationEvm;

        const nonceBuf = Buffer.alloc(8);
        nonceBuf.writeBigUInt64LE(BigInt(nonce), 0);
        const deadlineBuf = Buffer.alloc(8);
        deadlineBuf.writeBigInt64LE(BigInt(deadline), 0);

        const message = Buffer.concat([
            ownerKey.toBuffer(),                    // 32 bytes
            Buffer.from(evmAddressClean, "hex"),    // 20 bytes
            nonceBuf,                                // 8 bytes
            deadlineBuf,                             // 8 bytes
        ]);

        console.log(`   📝 Message length: ${message.length} bytes`);

        // Convert encrypted amount hex to bytes
        const encryptedAmountBytes = Buffer.from(encryptedAmount, "hex");
        console.log(`   🔐 Encrypted amount: ${encryptedAmountBytes.length} bytes`);

        // Get relayer's Solana keypair
        const payerKeypair = getSolanaWeb3Keypair();
        console.log(`   🔑 Relayer: ${payerKeypair.publicKey.toBase58()}`);

        // Derive PDAs
        const { keccak256: keccak256Hash } = await import("viem");
        const ownerHash = Buffer.from(keccak256Hash(new Uint8Array(ownerKey.toBuffer())).slice(2), "hex");

        const [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("confidential_vault"), ownerHash, mintKey.toBuffer()],
            BRIDGE_PROGRAM_ID
        );
        const [bridgeState] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge")],
            BRIDGE_PROGRAM_ID
        );

        // Check vault exists
        const solConnection = new Connection(config.solana.rpcUrl, "confirmed");
        const vaultAccountInfo = await solConnection.getAccountInfo(vaultPda);
        if (!vaultAccountInfo) {
            console.log(`   ❌ Vault doesn't exist for owner`);
            return c.json({ error: 'Vault does not exist. Initialize it first.' }, 400);
        }

        // Build Ed25519 pre-instruction for on-chain signature verification
        // Format: https://docs.solanalabs.com/runtime/programs#ed25519-program
        // struct Ed25519SignatureOffsets {
        //   signature_offset: u16,
        //   signature_instruction_index: u16,
        //   public_key_offset: u16,
        //   public_key_instruction_index: u16,
        //   message_data_offset: u16,
        //   message_data_size: u16,
        //   message_instruction_index: u16,
        // }
        const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");
        
        const headerSize = 2; // num_sigs(1) + padding(1)
        const sigDescriptorSize = 14; // 7 x u16 = 14 bytes per signature descriptor
        const dataStart = headerSize + sigDescriptorSize;
        
        const sigOffset = dataStart;
        const sigLen = 64;
        const pubkeyOffset = sigOffset + sigLen;
        const pubkeyLen = 32;
        const msgOffset = pubkeyOffset + pubkeyLen;
        const msgLen = message.length;

        // Use 0xFFFF for instruction_index to reference data within THIS instruction
        const CURRENT_IX = 0xFFFF;

        const ed25519Data = Buffer.alloc(dataStart + sigLen + pubkeyLen + msgLen);
        let offset = 0;
        // Header
        ed25519Data[offset++] = 1;   // num_sigs
        ed25519Data[offset++] = 0;   // padding
        // Signature descriptor (7 x u16)
        ed25519Data.writeUInt16LE(sigOffset, offset); offset += 2;      // signature_offset
        ed25519Data.writeUInt16LE(CURRENT_IX, offset); offset += 2;     // signature_instruction_index (0xFFFF = this ix)
        ed25519Data.writeUInt16LE(pubkeyOffset, offset); offset += 2;   // public_key_offset
        ed25519Data.writeUInt16LE(CURRENT_IX, offset); offset += 2;     // public_key_instruction_index
        ed25519Data.writeUInt16LE(msgOffset, offset); offset += 2;      // message_data_offset
        ed25519Data.writeUInt16LE(msgLen, offset); offset += 2;         // message_data_size
        ed25519Data.writeUInt16LE(CURRENT_IX, offset); offset += 2;     // message_instruction_index
        // Data section
        signatureBytes.copy(ed25519Data, sigOffset);
        ownerKey.toBuffer().copy(ed25519Data, pubkeyOffset);
        message.copy(ed25519Data, msgOffset);

        const ed25519Ix = new TransactionInstruction({
            programId: ED25519_PROGRAM_ID,
            keys: [],
            data: ed25519Data,
        });

        // Build relay_bridge_confidential_out instruction
        const crypto = await import("crypto");
        const discriminator = crypto.createHash("sha256")
            .update("global:relay_bridge_confidential_out")
            .digest()
            .slice(0, 8);

        // Destination EVM as 20 bytes
        const destinationBytes = Buffer.from(evmAddressClean, "hex");

        // Instruction data: discriminator + Vec<u8>(encrypted_amount) + [u8;20](destination) + Pubkey(vault_owner) + [u8;64](signature) + u64(nonce) + i64(deadline)
        const encLenBuf = Buffer.alloc(4);
        encLenBuf.writeUInt32LE(encryptedAmountBytes.length, 0);

        const sigBuf = Buffer.from(signatureBytes); // 64 bytes
        const nonceBufInst = Buffer.alloc(8);
        nonceBufInst.writeBigUInt64LE(BigInt(nonce), 0);
        const deadlineBufInst = Buffer.alloc(8);
        deadlineBufInst.writeBigInt64LE(BigInt(deadline), 0);

        const instructionData = Buffer.concat([
            discriminator,                           // 8 bytes
            encLenBuf,                               // 4 bytes (Vec length prefix)
            encryptedAmountBytes,                    // variable
            destinationBytes,                        // 20 bytes
            ownerKey.toBuffer(),                     // 32 bytes (vault_owner)
            sigBuf,                                  // 64 bytes (message_signature)
            nonceBufInst,                            // 8 bytes (nonce)
            deadlineBufInst,                         // 8 bytes (deadline)
        ]);

        // Instructions sysvar
        const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");

        const relayIx = new TransactionInstruction({
            programId: BRIDGE_PROGRAM_ID,
            keys: [
                { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },   // relayer
                { pubkey: bridgeState, isSigner: false, isWritable: false },             // bridge
                { pubkey: vaultPda, isSigner: false, isWritable: true },                 // vault
                { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },       // inco_lightning_program
                { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },     // instructions_sysvar
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            ],
            data: instructionData,
        });

        // Build and send transaction with Ed25519 pre-instruction + relay instruction
        console.log(`   🚀 Sending relay_bridge_confidential_out transaction...`);
        const { Transaction: SolTx, sendAndConfirmTransaction } = await import("@solana/web3.js");
        
        const tx = new SolTx();
        tx.add(ed25519Ix);  // Ed25519 signature verification (must come first!)
        tx.add(relayIx);    // relay_bridge_confidential_out

        const solanaTxHash = await sendAndConfirmTransaction(
            solConnection,
            tx,
            [payerKeypair],
            { commitment: "confirmed" }
        );

        console.log(`   ✅ Solana TX confirmed: ${solanaTxHash}`);
        console.log(`   🔒 Only relayer ${payerKeypair.publicKey.toBase58()} is visible on-chain!`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${solanaTxHash}?cluster=devnet`);

        return c.json({ 
            success: true, 
            solanaTxHash,
            message: 'Bridge-out submitted via relayer (sender privacy preserved)',
        });

    } catch (error: any) {
        console.error('Error in /relay-bridge-out:', error);
        return c.json({ error: error.message }, 500);
    }
});

/**
 * POST /authorize
 * 
 * DEPRECATED — Use /relay instead.
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
 * GET /tx/:hash
 * 
 * Frontend polls this to check relay completion.
 * Returns the target chain TX hash if the relay is done.
 */
app.get('/tx/:hash', (c) => {
    const hash = c.req.param('hash').toLowerCase();
    
    // Check Base→Solana relays
    const solanaRelay = completedRelays.get(hash);
    if (solanaRelay) {
        return c.json({ 
            status: 'completed',
            solanaTxHash: solanaRelay.solanaTxHash,
            baseTxHash: solanaRelay.baseTxHash,
        });
    }
    
    // Check Solana→Base relays
    const baseMint = completedBaseMints.get(hash);
    if (baseMint) {
        return c.json({ 
            status: 'completed',
            baseMintTxHash: baseMint.baseMintTxHash,
            solanaTxHash: baseMint.solanaTxHash,
        });
    }
    
    // Check if pending
    const pending = pendingBridgeEvents.get(hash);
    if (pending) {
        return c.json({ status: pending.processed ? 'completed' : 'pending' });
    }
    
    return c.json({ status: 'unknown' }, 404);
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
            toSolanaHash: e.toSolanaHash || ('0x0' as Hex),
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
        const zap = await createZap();
        
        console.log(`   📤 Requesting attested decrypt with user's signature...`);
        
        // The Inco SDK needs to use the pre-signed authorization
        // We need to call the lower-level API directly with the signature
        const decryptResults = await (zap as any).attestedDecryptWithSignature(
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
        const solanaTxHash = await relayToSolana(bridgeEvent, new Uint8Array(ciphertextBytes));

        if (solanaTxHash) {
            auth.processed = true;
            bridgeEvent.processed = true;
            completedRelays.set(bridgeEvent.txHash.toLowerCase(), {
                solanaTxHash,
                baseTxHash: bridgeEvent.txHash,
                timestamp: Date.now(),
            });
            console.log(`   ✅ Successfully relayed to Solana!`);
        }

        return !!solanaTxHash;
    } catch (error: any) {
        console.error(`   ❌ Failed to process:`, error.message);
        
        if (error.message?.includes('attestedDecryptWithSignature')) {
            console.error(`   ❌ Inco SDK doesn't support pre-signed auth yet.`);
            console.error(`   Cannot relay without real amount.`);
        }
        
        return false;
    }
}

/**
 * Send the relay transaction to Solana
 */
async function relayToSolana(bridgeEvent: BridgeEvent, encryptedAmountBytes: Uint8Array): Promise<string | null> {
    try {
        const recipientPubkey = bytes32ToPublicKey(bridgeEvent.toSolana);
        // Use the known Solana token mint (not from remoteToken which may be 0x0 for /relay calls)
        const SOLANA_TOKEN_MINT = new PublicKey("3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V");
        const tokenMint = SOLANA_TOKEN_MINT;
        
        console.log(`   🚀 Relaying to Solana:`);
        console.log(`      Recipient: ${recipientPubkey.toBase58()}`);
        console.log(`      Token Mint: ${tokenMint.toBase58()}`);

        // Find PDAs
        // Hash owner with keccak256 for privacy-preserving PDA (matches Rust program)
        const { keccak256: keccak256Hash } = await import("viem");
        const ownerHash = Buffer.from(keccak256Hash(new Uint8Array(recipientPubkey.toBuffer())).slice(2), "hex");

        const [vaultPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("confidential_vault"),
                ownerHash,
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
            console.log(`   ⚠️ Vault doesn't exist for recipient ${recipientPubkey.toBase58()}`);
            console.log(`   Vault PDA: ${vaultPda.toBase58()}`);
            console.log(`   The recipient must initialize a ConfidentialVault first.`);
            return null;
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

        console.log(`   📦 Instruction data: ${instructionData.length} bytes`);

        // Get Solana keypair for signing
        const payerKeypair = getSolanaWeb3Keypair();
        console.log(`   🔑 Using Solana payer: ${payerKeypair.publicKey.toBase58()}`);

        const { Transaction, sendAndConfirmTransaction, TransactionInstruction: TxIx } = await import("@solana/web3.js");

        const instruction = new TxIx({
            programId: BRIDGE_PROGRAM_ID,
            keys: [
                { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },   // relayer
                { pubkey: bridgeState, isSigner: false, isWritable: false },             // bridge
                { pubkey: bridgeAuthority, isSigner: false, isWritable: true },          // bridge_authority
                { pubkey: vaultPda, isSigner: false, isWritable: true },                 // vault
                { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },       // inco_lightning_program
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            ],
            data: instructionData,
        });

        console.log(`   🚀 Sending Solana transaction...`);
        const tx = new Transaction().add(instruction);
        const signature = await sendAndConfirmTransaction(
            connection,
            tx,
            [payerKeypair],
            { commitment: "confirmed" }
        );

        console.log(`   ✅ Solana TX confirmed: ${signature}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

        bridgeEvent.processed = true;
        return signature;

    } catch (error: any) {
        console.error(`   ❌ Relay failed:`, error.message);
        if (error.logs) {
            console.error(`   Logs:`);
            error.logs.forEach((log: string) => console.error(`      ${log}`));
        }
        return null;
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
                        console.log(`   To (hash): ${args.toSolanaHash}`);

                        const bridgeEvent: BridgeEvent = {
                            txHash: log.transactionHash as Hex,
                            nonce: args.nonce,
                            localToken: args.localToken,
                            remoteToken: args.remoteToken,
                            toSolana: '0x0' as Hex, // Unknown — will be set when /relay is called
                            toSolanaHash: args.toSolanaHash,
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
║          Privacy Relayer Server (Base ↔ Solana)              ║
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
  GET  /health                - Server status
  POST /relay                 - Submit decrypted plaintext for Solana relay (Base → Solana)
  POST /relay-bridge-to-solana - Bridge Base→Solana via relayer (EVM SENDER PRIVACY)
  POST /relay-to-base         - Submit decrypted plaintext for Base minting (Solana → Base)
  POST /relay-bridge-out      - Relay bridge-out from Solana via relayer (SOLANA SENDER PRIVACY)
  POST /authorize             - (deprecated) Submit decrypt authorization
  GET  /status/:handle        - Check authorization status
  GET  /tx/:hash              - Check relay completion by TX hash
  GET  /pending               - List pending bridge events
`);
