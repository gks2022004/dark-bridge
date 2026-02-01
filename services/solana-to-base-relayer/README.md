# Solana to Base Relayer

Automated relayer service that watches for confidential bridge events on Solana and mints tokens on Base using Inco TEE (Trusted Execution Environment).

## Overview

This service enables the Solana → Base direction of the confidential bridge by:

1. **Monitoring** Solana for `ConfidentialBridgeOutEvent` emissions
2. **Parsing** encrypted amount handles and destination addresses
3. **Relaying** to Base via `receiveFromSolanaForDemo()` contract call
4. **Minting** confidential tokens to users on Base

## Architecture

```
Solana                          Relayer                        Base
─────────                       ────────                       ────

User bridges               ┌──> Watch events
tokens from vault          │    
                           │    Parse event data
ConfidentialBridge         │    - vault address
.bridge_confidential_out() │    - owner address
                           │    - destination EVM
Emit event ───────────────>│    - encrypted handle (u128)
- encrypted_amount_handle  │    
- destination_evm          │    Convert handle format
                           │    Solana u128 → EVM bytes
                           │    
                           │    Call Base contract
                           └──> receiveFromSolanaForDemo()
                                - localToken
                                - to (destination)
                                - encryptedAmount (bytes)
                                
                                Mint tokens ───────────> User receives
                                                         confidential
                                                         tokens
```

## Features

✅ **Privacy Preserving** - No plaintext amounts revealed on either chain  
✅ **TEE-based Encryption** - Uses Inco Lightning for secure operations  
✅ **Automatic Polling** - Watches Solana every 5 seconds  
✅ **Duplicate Prevention** - Tracks processed transactions  
✅ **Error Recovery** - Comprehensive error handling  
✅ **Live Monitoring** - Detailed console logging  

## Prerequisites

- **Bun** (or Node.js v20+)
- **Base Sepolia ETH** for relayer gas fees + Inco fees
- **Environment variables** configured

## Installation

```bash
cd services/solana-to-base-relayer
bun install
```

## Configuration

Create a `.env` file or export environment variables:

```bash
export EVM_PRIVATE_KEY="0x..."  # Relayer's Base wallet private key
```

**Important:** The relayer needs:
- Sufficient Base Sepolia ETH for gas (0.001+ ETH recommended)
- Additional ETH for Inco fees (~0.0001 ETH per transaction)

## Running

### Development Mode (with auto-reload)

```bash
bun run dev
```

### Production Mode

```bash
bun run start
```

## Expected Output

```
=======================================================
 🌉 Solana to Base Relayer (Inco TEE)
=======================================================
🔗 Bridge Contract: 0x73055cefc13AdD067D76d6390F08E9B6Cb5f2FdF
🪙 Token Contract:  0xb605C1C8A1D8fA69bcE0F591952F21bB7ddb084A
📡 Solana Program:  EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9
🤖 Relayer Address: 0x1234...5678
🌐 Solana RPC:      https://api.devnet.solana.com

Initializing Inco Lightning client...
✅ Inco client initialized
👀 Watching for ConfidentialBridgeOutEvent on Solana...

[2026-01-28T10:30:45.123Z] 💓 Relayer running...
```

### When a Bridge Event is Detected

```
[2026-01-28T10:31:20.456Z] Processing Solana TX: 3Kj8...Xm7p

  ✅ Bridge transaction detected
  📦 Slot: 123456789
  👤 Owner: 7xK9...Ym3n
  💼 Vault: 4Lp2...Zq5k
  🎯 Destination EVM: 0xabcd...ef01
  🔐 Encrypted Handle: 123456789012345678

  🔄 Relaying to Base...
  💰 Inco fee: 100000000000000 wei
  📦 Encrypted amount (hex): 0x4e61bc0000000000000000000000000000000000
  📤 Sending mint transaction to Base...
  ⏳ TX sent: 0x789a...bcde
  🔍 Waiting for confirmation...
  ✅ RELAYED SUCCESSFULLY!
  📍 Base TX: 0x789a...bcde
  🎉 Tokens minted to 0xabcd...ef01
```

## How It Works

### 1. Event Monitoring

The relayer polls the Solana bridge program every 5 seconds:

```typescript
await connection.getSignaturesForAddress(BRIDGE_PROGRAM_ID, { limit: 20 });
```

### 2. Event Parsing

When a transaction is found, it parses the Anchor event structure:

```typescript
// Anchor event format:
// [0:8]    - Event discriminator
// [8:40]   - vault (Pubkey, 32 bytes)
// [40:72]  - owner (Pubkey, 32 bytes)
// [72:92]  - destination_evm ([u8; 20])
// [92:108] - encrypted_amount_handle (u128, 16 bytes)
```

### 3. Handle Conversion

Converts Solana's u128 handle to EVM bytes format:

```typescript
const handleBytes = new Uint8Array(16);
const view = new DataView(handleBytes.buffer);
view.setBigUint64(0, handle & 0xFFFFFFFFFFFFFFFFn, true);  // low 64 bits
view.setBigUint64(8, handle >> 64n, true);                  // high 64 bits
```

### 4. Base Transaction

Calls the Base contract to mint tokens:

```typescript
await walletClient.writeContract({
    address: CONFIDENTIAL_BRIDGE_ADDRESS,
    abi: BRIDGE_ABI,
    functionName: "receiveFromSolanaForDemo",
    args: [tokenAddress, destinationAddress, encryptedAmountHex],
    value: incoFee,
});
```

## Configuration Details

### Contract Addresses

```typescript
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x73055cefc13AdD067D76d6390F08E9B6Cb5f2FdF";
const CONFIDENTIAL_TOKEN_ADDRESS = "0xb605C1C8A1D8fA69bcE0F591952F21bB7ddb084A";
const BRIDGE_PROGRAM_ID = "EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9";
```

### Network Settings

```typescript
const SOLANA_RPC = "https://api.devnet.solana.com";
const BASE_RPC = "https://sepolia.base.org";
```

### Polling Intervals

- **Event polling:** 5 seconds
- **Heartbeat log:** 60 seconds

## Monitoring

### Health Checks

The relayer logs a heartbeat every minute:

```
[2026-01-28T10:32:45.789Z] 💓 Relayer running, last processed: 3Kj8...Xm7p
```

### Metrics to Watch

- **Processing lag:** Time between Solana event and Base mint
- **Success rate:** Percentage of successful relays
- **Gas costs:** ETH spent on Base transactions
- **Inco fees:** ETH spent on Inco operations

## Troubleshooting

### "Inco client not initialized"

**Cause:** Inco Lightning SDK failed to connect  
**Solution:**
```bash
# Check network connectivity
curl https://sepolia.base.org

# Restart relayer
bun run start
```

### "Insufficient funds for gas"

**Cause:** Relayer wallet has insufficient ETH  
**Solution:**
```bash
# Check balance
cast balance $RELAYER_ADDRESS --rpc-url https://sepolia.base.org

# Get more testnet ETH from faucet
```

### "Transaction reverted"

**Cause:** Base contract call failed  
**Solution:**
- Check contract addresses are correct
- Verify Inco fee is sufficient
- Check relayer has enough ETH for gas + fees

### "Transaction not found"

**Cause:** Solana transaction not finalized yet  
**Solution:** Wait 30-60 seconds, relayer will retry

### "Handle mismatch"

**Cause:** Security check failed (potential attack)  
**Solution:** This is normal in demo mode, investigate if in production

## Security Considerations

### Current Implementation (Demo Mode)

⚠️ **Using `receiveFromSolanaForDemo()`** which has no access control  
⚠️ **No signature verification** from bridge validators  
⚠️ **Anyone can call** the mint function with valid data  

### Production Requirements

✅ **Use `receiveFromSolana()`** with proper access control  
✅ **Add nonce verification** to prevent replay attacks  
✅ **Require validator signatures** for cross-chain messages  
✅ **Implement rate limiting** to prevent spam  
✅ **Monitor for anomalies** in bridge activity  

### Private Key Security

⚠️ **Never commit** `.env` file to git  
✅ **Use secrets management** in production (AWS Secrets, Vault, etc.)  
✅ **Rotate keys** periodically  
✅ **Monitor wallet balance** for unexpected drains  

## Performance

### Typical Latency

- **Solana finalization:** ~0.5 seconds
- **Relayer detection:** 5-10 seconds (polling)
- **Base transaction:** 2-3 seconds
- **Total end-to-end:** **10-15 seconds**

### Throughput

- **Transactions per minute:** ~10-12 (limited by polling)
- **Can be improved** with WebSocket subscriptions

## Scaling

### For Higher Throughput

1. **Use WebSocket subscriptions** instead of polling
2. **Run multiple relayer instances** with deduplication
3. **Batch transactions** on Base to save gas
4. **Implement priority queue** for large transfers

### For Production

1. **Add database** to track all relayed transactions
2. **Implement retry logic** with exponential backoff
3. **Add alerting** for failures (PagerDuty, Slack, etc.)
4. **Monitor metrics** (Prometheus, Grafana)
5. **Set up CI/CD** for automated deployments

## Dependencies

```json
{
    "@inco/js": "0.8.0-devnet-3",     // Inco Lightning TEE SDK
    "@solana/web3.js": "^1.95.8",     // Solana RPC client
    "viem": "^2.38.0"                 // EVM client (Base)
}
```

## API Reference

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EVM_PRIVATE_KEY` | Yes | Relayer's Base wallet private key (0x...) |

### Events Watched

**Solana:**
- `ConfidentialBridgeOutEvent` - User initiated Solana → Base transfer

**Base:**
- `ConfidentialBridgeReceived` - Tokens minted on Base (for logging)

### Functions Called

**Base Contract:**
- `receiveFromSolanaForDemo(address localToken, address to, bytes encryptedAmount)` - Mints tokens

## Development

### Running Tests

```bash
# Unit tests (not implemented yet)
bun test

# Integration tests
# 1. Start relayer in one terminal
bun run dev

# 2. Bridge tokens from Solana in another terminal
# (use frontend or CLI)
```

### Adding Features

To add new functionality:

1. Update `src/index.ts`
2. Follow TypeScript best practices
3. Add error handling
4. Update this README
5. Test thoroughly on devnet

## Resources

- **Main Documentation:** See `SOLANA_TO_BASE_GUIDE.md`
- **Inco SDK:** https://docs.inco.org
- **Solana Web3.js:** https://solana-labs.github.io/solana-web3.js/
- **Viem:** https://viem.sh

## License

MIT
