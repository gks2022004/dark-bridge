---
name: inco-lightning
description: Build privacy-preserving smart contracts using Inco Lightning confidential computing (TEE-based encrypted types)
---

# Inco Lightning Skill

Inco Lightning is a **confidentiality layer** for blockchains using **Trusted Execution Environments (TEEs)**. It provides encrypted data types where **handles** (bytes32/u128) reference private values processed securely inside hardware enclaves.

## Quick Reference

### Architecture Overview

```
On-Chain (EVM/SVM)                    Inco TEE Network (Off-Chain)
────────────────────                  ────────────────────────────
Only HANDLES stored                   ┌─────────────────────────┐
(opaque references)                   │  Trusted Execution Env  │
        │                             │  handle → plaintext     │
        │ Precompile/CPI              │                         │
        ▼                             │  1. Lookup handles      │
  e_add(h1, h2) ─────────────────────►│  2. Decrypt in TEE      │
                                      │  3. Compute result      │
  new_handle h3 ◄─────────────────────│  4. Return new handle   │
                                      └─────────────────────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Handles** | Immutable references to encrypted values (bytes32 on EVM, u128 on SVM) |
| **E-Types** | `euint256`, `ebool`, `eaddress` (EVM) / `Euint128`, `Ebool` (SVM) |
| **Operations** | Math/comparison on encrypted values via precompiles (EVM) or CPI (SVM) |
| **Access Control** | `allow()` grants decryption rights to specific addresses |
| **Fees** | Required for `newEuint256()`, `rand()` - use `inco.getFee()` |

---

## EVM (Solidity) API

### Setup

```solidity
import {euint256, ebool, eaddress, e, inco} from "@inco/lightning/src/Lib.sol";

contract MyContract {
    using e for *;
}
```

### Input Functions

```solidity
// From ciphertext (client-encrypted) - REQUIRES FEE
require(msg.value >= inco.getFee(), "Fee not paid");
euint256 encrypted = valueInput.newEuint256(msg.sender);
ebool flag = flagInput.newEbool(msg.sender);
eaddress addr = addrInput.newEaddress(msg.sender);

// From plaintext (trivial encrypt - NO FEE)
euint256 amount = uint256(1000).asEuint256();
ebool isActive = true.asEbool();
eaddress myAddr = address(this).asEaddress();
```

### Math Operations

```solidity
euint256 sum = a.add(b);       // Addition
euint256 diff = a.sub(b);      // Subtraction
euint256 prod = a.mul(b);      // Multiplication
euint256 quot = a.div(b);      // Division
euint256 rem = a.rem(b);       // Remainder
```

### Comparison Operations

```solidity
ebool isEqual = a.eq(b);       // Equal
ebool isNe = a.ne(b);          // Not equal
ebool isGt = a.gt(b);          // Greater than
ebool isGe = a.ge(b);          // Greater or equal
ebool isLt = a.lt(b);          // Less than
ebool isLe = a.le(b);          // Less or equal
euint256 minimum = a.min(b);   // Min value
euint256 maximum = a.max(b);   // Max value
```

### Bitwise Operations

```solidity
euint256 andResult = a.and(b);
euint256 orResult = a.or(b);
euint256 xorResult = a.xor(b);
euint256 shifted = a.shr(bits);
euint256 rotated = a.rotl(bits);
```

### Random Numbers (REQUIRE FEE)

```solidity
require(msg.value >= inco.getFee(), "Fee not paid");
euint256 random = e.rand();
euint256 bounded = e.randBounded(100);  // [0, 100)
```

### Control Flow (Multiplexer Pattern)

**CRITICAL: Never use if/else on encrypted conditions - use `select()`**

```solidity
// ✅ CORRECT: Use select() - never reveals condition
euint256 result = condition.select(valueIfTrue, valueIfFalse);

// Example: conditional transfer
ebool hasBalance = balanceOf[msg.sender].ge(amount);
euint256 transferred = hasBalance.select(amount, uint256(0).asEuint256());

// ❌ WRONG: This leaks information!
// if (someCondition) { ... }  // Can't branch on ebool anyway
```

### Access Control (CRITICAL!)

**Always call access control after every operation that creates a new handle:**

```solidity
function _transfer(address to, euint256 value) internal {
    euint256 newSenderBalance = balanceOf[msg.sender].sub(value);
    euint256 newReceiverBalance = balanceOf[to].add(value);
    
    balanceOf[msg.sender] = newSenderBalance;
    balanceOf[to] = newReceiverBalance;
    
    // MUST grant access - otherwise values are unusable!
    newSenderBalance.allow(msg.sender);      // Sender can decrypt
    newReceiverBalance.allow(to);            // Receiver can decrypt
    newSenderBalance.allowThis();            // Contract can compute later
    newReceiverBalance.allowThis();          // Contract can compute later
}

// Check access for external inputs
function transfer(address to, euint256 value) public {
    require(msg.sender.isAllowed(value), "Unauthorized handle access");
    _transfer(to, value);
}
```

### Decryption Attestations

```solidity
import {DecryptionAttestation} from "@inco/lightning/src/lightning-parts/DecryptionAttester.types.sol";
import {asBool} from "@inco/lightning/src/shared/TypeUtils.sol";

function verifyDecryption(
    DecryptionAttestation memory decryption,
    bytes[] memory signatures
) external {
    // 1. Verify covalidator signatures
    require(
        inco.incoVerifier().isValidDecryptionAttestation(decryption, signatures),
        "Invalid signature"
    );
    
    // 2. ALWAYS verify handle matches expected value (prevents swap attacks!)
    require(euint256.unwrap(myHandle) == decryption.handle, "Handle mismatch");
    
    // 3. Use decrypted value
    uint256 plaintext = uint256(decryption.value);
    // or for booleans:
    bool flag = asBool(decryption.value);
}
```

### Testing (Foundry)

```solidity
import {IncoTest} from "@inco/lightning/src/test/IncoTest.sol";

contract MyTest is IncoTest {
    function setUp() public override {
        super.setUp();  // REQUIRED: deploys mocked Inco infrastructure
        
        // Fund contracts to pay Inco fees
        vm.deal(address(myContract), 50 ether);
    }
    
    function testSomething() public {
        // Create fake ciphertext for testing
        bytes memory ct = fakePrepareEuint256Ciphertext(100, alice, address(myContract));
        
        // Execute operation
        vm.deal(alice, inco.getFee());
        vm.prank(alice);
        myContract.deposit{value: inco.getFee()}(ct);
        
        // Process TEE operations (simulates off-chain processing)
        processAllOperations();
        
        // Get decrypted value for assertions (test-only cheatcode)
        uint256 value = getUint256Value(myContract.balance());
        assertEq(value, 100);
    }
}
```

---

## SVM (Solana/Rust) API

### Setup

```toml
# Cargo.toml
[dependencies]
inco-lightning = { version = "0.1.4", features = ["cpi"] }
```

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
```

### Account Struct

```rust
#[derive(Accounts)]
pub struct MyInstruction<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    
    #[account(mut)]
    pub my_account: Account<'info, MyAccount>,
    
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}
```

### Input Functions

```rust
// From ciphertext (client-encrypted)
let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
let amount: Euint128 = new_euint128(cpi_ctx, encrypted_bytes, 0)?;

// From plaintext
let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
let zero: Euint128 = as_euint128(cpi_ctx, 0)?;
```

### Operations

```rust
// Arithmetic
let sum: Euint128 = e_add(cpi_ctx, a, b, 0)?;
let diff: Euint128 = e_sub(cpi_ctx, a, b, 0)?;
let prod: Euint128 = e_mul(cpi_ctx, a, b, 0)?;

// Comparison
let is_ge: Ebool = e_ge(cpi_ctx, balance, amount, 0)?;
let is_eq: Ebool = e_eq(cpi_ctx, a, b, 0)?;

// Conditional selection (if/else replacement)
let actual: Euint128 = e_select(cpi_ctx, condition, if_true, if_false, 0)?;

// Random
let random: Euint128 = e_rand(cpi_ctx, 0)?;
```

### Access Control (via remaining_accounts)

```rust
/// remaining_accounts:
///   [0] allowance_account (mut) - PDA for granting decrypt access
///   [1] owner_address (readonly) - The owner to grant access to
pub fn transfer<'info>(
    ctx: Context<'_, '_, '_, 'info, Transfer<'info>>,
    amount: Euint128,
) -> Result<()> {
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.authority.to_account_info();
    
    // ... perform operations ...
    
    // Grant allowance via remaining_accounts
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
        allow(cpi_ctx, new_balance.0, true, owner)?;
    }
    
    Ok(())
}
```

### PDA Derivation for Allowance Account

```rust
// seeds = [handle.to_le_bytes(), allowed_address]
```

```typescript
// TypeScript client
const INCO_PROGRAM_ID = new PublicKey('5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');

function findAllowanceAccount(handle: bigint, allowedAddress: PublicKey): PublicKey {
  const handleBuffer = Buffer.alloc(16);
  handleBuffer.writeBigUInt64LE(handle & BigInt('0xFFFFFFFFFFFFFFFF'), 0);
  handleBuffer.writeBigUInt64LE(handle >> BigInt(64), 8);
  
  const [allowanceAccount] = PublicKey.findProgramAddressSync(
    [handleBuffer, allowedAddress.toBuffer()],
    INCO_PROGRAM_ID
  );
  return allowanceAccount;
}
```

---

## TypeScript Client (@inco/js)

### Setup

```typescript
import { Lightning, supportedChains, handleTypes } from '@inco/js';
import { Lightning as LightningLite } from '@inco/js/lite';

// IMPORTANT: Lightning.latest() returns a Promise!
const zap = await Lightning.latest('testnet', supportedChains.baseSepolia);
```

### Encryption

```typescript
// Encrypt for EVM contract
const ciphertext = await zap.encrypt(amount, {
  accountAddress: userAddress,
  dappAddress: contractAddress,
  handleType: handleTypes.euint256  // or .ebool, .euint160 for eaddress
});

// Send to contract
await contract.deposit(ciphertext, { value: await incoFee() });
```

### Attested Decrypt

```typescript
import { createWalletClient, custom } from 'viem';

const walletClient = createWalletClient({...});

// Decrypt with covalidator signatures
const results = await zap.attestedDecrypt(walletClient, [handleHex]);
const { handle, plaintext, covalidatorSignatures } = results[0];

// Submit back to contract
await contract.verifyDecryption(
  { handle, value: plaintext.value },
  covalidatorSignatures
);
```

### Attested Compute (Off-chain Comparison)

```typescript
import { AttestedComputeSupportedOps } from '@inco/js/lite';

// Check if creditScore >= 700 without revealing the score
const result = await zap.attestedCompute(
  walletClient,
  creditScoreHandle,
  AttestedComputeSupportedOps.Ge,
  700n
);

console.log(result.plaintext.value); // boolean
```

### Session Keys (No Wallet Popup)

```typescript
import { generateSecp256k1Keypair } from '@inco/js/lite';

const ephemeralKeypair = generateSecp256k1Keypair();
const expiresAt = new Date(Date.now() + 3600000); // 1 hour

// Grant session (one-time wallet signature)
const voucher = await zap.grantSessionKeyAllowanceVoucher(
  walletClient,
  ephemeralKeypair.encodePublicKey(),
  expiresAt,
  '0xc34569efc25901bdd6b652164a2c8a7228b23005'  // default verifier
);

// Now decrypt without wallet popup
const results = await zap.attestedDecryptWithVoucher(
  ephemeralKeypair,
  voucher,
  [handleHex]
);
```

---

## Best Practices & Common Pitfalls

### ✅ DO

1. **Always call `allowThis()` after operations** - Contract can't use values in future txs otherwise
2. **Verify handle matches on attestation** - Prevents handle swap attacks
3. **Check `isAllowed()` for external handle inputs** - Prevent unauthorized access
4. **Use `select()` instead of if/else** - Never branch on encrypted conditions
5. **Pay fees for ciphertext inputs** - `msg.value >= inco.getFee() * count`
6. **Use bun instead of node** - @inco/js has ESM issues with Node.js
7. **Await `Lightning.latest()`** - It returns a Promise

### ❌ DON'T

1. **Don't forget `super.setUp()` in tests** - Deploys mocked Inco infrastructure
2. **Don't use mock bytes in fork tests** - Real Inco precompiles reject them
3. **Don't use delegatecall carelessly** - Called contract can decrypt your handles
4. **Don't hardcode fees** - Use `inco.getFee()` as fees may change

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Fee Not Paid` | Insufficient `msg.value` | Pay `inco.getFee() * ciphertextCount` |
| `encrypt is not a function` | Didn't await `Lightning.latest()` | Add `await` before the call |
| `InvalidInitialization()` | Called `initialize()` on implementation | Skip init or use proxy pattern |
| `EvmError: Revert` on fork test | Mock ciphertexts rejected | Use real ciphertexts from @inco/js |
| `Unauthorized handle access` | Missing `allow()` call | Call `allow(address)` after operation |

---

## Network Details

### EVM (Base Sepolia)

- **Network**: Base Sepolia Testnet
- **Chain ID**: 84532
- **Inco Environment**: `testnet`
- **Precompiles**: Built into chain, no deployment needed

### SVM (Solana Devnet)

- **Program ID**: `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj`

---

## Related Files in This Project

| File | Description |
|------|-------------|
| `base/src/ConfidentialBridge.sol` | Privacy-preserving bridge using Inco |
| `base/src/ConfidentialCrossChainERC20.sol` | Encrypted ERC20 token |
| `base/test/ConfidentialBridge.Fork.t.sol` | Fork tests with real Inco |
| `solana/programs/bridge/src/instructions/confidential_*` | Confidential vault operations |
| `clients/ts/src/privacy-client.ts` | Privacy bridge client |
| `scripts/src/demo-privacy-e2e.ts` | End-to-end privacy demo |
