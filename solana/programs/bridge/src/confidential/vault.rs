//! Confidential vault account for storing encrypted token balances.

use anchor_lang::prelude::*;
use inco_lightning::types::Euint128;

/// Confidential vault that holds encrypted token balances.
///
/// This account stores an encrypted balance using Inco's Euint128 type,
/// which is a 128-bit handle to encrypted data stored off-chain by the covalidator.
///
/// PRIVACY: The vault stores a keccak256 hash of the owner's pubkey instead of
/// the raw pubkey. This prevents explorers from linking vaults to wallet addresses.
/// Only the owner (who knows their own pubkey) can derive and find their vault.
#[account]
pub struct ConfidentialVault {
    /// Keccak256 hash of the owner's pubkey (privacy-preserving).
    /// The raw owner pubkey is NOT stored on-chain.
    pub owner_hash: [u8; 32],

    /// The SPL token mint this vault tracks.
    pub token_mint: Pubkey,

    /// Encrypted balance handle (Euint128).
    /// This is a reference to the encrypted value stored off-chain.
    pub encrypted_balance: Euint128,

    /// Authority that can bridge tokens (the bridge program).
    pub bridge_authority: Pubkey,

    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl ConfidentialVault {
    /// Seed prefix for PDA derivation.
    pub const SEED_PREFIX: &'static [u8] = b"confidential_vault";

    /// Account size in bytes.
    pub const SIZE: usize = 8 + // discriminator
        32 + // owner_hash
        32 + // token_mint
        16 + // encrypted_balance (Euint128 is u128 = 16 bytes)
        32 + // bridge_authority
        1;   // bump

    /// Derive the vault PDA for a given owner and mint.
    /// Uses keccak256(owner) for privacy — explorer can't reverse to get the owner.
    pub fn derive_pda(owner: &Pubkey, token_mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
        use anchor_lang::solana_program::keccak;
        let owner_hash = keccak::hash(owner.as_ref());
        Pubkey::find_program_address(
            &[Self::SEED_PREFIX, &owner_hash.0, token_mint.as_ref()],
            program_id,
        )
    }
}

/// Account for tracking confidential bridge messages.
#[account]
pub struct ConfidentialBridgeMessage {
    /// Unique nonce for this message.
    pub nonce: u64,

    /// The EVM address of the sender on Base.
    pub base_sender: [u8; 20],

    /// The Solana recipient pubkey.
    pub solana_recipient: Pubkey,

    /// Encrypted amount handle.
    pub encrypted_amount: Euint128,

    /// Whether this message has been processed.
    pub processed: bool,

    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl ConfidentialBridgeMessage {
    /// Seed prefix for PDA derivation.
    pub const SEED_PREFIX: &'static [u8] = b"conf_bridge_msg";

    /// Account size in bytes.
    pub const SIZE: usize = 8 + // discriminator
        8 +  // nonce
        20 + // base_sender
        32 + // solana_recipient
        16 + // encrypted_amount
        1 +  // processed
        1;   // bump
}

/// Account for privacy-preserving claims (receiver privacy).
/// 
/// Instead of minting directly to a recipient, tokens are locked in a claim
/// that can be redeemed by anyone who knows the secret.
#[account]
pub struct ConfidentialClaim {
    /// Hash of the secret required to claim (keccak256(secret)).
    pub commitment_hash: [u8; 32],

    /// The SPL token mint for this claim.
    pub token_mint: Pubkey,

    /// Encrypted amount handle.
    pub encrypted_amount: Euint128,

    /// Expiration timestamp (Unix seconds).
    pub expiry: i64,

    /// Whether this claim has been redeemed.
    pub claimed: bool,

    /// The bridge authority that created this claim.
    pub bridge_authority: Pubkey,

    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl ConfidentialClaim {
    /// Seed prefix for PDA derivation.
    pub const SEED_PREFIX: &'static [u8] = b"conf_claim";

    /// Account size in bytes.
    pub const SIZE: usize = 8 +  // discriminator
        32 + // commitment_hash
        32 + // token_mint
        16 + // encrypted_amount
        8 +  // expiry
        1 +  // claimed
        32 + // bridge_authority
        1;   // bump

    /// Derive the claim PDA for a given commitment hash and nonce.
    pub fn derive_pda(commitment_hash: &[u8; 32], nonce: u64, program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[Self::SEED_PREFIX, commitment_hash, &nonce.to_le_bytes()],
            program_id,
        )
    }
}

/// Account for FULLY PRIVATE claims using Inco TEE (recipient hidden via encrypted pubkey).
/// 
/// Unlike ConfidentialClaim which uses commitment hash, this uses Inco TEE to 
/// store an encrypted recipient pubkey. Only revealed via attested decryption.
#[account]
pub struct IncoPrivateClaim {
    /// The SPL token mint for this claim.
    pub token_mint: Pubkey,

    /// Encrypted amount handle (Inco TEE).
    pub encrypted_amount: Euint128,

    /// Encrypted recipient pubkey (32 bytes encrypted via Inco TEE).
    /// This is an Euint128 pair that encodes a 32-byte pubkey.
    pub encrypted_recipient_low: Euint128,  // Lower 128 bits
    pub encrypted_recipient_high: Euint128, // Upper 128 bits

    /// Expiration timestamp (Unix seconds).
    pub expiry: i64,

    /// Whether this claim has been redeemed.
    pub claimed: bool,

    /// The bridge authority that created this claim.
    pub bridge_authority: Pubkey,

    /// Claim nonce for uniqueness.
    pub nonce: u64,

    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl IncoPrivateClaim {
    /// Seed prefix for PDA derivation.
    pub const SEED_PREFIX: &'static [u8] = b"inco_private_claim";

    /// Account size in bytes.
    pub const SIZE: usize = 8 +  // discriminator
        32 + // token_mint
        16 + // encrypted_amount
        16 + // encrypted_recipient_low
        16 + // encrypted_recipient_high
        8 +  // expiry
        1 +  // claimed
        32 + // bridge_authority
        8 +  // nonce
        1;   // bump

    /// Derive the claim PDA for a given nonce.
    pub fn derive_pda(nonce: u64, program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[Self::SEED_PREFIX, &nonce.to_le_bytes()],
            program_id,
        )
    }
}
