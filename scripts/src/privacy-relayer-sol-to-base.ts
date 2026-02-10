#!/usr/bin/env bun
/**
 * Privacy Relayer: Solana → Base
 * 
 * Monitors ConfidentialBridgeOutEvent on Solana and relays encrypted transfers to Base.
 * This is the privacy-preserving counterpart to auto-relayer.ts.
 * 
 * Flow:
 * 1. Parse ConfidentialBridgeOutEvent to get handle
 * 2. Call grant_handle_access to enable attested decrypt
 * 3. Use official Inco SDK to decrypt the handle
 * 4. Mint the real decrypted amount on Base
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts --monitor
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts <SOLANA_TX_SIG>
 */

import {
    createSolanaRpc,
    getProgramDerivedAddress,
    type Address as SolanaAddress,
} from "@solana/kit";
import {
    createPublicClient,
    createWalletClient,
    http,
    toHex,
    type Address,
    type Hash,
    type Hex,
    parseAbi,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
    Connection,
    PublicKey,
    Keypair,
    SystemProgram,
    TransactionInstruction,
    Transaction,
    sendAndConfirmTransaction
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import { CONFIGS } from "@internal/constants";
import { getSolanaCliConfigKeypairSigner, getIdlConstant } from "@internal/sol";

const DEPLOY_ENV = "testnet-alpha" as const;
const config = CONFIGS[DEPLOY_ENV];

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Deployed addresses (from base/deployments/base_sepolia.json and .cdark-deployment.json)
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x04423E2D4e74b8C5D17730143400ca43fC800f73" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xeC7f5bDafE9934658d717E9a13Ae4259858b5F0b" as Address;

// Bridge Program ID
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

// Inco Lightning Program ID
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// Load Solana wallet - support both env var and file
let solanaWallet: Keypair;
if (process.env.SOLANA_PRIVATE_KEY) {
    // Parse from env var (JSON array format)
    const keypairData = JSON.parse(process.env.SOLANA_PRIVATE_KEY);
    solanaWallet = Keypair.fromSecretKey(new Uint8Array(keypairData), { skipValidation: true });
    console.log(`🔑 Loaded Solana wallet from SOLANA_PRIVATE_KEY env var: ${solanaWallet.publicKey.toBase58()}`);
} else {
    // Fall back to file
    const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    solanaWallet = Keypair.fromSecretKey(new Uint8Array(keypairData), { skipValidation: true });
}

// Optional: Load a separate keypair for decryption (the vault owner's keypair)
// This allows the relayer to decrypt handles owned by a different wallet
let decryptionWallet = solanaWallet;
if (process.env.SOLANA_DECRYPT_KEYPAIR) {
    try {
        const decryptKeypairPath = process.env.SOLANA_DECRYPT_KEYPAIR;
        const decryptKeypairData = JSON.parse(fs.readFileSync(decryptKeypairPath, "utf-8"));
        decryptionWallet = Keypair.fromSecretKey(new Uint8Array(decryptKeypairData));
        console.log(`\n🔑 Using custom decryption keypair: ${decryptionWallet.publicKey.toBase58()}`);
    } catch (e: any) {
        console.log(`⚠️ Failed to load SOLANA_DECRYPT_KEYPAIR, using default: ${e.message}`);
    }
}


// --- Viem Clients ---
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const baseWalletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// --- ABIs ---
const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "function receiveFromSolanaLegacy(address localToken, address to, bytes encryptedAmount) external payable",
    "function getIncoFee() external view returns (uint256)",
    "event ConfidentialBridgeReceived(uint256 indexed nonce, address indexed localToken, bytes32 indexed toHash, bytes32 encryptedAmount)",
]);

const CONFIDENTIAL_TOKEN_ABI = parseAbi([
    "function faucetMint(address to, bytes encryptedAmount) external payable",
]);

console.log("=== Privacy Relayer (Solana → Base) ===");
console.log(`EVM Signer: ${evmAccount.address}`);
console.log(`Confidential Bridge: ${CONFIDENTIAL_BRIDGE_ADDRESS}`);
console.log(`Confidential Token: ${CONFIDENTIAL_TOKEN_ADDRESS}`);

// --- Event Parsing ---
interface ConfidentialBridgeOutEvent {
    vault: string;
    ownerHash: string; // keccak256 hash hex (not a raw pubkey)
    destinationEvm: Uint8Array;
    encryptedAmountHandle: bigint;
}

/**\n * Parse ConfidentialBridgeOutEvent from Solana transaction logs.
 * 
 * Event structure (from instructions.rs):
 * - vault: Pubkey
 * - owner_hash: [u8; 32] (keccak256 of owner pubkey)
 * - destination_evm: [u8; 20]
 * - encrypted_amount_handle: u128
 */
function parseConfidentialBridgeOutEvent(logs: string[]): ConfidentialBridgeOutEvent | null {
    // Anchor event discriminator for ConfidentialBridgeOutEvent
    // sha256("event:ConfidentialBridgeOutEvent")[0:8] = fee3f47c36edab41
    const EXPECTED_DISCRIMINATOR = Buffer.from("fee3f47c36edab41", "hex");

    // Look for Anchor event discriminator for ConfidentialBridgeOutEvent
    // Format: "Program data: <base64 encoded data>"
    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const base64Data = log.replace("Program data: ", "");
                const data = Buffer.from(base64Data, "base64");

                // Check event discriminator (first 8 bytes)
                const discriminator = data.subarray(0, 8);
                if (!discriminator.equals(EXPECTED_DISCRIMINATOR)) {
                    continue; // Not our event, skip
                }

                // Event discriminator (first 8 bytes) + payload
                // We need to match the event structure from Rust
                if (data.length >= 8 + 32 + 32 + 20 + 16) {
                    // Skip discriminator (8 bytes)
                    let offset = 8;

                    // vault: Pubkey (32 bytes)
                    const vault = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
                    offset += 32;

                    // owner_hash: [u8; 32] (keccak256 hash, NOT a pubkey)
                    const ownerHash = Buffer.from(data.subarray(offset, offset + 32)).toString('hex');
                    offset += 32;

                    // destination_evm: [u8; 20]
                    const destinationEvm = data.subarray(offset, offset + 20);
                    offset += 20;

                    // encrypted_amount_handle: u128 (16 bytes, little endian)
                    const handleBytes = data.subarray(offset, offset + 16);
                    const encryptedAmountHandle = readU128LE(handleBytes);

                    return {
                        vault,
                        ownerHash,
                        destinationEvm,
                        encryptedAmountHandle,
                    };
                }
            } catch (e) {
                // Not the event we're looking for
            }
        }
    }
    return null;
}

/**
 * Interface for RelayedPrivateBridgeOutEvent (no owner/vault for sender privacy)
 */
interface RelayedPrivateBridgeOutEvent {
    destinationEvm: Uint8Array;
    encryptedAmountHandle: bigint;
}

/**
 * Parse RelayedPrivateBridgeOutEvent from Solana transaction logs.
 * This is the SENDER-PRIVATE version that doesn't include owner/vault.
 * 
 * Event structure:
 * - destination_evm: [u8; 20]
 * - encrypted_amount_handle: u128
 */
function parseRelayedPrivateBridgeOutEvent(logs: string[]): RelayedPrivateBridgeOutEvent | null {
    // sha256("event:RelayedPrivateBridgeOutEvent")[0:8]
    // Computed: sha256("event:RelayedPrivateBridgeOutEvent") in hex
    const EXPECTED_DISCRIMINATOR = Buffer.from(computeAnchorEventDiscriminator("RelayedPrivateBridgeOutEvent"));

    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const base64Data = log.replace("Program data: ", "");
                const data = Buffer.from(base64Data, "base64");

                const discriminator = data.subarray(0, 8);
                if (!discriminator.equals(EXPECTED_DISCRIMINATOR)) {
                    continue;
                }

                // Event: destination_evm (20 bytes) + encrypted_amount_handle (16 bytes)
                if (data.length >= 8 + 20 + 16) {
                    let offset = 8;

                    const destinationEvm = data.subarray(offset, offset + 20);
                    offset += 20;

                    const handleBytes = data.subarray(offset, offset + 16);
                    const encryptedAmountHandle = readU128LE(handleBytes);

                    return {
                        destinationEvm,
                        encryptedAmountHandle,
                    };
                }
            } catch (e) {
                // Not the event we're looking for
            }
        }
    }
    return null;
}

/**
 * Compute Anchor event discriminator (sha256("event:<name>")[0:8])
 */
function computeAnchorEventDiscriminator(eventName: string): Uint8Array {
    const hash = crypto.createHash("sha256");
    hash.update(`event:${eventName}`);
    return new Uint8Array(hash.digest().subarray(0, 8));
}

/**
 * Read a u128 little-endian from buffer.
 */
function readU128LE(buffer: Uint8Array): bigint {
    let result = BigInt(0);
    for (let i = 0; i < Math.min(16, buffer.length); i++) {
        result += BigInt(buffer[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

/**
 * Convert u128 handle to bytes32 for EVM.
 * Pads with zeros on the left to make 32 bytes.
 */
function handleToBytes32(handle: bigint): Hex {
    const hex = handle.toString(16).padStart(32, "0"); // 128 bits = 32 hex chars
    return ("0x" + hex.padStart(64, "0")) as Hex; // 256 bits = 64 hex chars
}

/**
 * Convert Euint128 handle to encrypted bytes for EVM.
 * For cross-chain, we create a "passthrough" ciphertext that encodes the handle directly.
 * 
 * NOTE: In production, this would need proper handle conversion between SVM and EVM.
 * For the hackathon demo, we send the raw handle bytes.
 */
function handleToEncryptedBytes(handle: bigint): Hex {
    // Convert u128 to 16 bytes (little-endian as stored in Solana)
    const buffer = Buffer.alloc(16);
    let remaining = handle;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    return toHex(buffer);
}

// Inco covalidator endpoint for attested decryption
const INCO_ATTESTED_DECRYPT_ENDPOINT = "https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/getDecryptAttested";

interface AttestedDecryptResult {
    handle: string;
    plaintext: bigint;
    signature: string;
}

/**
 * Request attested decryption from Inco covalidator.
 * 
 * This decrypts the Solana handle and returns:
 * - plaintext: The actual decrypted amount
 * - signature: Covalidator signature for on-chain verification
 * 
 * @param handle - The Euint128 handle from Solana (u128)
 * @param ownerAddress - The Solana wallet that owns the encrypted value
 * @param signMessage - Function to sign messages with the wallet
 */
async function requestAttestedDecrypt(
    handle: bigint,
    ownerAddress: string,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<AttestedDecryptResult> {
    // Sign the handle to prove ownership
    const handleStr = handle.toString();
    const messageBytes = new TextEncoder().encode(handleStr);
    const signatureBytes = await signMessage(messageBytes);
    const callerSignature = Buffer.from(signatureBytes).toString('base64');

    console.log(`   Requesting attested decrypt for handle: ${handle}`);
    console.log(`   Owner: ${ownerAddress}`);

    const response = await fetch(INCO_ATTESTED_DECRYPT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            handle: handleStr,
            address: ownerAddress,
            signature: callerSignature,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Attested decrypt failed: ${errorText}`);
    }

    const data = await response.json() as any;

    if (!data.plaintext) {
        throw new Error("No plaintext in attested decrypt response");
    }

    return {
        handle: data.handle_value || handleStr,
        plaintext: BigInt(data.plaintext),
        signature: data.signature,
    };
}

/**
 * Alternative: Request attested decrypt without wallet signature (for testing).
 * This may work for handles that were created with "allow anyone" permissions.
 */
async function requestAttestedDecryptSimple(handle: bigint): Promise<AttestedDecryptResult | null> {
    console.log(`   Attempting simple attested decrypt for handle: ${handle}`);

    try {
        // Try fetching from the encryption API directly
        const response = await fetch(`https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/decrypt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                handle: handle.toString(),
            }),
        });

        if (!response.ok) {
            console.log(`   Simple decrypt not available: ${response.status}`);
            return null;
        }

        const data = await response.json() as any;
        return {
            handle: handle.toString(),
            plaintext: BigInt(data.plaintext || data.value || 0),
            signature: data.signature || "",
        };
    } catch (e) {
        console.log(`   Simple decrypt failed: ${e}`);
        return null;
    }
}

/**
 * Helper to convert handle to little-endian buffer
 */
function handleToBuffer(handle: bigint): Buffer {
    const buffer = Buffer.alloc(16);
    let remaining = handle;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    return buffer;
}

/**
 * Compute Anchor instruction discriminator
 */
function computeDiscriminator(name: string): Buffer {
    const hash = crypto.createHash("sha256");
    hash.update(name);
    return Buffer.from(hash.digest().subarray(0, 8));
}

/**
 * Derive the allowance PDA for Inco Lightning
 */
function deriveAllowancePDA(handle: bigint, allowedAddress: PublicKey): [PublicKey, number] {
    const handleBuffer = handleToBuffer(handle);
    return PublicKey.findProgramAddressSync(
        [handleBuffer, allowedAddress.toBuffer()],
        INCO_LIGHTNING_ID
    );
}

/**
 * Call grant_handle_access on Solana to enable attested decrypt
 */
async function grantHandleAccess(handle: bigint, owner: PublicKey): Promise<string> {
    console.log(`   📝 Granting handle access for: ${handle}`);
    console.log(`      Using decryption wallet: ${decryptionWallet.publicKey.toBase58()}`);

    const connection = new Connection(config.solana.rpcUrl, "confirmed");

    // Derive allowance PDA
    const [allowancePDA] = deriveAllowancePDA(handle, owner);
    console.log(`      Allowance PDA: ${allowancePDA.toBase58()}`);

    // Build instruction
    const discriminator = computeDiscriminator("global:grant_handle_access");
    const handleBuffer = handleToBuffer(handle);
    const instructionData = Buffer.concat([discriminator, handleBuffer]);

    // Use decryptionWallet as the signer (it's the owner)
    const accounts = [
        { pubkey: decryptionWallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: allowancePDA, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
    ];

    const instruction = new TransactionInstruction({
        keys: accounts,
        programId: BRIDGE_PROGRAM_ID,
        data: instructionData,
    });

    const tx = new Transaction().add(instruction);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = decryptionWallet.publicKey;

    const sig = await sendAndConfirmTransaction(connection, tx, [decryptionWallet], {
        commitment: "confirmed",
    });

    console.log(`      ✅ Handle access granted: ${sig}`);
    return sig;
}

/**
 * Use official Inco SDK to decrypt handle
 */
async function decryptWithOfficialSDK(handle: bigint): Promise<bigint | null> {
    try {
        const { decrypt } = await import("@inco/solana-sdk/attested-decrypt");
        const nacl = await import("tweetnacl");

        // Use decryptionWallet (which may be different from solanaWallet if SOLANA_DECRYPT_KEYPAIR is set)
        const walletAdapter = {
            publicKey: decryptionWallet.publicKey,
            signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
                return nacl.sign.detached(message, decryptionWallet.secretKey);
            },
        };

        console.log(`   🔓 Decrypting handle with official SDK...`);
        console.log(`      Decryption wallet: ${decryptionWallet.publicKey.toBase58()}`);

        const result = await decrypt([handle.toString()], {
            address: decryptionWallet.publicKey,
            signMessage: walletAdapter.signMessage,
        });

        if (result.plaintexts && result.plaintexts.length > 0) {
            const plaintext = BigInt(result.plaintexts[0] ?? "0");
            console.log(`      ✅ Decrypted: ${plaintext} tokens`);
            return plaintext;
        }

        return null;
    } catch (e: any) {
        console.log(`      ❌ SDK decrypt failed: ${e.message}`);
        return null;
    }
}

/**
 * Relay a confidential bridge message from Solana to Base.
 * @param txSignature - The Solana TX signature containing the bridge event
 * @param plaintextAmountWei - Optional pre-decrypted amount (from user's attested decrypt)
 */
async function relayConfidentialToBase(txSignature: string, plaintextAmountWei?: bigint): Promise<boolean> {
    console.log(`\n=== Processing Solana TX: ${txSignature} ===`);

    try {
        const connection = new Connection(config.solana.rpcUrl, "confirmed");

        // 1. Get transaction details
        const tx = await connection.getTransaction(txSignature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
            console.log("   ❌ Transaction not found");
            return false;
        }

        const logs = tx.meta?.logMessages || [];
        console.log(`   Found ${logs.length} log messages`);

        // 2. Parse events - try encrypted event types
        const regularEvent = parseConfidentialBridgeOutEvent(logs);
        const privateEvent = !regularEvent ? parseRelayedPrivateBridgeOutEvent(logs) : null;

        // Create unified event structure
        let destinationEvm: Uint8Array;
        let encryptedAmountHandle: bigint;
        let plaintextAmount: bigint | null = null;

        if (regularEvent) {
            console.log(`   ✅ Found ConfidentialBridgeOutEvent:`);
            console.log(`      Vault: ${regularEvent.vault}`);
            console.log(`      Owner Hash: ${regularEvent.ownerHash}`);
            destinationEvm = regularEvent.destinationEvm;
            encryptedAmountHandle = regularEvent.encryptedAmountHandle;
        } else if (privateEvent) {
            console.log(`   ✅ Found RelayedPrivateBridgeOutEvent: (SENDER HIDDEN!)`);
            destinationEvm = privateEvent.destinationEvm;
            encryptedAmountHandle = privateEvent.encryptedAmountHandle;
        } else {
            console.log("   ❌ No bridge event found");
            console.log("   Logs:", logs.slice(0, 10));
            return false;
        }

        console.log(`      Destination EVM: 0x${Buffer.from(destinationEvm).toString("hex")}`);
        console.log(`      Encrypted Handle: ${encryptedAmountHandle}`);

        // 3. Convert destination address
        const destinationAddress = ("0x" + Buffer.from(destinationEvm).toString("hex")) as Address;

        // 4. Get Inco fee on Base
        let incoFee: bigint;
        try {
            incoFee = await basePublicClient.readContract({
                address: CONFIDENTIAL_BRIDGE_ADDRESS,
                abi: CONFIDENTIAL_BRIDGE_ABI,
                functionName: "getIncoFee",
            });
        } catch {
            // Default fee
            incoFee = BigInt("100000000000000"); // 0.0001 ETH
        }
        console.log(`   Inco fee: ${incoFee} wei`);

        // 5. Decrypt the encrypted handle to get the real amount
        let amountToMint: bigint;

        if (plaintextAmountWei && plaintextAmountWei > 0n) {
            // Pre-decrypted amount provided (from user's attested decrypt via frontend)
            console.log(`   ✅ Using pre-decrypted amount: ${plaintextAmountWei} (${Number(plaintextAmountWei) / 1e18} tokens)`);
            amountToMint = plaintextAmountWei;
        } else {
            try {
                console.log(`   🔓 Attempting to decrypt handle...`);

                // Try simple decrypt (for handles with public allow or relayer access)
                const simpleResult = await requestAttestedDecryptSimple(encryptedAmountHandle);

                if (simpleResult !== null && simpleResult.plaintext > 0n) {
                    console.log(`   ✅ Real amount decrypted: ${simpleResult.plaintext} tokens`);
                    amountToMint = simpleResult.plaintext;
                } else {
                    // Try with official SDK using the decryption wallet
                    console.log(`   📝 Simple decrypt failed, trying with SDK...`);
                    const plaintext = await decryptWithOfficialSDK(encryptedAmountHandle);

                    if (plaintext !== null && plaintext > 0n) {
                        console.log(`   ✅ Real amount decrypted via SDK: ${plaintext} tokens`);
                        amountToMint = plaintext;
                    } else {
                        console.error(`   ❌ Cannot decrypt handle. Owner needs to grant relayer access.`);
                        console.error(`   Skipping this transaction.`);
                        return false;
                    }
                }
            } catch (e: any) {
                console.error(`   ❌ Decrypt failed: ${e.message}`);
                console.error(`   Cannot relay without real amount. Skipping this transaction.`);
                return false;
            }
        }

        console.log(`   Amount to mint: ${amountToMint} tokens`);
        console.log(`   (Original Solana handle: ${encryptedAmountHandle})`);

        // 6. Re-encrypt the plaintext for EVM using Inco zap.encrypt() and call faucetMint
        // faucetMint is publicly callable (no access control) and accepts Inco-encrypted ciphertext
        console.log("   Minting on Base via faucetMint with Inco-encrypted ciphertext...");

        const { Lightning: LightningEvm } = await import("@inco/js/lite");
        const { supportedChains: evmSupportedChains, handleTypes } = await import("@inco/js");
        const evmZap = await LightningEvm.latest("devnet", evmSupportedChains.baseSepolia);

        const evmCiphertext = await evmZap.encrypt(amountToMint, {
            accountAddress: evmAccount.address,
            dappAddress: CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}`,
            handleType: handleTypes.euint256,
        });

        console.log(`   ✅ EVM ciphertext ready (${evmCiphertext.length} bytes)`);

        const FAUCET_MINT_ABI = parseAbi([
            "function faucetMint(address to, bytes encryptedAmount) external payable",
        ]);

        // Retry with fresh nonce up to 3 times
        let hash: `0x${string}` | null = null;
        let lastError: any = null;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                // Get fresh nonce on each attempt - use "pending" to include mempool txs
                const nonce = await basePublicClient.getTransactionCount({
                    address: evmAccount.address,
                    blockTag: "pending",
                });
                console.log(`   Attempt ${attempt}: Using nonce ${nonce}`);

                hash = await baseWalletClient.writeContract({
                    address: CONFIDENTIAL_TOKEN_ADDRESS,
                    abi: FAUCET_MINT_ABI,
                    functionName: "faucetMint",
                    args: [destinationAddress, evmCiphertext],
                    value: incoFee,
                    nonce: nonce,
                });
                
                console.log(`   ✅ Minted on Base: ${hash}`);
                break; // Success, exit retry loop
            } catch (txError: any) {
                lastError = txError;
                if (txError.message?.includes("nonce") && attempt < 3) {
                    console.log(`   ⚠️ Nonce error, retrying in 2s...`);
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    throw txError;
                }
            }
        }

        if (!hash) {
            throw lastError || new Error("Failed to send transaction after retries");
        }

        // 7. Wait for confirmation
        const receipt = await basePublicClient.waitForTransactionReceipt({ hash });
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

        return true;

    } catch (error: any) {
        console.error(`   ❌ Error: ${error.message}`);
        if (error.cause) {
            console.error(`   Cause: ${JSON.stringify(error.cause)}`);
        }
        return false;
    }
}

/**
 * Monitor mode - watch for new confidential bridge events on Solana.
 */
async function monitorMode() {
    console.log("\n=== Monitor Mode ===");
    console.log("Watching for ConfidentialBridgeOutEvent events on Solana...\n");

    const connection = new Connection(config.solana.rpcUrl, "confirmed");

    // Get the latest slot to start from
    let lastSlot = await connection.getSlot();
    console.log(`Starting from slot: ${lastSlot}`);

    // Poll for new transactions
    while (true) {
        try {
            const currentSlot = await connection.getSlot();

            if (currentSlot > lastSlot) {
                // Get signatures for the bridge program
                const signatures = await connection.getSignaturesForAddress(
                    BRIDGE_PROGRAM_ID,
                    { limit: 10 },
                    "confirmed"
                );

                // Process new signatures
                for (const sig of signatures) {
                    if (sig.slot > lastSlot) {
                        console.log(`\n[${new Date().toISOString()}] New TX: ${sig.signature}`);

                        // Check if it's a confidential bridge out event
                        const tx = await connection.getTransaction(sig.signature, {
                            commitment: "confirmed",
                            maxSupportedTransactionVersion: 0,
                        });

                        if (tx) {
                            const logs = tx.meta?.logMessages || [];
                            const regularEvent = parseConfidentialBridgeOutEvent(logs);
                            const privateEvent = parseRelayedPrivateBridgeOutEvent(logs);

                            if (regularEvent) {
                                console.log("   📦 Confidential bridge event detected!");
                                await relayConfidentialToBase(sig.signature);
                            } else if (privateEvent) {
                                console.log("   🔒 PRIVATE bridge event detected (sender hidden)!");
                                await relayConfidentialToBase(sig.signature);
                            }
                        }
                    }
                }

                lastSlot = currentSlot;
            }

            // Show heartbeat
            console.log(`[${new Date().toISOString()}] Slot: ${currentSlot}`);
            await new Promise((r) => setTimeout(r, 10000)); // 10 second polling

        } catch (error: any) {
            console.error(`Monitor error: ${error.message}`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

/**
 * Demo mode - simulate a privacy bridge flow.
 */
async function demoMode() {
    console.log("\n=== Privacy Bridge Demo ===");
    console.log(`
This relayer monitors ConfidentialBridgeOutEvent on Solana and relays them to Base.

Flow:
1. User encrypts amount on Solana using @inco/solana-sdk
2. User calls bridge_confidential_out() on Solana bridge program
3. This burns encrypted tokens and emits ConfidentialBridgeOutEvent
4. Relayer picks up event and calls receiveFromSolana() on Base
5. Base ConfidentialBridge mints encrypted tokens to recipient

To test:
1. Initialize a confidential vault on Solana
2. Deposit tokens to get encrypted balance
3. Bridge out with encrypted amount
4. Run this relayer in monitor mode
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

    // Parse --amount flag (pre-decrypted plaintext from user's attested decrypt)
    let plaintextAmountWei: bigint | undefined;
    const amountFlagIndex = process.argv.indexOf("--amount");
    if (amountFlagIndex !== -1 && process.argv[amountFlagIndex + 1]) {
        const amountStr = process.argv[amountFlagIndex + 1]!;
        plaintextAmountWei = BigInt(amountStr);
        console.log(`📝 Pre-decrypted amount provided: ${plaintextAmountWei} wei`);
    }

    if (arg === "--monitor") {
        await monitorMode();
    } else if (arg === "--demo") {
        await demoMode();
    } else if (arg && arg.length > 50) {
        // Looks like a Solana transaction signature
        await relayConfidentialToBase(arg, plaintextAmountWei);
    } else {
        console.log("\nUsage:");
        console.log("  Monitor mode:     bun run src/privacy-relayer-sol-to-base.ts --monitor");
        console.log("  Process TX:       bun run src/privacy-relayer-sol-to-base.ts <SOLANA_TX_SIGNATURE>");
        console.log("  Process TX (pre-decrypted): bun run src/privacy-relayer-sol-to-base.ts <SOLANA_TX_SIGNATURE> --amount <WEI>");
        console.log("  Demo info:        bun run src/privacy-relayer-sol-to-base.ts --demo");
    }
}

main().catch(console.error);