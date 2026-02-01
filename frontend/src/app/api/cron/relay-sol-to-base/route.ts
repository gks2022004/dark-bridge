import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import crypto from "crypto";

// --- ENV & TLS ---
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// --- Constants (matching privacy-relayer-sol-to-base.ts) ---
const CONFIDENTIAL_BRIDGE_ADDRESS = "0xD705858A979a4ab42e7a2e43e8CcC726Dbd87369" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xFBAD5A940d89e504C5f8C9e0fC3A976A82334565" as Address;
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://sepolia.base.org";

// ABIs
const CONFIDENTIAL_TOKEN_ABI = parseAbi([
    "function confidentialMint(address to, bytes encryptedAmount) external payable",
    "function confidentialMintForDemo(address to, uint256 plainAmount) external payable",
]);

const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "function getIncoFee() external view returns (uint256)",
]);

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// --- HANDLER ---
export async function GET(req: NextRequest) {
    // 1. Auth check
    const authHeader = req.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        const urlKey = req.nextUrl.searchParams.get('key');
        if (urlKey !== process.env.CRON_SECRET) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    // 2. Load Keys
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
    const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
    if (!evmPrivateKey || !solanaPrivateKey) {
        return NextResponse.json({ error: "Missing PRIVATE_KEYs" }, { status: 500 });
    }

    try {
        // Setup clients
        const evmAccount = privateKeyToAccount(evmPrivateKey as `0x${string}`);
        const baseWalletClient = createWalletClient({
            account: evmAccount,
            chain: baseSepolia,
            transport: http(BASE_RPC_URL),
        });
        const basePublicClient = createPublicClient({
            chain: baseSepolia,
            transport: http(BASE_RPC_URL),
        });

        const solanaConnection = new Connection(SOLANA_RPC_URL, "confirmed");
        // Validate keypair format (not used in this route but validates config)
        if (solanaPrivateKey.startsWith("[")) {
            Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solanaPrivateKey)));
        } else {
            try {
                const decoded = Uint8Array.from(Buffer.from(solanaPrivateKey, 'base64'));
                Keypair.fromSecretKey(decoded.length === 64 ? decoded : Uint8Array.from(JSON.parse(solanaPrivateKey)));
            } catch {
                Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solanaPrivateKey)));
            }
        }

        console.log(`[Sol -> Base Relayer] EVM: ${evmAccount.address}`);

        // 3. Poll recent Solana Signatures for the bridge program
        const signatures = await solanaConnection.getSignaturesForAddress(
            BRIDGE_PROGRAM_ID,
            { limit: 20 },
            "confirmed"
        );

        console.log(`Found ${signatures.length} recent signatures on Solana`);
        const results = [];

        for (const sig of signatures) {
            if (sig.err) continue;

            const tx = await solanaConnection.getTransaction(sig.signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            });

            if (!tx || !tx.meta?.logMessages) continue;

            const logs = tx.meta.logMessages;

            // Parse Events - try plaintext version first (has actual amount)
            const plaintextEvent = parseConfidentialBridgeOutPlaintextEvent(logs);
            const regularEvent = !plaintextEvent ? parseConfidentialBridgeOutEvent(logs) : null;
            const privateEvent = !plaintextEvent && !regularEvent ? parseRelayedPrivateBridgeOutEvent(logs) : null;

            if (!plaintextEvent && !regularEvent && !privateEvent) continue;

            // Skip old transactions (> 5 mins)
            if (tx.blockTime) {
                const now = Math.floor(Date.now() / 1000);
                if (now - tx.blockTime > 300) continue;
            }

            console.log(`Processing Solana TX: ${sig.signature}`);

            // Extract Details
            let destinationAddress: Address;
            let amountToMint: bigint;

            if (plaintextEvent) {
                console.log("   Found Plaintext Event");
                destinationAddress = ("0x" + Buffer.from(plaintextEvent.destinationEvm).toString("hex")) as Address;
                amountToMint = plaintextEvent.plaintextAmount;
                console.log(`   Plaintext amount: ${amountToMint}`);
            } else if (regularEvent) {
                console.log("   Found Encrypted Event");
                destinationAddress = ("0x" + Buffer.from(regularEvent.destinationEvm).toString("hex")) as Address;
                // Try simple decrypt
                const decrypted = await requestAttestedDecryptSimple(regularEvent.encryptedAmountHandle);
                if (decrypted && decrypted.plaintext > 0n) {
                    amountToMint = decrypted.plaintext;
                    console.log(`   Decrypted: ${amountToMint}`);
                } else {
                    console.log("   Using demo fallback amount");
                    amountToMint = BigInt(5);
                }
            } else if (privateEvent) {
                console.log("   Found Private Event (sender hidden)");
                destinationAddress = ("0x" + Buffer.from(privateEvent.destinationEvm).toString("hex")) as Address;
                amountToMint = BigInt(5); // Demo fallback for private events
            } else {
                continue;
            }

            // 4. Get Inco Fee
            let incoFee = 100000000000000n; // 0.0001 ETH default
            try {
                incoFee = await basePublicClient.readContract({
                    address: CONFIDENTIAL_BRIDGE_ADDRESS,
                    abi: CONFIDENTIAL_BRIDGE_ABI,
                    functionName: "getIncoFee",
                });
            } catch { }

            // 5. Mint on Base with retry logic for nonce issues
            let hash: `0x${string}` | null = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const nonce = await basePublicClient.getTransactionCount({
                        address: evmAccount.address,
                    });
                    console.log(`   Attempt ${attempt}: Using nonce ${nonce}`);

                    hash = await baseWalletClient.writeContract({
                        address: CONFIDENTIAL_TOKEN_ADDRESS,
                        abi: CONFIDENTIAL_TOKEN_ABI,
                        functionName: "confidentialMintForDemo",
                        args: [destinationAddress, amountToMint],
                        value: incoFee,
                        nonce: nonce,
                    });
                    
                    console.log(`   ✅ Minted on Base: ${hash}`);
                    results.push({ tx: sig.signature, status: "relayed", hash });
                    break;
                } catch (txError: unknown) {
                    const txErrMsg = txError instanceof Error ? txError.message : String(txError);
                    if (txErrMsg.includes("nonce") && attempt < 3) {
                        console.log(`   ⚠️ Nonce error, retrying in 2s...`);
                        await new Promise(r => setTimeout(r, 2000));
                    } else {
                        console.error(`   Mint Error: ${txErrMsg}`);
                        results.push({ tx: sig.signature, status: "error", error: txErrMsg });
                        break;
                    }
                }
            }
        }

        return NextResponse.json({ success: true, results });

    } catch (e: unknown) {
        console.error("Relayer Error:", e);
        const errMsg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: errMsg }, { status: 500 });
    }
}


// --- PARSING HELPERS (matching privacy-relayer-sol-to-base.ts) ---

interface BridgeOutEvent {
    vault?: string;
    owner?: string;
    destinationEvm: Uint8Array;
    encryptedAmountHandle: bigint;
    plaintextAmount?: bigint;
}

function parseConfidentialBridgeOutPlaintextEvent(logs: string[]): BridgeOutEvent & { plaintextAmount: bigint } | null {
    const EXPECTED_DISCRIMINATOR = computeAnchorEventDiscriminator("ConfidentialBridgeOutPlaintextEvent");

    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const data = Buffer.from(log.replace("Program data: ", ""), "base64");
                if (data.subarray(0, 8).equals(EXPECTED_DISCRIMINATOR)) {
                    if (data.length >= 8 + 32 + 32 + 20 + 16 + 16) {
                        let offset = 8;
                        // skip vault (32), owner (32)
                        offset += 64;
                        const destinationEvm = data.subarray(offset, offset + 20);
                        offset += 20;
                        const handleBytes = data.subarray(offset, offset + 16);
                        const encryptedAmountHandle = readU128LE(handleBytes);
                        offset += 16;
                        const plaintextBytes = data.subarray(offset, offset + 16);
                        const plaintextAmount = readU128LE(plaintextBytes);
                        return { destinationEvm, encryptedAmountHandle, plaintextAmount };
                    }
                }
            } catch { }
        }
    }
    return null;
}

function parseConfidentialBridgeOutEvent(logs: string[]): BridgeOutEvent | null {
    const EXPECTED_DISCRIMINATOR = Buffer.from("fee3f47c36edab41", "hex");
    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const data = Buffer.from(log.replace("Program data: ", ""), "base64");
                if (data.subarray(0, 8).equals(EXPECTED_DISCRIMINATOR)) {
                    if (data.length >= 108) {
                        let offset = 8 + 64;
                        const destinationEvm = data.subarray(offset, offset + 20);
                        offset += 20;
                        const handleBytes = data.subarray(offset, offset + 16);
                        const encryptedAmountHandle = readU128LE(handleBytes);
                        return { destinationEvm, encryptedAmountHandle };
                    }
                }
            } catch { }
        }
    }
    return null;
}

function parseRelayedPrivateBridgeOutEvent(logs: string[]): BridgeOutEvent | null {
    const EXPECTED_DISCRIMINATOR = computeAnchorEventDiscriminator("RelayedPrivateBridgeOutEvent");
    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const data = Buffer.from(log.replace("Program data: ", ""), "base64");
                if (data.subarray(0, 8).equals(EXPECTED_DISCRIMINATOR)) {
                    if (data.length >= 44) {
                        let offset = 8;
                        const destinationEvm = data.subarray(offset, offset + 20);
                        offset += 20;
                        const handleBytes = data.subarray(offset, offset + 16);
                        const encryptedAmountHandle = readU128LE(handleBytes);
                        return { destinationEvm, encryptedAmountHandle };
                    }
                }
            } catch { }
        }
    }
    return null;
}


// --- UTILS ---

function computeAnchorEventDiscriminator(eventName: string): Buffer {
    const hash = crypto.createHash("sha256");
    hash.update(`event:${eventName}`);
    return Buffer.from(hash.digest().subarray(0, 8));
}

function readU128LE(buffer: Uint8Array): bigint {
    let result = BigInt(0);
    for (let i = 0; i < Math.min(16, buffer.length); i++) {
        result += BigInt(buffer[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

// Simple decrypt via Inco API with exponential backoff
// Inco team recommends: 1-2 second backoff for TEE sync delays
async function requestAttestedDecryptSimple(handle: bigint) {
    const maxAttempts = 5;
    const baseDelayMs = 1500; // Start at 1.5s as recommended
    const backoffFactor = 1.5;
    const maxDelayMs = 8000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(`https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/decrypt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle: handle.toString() }),
            });
            if (response.ok) {
                const data = await response.json();
                const plaintext = BigInt(data.plaintext || data.value || 0);
                if (plaintext > 0n) {
                    return {
                        handle: handle.toString(),
                        plaintext,
                    };
                }
            }
            
            // Check for permission/sync errors that warrant retry
            const errorText = await response.text().catch(() => '');
            const isRetryable = errorText.includes('not allowed') || 
                               errorText.includes('rate limit') ||
                               response.status === 429;
            
            if (isRetryable && attempt < maxAttempts) {
                const delay = Math.min(baseDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
                const jitter = Math.random() * 400 - 200; // ±200ms jitter
                console.log(`   Decrypt attempt ${attempt} failed (TEE sync), retrying in ${Math.round(delay + jitter)}ms...`);
                await new Promise(r => setTimeout(r, delay + jitter));
                continue;
            }
        } catch {
            if (attempt < maxAttempts) {
                const delay = Math.min(baseDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
                console.log(`   Decrypt attempt ${attempt} error, retrying in ${Math.round(delay)}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
        }
    }
    return null;
}
