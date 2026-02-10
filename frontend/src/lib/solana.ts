/* eslint-disable @typescript-eslint/no-unused-vars */
import {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
} from "@solana/web3.js";
import { BRIDGE_PROGRAM_ID, SOLANA_RPC_URL, SOLANA_CDARK_TOKEN_MINT, INCO_LIGHTNING_PROGRAM_ID } from "./constants";
import crypto from "crypto";
import { keccak256 } from "viem";

// Inco Lightning Program ID on Solana Devnet
const INCO_LIGHTNING_ID = new PublicKey(INCO_LIGHTNING_PROGRAM_ID);

// Vault seed prefix (must match Solana program)
const VAULT_SEED_PREFIX = "confidential_vault";

// Bridge authority seed
const BRIDGE_AUTHORITY_SEED = "bridge_authority";

// ConfidentialVault account size (from Solana program)
const VAULT_SIZE = 113;

/**
 * Get the Solana connection
 */
export function getConnection(): Connection {
    return new Connection(SOLANA_RPC_URL, "confirmed");
}

/**
 * Derive the vault PDA for a user and token mint
 */
/**
 * Hash owner pubkey with keccak256 for privacy-preserving PDA derivation.
 * Matches Rust: anchor_lang::solana_program::keccak::hash(owner.as_ref())
 */
export function hashOwner(owner: PublicKey): Buffer {
    const hashHex = keccak256(new Uint8Array(owner.toBuffer()));
    return Buffer.from(hashHex.slice(2), "hex");
}

export function deriveVaultPda(owner: PublicKey, tokenMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from(VAULT_SEED_PREFIX),
            hashOwner(owner),
            tokenMint.toBuffer(),
        ],
        new PublicKey(BRIDGE_PROGRAM_ID)
    );
}

/**
 * Derive the bridge authority PDA
 */
export function deriveBridgeAuthorityPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [Buffer.from(BRIDGE_AUTHORITY_SEED)],
        new PublicKey(BRIDGE_PROGRAM_ID)
    );
}

/**
 * Check if a vault exists for the given owner and token mint
 */
export async function checkVaultExists(
    connection: Connection,
    owner: PublicKey,
    tokenMint: PublicKey
): Promise<boolean> {
    const [vaultPda] = deriveVaultPda(owner, tokenMint);
    const accountInfo = await connection.getAccountInfo(vaultPda);
    return accountInfo !== null;
}

/**
 * Compute Anchor instruction discriminator
 * discriminator = sha256("global:<instruction_name>")[0:8]
 */
function computeDiscriminator(instructionName: string): Buffer {
    const hash = crypto.createHash("sha256");
    hash.update(`global:${instructionName}`);
    return Buffer.from(hash.digest().subarray(0, 8));
}

/**
 * Build the initialize_confidential_vault instruction
 */
export function buildInitializeVaultInstruction(
    owner: PublicKey,
    tokenMint: PublicKey
): TransactionInstruction {
    const [vaultPda, vaultBump] = deriveVaultPda(owner, tokenMint);
    const [bridgeAuthority] = deriveBridgeAuthorityPda();

    // Anchor discriminator for "initialize_confidential_vault"
    const discriminator = computeDiscriminator("initialize_confidential_vault");

    // Instruction data is just the discriminator (no additional args)
    const instructionData = discriminator;

    return new TransactionInstruction({
        programId: new PublicKey(BRIDGE_PROGRAM_ID),
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },           // owner
            { pubkey: tokenMint, isSigner: false, isWritable: false },     // token_mint
            { pubkey: bridgeAuthority, isSigner: false, isWritable: false }, // bridge_authority
            { pubkey: vaultPda, isSigner: false, isWritable: true },       // vault
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false }, // inco_lightning_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data: instructionData,
    });
}

/**
 * Initialize a confidential vault for the user
 * Returns the transaction signature if successful
 */
export async function initializeVault(
    connection: Connection,
    owner: PublicKey,
    tokenMint: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<string> {
    // Check if vault already exists
    const exists = await checkVaultExists(connection, owner, tokenMint);
    if (exists) {
        throw new Error("Vault already exists");
    }

    // Build instruction
    const instruction = buildInitializeVaultInstruction(owner, tokenMint);

    // Create transaction
    const transaction = new Transaction().add(instruction);

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = owner;

    // Sign transaction using wallet adapter
    const signedTx = await signTransaction(transaction);

    // Send and confirm
    const signature = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
    });

    return signature;
}

/**
 * Get the default token mint for the bridge (cDARK equivalent on Solana)
 * This should match the remoteToken set in the EVM ConfidentialCrossChainERC20
 */
export function getDefaultTokenMint(): PublicKey {
    // This is the remoteToken from the EVM contract:
    // 0x223403719246903aaf8dc5029034932739e7641a28e51c89c199ab62e27d5598
    // Converted to base58: 3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V
    return new PublicKey(SOLANA_CDARK_TOKEN_MINT);
}

/**
 * Read a u128 little-endian from buffer
 */
function readU128LE(buffer: Uint8Array): bigint {
    let result = BigInt(0);
    for (let i = 0; i < Math.min(16, buffer.length); i++) {
        result += BigInt(buffer[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

/**
 * Create a simple encrypted amount ciphertext for bridging.
 * In production, this would use @inco/solana-sdk but it has ESM issues in Next.js.
 * The Inco TEE will validate and process this.
 */
function createEncryptedAmount(amount: bigint): Buffer {
    // Create a 16-byte little-endian representation of the amount
    const buffer = Buffer.alloc(16);
    let remaining = amount;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    return buffer;
}

/**
 * Get the encrypted balance from a vault account
 */
export async function getVaultBalance(
    connection: Connection,
    owner: PublicKey,
    tokenMint: PublicKey
): Promise<bigint | null> {
    const [vaultPda] = deriveVaultPda(owner, tokenMint);
    const accountInfo = await connection.getAccountInfo(vaultPda);

    if (!accountInfo) {
        return null;
    }

    // Vault structure: discriminator (8) + owner_hash (32) + token_mint (32) + encrypted_balance (16) + bridge_authority (32) + bump (1)
    const vaultData = accountInfo.data;
    if (vaultData.length < 8 + 32 + 32 + 16) {
        return null;
    }

    const encryptedBalance = vaultData.subarray(8 + 32 + 32, 8 + 32 + 32 + 16);
    return readU128LE(encryptedBalance);
}

/**
 * Build the bridge_confidential_out instruction for Solana → Base transfer.
 * Uses client-side encrypted ciphertext (via @inco/solana-sdk) for real privacy.
 *
 * NOTE: We do NOT pass remaining_accounts for Inco allow() grants here because:
 * - The allowance PDA seeds require the encrypted handle value (u128 LE + allowed_address)
 * - The handle is computed BY the Inco Lightning program during execution
 * - We can't know the handle before the transaction is submitted
 * - The program's allow() calls are guarded by `if remaining_accounts.len() >= 2`
 *   so they simply get skipped when no remaining accounts are passed
 * - The user already knows the amount they entered, so attested decrypt is NOT needed
 *   for the cross-chain relay — the frontend sends the user-known amount to the relayer
 */
export function buildBridgeConfidentialOutInstruction(
    owner: PublicKey,
    tokenMint: PublicKey,
    destinationEvmAddress: string,
    encryptedAmountBytes: Buffer
): TransactionInstruction {
    const [vaultPda] = deriveVaultPda(owner, tokenMint);

    // Anchor discriminator for "bridge_confidential_out"
    const discriminator = computeDiscriminator("bridge_confidential_out");

    // Convert EVM address to bytes (remove 0x prefix)
    const evmAddressClean = destinationEvmAddress.startsWith("0x")
        ? destinationEvmAddress.slice(2)
        : destinationEvmAddress;
    const destinationBytes = Buffer.from(evmAddressClean, "hex");

    // Instruction data: discriminator + borsh Vec<u8> (4-byte LE length + bytes) + destination_evm ([u8; 20])
    const lenBuffer = Buffer.alloc(4);
    lenBuffer.writeUInt32LE(encryptedAmountBytes.length, 0);

    const instructionData = Buffer.concat([
        discriminator,
        lenBuffer,
        encryptedAmountBytes,
        destinationBytes,
    ]);

    // Only pass the 4 required accounts — no remaining_accounts for allow() 
    // since we can't pre-derive the allowance PDA without knowing the handle
    return new TransactionInstruction({
        programId: new PublicKey(BRIDGE_PROGRAM_ID),
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: vaultPda, isSigner: false, isWritable: true },
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: instructionData,
    });
}

/**
 * Bridge tokens from Solana to Base (confidential) — direct on-chain transaction.
 * 
 * The user signs and sends the bridge_confidential_out transaction directly.
 * The encrypted amount is generated client-side via Inco Solana SDK.
 * After the Solana TX confirms, the frontend POSTs the plaintext to the
 * relayer's /relay-to-base endpoint for Base minting.
 */
export async function bridgeConfidentialOutDirect(
    connection: Connection,
    owner: PublicKey,
    tokenMint: PublicKey,
    destinationEvmAddress: string,
    amount: bigint,
    sendTransaction: (transaction: Transaction, connection: Connection) => Promise<string>,
): Promise<{ solanaTxHash: string }> {
    // Check vault exists
    const exists = await checkVaultExists(connection, owner, tokenMint);
    if (!exists) {
        throw new Error("Vault does not exist. Initialize it first.");
    }

    // Check vault has balance
    const balance = await getVaultBalance(connection, owner, tokenMint);
    if (balance === null || balance === 0n) {
        throw new Error("Vault has no balance. Bridge tokens TO Solana first.");
    }

    // Encrypt amount client-side using Inco Solana SDK
    const { encryptValue } = await import("@inco/solana-sdk/encryption");
    const encryptedHex = await encryptValue(amount);
    // Convert hex string to bytes
    const hexClean = encryptedHex.startsWith("0x") ? encryptedHex.slice(2) : encryptedHex;
    const encryptedAmountBytes = Buffer.from(hexClean, "hex");

    // Build the bridge_confidential_out instruction
    const ix = buildBridgeConfidentialOutInstruction(
        owner,
        tokenMint,
        destinationEvmAddress,
        encryptedAmountBytes,
    );

    // Build and send transaction
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const signature = await sendTransaction(tx, connection);

    // Wait for confirmation
    await connection.confirmTransaction(signature, "confirmed");

    return { solanaTxHash: signature };
}
