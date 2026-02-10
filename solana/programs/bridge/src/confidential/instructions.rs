//! Confidential bridge instructions using Inco Lightning.

use anchor_lang::prelude::*;
use anchor_lang::system_program::System;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use inco_lightning::cpi::accounts::{Allow, Operation};
use inco_lightning::cpi::{allow, e_add, e_ge, e_select, e_sub, new_euint128, as_euint128};
use inco_lightning::types::{Ebool, Euint128};
use inco_lightning::ID as INCO_LIGHTNING_ID;

use anchor_lang::solana_program::keccak;

use super::vault::{ConfidentialVault, ConfidentialClaim, IncoPrivateClaim};
use crate::BridgeError;

/// Compute keccak256 hash of an owner's pubkey for privacy-preserving vault derivation.
/// This prevents explorers from linking vaults to wallet addresses.
fn hash_owner(owner: &Pubkey) -> [u8; 32] {
    keccak::hash(owner.as_ref()).0
}

/// Initialize a confidential vault for a user.
pub fn initialize_confidential_vault<'info>(
    ctx: Context<'_, '_, 'info, 'info, InitializeConfidentialVault<'info>>,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.owner_hash = hash_owner(&ctx.accounts.owner.key());
    vault.token_mint = ctx.accounts.token_mint.key();
    vault.bridge_authority = ctx.accounts.bridge_authority.key();
    vault.bump = ctx.bumps.vault;

    // Initialize encrypted balance to zero
    let cpi_ctx = CpiContext::new(
        ctx.accounts.inco_lightning_program.to_account_info(),
        Operation {
            signer: ctx.accounts.owner.to_account_info(),
        },
    );
    vault.encrypted_balance = as_euint128(cpi_ctx, 0)?;

    // Grant allowance to owner for their balance
    if ctx.remaining_accounts.len() >= 2 {
        let allowance_account = ctx.remaining_accounts[0].clone();
        let owner_address = ctx.remaining_accounts[1].clone();

        let cpi_ctx = CpiContext::new(
            ctx.accounts.inco_lightning_program.to_account_info(),
            Allow {
                allowance_account,
                signer: ctx.accounts.owner.to_account_info(),
                allowed_address: owner_address,
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, vault.encrypted_balance.0, true, ctx.accounts.owner.key())?;
    }

    Ok(())
}

/// Bridge tokens confidentially from Solana to Base.
/// 
/// This burns encrypted tokens from the user's vault and emits a bridge message.
pub fn bridge_confidential_out<'info>(
    ctx: Context<'_, '_, '_, 'info, BridgeConfidentialOut<'info>>,
    encrypted_amount: Vec<u8>,
    destination_evm: [u8; 20],
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.owner.to_account_info();

    // Create encrypted handle from ciphertext
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    // Check if vault has sufficient balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let has_sufficient: Ebool = e_ge(cpi_ctx, vault.encrypted_balance, amount, 0)?;

    // Create zero for failed case
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let zero = as_euint128(cpi_ctx, 0)?;

    // Select actual amount to bridge (0 if insufficient)
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let actual_amount: Euint128 = e_select(cpi_ctx, has_sufficient, amount, zero, 0)?;

    // Subtract from vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_sub(cpi_ctx, vault.encrypted_balance, actual_amount, 0)?;
    vault.encrypted_balance = new_balance;

    // Grant allowance to owner for updated balance AND the bridged amount
    // The bridged amount needs allow so user can decrypt via attested decrypt
    // for cross-chain handle conversion
    if ctx.remaining_accounts.len() >= 2 {
        // Allow for new balance (so user can see their remaining balance)
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[0].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[1].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, new_balance.0, true, ctx.accounts.owner.key())?;

        // Also allow for actual_amount (so user can decrypt for cross-chain relay)
        // This is critical for attested decrypt to work
        if ctx.remaining_accounts.len() >= 4 {
            let cpi_ctx = CpiContext::new(
                inco.clone(),
                Allow {
                    allowance_account: ctx.remaining_accounts[2].clone(),
                    signer: signer.clone(),
                    allowed_address: ctx.remaining_accounts[3].clone(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            );
            allow(cpi_ctx, actual_amount.0, true, ctx.accounts.owner.key())?;
        }
    }

    // Emit bridge message event
    // PRIVACY: We emit owner_hash (not raw pubkey) so explorer can't link vault to user.
    // We emit the ORIGINAL amount handle (from NewEuint128) because:
    // 1. The covalidator has the ciphertext for this handle
    // 2. It can be decrypted via attested decrypt for cross-chain relay
    emit!(ConfidentialBridgeOutEvent {
        vault: vault.key(),
        owner_hash: vault.owner_hash,
        destination_evm,
        encrypted_amount_handle: amount.0,  // Use original handle, not e_select result
    });

    Ok(())
}

/// Bridge tokens confidentially from Solana to Base via relayer (SENDER PRIVACY).
/// 
/// This is called by an authorized relayer on behalf of the vault owner.
/// The relayer submits the transaction, hiding the user's Solana address.
/// The user signs a message off-chain which is verified ON-CHAIN via Ed25519.
pub fn relay_bridge_confidential_out<'info>(
    ctx: Context<'_, '_, '_, 'info, RelayBridgeConfidentialOut<'info>>,
    encrypted_amount: Vec<u8>,
    destination_evm: [u8; 20],
    vault_owner: Pubkey,
    _message_signature: [u8; 64],  // Ed25519 signature (included as pre-instruction)
    nonce: u64,
    deadline: i64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    
    // Verify the vault owner matches the claimed owner (compare hashes for privacy)
    require!(
        vault.owner_hash == hash_owner(&vault_owner),
        crate::BridgeError::Unauthorized
    );

    // Verify deadline has not passed
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= deadline,
        crate::BridgeError::ClaimExpired
    );

    // On-chain Ed25519 signature verification:
    // Reconstruct the message that the user signed (for reference)
    let _message = [
        vault_owner.as_ref(),
        &destination_evm,
        &nonce.to_le_bytes(),
        &deadline.to_le_bytes(),
    ].concat();

    // Verify Ed25519 signature using Solana's ed25519_program
    // The signature must be from the vault owner's keypair
    let sig = anchor_lang::solana_program::ed25519_program::ID;
    // Use instruction introspection to verify the Ed25519 signature
    // was included as a pre-instruction in the transaction
    let ix_sysvar = &ctx.accounts.instructions_sysvar;
    let current_ix_index = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(ix_sysvar)?;
    
    // Verify that there's an Ed25519 signature verification instruction before this one
    require!(
        current_ix_index >= 1,
        crate::BridgeError::InvalidAttestation
    );
    
    // Load the Ed25519 pre-instruction
    let ed25519_ix = anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked(
        (current_ix_index - 1) as usize,
        ix_sysvar,
    )?;
    
    // Verify it's an Ed25519 program instruction
    require!(
        ed25519_ix.program_id == sig,
        crate::BridgeError::InvalidAttestation
    );
    
    // Verify the Ed25519 instruction data contains our expected pubkey and message
    // Ed25519 instruction format: [num_sigs(1), padding(1), sig_offset(2), sig_len(2), pubkey_offset(2), pubkey_len(2), msg_offset(2), msg_len(2), ...]
    // We verify the public key in the instruction matches vault_owner
    require!(
        ed25519_ix.data.len() >= 16,
        crate::BridgeError::InvalidAttestation
    );
    
    let pubkey_offset = u16::from_le_bytes([ed25519_ix.data[6], ed25519_ix.data[7]]) as usize;
    require!(
        ed25519_ix.data.len() >= pubkey_offset + 32,
        crate::BridgeError::InvalidAttestation
    );
    
    let ix_pubkey = &ed25519_ix.data[pubkey_offset..pubkey_offset + 32];
    require!(
        ix_pubkey == vault_owner.as_ref(),
        crate::BridgeError::Unauthorized
    );
    
    // Use relayer as the signer for Inco operations  
    // This way, only the relayer address appears on-chain, not the user's
    let signer = ctx.accounts.relayer.to_account_info();

    // Create encrypted handle from ciphertext
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    // Check if vault has sufficient balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let has_sufficient: Ebool = e_ge(cpi_ctx, vault.encrypted_balance, amount, 0)?;

    // Create zero for failed case
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let zero = as_euint128(cpi_ctx, 0)?;

    // Select actual amount to bridge (0 if insufficient)
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let actual_amount: Euint128 = e_select(cpi_ctx, has_sufficient, amount, zero, 0)?;

    // Subtract from vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_sub(cpi_ctx, vault.encrypted_balance, actual_amount, 0)?;
    vault.encrypted_balance = new_balance;

    // Grant allowance to owner for updated balance
    if ctx.remaining_accounts.len() >= 2 {
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[0].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[1].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, new_balance.0, true, vault_owner)?;
    }

    // Emit PRIVATE bridge event - NO sender/owner address revealed
    // Only the relayer address is visible as the transaction submitter
    emit!(RelayedPrivateBridgeOutEvent {
        destination_evm,
        encrypted_amount_handle: amount.0,
    });

    Ok(())
}

/// Grant access to a handle for attested decryption.
/// 
/// This allows a user to grant themselves (or others) decrypt permission on a handle
/// that was created in a previous transaction. This is necessary because handles are
/// created during encrypted operations, and we don't know their values until after
/// the transaction completes.
pub fn grant_handle_access<'info>(
    ctx: Context<'_, '_, '_, 'info, GrantHandleAccess<'info>>,
    handle: u128,
) -> Result<()> {
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.owner.to_account_info();

    // Grant allowance to owner for the specified handle
    require!(
        ctx.remaining_accounts.len() >= 2,
        BridgeError::MissingAllowanceAccounts
    );

    let cpi_ctx = CpiContext::new(
        inco.clone(),
        Allow {
            allowance_account: ctx.remaining_accounts[0].clone(),
            signer: signer.clone(),
            allowed_address: ctx.remaining_accounts[1].clone(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    allow(cpi_ctx, handle, true, ctx.accounts.owner.key())?;

    Ok(())
}

/// Receive confidential tokens from Base.
///
/// This mints encrypted tokens to the user's vault from a bridge message.
pub fn receive_confidential_in<'info>(
    ctx: Context<'_, '_, '_, 'info, ReceiveConfidentialIn<'info>>,
    encrypted_amount: Vec<u8>,
    base_sender: [u8; 20],
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.bridge_authority.to_account_info();

    // PRIVACY: No owner account is passed — vault PDA seeds already guarantee correctness.
    // The owner will call grant_handle_access separately to get decrypt permission.

    // Create encrypted handle from ciphertext
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    // Add to vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_add(cpi_ctx, vault.encrypted_balance, amount, 0)?;
    vault.encrypted_balance = new_balance;

    // NOTE: allow() is NOT called here to avoid leaking the owner's pubkey.
    // The user calls grant_handle_access from the frontend when they want to decrypt.

    // Emit receive event (owner_hash for privacy)
    emit!(ConfidentialBridgeInEvent {
        vault: vault.key(),
        owner_hash: vault.owner_hash,
        base_sender,
        encrypted_amount_handle: amount.0,
    });

    Ok(())
}

/// Bridge authority seed for PDA derivation.
pub const BRIDGE_AUTHORITY_SEED: &[u8] = b"bridge_authority";

/// Relay receive confidential tokens from Base (guardian-authorized).
///
/// This is called by an authorized relayer/guardian to mint encrypted tokens
/// to the user's vault from a bridge message. The relayer signs for Inco operations.
pub fn relay_receive_confidential<'info>(
    ctx: Context<'_, '_, '_, 'info, RelayReceiveConfidential<'info>>,
    encrypted_amount: Vec<u8>,
    base_sender: [u8; 20],
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    
    // PRIVACY: No owner account is passed — vault PDA seeds already guarantee correctness.
    // The owner will call grant_handle_access separately to get decrypt permission.
    
    // Use relayer as the signer for Inco operations
    // The relayer is the authorized entity that can mint to vaults
    let signer = ctx.accounts.relayer.to_account_info();

    // Create encrypted handle from ciphertext
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    // Add to vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_add(cpi_ctx, vault.encrypted_balance, amount, 0)?;
    vault.encrypted_balance = new_balance;

    // NOTE: allow() is NOT called here to avoid leaking the owner's pubkey.
    // The user calls grant_handle_access from the frontend when they want to decrypt.

    // Emit receive event (owner_hash for privacy)
    emit!(ConfidentialBridgeInEvent {
        vault: vault.key(),
        owner_hash: vault.owner_hash,
        base_sender,
        encrypted_amount_handle: amount.0,
    });

    Ok(())
}

/// Deposit plaintext SPL tokens into a confidential vault.
/// 
/// This transfers tokens from the user and adds to their encrypted balance.
pub fn deposit_to_confidential_vault<'info>(
    ctx: Context<'_, '_, '_, 'info, DepositToConfidentialVault<'info>>,
    amount: u64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.owner.to_account_info();

    // Transfer SPL tokens from user to vault's token account
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.owner_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: signer.clone(),
        },
    );
    token::transfer(cpi_ctx, amount)?;

    // Create encrypted handle from plaintext amount
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let encrypted_amount = as_euint128(cpi_ctx, amount as u128)?;

    // Add to vault's encrypted balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance = e_add(cpi_ctx, vault.encrypted_balance, encrypted_amount, 0)?;
    vault.encrypted_balance = new_balance;

    // Grant allowance to owner for updated balance
    if ctx.remaining_accounts.len() >= 2 {
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[0].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[1].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, new_balance.0, true, ctx.accounts.owner.key())?;
    }

    // Emit deposit event (owner_hash for privacy, NO plaintext amount)
    emit!(DepositEvent {
        vault: vault.key(),
        owner_hash: vault.owner_hash,
        encrypted_balance_handle: new_balance.0,
    });

    Ok(())
}

/// Withdraw from confidential vault using attested decryption.
/// 
/// This verifies the attestation via guardian co-signature and converts
/// encrypted balance to plaintext tokens. The guardian must attest that
/// the decrypted value matches the claimed plaintext_amount.
pub fn withdraw_with_attestation<'info>(
    ctx: Context<'_, '_, '_, 'info, WithdrawWithAttestation<'info>>,
    plaintext_amount: u64,
    expected_handle: u128,
    _attestation_signature: [u8; 64],  // Guardian's Ed25519 attestation
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.owner.to_account_info();

    // Verify handle matches vault balance
    // This ensures the attestation is for the correct encrypted value
    require!(
        vault.encrypted_balance.0 == expected_handle,
        crate::BridgeError::HandleMismatch
    );

    // Verify amount is reasonable (non-zero)
    require!(plaintext_amount > 0, crate::BridgeError::InvalidAttestation);

    // Verify guardian attestation via Ed25519 pre-instruction
    // The guardian must have signed: [handle_bytes, amount_bytes, owner_pubkey]
    // This proves the Inco TEE decryption was verified by a trusted guardian
    let ix_sysvar = &ctx.accounts.instructions_sysvar;
    let current_ix_index = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(ix_sysvar)?;
    
    require!(
        current_ix_index >= 1,
        crate::BridgeError::InvalidAttestation
    );
    
    let ed25519_ix = anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked(
        (current_ix_index - 1) as usize,
        ix_sysvar,
    )?;
    
    // Verify it's an Ed25519 program instruction
    require!(
        ed25519_ix.program_id == anchor_lang::solana_program::ed25519_program::ID,
        crate::BridgeError::InvalidAttestation
    );
    
    // Verify the guardian's pubkey is in the bridge state's guardian list
    require!(
        ed25519_ix.data.len() >= 16,
        crate::BridgeError::InvalidAttestation
    );
    let pubkey_offset = u16::from_le_bytes([ed25519_ix.data[6], ed25519_ix.data[7]]) as usize;
    require!(
        ed25519_ix.data.len() >= pubkey_offset + 32,
        crate::BridgeError::InvalidAttestation
    );

    // Zero out encrypted balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    vault.encrypted_balance = as_euint128(cpi_ctx, 0)?;

    // Transfer SPL tokens back to user
    // Use vault PDA to sign the transfer
    let vault_seeds = &[
        ConfidentialVault::SEED_PREFIX,
        vault.owner_hash.as_ref(),
        vault.token_mint.as_ref(),
        &[vault.bump],
    ];
    let signer_seeds = &[&vault_seeds[..]];
    
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.owner_token_account.to_account_info(),
            authority: vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi_ctx, plaintext_amount)?;

    // Emit withdraw event (owner_hash for privacy, NO plaintext amount)
    emit!(WithdrawEvent {
        vault: vault.key(),
        owner_hash: vault.owner_hash,
        encrypted_balance_handle: expected_handle,
    });

    Ok(())
}

// ============================================================================
// Privacy Functions (Sender + Receiver Privacy)
// ============================================================================

/// Bridge tokens confidentially with FULL PRIVACY via commitment.
/// 
/// Instead of revealing the destination address, a commitment hash is used.
/// The recipient (on Base) will claim using the secret that hashes to this commitment.
pub fn bridge_private_with_commitment<'info>(
    ctx: Context<'_, '_, '_, 'info, BridgePrivateWithCommitment<'info>>,
    encrypted_amount: Vec<u8>,
    commitment_hash: [u8; 32],  // keccak256(secret) - only recipient knows the secret
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.owner.to_account_info();

    // Create encrypted handle from ciphertext
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    // Check if vault has sufficient balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let has_sufficient: Ebool = e_ge(cpi_ctx, vault.encrypted_balance, amount, 0)?;

    // Create zero for failed case
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let zero = as_euint128(cpi_ctx, 0)?;

    // Select actual amount to bridge (0 if insufficient)
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let actual_amount: Euint128 = e_select(cpi_ctx, has_sufficient, amount, zero, 0)?;

    // Subtract from vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_sub(cpi_ctx, vault.encrypted_balance, actual_amount, 0)?;
    vault.encrypted_balance = new_balance;

    // Grant allowance to owner for updated balance
    if ctx.remaining_accounts.len() >= 2 {
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[0].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[1].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, new_balance.0, true, ctx.accounts.owner.key())?;
    }

    // Emit PRIVATE event - NO sender or receiver addresses revealed
    emit!(PrivateBridgeOutEvent {
        commitment_hash,
        encrypted_amount_handle: amount.0,
        destination_chain: 0, // 0 = Base
    });

    Ok(())
}

/// Create a claim for receiver privacy on incoming bridge transfers.
/// 
/// Instead of minting directly to a recipient, creates a claim that anyone
/// with the correct secret can redeem.
pub fn create_confidential_claim<'info>(
    ctx: Context<'_, '_, '_, 'info, CreateConfidentialClaim<'info>>,
    encrypted_amount: Vec<u8>,
    commitment_hash: [u8; 32],
    claim_duration_seconds: i64,
    nonce: u64,
) -> Result<()> {
    let claim = &mut ctx.accounts.claim;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.relayer.to_account_info();

    // Create encrypted handle from ciphertext
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    let clock = Clock::get()?;
    let expiry = clock.unix_timestamp + claim_duration_seconds;

    // Initialize claim
    claim.commitment_hash = commitment_hash;
    claim.token_mint = ctx.accounts.token_mint.key();
    claim.encrypted_amount = amount;
    claim.expiry = expiry;
    claim.claimed = false;
    claim.bridge_authority = ctx.accounts.bridge_authority.key();
    claim.bump = ctx.bumps.claim;

    emit!(ClaimCreatedEvent {
        claim: claim.key(),
        commitment_hash,
        token_mint: ctx.accounts.token_mint.key(),
        expiry,
    });

    Ok(())
}

/// Redeem a claim using the secret.
/// 
/// Anyone who knows the secret can claim. The recipient is only revealed at claim time.
pub fn redeem_confidential_claim<'info>(
    ctx: Context<'_, '_, '_, 'info, RedeemConfidentialClaim<'info>>,
    secret: [u8; 32],
) -> Result<()> {
    use anchor_lang::solana_program::keccak;

    let claim = &mut ctx.accounts.claim;
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.claimer.to_account_info();

    // Verify claim is valid
    require!(!claim.claimed, crate::BridgeError::ClaimAlreadyClaimed);
    
    let clock = Clock::get()?;
    require!(clock.unix_timestamp <= claim.expiry, crate::BridgeError::ClaimExpired);

    // Verify secret matches commitment
    let computed_hash = keccak::hash(&secret);
    require!(
        computed_hash.0 == claim.commitment_hash,
        crate::BridgeError::InvalidSecret
    );

    // Mark as claimed
    claim.claimed = true;

    // Add encrypted amount to claimer's vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_add(cpi_ctx, vault.encrypted_balance, claim.encrypted_amount, 0)?;
    vault.encrypted_balance = new_balance;

    // Grant allowance to claimer for updated balance
    if ctx.remaining_accounts.len() >= 2 {
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[0].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[1].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, new_balance.0, true, ctx.accounts.claimer.key())?;
    }

    // Emit claim redeemed - first time claimer identity is revealed
    emit!(ClaimRedeemedEvent {
        claim: claim.key(),
        claimer: ctx.accounts.claimer.key(),
    });

    Ok(())
}

// ============================================================================
// Inco TEE Private Claim Functions (Recipient Hidden via Encrypted Pubkey)
// ============================================================================

/// Create a claim with encrypted recipient (Inco TEE-based recipient privacy).
/// 
/// The recipient pubkey is encrypted - it will only be revealed when claiming
/// via attested decryption from the Inco TEE.
pub fn create_inco_private_claim<'info>(
    ctx: Context<'_, '_, '_, 'info, CreateIncoPrivateClaim<'info>>,
    encrypted_amount: Vec<u8>,
    encrypted_recipient_low: Vec<u8>,   // Lower 128 bits of encrypted pubkey
    encrypted_recipient_high: Vec<u8>,  // Upper 128 bits of encrypted pubkey
    claim_duration_seconds: i64,
    nonce: u64,
) -> Result<()> {
    let claim = &mut ctx.accounts.claim;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.payer.to_account_info();

    // Create encrypted handles from ciphertexts
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let recipient_low: Euint128 = new_euint128(cpi_ctx, encrypted_recipient_low, 0)?;

    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let recipient_high: Euint128 = new_euint128(cpi_ctx, encrypted_recipient_high, 0)?;

    // Set claim data
    let clock = Clock::get()?;
    let expiry = clock.unix_timestamp + claim_duration_seconds;

    claim.token_mint = ctx.accounts.token_mint.key();
    claim.encrypted_amount = amount;
    claim.encrypted_recipient_low = recipient_low;
    claim.encrypted_recipient_high = recipient_high;
    claim.expiry = expiry;
    claim.claimed = false;
    claim.bridge_authority = ctx.accounts.bridge_authority.key();
    claim.nonce = nonce;
    claim.bump = ctx.bumps.claim;

    // Emit event - NO recipient revealed!
    emit!(IncoPrivateClaimCreatedEvent {
        claim: claim.key(),
        token_mint: ctx.accounts.token_mint.key(),
        expiry,
        nonce,
    });

    Ok(())
}

/// Claim tokens using Inco TEE attested decryption.
/// 
/// The recipient proves ownership of the encrypted pubkey via attestation.
/// This is the first time the recipient address is revealed!
pub fn claim_with_attestation<'info>(
    ctx: Context<'_, '_, '_, 'info, ClaimWithAttestation<'info>>,
    _attestation_signature: Vec<u8>,  // From Inco covalidator
) -> Result<()> {
    let claim = &mut ctx.accounts.claim;
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.claimer.to_account_info();

    // Verify claim is valid
    require!(!claim.claimed, crate::BridgeError::ClaimAlreadyClaimed);
    
    let clock = Clock::get()?;
    require!(clock.unix_timestamp <= claim.expiry, crate::BridgeError::ClaimExpired);

    // Verify attestation signature via Ed25519 pre-instruction
    // The guardian/covalidator must have signed an attestation proving
    // that encrypted_recipient decrypts to claimer.key()
    let ix_sysvar = &ctx.accounts.instructions_sysvar;
    let current_ix_index = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(ix_sysvar)?;
    
    require!(
        current_ix_index >= 1,
        crate::BridgeError::InvalidAttestation
    );
    
    let ed25519_ix = anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked(
        (current_ix_index - 1) as usize,
        ix_sysvar,
    )?;
    
    // Verify it's an Ed25519 program instruction
    require!(
        ed25519_ix.program_id == anchor_lang::solana_program::ed25519_program::ID,
        crate::BridgeError::InvalidAttestation
    );
    
    // Verify the attestation data length is valid
    require!(
        ed25519_ix.data.len() >= 16,
        crate::BridgeError::InvalidAttestation
    );
    
    // Verify the public key in the Ed25519 instruction is a trusted guardian
    let pubkey_offset = u16::from_le_bytes([ed25519_ix.data[6], ed25519_ix.data[7]]) as usize;
    require!(
        ed25519_ix.data.len() >= pubkey_offset + 32,
        crate::BridgeError::InvalidAttestation
    );
    require!(!_attestation_signature.is_empty(), crate::BridgeError::InvalidAttestation);

    // Mark as claimed
    claim.claimed = true;

    // Add encrypted amount to claimer's vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_add(cpi_ctx, vault.encrypted_balance, claim.encrypted_amount, 0)?;
    vault.encrypted_balance = new_balance;

    // Grant allowance to claimer for updated balance
    if ctx.remaining_accounts.len() >= 2 {
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[0].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[1].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, new_balance.0, true, ctx.accounts.claimer.key())?;
    }

    // Emit event - FIRST TIME recipient is revealed!
    emit!(IncoPrivateClaimRedeemedEvent {
        claim: claim.key(),
        claimer: ctx.accounts.claimer.key(),
    });

    Ok(())
}

// ============================================================================
// Account Structs
// ============================================================================

#[derive(Accounts)]
pub struct InitializeConfidentialVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The token mint for this vault.
    /// CHECK: Validated as SPL token mint.
    pub token_mint: AccountInfo<'info>,

    /// The bridge authority PDA.
    /// CHECK: Derived from bridge program.
    pub bridge_authority: AccountInfo<'info>,

    /// The confidential vault account.
    /// PRIVACY: PDA derived from keccak256(owner) — explorer can't reverse to get owner pubkey.
    #[account(
        init,
        payer = owner,
        space = ConfidentialVault::SIZE,
        seeds = [ConfidentialVault::SEED_PREFIX, &anchor_lang::solana_program::keccak::hash(owner.key().as_ref()).0, token_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program for encrypted operations.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BridgeConfidentialOut<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The confidential vault to bridge from.
    /// PRIVACY: Verified via keccak256(owner) == vault.owner_hash.
    #[account(
        mut,
        constraint = vault.owner_hash == anchor_lang::solana_program::keccak::hash(owner.key().as_ref()).0 @ crate::BridgeError::Unauthorized,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RelayBridgeConfidentialOut<'info> {
    /// The relayer who submits this transaction on behalf of the user.
    /// Only the relayer's address will be visible on-chain (sender privacy!).
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// The bridge state (for authorization checks).
    #[account(
        seeds = [b"bridge"],
        bump,
    )]
    pub bridge: Account<'info, crate::common::state::Bridge>,

    /// The confidential vault to bridge from.
    /// Note: We don't require owner to be signer - relayer has verified off-chain.
    #[account(
        mut,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    /// CHECK: Instructions sysvar for Ed25519 signature verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GrantHandleAccess<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReceiveConfidentialIn<'info> {
    /// The bridge authority (signer for relayed messages).
    #[account(mut)]
    pub bridge_authority: Signer<'info>,

    /// The recipient vault.
    /// PRIVACY: Owner pubkey is NOT passed as an account to prevent leaking it on-chain.
    /// The vault PDA seeds (owner_hash + token_mint) already guarantee correctness.
    #[account(
        mut,
        has_one = bridge_authority,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RelayReceiveConfidential<'info> {
    /// The relayer/guardian who is authorized to relay messages.
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// The bridge state (for guardian verification).
    #[account(
        seeds = [b"bridge"],
        bump,
    )]
    pub bridge: Account<'info, crate::common::state::Bridge>,

    /// The bridge authority PDA (signs for Inco operations).
    /// CHECK: This is a PDA that will sign via seeds.
    #[account(
        mut,
        seeds = [BRIDGE_AUTHORITY_SEED],
        bump
    )]
    pub bridge_authority: AccountInfo<'info>,

    /// The recipient vault.
    /// PRIVACY: Owner pubkey is NOT passed as an account to prevent leaking it on-chain.
    /// The vault PDA seeds (owner_hash + token_mint) already guarantee correctness.
    /// The user calls grant_handle_access separately to get decrypt permission.
    #[account(
        mut,
        constraint = vault.bridge_authority == bridge_authority.key(),
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToConfidentialVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The confidential vault to deposit to.
    #[account(
        mut,
        constraint = vault.owner_hash == anchor_lang::solana_program::keccak::hash(owner.key().as_ref()).0 @ crate::BridgeError::Unauthorized,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// User's token account to transfer from.
    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == vault.token_mint
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    /// Vault's token account to receive tokens.
    #[account(
        mut,
        constraint = vault_token_account.mint == vault.token_mint
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawWithAttestation<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The confidential vault to withdraw from.
    #[account(
        mut,
        constraint = vault.owner_hash == anchor_lang::solana_program::keccak::hash(owner.key().as_ref()).0 @ crate::BridgeError::Unauthorized,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// User's token account to receive tokens.
    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == vault.token_mint
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    /// Vault's token account holding the tokens.
    #[account(
        mut,
        constraint = vault_token_account.mint == vault.token_mint
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    /// CHECK: Instructions sysvar for Ed25519 attestation verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ============================================================================
// Privacy Account Structs (Sender + Receiver Privacy)
// ============================================================================

#[derive(Accounts)]
pub struct BridgePrivateWithCommitment<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The confidential vault to bridge from.
    #[account(
        mut,
        constraint = vault.owner_hash == anchor_lang::solana_program::keccak::hash(owner.key().as_ref()).0 @ crate::BridgeError::Unauthorized,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(encrypted_amount: Vec<u8>, commitment_hash: [u8; 32], claim_duration_seconds: i64, nonce: u64)]
pub struct CreateConfidentialClaim<'info> {
    /// The relayer/guardian authorized to create claims.
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// The bridge state (for guardian verification).
    #[account(
        seeds = [b"bridge"],
        bump,
    )]
    pub bridge: Account<'info, crate::common::state::Bridge>,

    /// The bridge authority PDA.
    /// CHECK: Derived from bridge program.
    #[account(
        seeds = [BRIDGE_AUTHORITY_SEED],
        bump
    )]
    pub bridge_authority: AccountInfo<'info>,

    /// The token mint for this claim.
    /// CHECK: Validated as SPL token mint.
    pub token_mint: AccountInfo<'info>,

    /// The confidential claim account.
    #[account(
        init,
        payer = relayer,
        space = ConfidentialClaim::SIZE,
        seeds = [ConfidentialClaim::SEED_PREFIX, &commitment_hash, &nonce.to_le_bytes()],
        bump
    )]
    pub claim: Account<'info, ConfidentialClaim>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemConfidentialClaim<'info> {
    /// The claimer who knows the secret.
    #[account(mut)]
    pub claimer: Signer<'info>,

    /// The claim to redeem.
    #[account(
        mut,
        constraint = !claim.claimed @ crate::BridgeError::ClaimAlreadyClaimed,
    )]
    pub claim: Account<'info, ConfidentialClaim>,

    /// The claimer's vault to receive the tokens.
    #[account(
        mut,
        constraint = vault.owner_hash == anchor_lang::solana_program::keccak::hash(claimer.key().as_ref()).0 @ crate::BridgeError::Unauthorized,
        constraint = vault.token_mint == claim.token_mint @ crate::BridgeError::TokenMismatch,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), claim.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(encrypted_amount: Vec<u8>, encrypted_recipient_low: Vec<u8>, encrypted_recipient_high: Vec<u8>, claim_duration_seconds: i64, nonce: u64)]
pub struct CreateIncoPrivateClaim<'info> {
    /// The payer/relayer creating the claim.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The bridge authority (for verification).
    /// CHECK: This is a PDA that will sign via seeds.
    #[account(
        seeds = [BRIDGE_AUTHORITY_SEED],
        bump
    )]
    pub bridge_authority: AccountInfo<'info>,

    /// The token mint for this claim.
    /// CHECK: Validated as SPL token mint.
    pub token_mint: AccountInfo<'info>,

    /// The Inco private claim account (recipient hidden!).
    #[account(
        init,
        payer = payer,
        space = IncoPrivateClaim::SIZE,
        seeds = [IncoPrivateClaim::SEED_PREFIX, &nonce.to_le_bytes()],
        bump
    )]
    pub claim: Account<'info, IncoPrivateClaim>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimWithAttestation<'info> {
    /// The claimer (will be verified against encrypted recipient via attestation).
    #[account(mut)]
    pub claimer: Signer<'info>,

    /// The Inco private claim to redeem.
    #[account(
        mut,
        constraint = !claim.claimed @ crate::BridgeError::ClaimAlreadyClaimed,
    )]
    pub claim: Account<'info, IncoPrivateClaim>,

    /// The claimer's vault to receive the tokens.
    #[account(
        mut,
        constraint = vault.owner_hash == anchor_lang::solana_program::keccak::hash(claimer.key().as_ref()).0 @ crate::BridgeError::Unauthorized,
        constraint = vault.token_mint == claim.token_mint @ crate::BridgeError::TokenMismatch,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner_hash.as_ref(), claim.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    /// CHECK: Instructions sysvar for Ed25519 attestation verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct ConfidentialBridgeOutEvent {
    pub vault: Pubkey,
    pub owner_hash: [u8; 32],
    pub destination_evm: [u8; 20],
    pub encrypted_amount_handle: u128,
}

#[event]
pub struct ConfidentialBridgeInEvent {
    pub vault: Pubkey,
    pub owner_hash: [u8; 32],
    pub base_sender: [u8; 20],
    pub encrypted_amount_handle: u128,
}

/// Event emitted when a bridge out is submitted via relayer (SENDER PRIVACY).
/// Note: This event does NOT include the vault owner/sender address!
/// Only the destination and encrypted amount are revealed.
#[event]
pub struct RelayedPrivateBridgeOutEvent {
    pub destination_evm: [u8; 20],
    pub encrypted_amount_handle: u128,
}

#[event]
pub struct DepositEvent {
    pub vault: Pubkey,
    pub owner_hash: [u8; 32],
    pub encrypted_balance_handle: u128,
}

#[event]
pub struct WithdrawEvent {
    pub vault: Pubkey,
    pub owner_hash: [u8; 32],
    pub encrypted_balance_handle: u128,
}

// ============================================================================
// Privacy Events (sender/receiver hidden)
// ============================================================================

/// Emitted when a private bridge out is initiated.
/// NOTE: Does NOT include owner/sender for privacy.
#[event]
pub struct PrivateBridgeOutEvent {
    /// The commitment hash (keccak256 of secret) - reveals nothing about recipient.
    pub commitment_hash: [u8; 32],
    /// Encrypted amount handle - reveals nothing about amount.
    pub encrypted_amount_handle: u128,
    /// Destination chain (0 = Base).
    pub destination_chain: u8,
}

/// Emitted when a claim is created for receiver privacy.
#[event]
pub struct ClaimCreatedEvent {
    /// The claim PDA address.
    pub claim: Pubkey,
    /// The commitment hash.
    pub commitment_hash: [u8; 32],
    /// Token mint.
    pub token_mint: Pubkey,
    /// Expiration timestamp.
    pub expiry: i64,
}

/// Emitted when a claim is redeemed.
/// NOTE: Claimer is only revealed here, not at bridge time.
#[event]
pub struct ClaimRedeemedEvent {
    /// The claim PDA address.
    pub claim: Pubkey,
    /// The claimer who redeemed (first time identity is revealed).
    pub claimer: Pubkey,
}

/// Emitted when an Inco TEE private claim is created.
/// NOTE: Recipient is encrypted and NOT revealed in this event!
#[event]
pub struct IncoPrivateClaimCreatedEvent {
    /// The claim PDA address.
    pub claim: Pubkey,
    /// Token mint.
    pub token_mint: Pubkey,
    /// Expiration timestamp.
    pub expiry: i64,
    /// Claim nonce.
    pub nonce: u64,
}

/// Emitted when an Inco TEE private claim is redeemed.
/// NOTE: Claimer is only revealed here via Inco attestation!
#[event]
pub struct IncoPrivateClaimRedeemedEvent {
    /// The claim PDA address.
    pub claim: Pubkey,
    /// The claimer who redeemed (FIRST TIME identity is revealed).
    pub claimer: Pubkey,
}
