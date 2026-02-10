# DarkBridge 🌑

**Privacy-preserving cross-chain bridge between Base (Ethereum L2) and Solana.**

DarkBridge enables confidential token transfers where transaction amounts, balances, and participant identities remain hidden from on-chain observers. It leverages [Inco Network's](https://www.inco.org/) Trusted Execution Environment (TEE) technology — Inco Lightning — to process encrypted data inside secure hardware enclaves.

> **Networks:** Base Sepolia (Testnet) ↔ Solana Devnet
> **Token:** cDARK (confidential DARK)

---

## Table of Contents

- [Overview](#overview)
- [Privacy Features](#privacy-features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Running the Relayer](#running-the-relayer)
- [Deployment](#deployment)
- [Testing](#testing)
- [Contract Addresses](#contract-addresses)
- [API Reference](#api-reference)
- [Security Model](#security-model)

---

## Overview

Traditional cross-chain bridges expose all transaction details publicly on-chain — who is sending, how much, and where. This creates problems:

- **Wealth tracking** and profiling of addresses
- **Front-running** and MEV extraction
- **Cross-chain address correlation**
- **Trading strategy exposure**

DarkBridge solves this by integrating Inco Lightning, a confidentiality layer using hardware TEEs (Intel SGX/TDX). Transaction amounts are never visible on-chain. Balances are stored as encrypted handles. Sender and receiver addresses can be hidden through relayer submission and commitment-based claims.

---

## Privacy Features

DarkBridge implements **three tiers** of privacy protection:

### 1. Amount Privacy
All token amounts are encrypted before being stored on-chain. Values are represented as opaque **handles** — references to private data inside Inco's TEE network. On-chain observers see that a bridge transaction occurred but cannot determine the actual amount.

### 2. Sender Privacy
Users can submit bridge transactions through a relayer service. The user signs an EIP-712 typed message off-chain and the relayer submits the transaction on their behalf. On-chain, only the relayer's address appears as the sender.

### 3. Receiver Privacy
DarkBridge supports a **commitment-claim system**. Instead of specifying a destination address directly, users provide a cryptographic commitment (hash of a secret). The recipient claims tokens later by revealing the secret. The receiver's address is only exposed at claim time, breaking the on-chain link between sender and receiver.

Additionally, **Inco TEE-encrypted recipients** allow the destination address itself to be stored encrypted, revealed only via attested decryption.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              USER / FRONTEND                                │
│                        (Next.js + RainbowKit + Phantom)                     │
│                    Encrypts amounts via @inco/js SDK                        │
└────────────┬──────────────────────────────────────────────┬─────────────────┘
             │                                              │
             ▼                                              ▼
┌────────────────────────┐                    ┌────────────────────────┐
│     BASE (EVM)         │                    │     SOLANA (SVM)       │
│                        │                    │                        │
│  ConfidentialBridge    │                    │  Bridge Program        │
│  ConfidentialERC20     │                    │  (Anchor/Rust)         │
│  (euint256 balances)   │                    │  Confidential Vaults   │
│                        │                    │  (Euint128 handles)    │
│  Bridge + Twin         │                    │                        │
│  BridgeValidator       │                    │  Base Relayer Program  │
│  CrossChainERC20       │                    │  (gas fee management)  │
│  CrossChainERC20Factory│                    │                        │
└────────────┬───────────┘                    └──────────┬─────────────┘
             │                                           │
             │       ┌──────────────────────┐            │
             └──────►│   PRIVACY RELAYER    │◄───────────┘
                     │   (Hono HTTP Server) │
                     │   Port 3001          │
                     │                      │
                     │  POST /relay         │  Base → Solana
                     │  POST /relay-to-base │  Solana → Base
                     │  GET  /health        │
                     └──────────┬───────────┘
                                │
                                ▼
                     ┌──────────────────────┐
                     │   INCO TEE NETWORK   │
                     │                      │
                     │  Decrypt → Compute   │
                     │  → Re-encrypt        │
                     │                      │
                     │  Attestation proofs  │
                     └──────────────────────┘
```

### Components

| Component | Location | Description |
|-----------|----------|-------------|
| **Base Contracts** | `base/` | Solidity smart contracts (Foundry). Core bridge, confidential bridge, encrypted ERC20, token factory, Twin execution proxies, and message validation. |
| **Solana Programs** | `solana/` | Anchor/Rust programs. Bridge program with confidential vaults, commitment-based claims, and cross-chain messaging. Base relayer program for gas fee management. |
| **Frontend** | `frontend/` | Next.js 14 web app. Wallet connection (EVM + Solana), bridge interface, vault management, faucet, and documentation. |
| **Privacy Relayer** | `scripts/` | Hono HTTP server that monitors bridge events, decrypts via Inco TEE, re-encrypts for the target chain, and relays transactions. Dockerized. |
| **Relayer Services** | `services/` | Standalone relayer microservices for each bridge direction (Base→Solana, Solana→Base). |
| **TypeScript SDK** | `clients/ts/` | Auto-generated Anchor IDL bindings for the Solana bridge and base relayer programs. Publishable to npm. |

---

## Technology Stack

### Blockchain Infrastructure

| Component | Technology | Purpose |
|-----------|------------|---------|
| EVM Chain | Base Sepolia (Chain ID: 84532) | Primary chain for ERC20 operations |
| SVM Chain | Solana Devnet | High-throughput destination chain |
| Privacy Layer | Inco Lightning (TEE) | Encrypted computation via hardware enclaves |

### Smart Contract Development

| Component | Technology |
|-----------|------------|
| EVM Framework | Foundry (Forge/Cast) |
| Solidity | 0.8.28 with IR optimizer |
| Solana Framework | Anchor 0.30.x |
| Rust | 1.75+ Stable |

### Frontend & Services

| Component | Technology |
|-----------|------------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript 5.x |
| EVM Wallet | RainbowKit + wagmi 2.x |
| Solana Wallet | Wallet Adapter (Phantom, Solflare) |
| Styling | Tailwind CSS 3.4 + Framer Motion |
| Runtime | Bun |
| Relayer HTTP | Hono |
| Containerization | Docker (oven/bun base image) |

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `@inco/lightning` | Solidity library for encrypted operations |
| `@inco/js` | JavaScript SDK for client-side encryption |
| `@inco/solana-sdk` | Solana SDK for Inco TEE operations |
| `viem` | EVM interactions and ABI encoding |
| `@solana/web3.js` | Solana RPC and transaction building |
| `@coral-xyz/anchor` | Anchor client for Solana programs |
| `solady` | Gas-optimized Solidity utilities |

---

## How It Works

### Encryption Model

DarkBridge uses Inco Lightning's **TEE-based encryption** (not FHE). Encrypted values are stored on-chain as opaque **handles** (`bytes32` on EVM, `u128` on Solana) that reference private data inside Inco's TEE network.

```
 On-Chain (Base/Solana)              Inco TEE Network
 ──────────────────────              ────────────────────

 Only HANDLES stored                 ┌────────────────────┐
 (opaque references)                 │  Secure Enclave    │
       │                             │                    │
       │  CPI / Precompile           │  1. Lookup handles │
       ▼                             │  2. Decrypt in TEE │
 e_add(h1, h2)  ───────────────────► │  3. Compute        │
                                     │  4. Re-encrypt     │
 new_handle h3  ◄─────────────────── │  5. Return handle  │
                                     │                    │
                                     │  TEE Attestation   │
                                     └────────────────────┘
```

Operations (add, subtract, compare) are sent to the TEE network, which decrypts operands inside the secure enclave, performs the computation, re-encrypts the result, and returns a new handle. Plaintext never exists on-chain.

### Base → Solana Transfer Flow

1. **Encrypt** — User encrypts the transfer amount client-side using `@inco/js` SDK
2. **Bridge** — User calls `bridgePrivateToSolana()` on ConfidentialBridge, providing the ciphertext and destination Solana address
3. **Burn** — Contract creates an encrypted handle, verifies sufficient balance via encrypted comparison, burns tokens from the user's encrypted balance
4. **Event** — `ConfidentialBridgeInitiated` event emitted with the encrypted handle (not plaintext)
5. **Relay** — Privacy relayer detects the event, requests attested decryption from Inco TEE, obtains the plaintext amount
6. **Re-encrypt** — Relayer re-encrypts the amount for Solana using `@inco/solana-sdk`
7. **Mint** — Relayer calls the Solana bridge program to mint tokens to the recipient's confidential vault

### Solana → Base Transfer Flow

1. **Withdraw** — User initiates a withdrawal from their Solana confidential vault with an encrypted amount
2. **Deduct** — Program verifies sufficient balance (encrypted comparison) and subtracts from the vault
3. **Event** — `ConfidentialBridgeOutEvent` emitted on Solana
4. **Relay** — Relayer detects the event, decrypts via Inco, re-encrypts for EVM
5. **Mint** — Relayer calls `faucetMint()` on the ConfidentialCrossChainERC20 contract to mint encrypted tokens on Base

### Solana Vault Model

Each user has a PDA-derived `ConfidentialVault` per token, keyed by `keccak256(ownerPubkey)`. The vault stores an encrypted balance as a `u128` Inco handle. This hashing provides an additional layer of privacy — the vault owner's pubkey is not directly stored.

---

## Project Structure

```
dark-bridge/
├── base/                            # EVM Smart Contracts (Foundry)
│   ├── src/
│   │   ├── Bridge.sol                   # Core bridge: MMR messaging, Twin dispatch, token relay
│   │   ├── BridgeValidator.sol          # Multi-sig message pre-validation
│   │   ├── ConfidentialBridge.sol       # Privacy bridge: encrypted amounts, relayer, claims
│   │   ├── ConfidentialCrossChainERC20.sol  # ERC20 with encrypted balances (euint256)
│   │   ├── CrossChainERC20.sol          # Standard wrapped token (mint/burn by bridge)
│   │   ├── CrossChainERC20Factory.sol   # CREATE2 factory for wrapped tokens
│   │   ├── Twin.sol                     # Execution proxy per Solana sender
│   │   ├── interfaces/                  # IPartner validator interface
│   │   ├── libraries/                   # CallLib, MessageLib, MessageStorageLib,
│   │   │                                # SVMBridgeLib, SVMLib, TokenLib, VerificationLib
│   │   └── mocks/                       # MockERC20 for testing
│   ├── script/                      # Forge deployment & action scripts
│   ├── test/                        # Test suites (unit, fork, E2E, handle verification)
│   └── deployments/                 # Deployed contract addresses per network
│
├── solana/                          # Solana Programs (Anchor/Rust)
│   └── programs/
│       ├── bridge/                      # Main bridge program
│       │   └── src/lib.rs               # Messaging, token vaults, confidential vaults,
│       │                                # commitment claims, Inco TEE private claims
│       └── base_relayer/                # Gas fee management program
│           └── src/lib.rs               # EIP-1559 pricing, relay request PDAs
│
├── frontend/                        # Next.js 14 Web Application
│   └── src/
│       ├── app/                         # Pages: bridge UI (/), docs (/docs)
│       ├── components/
│       │   ├── BridgeInterface.tsx       # Core bridge UI
│       │   ├── VaultBalance.tsx          # Encrypted Solana vault balance viewer
│       │   ├── FaucetButton.tsx          # cDARK test token faucet
│       │   ├── Header.tsx               # Navigation + wallet connections
│       │   └── ...                      # Background, dropdowns, wallet wrappers
│       └── lib/
│           ├── constants.ts             # All deployed addresses & config
│           ├── solana-helpers.ts         # Vault PDA derivation, IX builders
│           ├── inco-helpers.ts          # Inco SDK wrappers for encryption
│           └── wagmi.ts                 # RainbowKit/wagmi config
│
├── scripts/                         # Operational Scripts & Privacy Relayer
│   ├── Dockerfile.relayer               # Docker image for relayer deployment
│   ├── src/
│   │   ├── privacy-relayer-server.ts    # Unified Hono HTTP server (port 3001)
│   │   ├── privacy-relayer-base-to-sol.ts   # Standalone Base→Solana relayer
│   │   ├── privacy-relayer-sol-to-base.ts   # Standalone Solana→Base relayer
│   │   ├── commands/                    # Interactive CLI commands (sol/*)
│   │   ├── internal/                    # IDLs, ABIs, Solana helpers
│   │   └── utils/                       # Attestation helpers
│   └── start-relayers.sh               # Legacy multi-relayer launcher
│
├── services/                        # Relayer Microservices
│   ├── base-to-solana-relayer/          # B→S event monitor & relay
│   └── solana-to-base-relayer/          # S→B event monitor & relay
│
├── clients/                         # TypeScript SDK
│   └── ts/
│       └── src/                         # Auto-generated Anchor IDL bindings
│           ├── bridge/                  # Bridge program types & instructions
│           └── base-relayer/            # Base relayer program types
│
├── CLAUDE.md                        # AI development guide
└── README.md                        # This file
```

---

## Getting Started

### Prerequisites

- **Bun** runtime (recommended) or Node.js 18+
- **Foundry** toolchain (forge, cast, anvil)
- **Rust** 1.75+ with Solana CLI
- **Anchor** 0.30.x
- **Docker** (for containerized relayer deployment)
- An EVM wallet (MetaMask, Coinbase Wallet, etc.)
- A Solana wallet (Phantom, Solflare, Backpack)

### Installation

```bash
# Clone the repository
git clone https://github.com/gks2022004/dark-bridge.git
cd dark-bridge

# Install frontend dependencies
cd frontend && bun install

# Install base contract dependencies
cd ../base && forge install && bun install

# Install scripts dependencies
cd ../scripts && bun install

# Install client SDK dependencies
cd ../clients/ts && bun install && bun run build

# Install Solana program dependencies (if building programs)
cd ../../solana && bun install
```

### Environment Configuration

**Scripts (`scripts/.env`)**
```env
# EVM Configuration
EVM_PRIVATE_KEY=0x...
BASE_RPC_URL=https://sepolia.base.org

# Solana Configuration
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY=[...]

# Contract Addresses (Base Sepolia)
CONFIDENTIAL_BRIDGE_ADDRESS=0x...
CONFIDENTIAL_TOKEN_ADDRESS=0x...

# Program IDs (Solana Devnet)
BRIDGE_PROGRAM_ID=EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9
INCO_LIGHTNING_ID=5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj

# Inco Network
INCO_ENVIRONMENT=devnet
INCO_CHAIN_ID=84532

# TLS Settings
NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Frontend (`frontend/.env`)**
```env
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id
```

### Running the Frontend

```bash
cd frontend
bun run dev
```

The application will be available at `http://localhost:3000`.

---

## Running the Relayer

The privacy relayer is the core service that bridges encrypted transactions between chains. It decrypts amounts via Inco TEE, re-encrypts for the destination chain, and submits relay transactions.

### Option 1: Direct (Development)

```bash
cd scripts
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-server.ts
```

The relayer starts on port **3001** with the following endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server status, relayer address, pending counts |
| `/relay` | POST | Submit plaintext for Base → Solana relay |
| `/relay-to-base` | POST | Submit plaintext for Solana → Base relay |
| `/status/:handle` | GET | Check authorization status for a handle |
| `/pending` | GET | List pending bridge events |

### Option 2: Docker (Production)

```bash
# Build the image (from project root)
docker build -f scripts/Dockerfile.relayer -t privacy-relayer .

# Run with env file (secrets never baked into image)
docker run --env-file scripts/.env -p 3001:3001 --name privacy-relayer privacy-relayer
```

Manage the container:
```bash
# Check logs
docker logs privacy-relayer

# Health check
curl http://localhost:3001/health

# Stop
docker rm -f privacy-relayer
```

### Standalone Relayers (Alternative)

For running individual direction relayers:

```bash
# Base → Solana (monitors Base events, relays to Solana)
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor

# Solana → Base (monitors Solana events, relays to Base)
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts --monitor
```

---

## Deployment

### Base Contracts

```bash
cd base

# Build contracts
forge build

# Deploy to Base Sepolia
make deploy

# Deploy confidential contracts
forge script script/DeployConfidentialFull.s.sol --rpc-url base_sepolia --broadcast

# Verify contracts
forge verify-contract <address> ConfidentialBridge --chain base-sepolia
```

### Solana Programs

```bash
cd solana

# Build for devnet
bun run program:build devnet-alpha

# Deploy to devnet
bun run program:deploy devnet-alpha

# Initialize bridge state
bun run tx:initialize devnet-alpha
```

### Interactive CLI

The project includes a full interactive CLI for Solana operations:

```bash
cd scripts
bun cli sol bridge       # Bridge operations
bun cli sol wrap-token   # Deploy wrapped tokens
bun cli sol deploy       # Deploy programs
bun cli sol build        # Build programs
```

---

## Testing

### Base Contract Tests

```bash
cd base

# Run all unit tests
forge test

# Run fork tests against Base Sepolia (requires real Inco covalidator)
forge test --fork-url https://sepolia.base.org -vvv

# Specific test suites
forge test --match-contract ConfidentialBridgeForkTest --fork-url https://sepolia.base.org -v
forge test --match-contract ConfidentialBridgeE2EForkTest --fork-url https://sepolia.base.org -vv
forge test --match-contract ConfidentialBridgeHandleVerificationTest --fork-url https://sepolia.base.org -vv

# Coverage
make coverage
```

### Solana Program Tests

```bash
cd solana

# Rust unit tests
cargo test
```

### Test Requirements

Fork tests require:
- Contracts funded with ETH for Inco fees (`vm.deal(address, 50 ether)`)
- Real ciphertexts from `@inco/js` (mock ciphertexts are rejected by Inco precompiles)
- Active Inco covalidator network on Base Sepolia

---

## Contract Addresses

### Base Sepolia

| Contract | Address |
|----------|---------|
| Bridge | `0x8e46419298a9620ea326113baf4019a23594bb11` |
| BridgeValidator | `0x9fc354b36a6a1da0c1dBdcE2fc73793eAb6FC462` |
| **ConfidentialBridge** | `0x971B8434F64B0c8f3119aD2825f257F503abB48e` |
| **ConfidentialCrossChainERC20 (cDARK)** | `0xbBbE1A6BaFa59dC40377E1a264AB21797EA51193` |
| CrossChainERC20Factory | `0xD40931BEa89fe4c1589c251dCD138f856bCAE750` |
| Twin | `0x8BF4a8819763385A539759aBf7991546071057C9` |

### Solana Devnet

| Program | Address |
|---------|---------|
| **Bridge Program** | `EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9` |
| Base Relayer Program | `BGrkLkS3VZLxkM8PtKJukYYXQW1N3mPJaL3PPXieLQi9` |
| Inco Lightning | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` |
| cDARK Token Mint | `3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V` |

---

## API Reference

### ConfidentialBridge (Solidity)

```solidity
// Bridge with encrypted amount (sender visible, receiver visible)
function bridgePrivateToSolana(
    address localToken,
    bytes32 toSolana,
    bytes calldata encryptedAmount
) external payable

// Bridge via relayer (sender hidden via EIP-712 signature)
function bridgePrivateViaRelayer(
    address localToken,
    bytes32 commitment,
    bytes calldata encryptedAmount,
    address sender,
    uint256 senderNonce,
    uint256 deadline,
    bytes calldata signature
) external onlyRoles(RELAYER_ROLE)

// Receive from Solana (relayer calls this)
function receiveFromSolana(
    uint256 nonce,
    address localToken,
    address to,
    bytes calldata encryptedAmount
) external onlyRoles(RELAYER_ROLE)

// Claim tokens using commitment secret (receiver privacy)
function redeemClaim(uint256 claimId, bytes32 secret) external
```

### ConfidentialCrossChainERC20 (Solidity)

```solidity
// All balances are encrypted — returns an opaque handle
function balanceOf(address account) external view returns (euint256)

// Transfer with encrypted amount
function transfer(address to, bytes calldata encryptedAmount) external returns (bool)

// Deposit plaintext ERC20 → receive encrypted balance
function deposit(uint256 amount) external

// Withdraw encrypted balance → plaintext ERC20 (requires Inco attestation)
function withdrawWithAttestation(
    bytes calldata decryption,
    bytes[] calldata signatures
) external

// Testnet faucet: mint encrypted cDARK tokens
function faucetMint(address to, bytes calldata encryptedAmount) external
```

### Solana Bridge Program (Anchor/Rust)

```rust
// Initialize a confidential vault for a user
pub fn initialize_confidential_vault(ctx, owner_hash: [u8; 32]) -> Result<()>

// Bridge out from Solana (encrypted amount)
pub fn bridge_confidential_out(
    ctx, encrypted_amount: Vec<u8>, destination: [u8; 20]
) -> Result<()>

// Receive confidential tokens from Base
pub fn receive_confidential_in(
    ctx, nonce: u64, encrypted_amount: Vec<u8>
) -> Result<()>

// Bridge out via relayer (sender hidden)
pub fn bridge_confidential_out_via_relayer(ctx, ...) -> Result<()>
```

### Privacy Relayer HTTP API

```
GET  /health              →  { status, relayer, bridge, pendingEvents }
POST /relay               →  { success, txSignature }         # Base → Solana
POST /relay-to-base       →  { success, txHash }              # Solana → Base
GET  /status/:handle      →  { status, handle }
GET  /pending             →  [{ nonce, token, handle, ... }]
```

---

## Security Model

### Threat Mitigation

| Threat | Mitigation |
|--------|------------|
| Amount Leakage | All amounts encrypted; only handles visible on-chain |
| Balance Tracking | Balances stored as encrypted handles with access control |
| Front-Running | Relayers cannot see actual amounts; MEV protection inherent |
| Handle Substitution | Handle verification (`expectedHandles`) prevents swap attacks |
| Replay Attacks | Nonce tracking for all bridge operations |
| Unauthorized Decryption | Explicit `allow()` grants required; TEE enforces access |
| Sender Correlation | EIP-712 meta-transactions via relayer hide the real sender |
| Receiver Correlation | Commitment-claim or encrypted address system |

### Trust Assumptions

1. **TEE Hardware** — Security relies on the integrity of Inco's TEE hardware (Intel SGX/TDX). Attestation proofs verify authentic hardware execution.
2. **Inco Network** — The covalidator network must remain available and honest. Multiple validators sign attestations for redundancy.
3. **Relayer** — The relayer sees plaintext amounts during cross-chain re-encryption (architecturally unavoidable since Inco handles cannot transfer between EVM and SVM without decrypt→re-encrypt). In production, the relayer should run inside a TEE (AWS Nitro, Intel SGX).
4. **Smart Contracts** — Standard security patterns: reentrancy guards (Solady `ReentrancyGuardTransient`), role-based access control, input validation, and pausability.

### Access Control

| Role | Capability |
|------|-----------|
| **Owner** | Full administrative control, role assignment |
| **Guardian** | Emergency pause, configuration updates |
| **Relayer** | Submit cross-chain messages, trigger mints |
| **User** | Automatic decryption grants for own balances |

---

## License

This project is licensed under the MIT License.

---

## Acknowledgments

- [Inco Network](https://www.inco.org/) — Lightning confidentiality layer (TEE-based encrypted computation)
- [Base](https://base.org/) — Ethereum L2 infrastructure
- [Solana Foundation](https://solana.org/) — High-performance runtime
- [Solady](https://github.com/Vectorized/solady) — Gas-optimized Solidity utilities
- [Anchor](https://www.anchor-lang.com/) — Solana program framework