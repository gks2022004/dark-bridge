/**
 * Attestation Verification Utilities
 * 
 * Helper functions for working with Inco Lightning decryption attestations.
 * Used for verifying and using attestations in withdraw operations.
 */

import { type Address, type Hex, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { PublicKey } from '@solana/web3.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Decryption attestation from Inco covalidators (EVM format).
 */
export interface EvmDecryptionAttestation {
    handle: Hex;          // bytes32 - the encrypted handle
    value: Hex;           // bytes32 - the decrypted plaintext value
    signatures: Hex[];    // bytes[] - covalidator signatures
}

/**
 * Solana-compatible attestation data.
 */
export interface SolanaAttestation {
    plaintextAmount: bigint;  // u64 - decrypted amount
    expectedHandle: bigint;   // u128 - the vault's encrypted_balance handle
}

/**
 * Attestation verification result.
 */
export interface AttestationVerificationResult {
    isValid: boolean;
    handle: Hex;
    plaintextValue: bigint;
    signerCount: number;
    errors: string[];
}

// ============================================================================
// EVM Attestation Helpers
// ============================================================================

/**
 * Parse an attestation from Inco's attestedDecrypt response.
 */
export function parseAttestationResponse(
    handle: Hex,
    response: { values: string[]; signatures: string[] }
): EvmDecryptionAttestation {
    const value = '0x' + BigInt(response.values[0]).toString(16).padStart(64, '0');

    return {
        handle,
        value: value as Hex,
        signatures: response.signatures as Hex[],
    };
}

/**
 * Verify attestation format and basic validity.
 * Does NOT verify cryptographic signatures (that's done on-chain).
 */
export function verifyAttestationFormat(
    attestation: EvmDecryptionAttestation
): AttestationVerificationResult {
    const errors: string[] = [];

    // Handle should be 32 bytes (66 chars with 0x prefix)
    if (!attestation.handle || attestation.handle.length !== 66) {
        errors.push(`Invalid handle length: expected 66, got ${attestation.handle?.length}`);
    }

    // Value should be 32 bytes
    if (!attestation.value || attestation.value.length !== 66) {
        errors.push(`Invalid value length: expected 66, got ${attestation.value?.length}`);
    }

    // Need at least one signature
    if (!attestation.signatures || attestation.signatures.length === 0) {
        errors.push('No signatures provided');
    }

    // Each signature should be 65 bytes (132 chars with 0x prefix)
    for (let i = 0; i < (attestation.signatures?.length || 0); i++) {
        const sig = attestation.signatures[i];
        if (!sig.startsWith('0x') || sig.length !== 132) {
            errors.push(`Signature ${i} has invalid length: expected 132, got ${sig.length}`);
        }
    }

    const plaintextValue = attestation.value ? BigInt(attestation.value) : 0n;

    return {
        isValid: errors.length === 0,
        handle: attestation.handle,
        plaintextValue,
        signerCount: attestation.signatures?.length || 0,
        errors,
    };
}

/**
 * Encode attestation for EVM contract call.
 */
export function encodeAttestationForEvm(
    attestation: EvmDecryptionAttestation
): { decryption: { handle: Hex; value: Hex }; signatures: Hex[] } {
    return {
        decryption: {
            handle: attestation.handle,
            value: attestation.value,
        },
        signatures: attestation.signatures,
    };
}

/**
 * Compute the message hash that was signed by covalidators.
 * This matches the hash computed in the Solidity contract.
 */
export function computeAttestationMessageHash(
    handle: Hex,
    value: Hex
): Hex {
    // The message is: keccak256(abi.encodePacked(handle, value))
    const encoded = encodeAbiParameters(
        parseAbiParameters('bytes32, bytes32'),
        [handle as `0x${string}`, value as `0x${string}`]
    );
    return keccak256(encoded);
}

// ============================================================================
// Solana Attestation Helpers
// ============================================================================

/**
 * Convert EVM attestation to Solana format.
 * Takes the lower 128 bits of the handle for Euint128 compatibility.
 */
export function convertToSolanaAttestation(
    evmAttestation: EvmDecryptionAttestation
): SolanaAttestation {
    // Lower 128 bits = last 32 hex chars of the handle (16 bytes)
    const handleHex = evmAttestation.handle.slice(-32);
    const expectedHandle = BigInt('0x' + handleHex);

    // Value is already the plaintext
    const plaintextAmount = BigInt(evmAttestation.value);

    return {
        plaintextAmount,
        expectedHandle,
    };
}

/**
 * Encode attestation for Solana program call.
 * Returns the parameters for withdraw_with_attestation instruction.
 */
export function encodeAttestationForSolana(
    attestation: SolanaAttestation
): { plaintextAmount: bigint; expectedHandle: Buffer } {
    // Convert u128 handle to 16-byte little-endian buffer
    const handleBuffer = Buffer.alloc(16);
    let remaining = attestation.expectedHandle;
    for (let i = 0; i < 16; i++) {
        handleBuffer[i] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }

    return {
        plaintextAmount: attestation.plaintextAmount,
        expectedHandle: handleBuffer,
    };
}

/**
 * Derive the vault PDA for a user.
 */
/**
 * Hash owner pubkey with keccak256 for privacy-preserving PDA derivation.
 * Matches Rust: anchor_lang::solana_program::keccak::hash(owner.as_ref())
 */
export function hashOwner(owner: PublicKey): Buffer {
    const hashHex = keccak256(new Uint8Array(owner.toBuffer()));
    return Buffer.from(hashHex.slice(2), 'hex');
}

export function deriveVaultPda(
    owner: PublicKey,
    tokenMint: PublicKey,
    bridgeProgramId: PublicKey
): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from('confidential_vault'),
            hashOwner(owner),
            tokenMint.toBuffer(),
        ],
        bridgeProgramId
    );
}

// ============================================================================
// Cross-Chain Handle Conversion
// ============================================================================

/**
 * Convert euint256 handle (EVM) to Euint128 bytes (Solana).
 * Takes the lower 128 bits in little-endian format.
 */
export function euint256ToEuint128(handle: Hex): Uint8Array {
    // Remove 0x prefix and take last 32 chars (16 bytes)
    const lower = handle.slice(-32);
    const bytes = Buffer.from(lower, 'hex');

    // Reverse for little-endian (Solana uses LE)
    return new Uint8Array(bytes.reverse());
}

/**
 * Convert Euint128 bytes (Solana) to euint256 handle (EVM).
 * Zero-pads the upper 128 bits.
 */
export function euint128ToEuint256(handle: Uint8Array): Hex {
    // Reverse for big-endian (EVM uses BE)
    const bytes = Buffer.from(handle).reverse();

    // Pad to 32 bytes
    const padded = Buffer.alloc(32);
    bytes.copy(padded, 16);

    return ('0x' + padded.toString('hex')) as Hex;
}

/**
 * Extract u128 value from Euint128 handle.
 */
export function euint128ToU128(handle: Uint8Array): bigint {
    let result = 0n;
    for (let i = 0; i < Math.min(16, handle.length); i++) {
        result += BigInt(handle[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

// ============================================================================
// Logging Helpers
// ============================================================================

/**
 * Format attestation for logging.
 */
export function formatAttestation(attestation: EvmDecryptionAttestation): string {
    const value = BigInt(attestation.value);
    return `
Attestation Details:
  Handle: ${attestation.handle}
  Value: ${value.toString()} (0x${value.toString(16)})
  Signatures: ${attestation.signatures.length} covalidator(s)
`.trim();
}

/**
 * Format verification result for logging.
 */
export function formatVerificationResult(result: AttestationVerificationResult): string {
    if (result.isValid) {
        return `Attestation valid: ${result.plaintextValue.toString()} tokens, ${result.signerCount} signature(s)`;
    } else {
        return `Attestation invalid:\n${result.errors.map(e => `  - ${e}`).join('\n')}`;
    }
}
