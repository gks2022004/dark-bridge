#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

mod base_to_solana;
mod common;
mod confidential;
mod errors;
mod solana_to_base;

use base_to_solana::*;
use common::*;
use confidential::*;
pub use errors::*;

use common::{
    config::{
        set_adjustment_denominator_handler, set_block_interval_requirement_handler,
        set_gas_cost_scaler_dp_handler, set_gas_cost_scaler_handler, set_gas_fee_receiver_handler,
        set_gas_target_handler, set_max_call_buffer_size_handler, set_minimum_base_fee_handler,
        set_pause_status_handler, set_window_duration_handler,
    },
    guardian::transfer_guardian_handler,
    initialize::initialize_handler,
};
use solana_to_base::*;

#[cfg(test)]
mod test_utils;

declare_id!("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

#[program]
pub mod bridge {

    use super::*;

    // Common

    /// Initializes the bridge program with required state accounts.
    /// This function sets up the initial bridge configuration and must be called once during deployment.
    ///
    /// # Arguments
    /// * `ctx`      - The context containing all accounts needed for initialization, including the guardian signer
    /// * `guardian` - The guardian account that will have administrative authority over the bridge
    /// * `cfg`      - All the configuration parameters needed to initialize the bridge
    pub fn initialize(ctx: Context<Initialize>, guardian: Pubkey, cfg: Config) -> Result<()> {
        initialize_handler(ctx, guardian, cfg)
    }

    // Base -> Solana

    /// Registers an output root from Base to enable message verification.
    /// This function stores the MMR root of Base message state at a specific block number,
    /// which is required before any messages from that block can be proven and relayed.
    /// Authorization is enforced via EVM signatures from authorized Base oracles and partner
    /// signers per configured thresholds; the Solana payer only funds account creation.
    ///
    /// # Arguments
    /// * `ctx`               - The context containing accounts for storing the output root (payer signs for fees; authorization is provided via EVM signatures)
    /// * `output_root`       - The 32-byte MMR root of Base messages for the given block
    /// * `base_block_number` - The Base block number this output root corresponds to
    /// * `total_leaf_count`  - The total number of leaves in the MMR with this root
    /// * `signatures`        - A list of ECDSA signatures from authorized oracles attesting to the output root
    pub fn register_output_root(
        ctx: Context<RegisterOutputRoot>,
        output_root: [u8; 32],
        base_block_number: u64,
        total_leaf_count: u64,
        signatures: Vec<[u8; 65]>,
    ) -> Result<()> {
        register_output_root_handler(
            ctx,
            output_root,
            base_block_number,
            total_leaf_count,
            signatures,
        )
    }

    /// Proves that a cross-chain message exists in the Base Bridge contract using an MMR proof.
    /// This function verifies the message was included in a previously registered output root
    /// and stores the proven message state for later relay execution.
    ///
    /// # Arguments
    /// * `ctx`          - The transaction context
    /// * `nonce`        - Unique identifier for the cross-chain message
    /// * `sender`       - The 20-byte Ethereum address that sent the message on Base
    /// * `data`         - The message payload/calldata to be executed on Solana
    /// * `proof`        - MMR proof demonstrating message inclusion in the output root
    /// * `message_hash` - The 32-byte hash of the message for verification
    pub fn prove_message(
        ctx: Context<ProveMessage>,
        nonce: u64,
        sender: [u8; 20],
        data: Vec<u8>,
        proof: Vec<[u8; 32]>,
        message_hash: [u8; 32],
    ) -> Result<()> {
        prove_message_handler(ctx, nonce, sender, data, proof, message_hash)
    }

    /// Initializes a prove buffer account that can store large prove inputs.
    /// This account can be used to build up serialized message data and MMR proof nodes
    /// over multiple transactions before calling `prove_message_buffered`.
    ///
    /// # Arguments
    /// * `ctx`           - The context containing accounts for initialization (payer, bridge, buffer)
    /// * `max_data_len`  - Maximum total length of serialized `Message` data that will be stored
    /// * `max_proof_len` - Maximum number of 32-byte MMR proof nodes that will be stored
    pub fn initialize_prove_buffer(
        ctx: Context<InitializeProveBuffer>,
        max_data_len: u64,
        max_proof_len: u64,
    ) -> Result<()> {
        initialize_prove_buffer_handler(ctx, max_data_len, max_proof_len)
    }

    /// Appends serialized `Message` bytes to an existing prove buffer.
    /// Only the owner of the prove buffer can append data to it.
    ///
    /// # Arguments
    /// * `ctx`   - The context containing the prove buffer account (owned by signer)
    /// * `chunk` - Additional serialized `Message` bytes to append to the buffer
    pub fn append_to_prove_buffer_data(
        ctx: Context<AppendToProveBufferData>,
        chunk: Vec<u8>,
    ) -> Result<()> {
        append_to_prove_buffer_data_handler(ctx, chunk)
    }

    /// Appends MMR proof nodes to an existing prove buffer.
    /// Only the owner of the prove buffer can append proof nodes to it.
    ///
    /// # Arguments
    /// * `ctx`         - The context containing the prove buffer account (owned by signer)
    /// * `proof_chunk` - Additional MMR proof nodes to append to the buffer
    pub fn append_to_prove_buffer_proof(
        ctx: Context<AppendToProveBufferProof>,
        proof_chunk: Vec<[u8; 32]>,
    ) -> Result<()> {
        append_to_prove_buffer_proof_handler(ctx, proof_chunk)
    }

    /// Closes a prove buffer account and returns the rent to the owner.
    /// Only the owner of the prove buffer can close it. This is useful if the user
    /// cannot complete proving and wants to recover the rent.
    ///
    /// # Arguments
    /// * `ctx` - The context containing the prove buffer to close and rent receiver (owner)
    pub fn close_prove_buffer(ctx: Context<CloseProveBuffer>) -> Result<()> {
        close_prove_buffer_handler(ctx)
    }

    /// Proves that a cross-chain message exists using buffered data and proof.
    /// This function reads the serialized message and MMR proof from a `ProveBuffer`,
    /// verifies inclusion against a previously registered output root, and stores the
    /// proven message for later relay execution. The prove buffer is closed on success.
    ///
    /// # Arguments
    /// * `ctx`          - The context containing accounts for verification and message creation
    /// * `nonce`        - Unique identifier for the cross-chain message
    /// * `sender`       - The 20-byte Ethereum address that sent the message on Base
    /// * `message_hash` - The 32-byte hash of the message for verification
    pub fn prove_message_buffered(
        ctx: Context<ProveMessageBuffered>,
        nonce: u64,
        sender: [u8; 20],
        message_hash: [u8; 32],
    ) -> Result<()> {
        prove_message_buffered_handler(ctx, nonce, sender, message_hash)
    }

    /// Executes a previously proven cross-chain message on Solana.
    /// This function takes a message that has been proven via `prove_message` and executes
    /// its payload using a bridge CPI authority derived from the message sender.
    ///
    /// # Arguments
    /// * `ctx` - The transaction context
    pub fn relay_message<'a, 'info>(
        ctx: Context<'a, '_, 'info, 'info, RelayMessage<'info>>,
    ) -> Result<()> {
        relay_message_handler(ctx)
    }

    // Solana -> Base

    /// Creates a wrapped version of a Base token.
    /// This function creates a new SPL mint account on Solana that represents the Base token,
    /// enabling users to bridge the token between the two chains. It will also trigger a message
    /// to Base to register the wrapped token in the Base Bridge contract.
    ///
    /// # Arguments
    /// * `ctx`                    - The transaction context
    /// * `outgoing_message_salt`  - The salt for the outgoing message account
    /// * `decimals`               - Number of decimal places for the token
    /// * `partial_token_metadata` - Token name, symbol, remote Base token address, and scaler exponent
    pub fn wrap_token(
        ctx: Context<WrapToken>,
        outgoing_message_salt: [u8; 32],
        decimals: u8,
        partial_token_metadata: PartialTokenMetadata,
    ) -> Result<()> {
        wrap_token_handler(ctx, outgoing_message_salt, decimals, partial_token_metadata)
    }

    /// Initiates a cross-chain function call from Solana to Base.
    /// This function allows executing arbitrary contract calls on Base using
    /// the bridge's cross-chain messaging system.
    ///
    /// # Arguments
    /// * `ctx`                   - The context containing accounts for the bridge operation
    /// * `outgoing_message_salt` - The salt for the outgoing message account
    /// * `call`                  - The contract call details including call type, target address, value, and calldata
    pub fn bridge_call(
        ctx: Context<BridgeCall>,
        outgoing_message_salt: [u8; 32],
        call: Call,
    ) -> Result<()> {
        bridge_call_handler(ctx, outgoing_message_salt, call)
    }

    /// Bridges a call using data from a call buffer account.
    /// This instruction consumes the call buffer and creates an outgoing message
    /// for execution on Base.
    ///
    /// # Arguments
    /// * `ctx`                   - The context containing accounts for the bridge operation
    /// * `outgoing_message_salt` - The salt for the outgoing message account
    pub fn bridge_call_buffered<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, BridgeCallBuffered<'info>>,
        outgoing_message_salt: [u8; 32],
    ) -> Result<()> {
        bridge_call_buffered_handler(ctx, outgoing_message_salt)
    }

    /// Bridges native SOL tokens from Solana to Base.
    /// This function locks SOL on Solana and initiates a message to mint equivalent
    /// tokens on Base for the specified recipient.
    ///
    /// # Arguments
    /// * `ctx`                   - The context containing accounts for the SOL bridge operation
    /// * `outgoing_message_salt` - The salt for the outgoing message account
    /// * `to`                    - The 20-byte Ethereum address that will receive tokens on Base
    /// * `amount`                - Amount of SOL to bridge (in lamports)
    /// * `call`                  - Optional additional contract call to execute with the token transfer
    pub fn bridge_sol(
        ctx: Context<BridgeSol>,
        outgoing_message_salt: [u8; 32],
        to: [u8; 20],
        amount: u64,
        call: Option<Call>,
    ) -> Result<()> {
        bridge_sol_handler(ctx, outgoing_message_salt, to, amount, call)
    }

    /// Bridges native SOL tokens from Solana to Base with a call using buffered data.
    /// This function locks SOL on Solana and initiates a message to mint equivalent
    /// tokens on Base, then executes a call using data from a call buffer.
    ///
    /// # Arguments
    /// * `ctx`                   - The context containing accounts for the SOL bridge operation
    /// * `outgoing_message_salt` - The salt for the outgoing message account
    /// * `to`                    - The 20-byte Ethereum address that will receive tokens on Base
    /// * `amount`                - Amount of SOL to bridge (in lamports)
    pub fn bridge_sol_with_buffered_call<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, BridgeSolWithBufferedCall<'info>>,
        outgoing_message_salt: [u8; 32],
        to: [u8; 20],
        amount: u64,
    ) -> Result<()> {
        bridge_sol_with_buffered_call_handler(ctx, outgoing_message_salt, to, amount)
    }

    /// Bridges SPL tokens from Solana to Base.
    /// This function burns or locks SPL tokens on Solana and initiates a message to mint
    /// equivalent ERC20 tokens on Base for the specified recipient.
    ///
    /// # Arguments
    /// * `ctx`                   - The context containing accounts for the SPL token bridge operation
    /// * `outgoing_message_salt` - The salt for the outgoing message account
    /// * `to`                    - The 20-byte Ethereum address that will receive tokens on Base
    /// * `remote_token`          - The 20-byte address of the ERC20 token contract on Base
    /// * `amount`                - Amount of SPL tokens to bridge (in the token's smallest units)
    /// * `call`                  - Optional additional contract call to execute with the token transfer
    pub fn bridge_spl(
        ctx: Context<BridgeSpl>,
        outgoing_message_salt: [u8; 32],
        to: [u8; 20],
        remote_token: [u8; 20],
        amount: u64,
        call: Option<Call>,
    ) -> Result<()> {
        bridge_spl_handler(ctx, outgoing_message_salt, to, remote_token, amount, call)
    }

    /// Bridges SPL tokens from Solana to Base with a call using buffered data.
    /// This function locks SPL tokens on Solana and initiates a message to mint equivalent
    /// tokens on Base, then executes a call using data from a call buffer.
    ///
    /// # Arguments
    /// * `ctx`                   - The context containing accounts for the SPL token bridge operation
    /// * `outgoing_message_salt` - The salt for the outgoing message account
    /// * `to`                    - The 20-byte Ethereum address that will receive tokens on Base
    /// * `remote_token`          - The 20-byte address of the ERC20 token contract on Base
    /// * `amount`                - Amount of SPL tokens to bridge (in the token's smallest units)
    pub fn bridge_spl_with_buffered_call<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, BridgeSplWithBufferedCall<'info>>,
        outgoing_message_salt: [u8; 32],
        to: [u8; 20],
        remote_token: [u8; 20],
        amount: u64,
    ) -> Result<()> {
        bridge_spl_with_buffered_call_handler(ctx, outgoing_message_salt, to, remote_token, amount)
    }

    /// Bridges wrapped tokens from Solana back to their native form on Base.
    /// This function burns wrapped tokens on Solana and initiates a message to release
    /// or mint the original tokens on Base for the specified recipient.
    ///
    /// # Arguments
    /// * `ctx`                   - The context containing accounts for the wrapped token bridge operation
    /// * `outgoing_message_salt` - The salt for the outgoing message account
    /// * `to`                    - The 20-byte Ethereum address that will receive the original tokens on Base
    /// * `amount`                - Amount of wrapped tokens to bridge back (in the token's smallest units)
    /// * `call`                  - Optional additional contract call to execute with the token transfer
    pub fn bridge_wrapped_token(
        ctx: Context<BridgeWrappedToken>,
        outgoing_message_salt: [u8; 32],
        to: [u8; 20],
        amount: u64,
        call: Option<Call>,
    ) -> Result<()> {
        bridge_wrapped_token_handler(ctx, outgoing_message_salt, to, amount, call)
    }

    /// Bridges wrapped tokens from Solana back to Base with a call using buffered data.
    /// This function burns wrapped tokens on Solana and initiates a message to release
    /// the original tokens on Base, then executes a call using data from a call buffer.
    ///
    /// # Arguments
    /// * `ctx`                   - The context containing accounts for the wrapped token bridge operation
    /// * `outgoing_message_salt` - The salt for the outgoing message account
    /// * `to`                    - The 20-byte Ethereum address that will receive tokens on Base
    /// * `amount`                - Amount of wrapped tokens to bridge back (in the token's smallest units)
    pub fn bridge_wrapped_token_with_buffered_call<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, BridgeWrappedTokenWithBufferedCall<'info>>,
        outgoing_message_salt: [u8; 32],
        to: [u8; 20],
        amount: u64,
    ) -> Result<()> {
        bridge_wrapped_token_with_buffered_call_handler(ctx, outgoing_message_salt, to, amount)
    }

    /// Initializes a call buffer account that can store large call data.
    /// This account can be used to build up call data over multiple transactions
    /// before using it in a bridge operation.
    ///
    /// # Arguments
    /// * `ctx`          - The context containing accounts for initialization (including bridge config)
    /// * `ty`           - The type of call (Call, DelegateCall, Create, Create2)
    /// * `to`           - The target contract address on Base
    /// * `value`        - The amount of ETH to send with the call (in wei)
    /// * `initial_data` - Initial call data to store
    /// * `max_data_len` - Maximum total length of data that will be stored
    pub fn initialize_call_buffer(
        ctx: Context<InitializeCallBuffer>,
        ty: CallType,
        to: [u8; 20],
        value: u128,
        initial_data: Vec<u8>,
        max_data_len: u64,
    ) -> Result<()> {
        initialize_call_buffer_handler(ctx, ty, to, value, initial_data, max_data_len)
    }

    /// Appends data to an existing call buffer account.
    /// Only the owner of the call buffer can append data to it.
    ///
    /// # Arguments
    /// * `ctx`  - The context containing the call buffer account
    /// * `data` - Additional data to append to the buffer
    pub fn append_to_call_buffer(ctx: Context<AppendToCallBuffer>, data: Vec<u8>) -> Result<()> {
        append_to_call_buffer_handler(ctx, data)
    }

    /// Closes a call buffer account and returns the rent to the specified receiver.
    /// Only the owner of the call buffer can close it. This is useful if the user
    /// changed their mind or made a mistake and wants to recover the rent.
    ///
    /// # Arguments
    /// * `ctx` - The context containing the call buffer to close and rent receiver (owner)
    pub fn close_call_buffer(ctx: Context<CloseCallBuffer>) -> Result<()> {
        close_call_buffer_handler(ctx)
    }

    /// Transfer guardian authority to a new pubkey
    /// Only the current guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and current guardian
    /// * `new_guardian` - The pubkey of the new guardian
    pub fn transfer_guardian(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_guardian: Pubkey,
    ) -> Result<()> {
        transfer_guardian_handler(ctx, new_guardian)
    }

    /// Sets the authorized oracle EVM signer addresses and the signature threshold used
    /// when registering output roots. This function updates the `OracleSigners` account
    /// and can only be called by the guardian.
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge, guardian signer, and oracle signers accounts
    /// * `cfg` - Configuration parameters for Base oracle signers
    pub fn set_oracle_signers(
        ctx: Context<SetBridgeConfigFromUpgradeAuthority>,
        cfg: BaseOracleConfig,
    ) -> Result<()> {
        set_oracle_signers_handler(ctx, cfg)
    }

    // EIP-1559 Configuration Management

    /// Set the minimum base fee for EIP-1559 pricing
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_fee` - The new minimum base fee value
    pub fn set_minimum_base_fee(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_fee: u64,
    ) -> Result<()> {
        set_minimum_base_fee_handler(ctx, new_fee)
    }

    /// Set the window duration for EIP-1559 pricing
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_duration` - The new window duration in seconds
    pub fn set_window_duration(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_duration: u64,
    ) -> Result<()> {
        set_window_duration_handler(ctx, new_duration)
    }

    /// Set the gas target for EIP-1559 pricing
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_target` - The new gas target value
    pub fn set_gas_target(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_target: u64,
    ) -> Result<()> {
        set_gas_target_handler(ctx, new_target)
    }

    /// Set the adjustment denominator for EIP-1559 pricing
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_denominator` - The new adjustment denominator
    pub fn set_adjustment_denominator(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_denominator: u64,
    ) -> Result<()> {
        set_adjustment_denominator_handler(ctx, new_denominator)
    }

    /// Set the gas cost scaler for Gas Cost Config
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_scaler` - The new gas cost scaler value
    pub fn set_gas_cost_scaler(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_scaler: u64,
    ) -> Result<()> {
        set_gas_cost_scaler_handler(ctx, new_scaler)
    }

    /// Set the gas cost scaler DP for Gas Cost Config
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_dp` - The new gas cost scaler DP value
    pub fn set_gas_cost_scaler_dp(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_dp: u64,
    ) -> Result<()> {
        set_gas_cost_scaler_dp_handler(ctx, new_dp)
    }

    /// Set the gas fee receiver for Gas Cost Config
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_receiver` - The new gas fee receiver
    pub fn set_gas_fee_receiver(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_receiver: Pubkey,
    ) -> Result<()> {
        set_gas_fee_receiver_handler(ctx, new_receiver)
    }

    /// Set the gas amount per call for Gas Config
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_val` - The new gas amount per call value
    pub fn set_gas_per_call(ctx: Context<SetBridgeConfigFromGuardian>, new_val: u64) -> Result<()> {
        set_gas_per_call_handler(ctx, new_val)
    }

    /// Set the block interval requirement for Protocol Config
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_interval` - The new block interval requirement value
    pub fn set_block_interval_requirement(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_interval: u64,
    ) -> Result<()> {
        set_block_interval_requirement_handler(ctx, new_interval)
    }

    /// Set the max call buffer size for Buffer Config
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_size` - The new max call buffer size value
    pub fn set_max_call_buffer_size(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_size: u64,
    ) -> Result<()> {
        set_max_call_buffer_size_handler(ctx, new_size)
    }

    /// Set the pause status for the bridge
    /// Only the guardian can call this function
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_paused` - The new pause status (true for paused, false for unpaused)
    pub fn set_pause_status(
        ctx: Context<SetBridgeConfigFromGuardian>,
        new_paused: bool,
    ) -> Result<()> {
        set_pause_status_handler(ctx, new_paused)
    }

    /// Update the partner oracle configuration containing the required signature threshold
    ///
    /// # Arguments
    /// * `ctx` - The context containing the bridge account and guardian
    /// * `new_config` - The new partner oracle config
    pub fn set_partner_oracle_config(
        ctx: Context<SetBridgeConfigFromUpgradeAuthority>,
        new_config: PartnerOracleConfig,
    ) -> Result<()> {
        set_partner_config_handler(ctx, new_config)
    }

    // ============================================================================
    // Confidential Bridge Instructions (Inco Lightning)
    // ============================================================================

    /// Initialize a confidential vault for storing encrypted token balances.
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for vault initialization
    pub fn initialize_confidential_vault<'info>(
        ctx: Context<'_, '_, 'info, 'info, InitializeConfidentialVault<'info>>,
    ) -> Result<()> {
        confidential::initialize_confidential_vault(ctx)
    }

    /// Bridge tokens confidentially from Solana to Base.
    /// Burns encrypted tokens from vault and emits bridge message.
    ///
    /// Bridge tokens confidentially from Solana to Base (ciphertext).
    /// This version expects client-side encrypted ciphertext from Inco SDK.
    ///
    /// # Arguments
    /// * `ctx` - The context containing vault and bridge accounts
    /// * `encrypted_amount` - Client-encrypted amount ciphertext
    /// * `destination_evm` - 20-byte Ethereum address on Base
    pub fn bridge_confidential_out<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, BridgeConfidentialOut<'info>>,
        encrypted_amount: Vec<u8>,
        destination_evm: [u8; 20],
    ) -> Result<()> {
        confidential::bridge_confidential_out(ctx, encrypted_amount, destination_evm)
    }

    /// Bridge tokens confidentially from Solana to Base via relayer (SENDER PRIVACY).
    /// The relayer submits the transaction on behalf of the user, hiding their address.
    /// User's signature is verified off-chain by the relayer before submission.
    ///
    /// # Arguments
    /// * `ctx` - The context containing vault, bridge state, and relayer
    /// * `encrypted_amount` - Client-encrypted amount ciphertext
    /// * `destination_evm` - 20-byte Ethereum address on Base
    /// * `vault_owner` - The Pubkey of the vault owner (for verification)
    /// * `message_signature` - Ed25519 signature from vault owner (verified off-chain)
    /// * `nonce` - Replay protection nonce
    /// * `deadline` - Message expiration timestamp
    pub fn relay_bridge_confidential_out<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, RelayBridgeConfidentialOut<'info>>,
        encrypted_amount: Vec<u8>,
        destination_evm: [u8; 20],
        vault_owner: Pubkey,
        message_signature: [u8; 64],
        nonce: u64,
        deadline: i64,
    ) -> Result<()> {
        confidential::relay_bridge_confidential_out(
            ctx,
            encrypted_amount,
            destination_evm,
            vault_owner,
            message_signature,
            nonce,
            deadline,
        )
    }

    /// Grant access to a handle for attested decryption.
    /// This is needed as a second transaction after bridge_confidential_out
    /// because we don't know the handle value until after it's created.
    ///
    /// # Arguments
    /// * `ctx` - The context containing owner and Inco Lightning program
    /// * `handle` - The 128-bit handle to grant access for
    pub fn grant_handle_access<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, GrantHandleAccess<'info>>,
        handle: u128,
    ) -> Result<()> {
        confidential::grant_handle_access(ctx, handle)
    }

    /// Receive confidential tokens from Base.
    /// Mints encrypted tokens to recipient's vault.
    ///
    /// # Arguments
    /// * `ctx` - The context containing vault and bridge authority
    /// * `encrypted_amount` - Encrypted amount ciphertext from Base
    /// * `base_sender` - 20-byte Ethereum sender address on Base
    pub fn receive_confidential_in<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, ReceiveConfidentialIn<'info>>,
        encrypted_amount: Vec<u8>,
        base_sender: [u8; 20],
    ) -> Result<()> {
        confidential::receive_confidential_in(ctx, encrypted_amount, base_sender)
    }

    /// Relay receive confidential tokens from Base (guardian-authorized).
    /// Called by relayer to mint encrypted tokens using bridge_authority PDA.
    ///
    /// # Arguments
    /// * `ctx` - The context containing vault, bridge state, and relayer
    /// * `encrypted_amount` - Encrypted amount ciphertext from Base
    /// * `base_sender` - 20-byte Ethereum sender address on Base
    pub fn relay_receive_confidential<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, RelayReceiveConfidential<'info>>,
        encrypted_amount: Vec<u8>,
        base_sender: [u8; 20],
    ) -> Result<()> {
        confidential::relay_receive_confidential(ctx, encrypted_amount, base_sender)
    }

    /// Deposit plaintext SPL tokens into a confidential vault.
    /// Converts regular token balance to encrypted balance.
    ///
    /// # Arguments
    /// * `ctx` - The context containing vault and token accounts
    /// * `amount` - Plaintext amount of tokens to deposit
    pub fn deposit_to_confidential_vault<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositToConfidentialVault<'info>>,
        amount: u64,
    ) -> Result<()> {
        confidential::deposit_to_confidential_vault(ctx, amount)
    }

    /// Withdraw from confidential vault using attested decryption.
    /// Verifies the attestation and converts encrypted balance to plaintext tokens.
    ///
    /// # Arguments
    /// * `ctx` - The context containing vault and token accounts
    /// * `plaintext_amount` - The decrypted amount from attestation
    /// * `expected_handle` - The encrypted handle that was decrypted
    /// * `attestation_signature` - Guardian's Ed25519 attestation signature
    pub fn withdraw_with_attestation<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawWithAttestation<'info>>,
        plaintext_amount: u64,
        expected_handle: u128,
        attestation_signature: [u8; 64],
    ) -> Result<()> {
        confidential::withdraw_with_attestation(ctx, plaintext_amount, expected_handle, attestation_signature)
    }

    // ============================================================================
    // Privacy Functions (Sender + Receiver Privacy)
    // ============================================================================

    /// Bridge tokens with FULL PRIVACY using commitment.
    /// The recipient is hidden behind a commitment hash. Only someone with
    /// the secret (whose hash matches the commitment) can claim the tokens.
    ///
    /// # Arguments
    /// * `ctx` - The context containing vault accounts
    /// * `encrypted_amount` - Client-encrypted amount ciphertext
    /// * `commitment_hash` - keccak256(secret) - recipient must know the secret
    pub fn bridge_private_with_commitment<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, BridgePrivateWithCommitment<'info>>,
        encrypted_amount: Vec<u8>,
        commitment_hash: [u8; 32],
    ) -> Result<()> {
        confidential::bridge_private_with_commitment(ctx, encrypted_amount, commitment_hash)
    }

    /// Create a claim for receiver privacy on incoming bridge transfers.
    /// Instead of minting directly to a recipient, creates a claim that anyone
    /// with the correct secret can redeem.
    ///
    /// # Arguments
    /// * `ctx` - The context containing bridge authority and claim account
    /// * `encrypted_amount` - Encrypted amount ciphertext
    /// * `commitment_hash` - keccak256(secret) for claiming
    /// * `claim_duration_seconds` - How long the claim is valid
    /// * `nonce` - Unique nonce for this claim
    pub fn create_confidential_claim<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, CreateConfidentialClaim<'info>>,
        encrypted_amount: Vec<u8>,
        commitment_hash: [u8; 32],
        claim_duration_seconds: i64,
        nonce: u64,
    ) -> Result<()> {
        confidential::create_confidential_claim(ctx, encrypted_amount, commitment_hash, claim_duration_seconds, nonce)
    }

    /// Redeem a claim using the secret.
    /// Anyone who knows the secret can claim. The recipient is only revealed
    /// at claim time, not at bridge time.
    ///
    /// # Arguments
    /// * `ctx` - The context containing claim and recipient vault
    /// * `secret` - The 32-byte secret whose hash matches the claim's commitment
    pub fn redeem_confidential_claim<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, RedeemConfidentialClaim<'info>>,
        secret: [u8; 32],
    ) -> Result<()> {
        confidential::redeem_confidential_claim(ctx, secret)
    }

    // ============================================================================
    // Inco TEE Private Claim Functions (Recipient Hidden via Encrypted Pubkey)
    // ============================================================================

    /// Create a claim with encrypted recipient (Inco TEE-based recipient privacy).
    /// The recipient pubkey is encrypted - only revealed via attested decryption.
    ///
    /// # Arguments
    /// * `ctx` - The context containing payer, bridge authority, and claim account
    /// * `encrypted_amount` - Client-encrypted amount ciphertext
    /// * `encrypted_recipient_low` - Lower 128 bits of encrypted recipient pubkey
    /// * `encrypted_recipient_high` - Upper 128 bits of encrypted recipient pubkey
    /// * `claim_duration_seconds` - How long the claim is valid
    /// * `nonce` - Unique nonce for this claim
    pub fn create_inco_private_claim<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, CreateIncoPrivateClaim<'info>>,
        encrypted_amount: Vec<u8>,
        encrypted_recipient_low: Vec<u8>,
        encrypted_recipient_high: Vec<u8>,
        claim_duration_seconds: i64,
        nonce: u64,
    ) -> Result<()> {
        confidential::create_inco_private_claim(
            ctx,
            encrypted_amount,
            encrypted_recipient_low,
            encrypted_recipient_high,
            claim_duration_seconds,
            nonce,
        )
    }

    /// Claim tokens using Inco TEE attested decryption.
    /// The recipient proves ownership of the encrypted pubkey via attestation.
    /// This is the FIRST TIME the recipient address is revealed!
    ///
    /// # Arguments
    /// * `ctx` - The context containing claim and recipient vault
    /// * `attestation_signature` - Covalidator signature proving the decryption
    pub fn claim_with_attestation<'a, 'info>(
        ctx: Context<'a, '_, '_, 'info, ClaimWithAttestation<'info>>,
        attestation_signature: Vec<u8>,
    ) -> Result<()> {
        confidential::claim_with_attestation(ctx, attestation_signature)
    }
}
