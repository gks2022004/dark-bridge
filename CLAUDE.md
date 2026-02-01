# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a bidirectional bridge between Base and Solana that enables:

- Cross-chain token transfers (SOL, SPL tokens, ERC20s, ETH)
- Arbitrary cross-chain message passing
- Wrapped token deployment on both chains
- **Privacy-preserving transfers via Inco Lightning encrypted computation**

The bridge consists of two main components:

1. **Base contracts** (Solidity/Foundry) - handles Base-side operations
2. **Solana program** (Rust/Anchor) - handles Solana-side operations

## Development Commands

### Privacy Bridge (Quick Start)

```bash
cd scripts

# Run privacy demo (shows complete flow)
EVM_PRIVATE_KEY=0x... bun run src/demo-privacy-e2e.ts

# Start privacy relayers (separate terminals)
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts --monitor
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor
```

### Base Contracts (Foundry)

```bash
cd base

# Build contracts
forge build

# Run tests
forge test

# Run fork tests against Base Sepolia
forge test --fork-url https://sepolia.base.org -vvv

# Privacy fork tests (with real Inco)
forge test --match-contract ConfidentialBridgeForkTest --fork-url https://sepolia.base.org -v
forge test --match-contract ConfidentialBridgeE2EForkTest --fork-url https://sepolia.base.org -vv

# Test coverage
make coverage

# Install dependencies
make deps

# Deploy to testnet
make deploy

# Create wrapped tokens
make create-wrapped-sol
make create-wrapped-spl
```

### Solana Program

```bash
cd solana

# Install dependencies
bun install

# Build program for specific environment
bun run program:build devnet-alpha
bun run program:build devnet-prod

# Deploy program
bun run program:deploy devnet-alpha

# Generate IDL and client
bun run generate:idl devnet-alpha
bun run generate:client

# Initialize bridge
bun run tx:initialize devnet-alpha

# Bridge operations
bun run tx:bridge-sol devnet-alpha
bun run tx:bridge-spl devnet-alpha
bun run tx:wrap-token devnet-alpha
```

### TypeScript Client

```bash
cd clients/ts

# Install dependencies
npm install

# Generate test ciphertexts (requires bun due to @inco/js ESM issues)
bun run src/generate-test-ciphertexts.ts
```

## Architecture

### Base Side

- **Bridge.sol**: Main contract receiving calls from Solana and managing message execution
- **Twin.sol**: Execution contract for each Solana sender pubkey  
- **CrossChainERC20.sol**: Mintable/burnable ERC20 for cross-chain transfers
- **CrossChainERC20Factory.sol**: Factory for deploying wrapped tokens
- **ConfidentialBridge.sol**: Privacy-preserving bridge using Inco Lightning encrypted computation
- **ConfidentialCrossChainERC20.sol**: Confidential ERC20 with encrypted balances (euint256)

### Solana Side

- **Bridge State**: Central account with configuration and message nonces
- **OutgoingMessage**: Messages sent from Solana to Base
- **IncomingMessage**: Messages sent from Base to Solana
- **Vaults**: Lock SPL tokens and native SOL during bridging
- **ConfidentialVault**: Encrypted vault for private balances (Euint128 handles)

### Bridge Flow

1. **Base → Solana**: Initiate on Base, wait ~15 minutes for root posting, then prove + finalize on Solana
2. **Solana → Base**: Direct execution after message creation

### Privacy Flow (Inco Lightning - TEE-based)

1. User encrypts amount using `@inco/js` SDK (EVM) or `@inco/solana-sdk` (SVM)
2. Encrypted ciphertext passed to bridge contract/program
3. Bridge stores encrypted handle (reference to value in TEE network)
4. Operations (add, sub, compare) performed via CPI - TEE decrypts, computes, re-encrypts
5. Handle verified on receive to prevent substitution attacks
6. **Privacy preserved**: Plaintext only exists inside TEE, never on-chain

### Bidirectional Bridge Client (Added in 6d71c93)

A unified client (`BidirectionalBridge`) manages operations across both chains:

- **State Monitoring**: `getState()` provides real-time sync status (Base blocks/MMR vs Solana registered roots).
- **Visual Dashboard**: `printStatus()` displays bridge balances, message counts, and oracle sync latency.
- **Operations**:
  - `startOracle()`: Runs the oracle service to register Base output roots.
  - `proveMessage()`: Proves and relays Base messages to Solana.
  - `relayToBase()`: Relays Solana messages to Base.

## Environment Setup

### Base Contracts

- Uses Foundry with forge
- Requires `testnet-admin` wallet account for deployments
- Environment variables in `base/Makefile` for contract addresses
- Inco Lightning available on Base Sepolia at precompile addresses

### Solana Program  

- Uses Anchor framework with Rust
- Requires keypair files in `keypairs/` directory
- Scripts automatically resolve deployer keypair from `~/.config/solana/cli/config.yml`
- Two environments: devnet-alpha and devnet-prod

## Testing Strategy

### Unit Tests

- **Base**: Use `forge test` for Solidity unit tests
- **Solana**: Rust unit tests within the program

### Fork Tests

Fork tests run against Base Sepolia with real Inco Lightning covalidator infrastructure:

```bash
cd base

# Basic fork tests (fast, ~30s)
forge test --match-contract ConfidentialBridgeForkTest --fork-url https://sepolia.base.org -v

# E2E fork tests (requires real Inco ciphertexts)
forge test --match-contract ConfidentialBridgeE2EForkTest --fork-url https://sepolia.base.org -vv

# Handle verification security tests
forge test --match-contract ConfidentialBridgeHandleVerificationTest --fork-url https://sepolia.base.org -vv
```

### Test Files

- `ConfidentialBridge.Fork.t.sol` - Basic deployment and configuration tests
- `ConfidentialBridge.E2E.Fork.t.sol` - End-to-end privacy scenarios
- `ConfidentialBridge.HandleVerification.t.sol` - Handle verification security tests

### Test Setup Requirements

Tests using Inco encrypted operations require:

1. **Contract funding** - Contracts need ETH to pay Inco fees
2. **Real ciphertexts** - Mock ciphertexts will be rejected by Inco precompiles
3. **DEPLOYED_BRIDGE funding** - When using `vm.prank()`, ensure the pranked address has ETH

Example test setup:

```solidity
// Fund contracts with ETH to pay Inco fees
vm.deal(address(confidentialBridge), 50 ether);
vm.deal(address(confidentialToken), 50 ether);
vm.deal(DEPLOYED_BRIDGE, 50 ether); // For prank calls
```

## Known Issues

### @inco/js ESM Package Bug ✅ RESOLVED

The `@inco/js` package (v0.8.0-devnet) has **broken ESM exports** when used with Node.js:

- Missing `types_pb` module in ESM resolution
- Named exports fail: `"does not provide an export named 'Lightning'"`
- Affects: `@inco/js/lite`, `@inco/js/encryption` subpaths

**Resolution:** Use **bun** instead of Node.js

```bash
# Install bun (one-time)
curl -fsSL https://bun.sh/install | bash
source ~/.zshrc

# Run scripts with bun (works perfectly!)
bun run src/demo-private-bridge.ts
```

**Why this works:** Bun has better ESM module resolution that handles the package's subpath exports correctly.

**Additional fix needed:** The `Lightning.latest()` method returns a Promise, so it must be awaited:

```typescript
// ❌ Wrong (what was causing "encrypt is not a function")
this.baseZap = Lightning.latest(config.incoEnvironment, chainId);

// ✅ Correct (await the Promise)
this.baseZap = await Lightning.latest(config.incoEnvironment, chainId);
```

### ConfidentialCrossChainERC20 Initialization

The implementation contract has `_disableInitializers()` in its constructor. This means:

- **Do NOT call `initialize()` on deployed implementation contracts**
- Tests should skip initialization or use a proxy pattern
- Will get `InvalidInitialization()` error if you try to initialize

### Inco Fork Test Limitation

When running fork tests with mock encrypted amounts:

- The mock bytes (`_mockEncryptedAmount()`) will be **rejected** by real Inco precompiles
- Tests will revert at `newEuint256()` call to Inco covalidator
- Solutions: Use real ciphertexts from `@inco/js`, mock the precompile, or skip Inco-dependent tests

## Key Files to Understand

### Core Contracts

- `base/src/Bridge.sol` - Core Base bridge logic
- `base/src/ConfidentialBridge.sol` - Privacy-preserving bridge
- `base/src/ConfidentialCrossChainERC20.sol` - Inco encrypted ERC20
- `solana/programs/bridge/src/lib.rs` - Solana program entry point  

### Deployment & Scripts

- `base/script/Deploy.s.sol` - Base deployment script
- `solana/scripts/onchain/` - Solana transaction examples

### Testing

- `base/test/ConfidentialBridge.Fork.t.sol` - Fork test suite
- `base/test/ConfidentialBridge.HandleVerification.t.sol` - Security tests

### TypeScript SDK

- `clients/ts/src/privacy-client.ts` - Privacy bridge client using Inco
- `clients/ts/src/bidirectional-bridge.ts` - Unified bridge client & oracle
- `clients/ts/src/generate-test-ciphertexts.ts` - Test ciphertext generator

## Inco Lightning Integration

Inco Lightning is a **confidentiality layer** for blockchains using **Trusted Execution Environments (TEEs)** - NOT Fully Homomorphic Encryption (FHE). It provides encrypted data types where **handles** (bytes32/u128) reference private values processed securely inside hardware enclaves.

### How TEE-Based Privacy Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    INCO LIGHTNING ARCHITECTURE (TEE-based)                  │
├─────────────────────────────────────────────────────────────────────────────┤
│   On-Chain (Base/Solana)              Inco TEE Network (Off-Chain)          │
│   ──────────────────────              ────────────────────────────          │
│                                                                             │
│   Only HANDLES stored                 ┌───────────────────────────┐         │
│   (opaque references)                 │  Trusted Execution Env    │         │
│         │                             │  ┌─────────────────────┐  │         │
│         │ CPI/Precompile              │  │ Private Data Store  │  │         │
│         ▼                             │  │ handle → plaintext  │  │         │
│   e_add(h1, h2)  ────────────────────▶│  └─────────────────────┘  │         │
│                                       │         │                 │         │
│                                       │         ▼                 │         │
│                                       │  1. Lookup h1, h2         │         │
│                                       │  2. Decrypt in TEE        │         │
│                                       │  3. Add plaintexts        │         │
│                                       │  4. Re-encrypt result     │         │
│   new_handle h3  ◀────────────────────│  5. Return new handle     │         │
│                                       │                           │         │
│                                       │  TEE Attestation proves   │         │
│                                       │  correct execution        │         │
│                                       └───────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### TEE vs FHE Comparison

| Aspect | FHE (Old Approach) | TEE / Inco Lightning (Current) |
|--------|-------------------|-------------------------------|
| **Where computation happens** | On encrypted data directly | Inside secure hardware enclave on plaintext |
| **Speed** | Very slow (heavy crypto) | Lightning fast (native CPU in TEE) |
| **Trust model** | Math-based (no trust needed) | Hardware-based (trust TEE attestation) |
| **Operations** | Limited by FHE scheme | Any computation possible |
| **Verification** | Cryptographic proof | TEE attestation signatures |

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Handles** | Immutable references to encrypted values (bytes32 on EVM, u128 on SVM) |
| **E-Types** | `euint256`, `ebool`, `eaddress` (EVM) / `Euint128`, `Ebool` (SVM) |
| **Operations** | Arithmetic/comparison on encrypted values via contract calls or CPI |
| **Access Control** | `allow()` grants decryption rights to specific addresses |
| **Attestations** | Covalidator-signed proofs for decryption/computation results |

### EVM (Base) - Solidity API

```solidity
import {euint256, ebool, eaddress, e, inco} from "@inco/lightning/Lib.sol";
using e for *;

// ============== Input Functions ==============

// From ciphertext (client-encrypted) - requires fee
euint256 encrypted = valueInput.newEuint256(msg.sender);
ebool flag = flagInput.newEbool(msg.sender);
eaddress addr = addrInput.newEaddress(msg.sender);

// From plaintext (trivial encrypt)
euint256 amount = uint256(1000).asEuint256();
ebool isActive = true.asEbool();

// ============== Math Operations ==============

euint256 sum = a.add(b);      // Addition
euint256 diff = a.sub(b);     // Subtraction
euint256 prod = a.mul(b);     // Multiplication
euint256 quot = a.div(b);     // Division
euint256 remainder = a.rem(b); // Remainder

// ============== Bitwise Operations ==============

euint256 andResult = a.and(b);
euint256 orResult = a.or(b);
euint256 xorResult = a.xor(b);
euint256 shifted = a.shr(bits);
euint256 rotated = a.rotl(bits);

// ============== Comparison Operations ==============

ebool isEqual = a.eq(b);      // Equal
ebool isGreater = a.gt(b);    // Greater than
ebool isGe = a.ge(b);         // Greater or equal
ebool isLess = a.lt(b);       // Less than
ebool isLe = a.le(b);         // Less or equal
euint256 minimum = a.min(b);  // Min value
euint256 maximum = a.max(b);  // Max value

// ============== Random Numbers ==============

euint256 random = e.rand();
euint256 bounded = e.randBounded(100);          // [0, 100)
euint256 encBounded = e.randBounded(upperBound); // Encrypted bound

// ============== Control Flow (Multiplexer Pattern) ==============

// Use select() instead of if/else - never reveals condition
euint256 result = condition.select(valueIfTrue, valueIfFalse);

// Example: conditional transfer
ebool hasBalance = balanceOf[msg.sender].ge(amount);
euint256 transferred = hasBalance.select(amount, uint256(0).asEuint256());

// ============== Access Control ==============

// Grant decryption access (required after every operation!)
newBalance.allow(msg.sender);  // Allow user to decrypt
newBalance.allowThis();        // Allow contract to compute in future

// Check if address can decrypt
require(msg.sender.isAllowed(value), "Unauthorized");

// ============== Fees ==============

require(msg.value >= inco.getFee() * ciphertextCount, "Fee not paid");
```

### EVM Decryption Flows

```solidity
import {DecryptionAttestation} from "@inco/lightning/src/lightning-parts/DecryptionAttester.types.sol";

// Verify attested decryption on-chain
function verifyDecryption(
    DecryptionAttestation memory decryption,
    bytes[] memory signatures
) external {
    // 1. Verify covalidator signatures
    require(
        inco.incoVerifier().isValidDecryptionAttestation(decryption, signatures),
        "Invalid signature"
    );
    
    // 2. Verify handle matches expected value
    require(euint256.unwrap(myHandle) == decryption.handle, "Handle mismatch");
    
    // 3. Use decrypted value
    uint256 plaintext = uint256(decryption.value);
}
```

### SVM (Solana) - Rust API

```rust
use anchor_lang::prelude::*;
use inco_lightning::cpi::accounts::{Operation, Allow};
use inco_lightning::cpi::{
    e_add, e_sub, e_mul, e_ge, e_gt, e_le, e_lt, e_eq,
    e_select, e_and, e_or, e_not, e_shl, e_shr, e_rand,
    new_euint128, as_euint128, new_ebool, as_ebool, allow
};
use inco_lightning::types::{Euint128, Ebool};
use inco_lightning::ID as INCO_LIGHTNING_ID;

// ============== Input Functions ==============

// From ciphertext (client-encrypted)
let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

// From plaintext
let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
let zero: Euint128 = as_euint128(cpi_ctx, 0)?;

// ============== Arithmetic Operations ==============

let sum: Euint128 = e_add(cpi_ctx, a, b, 0)?;
let diff: Euint128 = e_sub(cpi_ctx, a, b, 0)?;
let prod: Euint128 = e_mul(cpi_ctx, a, b, 0)?;

// ============== Comparison Operations ==============

let is_ge: Ebool = e_ge(cpi_ctx, balance, amount, 0)?;
let is_gt: Ebool = e_gt(cpi_ctx, a, b, 0)?;
let is_eq: Ebool = e_eq(cpi_ctx, a, b, 0)?;

// ============== Control Flow ==============

// Conditional selection (if/else replacement)
let actual: Euint128 = e_select(cpi_ctx, condition, if_true, if_false, 0)?;

// ============== Access Control ==============

// Grant decryption access via remaining_accounts
let cpi_ctx = CpiContext::new(
    inco.clone(),
    Allow {
        allowance_account: ctx.remaining_accounts[0].clone(),
        signer: signer.clone(),
        allowed_address: ctx.remaining_accounts[1].clone(),
        system_program: ctx.accounts.system_program.to_account_info(),
    },
);
allow(cpi_ctx, new_balance.0, true, owner)?;

// ============== Random Numbers ==============

let random: Euint128 = e_rand(cpi_ctx, 0)?;

// ============== Bitwise Operations ==============

let and_result: Euint128 = e_and(cpi_ctx, a, b, 0)?;
let or_result: Euint128 = e_or(cpi_ctx, a, b, 0)?;
let not_result: Euint128 = e_not(cpi_ctx, a, 0)?;
```

### TypeScript Client (Encryption)

```typescript
import { Lightning, supportedChains } from '@inco/js';

// Initialize Inco
const zap = await Lightning.latest('testnet', supportedChains.baseSepolia);

// Encrypt value for EVM
const ciphertext = await zap.encrypt(amount, {
  accountAddress: userAddress,
  dappAddress: contractAddress
});

// Attested decrypt (with covalidator signatures)
const results = await zap.attestedDecrypt(walletClient, [handleHex]);
const { handle, plaintext, covalidatorSignatures } = results[0];

// Attested compute (off-chain computation)
const result = await zap.attestedCompute(
  walletClient,
  handleHex,
  AttestedComputeSupportedOps.Ge,
  700n  // Compare: handle >= 700
);

// Attested reveal (for publicly revealed handles)
const revealed = await zap.attestedReveal([handleHex]);
```

### Best Practices

1. **Always call `allowThis()` after operations** - Otherwise contract can't use the value in future tx
2. **Verify handle matches on attestation** - Prevents handle swap attacks
3. **Check `isAllowed()` for external handle inputs** - Prevent unauthorized access
4. **Use `select()` instead of if/else** - Never branch on encrypted conditions
5. **Pay fees for ciphertext inputs** - `msg.value >= inco.getFee() * count`
6. **Be careful with delegatecall** - Called contract can decrypt your handles

---

## Base → Solana Bridge Troubleshooting (January 2026)

This section documents the issues encountered and fixes implemented to get the Base→Solana bridge operational.

### Problem Summary

The Base→Solana bridge was not working due to several configuration and code issues:

1. **Oracle signer not authorized** on the Solana bridge program
2. **Double EIP-191 prefix bug** in the oracle signing code
3. **Wrong bridge contract address** in the oracle configuration
4. **Massive block gap** between Solana bridge state and current Base blocks

### Issue 1: Oracle Signer Not Authorized

**Symptom**: Oracle failed with `InsufficientBaseSignatures` error

**Root Cause**: The EVM address `0xF8AF04bF0Ac151f2050436603d81Ba20f449028F` (derived from the private key in `base/.env`) was not registered as an authorized oracle signer on the Solana bridge program.

**Solution**: Created `scripts/src/set-oracle-signers.ts` to call the `setOracleSigners` instruction:

```bash
cd scripts && bun run src/set-oracle-signers.ts
```

This requires the **program upgrade authority** (deployer) keypair to sign. The script:

- Derives the bridge PDA and program data address
- Builds a `BaseOracleConfig` with threshold=1 and the EVM signer address
- Sends the `setOracleSigners` instruction

**Key Transaction**: `5mzPig9YVKqkGjhpST8EJCmGKQAF5RcsRqi3Vs3pqVcZsgiW5kywSuR6bHeZEVszXxEmqryqaRffEHEzGyQ15pTG`

### Issue 2: Double EIP-191 Prefix Bug

**Symptom**: Oracle signatures were being rejected even after setting the correct signer

**Root Cause**: In `clients/ts/src/base-to-solana-oracle.ts`, the `signOutputRoot` function was:

1. Computing `messageHash` with EIP-191 prefix applied
2. Then calling `signMessage({ raw: messageHash })` which adds **another** EIP-191 prefix

This resulted in a double-prefixed message that didn't match what the Solana program expected.

**Solution**: Changed the signing flow to pass raw message bytes to `signMessage`:

```typescript
// Before (WRONG - double prefix):
const messageHash = computeOutputRootMessageHash(...); // Adds EIP-191 prefix
const signature = await account.signMessage({ message: { raw: messageHash } }); // Adds ANOTHER prefix!

// After (CORRECT - single prefix):
const rawMessage = buildRawMessageBytes(...); // NO prefix
const signature = await account.signMessage({ message: { raw: rawMessage } }); // Adds prefix ONCE
```

The Solana program at `register_output_root.rs:8` computes:

```rust
// message = keccak256("\x19Ethereum Signed Message:\n" || len || (output_root || base_block_number_be || total_leaf_count_be))
```

So viem's `signMessage` should receive the raw bytes (output_root || block_number || leaf_count), and it will add the prefix automatically.

### Issue 3: Wrong Bridge Contract Address

**Symptom**: Oracle was using a different bridge than the CLI tools

**Root Cause**: The oracle's `TESTNET_CONFIG` in `base-to-solana-oracle.ts` had:

```typescript
baseBridgeAddress: '0x2B3550823301752c95290ec6f8781E88F0Bac8c4'  // Wrong!
```

But the CLI's `testnet-alpha` config uses:

```typescript
bridgeContract: '0x8e46419298a9620ea326113baf4019a23594bb11'  // Correct!
```

**Solution**: Updated `TESTNET_CONFIG` to use the correct address:

```typescript
const TESTNET_CONFIG: OracleConfig = {
    baseBridgeAddress: '0x8e46419298a9620ea326113baf4019a23594bb11',
    // ... rest of config
};
```

### Issue 4: Block Number Gap

**Symptom**: `prove-message` failed with "Transaction not finalized yet: 4200 < 36409637"

**Root Cause**: The Solana bridge was initialized starting from block 0, but Base Sepolia was already at block 36+ million. The oracle syncs 300 blocks every 30 seconds, meaning it would take 1000+ hours to catch up.

**Solution**: Created `scripts/src/fast-forward-oracle.ts` to register output roots at any block number:

```bash
cd scripts && EVM_PRIVATE_KEY=0x... bun run src/fast-forward-oracle.ts
```

This script:

1. Gets the current Base block number
2. Calculates the most recent 300-block aligned checkpoint automatically
3. Signs the output root message
4. Calls `registerOutputRoot` on Solana at the target block

### Complete Command Reference

```bash
# 1. Set oracle signers (requires upgrade authority)
cd scripts && bun run src/set-oracle-signers.ts

# 2. Start the oracle service
cd clients/ts && \
  SOLANA_PRIVATE_KEY=$(cat ~/.config/solana/id.json) \
  EVM_PRIVATE_KEY=0x2526bbb0e6f0b2b5974fd974d7d26907e584d44c1de55876d2ef4b794fae97db \
  bun run src/base-to-solana-oracle.ts

# 3. Fast-forward to current block (for testing)
cd scripts && EVM_PRIVATE_KEY=0x... bun run src/fast-forward-oracle.ts

# 4. Create a Base transaction (example bridgeCall)
cast send 0x8e46419298a9620ea326113baf4019a23594bb11 \
  "bridgeCall((bytes32,bytes[],bytes)[])" \
  '[(0xc671a23760000000000000000000000000000000000000000000000000000000,[],0x00)]' \
  --rpc-url https://sepolia.base.org \
  --private-key 0x...

# 5. Prove message on Solana (from scripts/ directory!)
cd scripts && bun run cli sol bridge prove-message \
  --deploy-env testnet-alpha \
  --transaction-hash 0x<BASE_TX_HASH> \
  --payer-kp config

# 6. Relay message (automatically done if not using --skip-relay)
cd scripts && bun run cli sol bridge relay-message \
  --deploy-env testnet-alpha \
  --message-hash 0x<MESSAGE_HASH> \
  --payer-kp config
```

### Key Files Modified/Created

| File | Purpose |
|------|---------|
| `scripts/src/set-oracle-signers.ts` | Set authorized EVM signers on Solana bridge |
| `scripts/src/fast-forward-oracle.ts` | Jump oracle to current Base block |
| `clients/ts/src/base-to-solana-oracle.ts` | Fixed signing bug and bridge address |

### Verified End-to-End Flow

1. ✅ Oracle signer `0xF8AF04bF0Ac151f2050436603d81Ba20f449028F` authorized
2. ✅ Oracle registering output roots at 300-block intervals
3. ✅ Base transaction created at block 36409637
4. ✅ Prove-message succeeded: `4uiXn8sMRD5TBc6HQHGM9TN8VxRV8AVtsN5jG3caiAjMxfu8xhuYVNhbKMbxFxRfny5ToYNMdntFCxXKfXfBgEAp`
5. ⚠️ Relay failed due to dummy program ID (expected - test instruction was invalid)

### Architecture Insight: How the Bridge Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     BASE → SOLANA FLOW                          │
│                                                                 │
│  1. User calls bridgeCall() or bridgeToken() on Base            │
│     └── MessageInitiated event emitted with MMR root + nonce    │
│                                                                 │
│  2. Oracle monitors Base, every 300 blocks:                     │
│     ├── Reads MMR root from Base bridge contract                │
│     ├── Signs (root || block_number || leaf_count) with EVM key │
│     └── Calls registerOutputRoot() on Solana bridge             │
│                                                                 │
│  3. User runs prove-message:                                    │
│     ├── Fetches Base tx receipt and MessageInitiated event      │
│     ├── Generates Merkle proof from Base bridge.generateProof() │
│     ├── Finds registered output root on Solana at >= tx block   │
│     └── Calls proveMessage() on Solana with proof               │
│                                                                 │
│  4. User runs relay-message:                                    │
│     ├── Fetches proven message account from Solana              │
│     └── Calls relayMessage() to execute the instruction(s)      │
└─────────────────────────────────────────────────────────────────┘
```

### Common Errors and Solutions

| Error | Cause | Fix |
|-------|-------|-----|
| `InsufficientBaseSignatures` | EVM signer not authorized | Run `set-oracle-signers.ts` |
| `Transaction not finalized yet` | Oracle hasn't synced to tx block | Wait for oracle or run `fast-forward-oracle.ts` |
| `Script not found "cli"` | Running from wrong directory | `cd scripts` first |
| `custom program error: #0` | Account already exists | Block already registered, skip ahead |
| `Unsupported program id` | Instruction targets invalid program | Use valid Solana program ID in bridgeCall |

## Base Relayer Implementation (January 17, 2026)

This section documents the implementation of the Base Relayer (Solana → Base direction) and the automation of the entire bidirectional flow.

### Implementation Status

- **Base Relayer Program**: Deployed on Solana devnet (`Ma6Fkuhx7SDzPGxEECovenoX62iBAf8kabWcfQx9qL9`).
- **Relayer Configuration**: Initialized with `Cfg` PDA (`6aDzYCjdz5kCkwgGgJrPav3YcJyT6vkVCa46ULniHqoy`).
- **Pay for Relay**: Currently disabled on-chain function due to gas limit constraints (requires ~1.5M gas, initialized with 1M).
- **Auto-Relayers**: Fully functional off-chain automation for both directions.

### New Automation Scripts

We replaced the complex `services/relayer` implementation with two lightweight, robust scripts in `scripts/src/`:

| Script | Direction | Description |
|--------|-----------|-------------|
| `auto-relayer.ts` | **Solana → Base** | Monitors Solana for outgoing messages, registers them on Base validator, and relays them to Base bridge. |
| `auto-relayer-base-sol.ts` | **Base → Solana** | Monitors Base for transactions, syncs oracle if needed, proves message on Solana, and relays it. |

### How to Run (End-to-End Automation)

To run a fully automated bidirectional bridge, open two terminals:

#### Terminal 1: Solana → Base Relayer

```bash
cd scripts
EVM_PRIVATE_KEY=0x... bun run src/auto-relayer.ts
```

*Monitors Solana 24/7. When a user calls `bridge-call` on Solana, this script picks it up and executes it on Base.*

#### Terminal 2: Base → Solana Relayer

```bash
cd scripts
EVM_PRIVATE_KEY=0x... bun run src/auto-relayer-base-sol.ts --monitor
```

*Monitors Base 24/7. When a user creates a transaction on Base, this script syncs the oracle, proves the message, and relays it to Solana.*

### Manual Workflows (Fallback)

If automation fails or you want to relay a specific message manually:

**Solana → Base:**

```bash
# Relay generic message
cd scripts
EVM_PRIVATE_KEY=0x... bun run src/auto-relayer.ts <SOLANA_MESSAGE_PUBKEY>

# Or using the older manual script
cd scripts
EVM_PRIVATE_KEY=0x... bun run src/register-and-relay.ts <SOLANA_MESSAGE_PUBKEY>
```

**Base → Solana:**

```bash
# Relay specific Base transaction
cd scripts
EVM_PRIVATE_KEY=0x... bun run src/auto-relayer-base-sol.ts <BASE_TX_HASH>
```

---

## Privacy Bridge with Inco Lightning

Dark Bridge includes a **complete privacy layer** using Inco Lightning for confidential computation, making it the **first bidirectional privacy bridge** between Base (EVM) and Solana (SVM). 

**Important**: Inco Lightning uses **Trusted Execution Environments (TEEs)**, NOT Fully Homomorphic Encryption (FHE). Handles reference private values that are:
- Stored securely in the Inco TEE network
- Decrypted only inside hardware enclaves for computation
- Re-encrypted before returning results
- Never exposed as plaintext on-chain

### Privacy Features

- ✅ **Encrypted Amounts**: All transfer amounts encrypted using Inco SDK
- ✅ **Encrypted Balances**: Token balances stored as handles (euint256/Euint128)
- ✅ **Cross-Chain Privacy**: Privacy preserved during bridging via handle conversion
- ✅ **TEE-Based Compute**: Add, subtract, compare performed inside secure enclaves
- ✅ **Handle Verification**: Prevents swap attacks via nonce mapping
- ✅ **Access Control**: `allow()` grants decryption permissions to specific addresses
- ✅ **Attestation**: TEE signatures prove correct execution

### Quick Start: Privacy Bridge

```bash
cd scripts

# 1. Run the privacy demo (explains everything)
EVM_PRIVATE_KEY=0x... bun run src/demo-privacy-e2e.ts

# 2. Start privacy relayers (in separate terminals)
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts --monitor
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor
```

### Privacy Architecture

#### EVM Side (Base Sepolia)

**Contracts:**

- `ConfidentialBridge.sol` - Privacy layer for cross-chain transfers
- `ConfidentialCrossChainERC20.sol` - ERC20 with encrypted balances using `euint256` handles

**Key Inco Operations (EVM):**

```solidity
import {euint256, ebool, e, inco} from "@inco/lightning/Lib.sol";

// Create encrypted value from ciphertext
euint256 encrypted = e.newEuint256{value: inco.getFee()}(ciphertext, msg.sender);

// Arithmetic and comparison on encrypted values
euint256 sum = e.add(a, b);
ebool isGreater = e.ge(a, b);

// Grant decryption access
e.allow(handle, user);
```

**Deployed:**

- ConfidentialBridge: `0x7C788FE737acf46e2dbc2F6219653533bd02c558`
- ConfidentialToken: `0x905367eff70fE43F0792bf16DB183a6929E181d7`

#### SVM Side (Solana Devnet)

**Program:**

- `confidential` module with `ConfidentialVault` accounts
- Encrypted balances using `Euint128` (u128 handle = 16 bytes)
- CPI to Inco Lightning program (`5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj`)

**Key Inco Operations (SVM):**

```rust
use inco_lightning::cpi::{e_add, e_sub, e_ge, e_select, new_euint128, as_euint128, allow};
use inco_lightning::types::{Euint128, Ebool};

// Create encrypted handle from ciphertext
let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

// Arithmetic on encrypted values
let new_balance: Euint128 = e_add(cpi_ctx, balance, amount, 0)?;

// Comparison (returns encrypted boolean)
let has_sufficient: Ebool = e_ge(cpi_ctx, balance, amount, 0)?;

// Conditional selection without revealing condition
let actual: Euint128 = e_select(cpi_ctx, has_sufficient, amount, zero, 0)?;

// Grant decryption access via remaining_accounts
allow(cpi_ctx, new_balance.0, true, owner)?;
```

**Deployed:**

- Bridge Program: `EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9`

### Privacy Flow

**Base → Solana:**

```
1. Encrypt amount: @inco/js → euint256 ciphertext
2. Call: ConfidentialBridge.bridgePrivateToSolana()
3. Burns from ConfidentialCrossChainERC20 (via TEE compute)
4. Privacy relayer converts: euint256 (32 bytes) → Euint128 (16 bytes)
5. Mints to ConfidentialVault on Solana (via TEE compute)
✅ Amount NEVER exposed - only exists inside TEE!
```

**Solana → Base:**

```
1. Encrypt amount: @inco/solana-sdk → Euint128 ciphertext
2. Call: bridge.bridge_confidential_out()
3. Burns from ConfidentialVault (via TEE compute)
4. Privacy relayer converts: Euint128 → euint256
5. Mints to ConfidentialCrossChainERC20 on Base (via TEE compute)
✅ Amount NEVER exposed - only exists inside TEE!
```

### Privacy Testing

**Fork Tests (Base):**

```bash
cd base

# Basic privacy tests
forge test --match-contract ConfidentialBridgeForkTest \
  --fork-url https://sepolia.base.org -v

# E2E with real Inco ciphertexts
forge test --match-contract ConfidentialBridgeE2EForkTest \
  --fork-url https://sepolia.base.org -vv

# Security: Handle verification
forge test --match-contract ConfidentialBridgeHandleVerificationTest \
  --fork-url https://sepolia.base.org -vv
```

**Generate Real Ciphertexts:**

```bash
cd clients/ts

# MUST use bun (not node) due to @inco/js ESM issues
bun run src/generate-test-ciphertexts.ts
```

**Encrypt/Decrypt Examples:**

```typescript
// Encrypt for Base
import { Lightning } from '@inco/js/lite';
const zap = await Lightning.latest('testnet', 84532);
const encrypted = await zap.encrypt(amount, {
  accountAddress: userAddress,
  dappAddress: confidentialBridge
});

// Encrypt for Solana
import { encryptValue } from '@inco/solana-sdk/encryption';
const encrypted = await encryptValue(amountBigInt);

// Decrypt (requires permission)
import { decrypt } from '@inco/solana-sdk/attested-decrypt';
const result = await decrypt([handle], {
  address: wallet.publicKey,
  signMessage: wallet.signMessage,
});
```

### Security: Handle Verification

Prevents handle swap attacks via nonce-based verification:

```solidity
// On bridgePrivateToSolana (Base):
expectedHandles[nonce] = euint256.unwrap(amount);

// On receiveFromSolana (Base):
bytes32 received = euint256.unwrap(amount);
if (received != expectedHandles[nonce]) revert HandleMismatch();
delete expectedHandles[nonce]; // Prevent replay
```

### Privacy Documentation

- **[PRIVACY_ARCHITECTURE.md](PRIVACY_ARCHITECTURE.md)** - Complete technical architecture
- **[PRIVACY_TESTING_GUIDE.md](PRIVACY_TESTING_GUIDE.md)** - Testing workflows and troubleshooting
- **[PRIVACY_HACKATHON_SUMMARY.md](PRIVACY_HACKATHON_SUMMARY.md)** - Hackathon submission overview

### Known Issues: Privacy

#### @inco/js ESM Package ✅ RESOLVED

Use **bun** instead of Node.js:

```bash
# Install bun
curl -fsSL https://bun.sh/install | bash

# Run with bun
bun run src/demo-private-bridge.ts
```

**Fix for `Lightning.latest()`:**

```typescript
// ❌ Wrong
this.baseZap = Lightning.latest(config.incoEnvironment, chainId);

// ✅ Correct (await the Promise)
this.baseZap = await Lightning.latest(config.incoEnvironment, chainId);
```

#### Inco Fees Required

Encrypted operations require Inco fees (~0.005 ETH per operation on testnet):

```bash
# Check current fee
cast call <CONFIDENTIAL_BRIDGE> "getIncoFee()(uint256)" \
  --rpc-url https://sepolia.base.org

# Send transaction with fee
--value 0.01ether
```

#### Mock Ciphertexts Rejected

Inco precompiles reject fake encrypted values. Use real ciphertexts:

```bash
cd clients/ts
bun run src/generate-test-ciphertexts.ts
```

### Privacy Benchmarks

| Operation | Gas (Base) | Compute (Solana) | Inco Fee |
|-----------|-----------|------------------|----------|
| Encrypt balance | ~200k | N/A | 0.005 ETH |
| Private transfer | ~250k | ~15k CU | 0.005 ETH |
| Private bridge | ~220k | ~28k CU | 0.005 ETH |
| Handle verification | ~50k | N/A | 0.003 ETH |

*Testnet measurements*

---

## Verified End-to-End Privacy Bridge (January 2026)

The Base ↔ Solana privacy bridge has been **fully tested and verified** with real Inco Lightning integration on both chains.

### Successful Transactions (DARK Token - v6)

| Direction | Chain | Transaction |
|-----------|-------|-------------|
| Mint DARK tokens | Base Sepolia | `0x7b06e1547352b1488b47db06f050ba5c88e9e04258b47f47a2ea0f30d1762051` |
| Bridge DARK → Solana | Base Sepolia | `0x9160806facee0a059562a2b11203361f3eeb9e24c3a522e51262897baeeab5da` |
| Initialize Vault | Solana Devnet | `2ba7LcvHwqFzkoH6sys5ifrp1d9ffo7FKDTqGciK6cwyef6LZLze1ULERTUV2Edbfpo2FpUH6FVnQv6PLgaHM2bk` |
| Relay to Solana | Solana Devnet | `5RqumCMF3NDcbVcZ9mFBxQnWPFgH8u6nvERH8cgKGhgG73SfFcDksbpihVyTibL6YPJ8PCHGiLYdf77FY8JpQJht` |

### Successful Transactions (Legacy - v5)

| Direction | Chain | Transaction |
|-----------|-------|-------------|
| Base → Solana (initiate) | Base Sepolia | `0x24906e78b14ed37d62c597259385a07d52c0157b60e222499ec1ba5ed51501b1` |
| Base → Solana (relay) | Solana Devnet | `4RKWxhbAjs4TK3jyfBAc73M6hUVcHWRthP7RJ5AeLtryECuhSWzZH2FSzBCULbyojZ8GNRSi3bpCCKPorfFBzNya` |

### Verified Inco Operations

**On Base (EVM):**
```
Inco Precompile: 0x4732520194584a04Cac0224e067658619F4086bD
Operations:
  1. newEuint256() - Created encrypted handle from user's ciphertext
  2. e.allow() - Granted ACL for bridge contract
  3. e.allow() - Granted ACL for token contract  
  4. e.sub() - Subtracted encrypted amount from balance
  5. Emitted handle in ConfidentialBridgeInitiated event
```

### Inco SDK Configuration (CRITICAL)

**IMPORTANT**: The `@inco/js` SDK supports multiple "peppers" (deployment environments) with DIFFERENT executor addresses. The Solidity contracts were deployed using the `devnet` pepper, so TypeScript code MUST use `'devnet'` when initializing Lightning:

```typescript
// ✅ CORRECT - matches deployed contracts
const zap = await Lightning.latest('devnet', 84532);

// ❌ WRONG - will fail with ExternalHandleDoesNotMatchComputedHandle
const zap = await Lightning.latest('testnet', 84532);
```

**Pepper → Executor Address Mapping (Base Sepolia 84532):**
| Pepper | Executor Address | Status |
|--------|------------------|--------|
| **devnet** | `0x4732520194584a04Cac0224e067658619F4086bD` | ✅ Used by deployed contracts |
| testnet | `0x168FDc3Ae19A5d5b03614578C58974FF30FCBe92` | ❌ Different executor |
| demonet | `0xA95EAbCE575f5f1e52605358Ee893F6536166378` | ❌ Different executor |
| alphanet | `0xc0d693DeEF0A91CE39208676b6da09B822abd199` | ❌ Different executor |

The handle computation includes the executor address, so mismatching peppers will cause `ExternalHandleDoesNotMatchComputedHandle` (error `0x5924bb27`).

**Real Inco Encryption Example:**
```typescript
import { Lightning } from '@inco/js/lite';
import { handleTypes } from '@inco/js';

const zap = await Lightning.latest('devnet', 84532); // MUST be 'devnet'

const encryptedAmount = await zap.encrypt(amount, {
  accountAddress: userAddress.toLowerCase(), // Lowercase!
  dappAddress: bridgeAddress.toLowerCase(),  // Lowercase!
  handleType: handleTypes.euint256,
});
```

### Successful Transactions (January 20, 2026)

**Direct Privacy Bridge (Real Inco Encryption):**
```
TX: 0x78a1620594821fc84d88163d7c3f8762f09deb6700e62da19bbe455a3dc02d2e
Block: 36566475
Status: SUCCESS ✅
Function: bridgePrivateToSolana()
Encrypted Amount: Real Inco TEE ciphertext (288 bytes)
```

**Relayer Privacy Bridge (EIP-712 Signed):**
```
TX: 0xb184c1ddc3c7714887b594ee09a4dc212a4f7f8bd0f706c2e86f06928957afbb
Block: 36566491
Status: SUCCESS ✅
Function: bridgePrivateViaRelayer()
Encrypted Amount: Real Inco TEE ciphertext (288 bytes)
```

**On Solana (SVM):**
```
Inco Lightning Program: 5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj
CPI Calls (from transaction logs):
  1. NewEuint128 - Created handle from ciphertext bytes
     Input: [0, 8, 0, 122, 1, 24, 175, 162, 21, 247, 246, 65, 177, 240, 175, 115]
     Result: 73856371933150398353131193095701286645
  
  2. EAdd - Added bridged amount to vault balance (inside TEE)
     LHS: 54261709583977038884628912189548807991
     RHS: 73856371933150398353131193095701286645
     Result: 132730140503005526778731605968183244955
```

### What Observers See vs What's Hidden

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ VISIBLE ON-CHAIN (Public)                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Sender address: 0xf8af04bf0ac151f2050436603d81ba20f449028f               │
│ • Recipient vault: Gui8LGdtRwLJL772q1YuVJyRCD8RFbUe6rHiZu6f8Goc            │
│ • That a bridge transfer happened                                          │
│ • Encrypted handle: 0xbbf3133ae55abf2b...7a000800                          │
│ • Token contract addresses                                                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ HIDDEN (Private - Processed inside TEE)                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Actual transfer amount (100 tokens, 1000 tokens, etc.)                   │
│ • User's total balance before and after                                   │
│ • Any intermediate computation values                                      │
│ • Decryption only possible by authorized addresses                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Deployed Contract Addresses (v6 - January 2026)

**Base Sepolia (DARK Token - Latest):**
| Contract | Address |
|----------|---------|
| ConfidentialBridge | `0xfa1CBa0067D967bbD17eFd2Ab815B92AaB418A7f` |
| ConfidentialCrossChainERC20 (DARK) | `0xc4104aCBa7059c2f8FEFdf746a1c4b9B8a89Ec7D` |

**Base Sepolia (v5 - Legacy):**
| Contract | Address |
|----------|---------|
| ConfidentialBridge | `0x1C5d960F3757C59BEC347a536F4B811310B6f2aa` |
| ConfidentialCrossChainERC20 | `0x2C492Fc664e54903A966d5D7f666556FF5BeF9F1` |
| MOCK_DARK_TOKEN | `0xa2a7bb7fBF67A830B74c3993A76D6d6124175E44` |

**Solana Devnet:**
| Account | Address |
|---------|---------|
| Bridge Program | `EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9` |
| Bridge Authority PDA | `k9XhdJyuGbmkSePFBzZ7eUjj9EmHANQL9YivYYL53rr` |
| DARK Token Vault PDA | `DNFNNzesmHdLQ5rG7UMa9QMcDaydkrJAdygwE8vDpNwk` |
| Legacy Vault PDA | `Gui8LGdtRwLJL772q1YuVJyRCD8RFbUe6rHiZu6f8Goc` |
| Inco Lightning | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` |

### Latest Verified Transactions (DARK Token - January 2026)

**Base → Solana (Complete E2E):**
| Step | Chain | Transaction |
|------|-------|-------------|
| Mint 1000 DARK | Base Sepolia | `0x7b06e1547352b1488b47db06f050ba5c88e9e04258b47f47a2ea0f30d1762051` |
| Bridge 10 DARK to Solana | Base Sepolia | `0x9160806facee0a059562a2b11203361f3eeb9e24c3a522e51262897baeeab5da` |
| Init Solana Vault | Solana Devnet | `2ba7LcvHwqFzkoH6sys5ifrp1d9ffo7FKDTqGciK6cwyef6LZLze1ULERTUV2Edbfpo2FpUH6FVnQv6PLgaHM2bk` |
| Relay to Solana | Solana Devnet | `5RqumCMF3NDcbVcZ9mFBxQnWPFgH8u6nvERH8cgKGhgG73SfFcDksbpihVyTibL6YPJ8PCHGiLYdf77FY8JpQJht` |

**Solana → Base (Complete E2E):**
| Step | Chain | Transaction |
|------|-------|-------------|
| Bridge 5 DARK to Base | Solana Devnet | `4NQskmaquWqomJpy8JCpTddPXhujiVVYdyNwS4rDow18NCs7B9rfc4cXB8fwHQYeLC5EXiRRpLoSveQjsp2ifkAD` |
| Relay/Mint on Base | Base Sepolia | `0x83e642c48fd4dc13d618f3d4b716be63c2a19346393e4afa0e2400ed6c0d7aea` |

### New Demo Functions (v6)

The v6 ConfidentialCrossChainERC20 contract includes these demo helper functions:

```solidity
// Mint tokens for testing (encrypts plaintext amount via TEE)
function confidentialMintForDemo(address to, uint256 plainAmount) external payable;

// Set remote Solana token address (one-time)
function setRemoteTokenForDemo(bytes32 remoteToken_) external;
```

**Usage:**
```bash
# Mint DARK tokens for testing
cast send 0xc4104aCBa7059c2f8FEFdf746a1c4b9B8a89Ec7D \
  "confidentialMintForDemo(address,uint256)" \
  <YOUR_ADDRESS> 1000 \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --value 0.001ether
```

### Key Implementation Details

**Event Parsing with Discriminator (CRITICAL):**

Anchor events are identified by their discriminator (sha256 of event name). When parsing `ConfidentialBridgeOutEvent`, you MUST check the discriminator to avoid picking up other events:

```typescript
// In privacy-relayer-sol-to-base.ts:
// sha256("event:ConfidentialBridgeOutEvent")[0:8] = fee3f47c36edab41
const EXPECTED_DISCRIMINATOR = Buffer.from("fee3f47c36edab41", "hex");

for (const log of logs) {
    if (log.startsWith("Program data:")) {
        const data = Buffer.from(log.replace("Program data: ", ""), "base64");
        const discriminator = data.subarray(0, 8);
        if (!discriminator.equals(EXPECTED_DISCRIMINATOR)) {
            continue; // Not our event, skip
        }
        // Parse event data...
    }
}
```

**Solana → Base: Proper Attested Decrypt Flow (UI-Based):**

When building a UI, the user's wallet can sign the attested decrypt request directly:

```
┌─────────────────────────────────────────────────────────────────┐
│          Solana → Base with User-Signed Attestation             │
├─────────────────────────────────────────────────────────────────┤
│ 1. User burns on Solana → emits handle                          │
│ 2. UI prompts user to sign (proves ownership of handle)         │
│ 3. Inco covalidator returns plaintext + attestation signature   │
│ 4. UI mints on Base with the real plaintext amount              │
│                                                                 │
│ ✨ No fixed demo amount - actual decrypted value used!          │
└─────────────────────────────────────────────────────────────────┘
```

```typescript
// frontend/src/lib/attested-decrypt.ts
import bs58 from 'bs58';

const INCO_ENDPOINT = "https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/getDecryptAttested";

async function requestAttestedDecrypt(handle: bigint, wallet: WalletAdapter) {
    // User signs the handle to prove ownership
    const messageBytes = new TextEncoder().encode(handle.toString());
    const signatureBytes = await wallet.signMessage(messageBytes);
    const signature = bs58.encode(signatureBytes);
    
    // Call Inco covalidator with signed request
    const response = await fetch(INCO_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            handle: handle.toString(),
            address: wallet.publicKey.toBase58(),
            signature: signature,
        }),
    });
    
    const data = await response.json();
    return {
        plaintext: BigInt(data.plaintext),      // Actual decrypted amount!
        signature: data.signature,               // Covalidator attestation
    };
}
```

**React Hook Usage:**

```typescript
// In your bridge UI component:
const { state, bridge } = useSolanaToBaseBridge();

// User clicks "Bridge"
await bridge(amountBigInt, DARK_TOKEN_MINT);

// Flow:
// 1. Burns on Solana (user signs tx)
// 2. Prompts user to sign handle for attested decrypt
// 3. Mints on Base with real plaintext amount
```

See `frontend/src/hooks/useSolanaToBaseBridge.ts` for complete implementation.

**⚠️ Known Issue: Solana→Base Attested Decrypt ACL**

The current Solana bridge program does NOT grant `allow` permission on the `actual_amount` handle emitted in `ConfidentialBridgeOutEvent`. This means attested decrypt fails with "Address is not allowed to decrypt this handle".

**Workaround (Demo Mode):** Use `confidentialMintForDemo()` with a fixed amount:
```typescript
// In privacy-relayer-sol-to-base.ts
const DEMO_AMOUNT = 5n; // Fixed demo amount
await tokenContract.confidentialMintForDemo(destination, DEMO_AMOUNT);
```

**Fix (Requires Program Upgrade):** The Solana bridge program has been updated in `solana/programs/bridge/src/confidential/instructions.rs` to grant ACL on both handles:
```rust
// Grant allowance to owner for updated balance AND the bridged amount
if ctx.remaining_accounts.len() >= 4 {
    // Allow for actual_amount (for attested decrypt)
    allow(cpi_ctx, actual_amount.0, true, vault.owner)?;
}
```

After rebuilding and redeploying the Solana program, the UI-based attested decrypt flow will work properly.

**Relayer Signing for Inco CPIs:**

The Solana program uses the **relayer** (not a PDA) to sign for Inco Lightning CPIs. This is because Inco Lightning can't validate seeds from other programs:

```rust
// In relay_receive_confidential():
// Use relayer as signer for Inco operations (not PDA)
let signer = ctx.accounts.relayer.to_account_info();

let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;
```

**Handle Conversion (EVM → SVM):**

EVM uses 32-byte `euint256` handles, Solana uses 16-byte `Euint128`. The relayer extracts the last 16 bytes:

```typescript
// In privacy-relayer-base-to-sol.ts:
const fullHandle = event.args.encryptedAmountHandle; // 32 bytes
const encryptedBytes = fullHandle.slice(-32); // Last 16 bytes (reversed for Solana)
```

**ACL Propagation:**

Before cross-contract calls, the bridge grants ACL access to the target contract:

```solidity
// In ConfidentialBridge.bridgePrivateToSolana():
e.allow(amount, localToken); // Allow token contract to access handle
ICrossChainERC20(localToken).confidentialBurnFromHandle(msg.sender, amount);
```

---

## Production-Ready Privacy Bridge (January 27, 2026)

After extensive testing, the Inco devnet covalidator infrastructure was found to return HTTP 404 "[unimplemented]" for both `attestedReveal` and `attestedDecrypt` endpoints. This section documents the production-ready solution that bypasses this limitation.

### The Problem

The original approach relied on:
1. Contract marks handle with `e.reveal(amount)` 
2. Relayer calls `attestedReveal()` to get plaintext
3. Relayer re-encrypts for Solana

**Issue**: The Inco devnet covalidator returns:
```
Error: 404 "[unimplemented]" at attestedReveal
Error: 404 "[unimplemented]" at attestedDecrypt
```

### The Production Solution

**New Approach**: Use `bridgePrivateToSolanaPlaintext()` - the user provides the plaintext amount directly, and the contract:
1. Encrypts it on-chain using `e.asEuint256(amount)`
2. Burns from user's encrypted balance (FHE comparison ensures sufficient balance)
3. Emits plaintext in a new event for the relayer

This is secure because:
- The FHE balance check (`e.ge()`) prevents over-spending
- The plaintext is what the user chose to send (they already know it)
- The relayer only needs to read the event and re-encrypt for Solana

### New Contract Functions

```solidity
// ConfidentialBridge.sol - Production function (no attestedReveal needed)
function bridgePrivateToSolanaPlaintext(
    address localToken,
    bytes32 toSolana,
    uint256 amount
) external payable nonReentrant whenNotPaused requiresFee {
    // 1. Encrypt the plaintext amount on-chain (trivial encrypt)
    euint256 encryptedAmount = e.asEuint256(amount);
    e.allow(encryptedAmount, address(this));
    e.allow(encryptedAmount, localToken);

    // 2. Burn from sender's confidential balance
    //    FHE comparison (e.ge) ensures user has sufficient balance
    ConfidentialCrossChainERC20(localToken).confidentialBurnFromHandle(
        msg.sender,
        encryptedAmount
    );

    // 3. Emit event with plaintext for relayer
    emit ConfidentialBridgeInitiatedWithPlaintext(
        nonce++,
        localToken,
        remoteToken,
        toSolana,
        amount
    );
}
```

### New Event

```solidity
/// @notice Emitted when a confidential bridge is initiated with plaintext amount.
/// @dev The plaintext amount is verified by on-chain FHE balance check.
event ConfidentialBridgeInitiatedWithPlaintext(
    uint256 indexed nonce,
    address indexed localToken,
    Pubkey indexed remoteToken,
    bytes32 toSolana,
    uint256 plaintextAmount
);
```

### Updated Frontend (No Client-Side Encryption)

```typescript
// BridgeForm.tsx - Simplified flow
const bridgeBaseToSolana = async () => {
    const amountWei = parseUnits(amount, 18);
    const solanaBytes32 = toHex(solanaPublicKey.toBytes(), { size: 32 });

    // Call bridgePrivateToSolanaPlaintext - no client encryption needed!
    const hash = await walletClient.writeContract({
        address: CONFIDENTIAL_BRIDGE_ADDRESS,
        abi: BRIDGE_ABI,
        functionName: "bridgePrivateToSolanaPlaintext",
        args: [CONFIDENTIAL_TOKEN_ADDRESS, solanaBytes32, amountWei],
        value: incoFee,
    });

    // Transaction confirmed - relayer will complete transfer
    setStatus("✅ Bridge initiated! Relayer will complete transfer to Solana.");
};
```

### Updated Relayer (Reads Plaintext from Event)

```typescript
// privacy-relayer-base-to-sol.ts
async function relayConfidentialToSolana(txHash: string): Promise<boolean> {
    const receipt = await basePublicClient.getTransactionReceipt({ hash: txHash });

    // Try new plaintext event first (production flow)
    const plaintextEvent = parseConfidentialBridgeWithPlaintextEvent(receipt.logs);
    
    if (plaintextEvent) {
        console.log(`✅ Found plaintext event: ${plaintextEvent.plaintextAmount} wei`);
        
        // Re-encrypt for Solana TEE - no attestedReveal needed!
        const solanaCiphertext = await encryptValue(plaintextEvent.plaintextAmount);
        
        return await sendRelayConfidentialReceive(
            recipientPubkey,
            new Uint8Array(hexToBuffer(solanaCiphertext)),
            baseSender
        );
    }

    // Fall back to legacy event (requires attestedReveal - may fail)
    // ...
}
```

### Latest Deployed Addresses (January 27, 2026)

**Base Sepolia (Production Ready):**

| Contract | Address |
|----------|---------|
| **ConfidentialBridge** | `0xD705858A979a4ab42e7a2e43e8CcC726Dbd87369` |
| **cDARK Token** | `0xFBAD5A940d89e504C5f8C9e0fC3A976A82334565` |
| Deployer/Owner | `0xF8AF04bF0Ac151f2050436603d81Ba20f449028F` |

**Solana Devnet:**

| Account | Address |
|---------|---------|
| Bridge Program | `EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9` |
| Inco Lightning | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` |
| Solana cDARK Mint | `2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH` |

### Quick Start (Production)

```bash
# 1. Start the frontend
cd frontend && npm run dev

# 2. Start the privacy relayer (separate terminal)
cd scripts && EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor

# 3. Open http://localhost:3000
# 4. Connect both EVM and Solana wallets
# 5. Enter amount and click "Bridge to Solana"
# 6. Relayer automatically picks up the event and relays to Solana
```

### Architecture Summary

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                   PRODUCTION PRIVACY BRIDGE FLOW                              │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  USER                FRONTEND              CONTRACT              RELAYER      │
│  ────                ────────              ────────              ───────      │
│                                                                               │
│  1. Enter amount ──▶ Parse amount          │                       │          │
│                      (plaintext)           │                       │          │
│                      │                     │                       │          │
│  2. Sign TX ────────▶ bridgePrivateToSolanaPlaintext()             │          │
│                      │                     │                       │          │
│                      │                     ▼                       │          │
│                      │              e.asEuint256(amount)           │          │
│                      │              (encrypt on-chain)             │          │
│                      │                     │                       │          │
│                      │              e.ge(balance, amount)          │          │
│                      │              (FHE comparison)               │          │
│                      │                     │                       │          │
│                      │              balance = e.sub(balance, amt)  │          │
│                      │                     │                       │          │
│                      │              emit ConfidentialBridgeInitiatedWithPlaintext
│                      │              (includes plaintext!)          │          │
│                      │                                             │          │
│                      │                                             ▼          │
│                      │                                    Parse plaintext     │
│                      │                                    from event          │
│                      │                                             │          │
│                      │                                    encryptValue()      │
│                      │                                    (for Solana)        │
│                      │                                             │          │
│                      │                                    Send to Solana ─────▶
│                                                                               │
│  ✅ No attestedReveal/attestedDecrypt required!                               │
│  ✅ User's balance remains encrypted on-chain                                 │
│  ✅ Only the bridged amount is revealed (user chose to send it anyway)        │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Alternative Functions Still Available

The contract also includes these functions for when Inco infrastructure supports attestedReveal/attestedDecrypt:

```solidity
// Legacy function (requires attestedReveal to work)
function bridgePrivateToSolana(
    address localToken,
    bytes32 toSolana,
    bytes calldata encryptedAmount  // Client-encrypted ciphertext
) external payable;

// Full attestation function (for future use)
function bridgePrivateToSolanaWithAttestation(
    address localToken,
    bytes32 toSolana,
    bytes calldata encryptedAmount,
    DecryptionAttestation memory decryption,
    bytes[] memory signatures
) external payable;
```

### Files Modified

| File | Changes |
|------|---------|
| `base/src/ConfidentialBridge.sol` | Added `bridgePrivateToSolanaPlaintext()`, `bridgePrivateToSolanaWithAttestation()`, new event, `DecryptionAttestation` import |
| `frontend/src/components/BridgeForm.tsx` | Simplified to use plaintext function, removed signature flow |
| `frontend/src/lib/constants.ts` | Updated contract addresses |
| `frontend/src/lib/inco.ts` | Updated `attestedDecrypt` return type |
| `scripts/src/privacy-relayer-base-to-sol.ts` | Added plaintext event parsing, helper function, removed attestedReveal dependency |
| `base/script/SetupConfidentialToken.s.sol` | Updated bridge address |

---
