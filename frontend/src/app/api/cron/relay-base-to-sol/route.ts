import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    http,
    decodeEventLog,
    type Address,
    type Hex,
    toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { encryptValue } from "@inco/solana-sdk/encryption";
import { hexToBuffer } from "@inco/solana-sdk/utils";
import crypto from "crypto";

// --- ENV & TLS ---
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// --- Constants (matching privacy-relayer-base-to-sol.ts) ---
const CONFIDENTIAL_BRIDGE_ADDRESS = "0xD705858A979a4ab42e7a2e43e8CcC726Dbd87369" as Address;
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");
const SOLANA_TOKEN_MINT = new PublicKey("2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH");
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://sepolia.base.org";

// ABI for parsing events (matching script)
const CONFIDENTIAL_BRIDGE_FULL_ABI = [
    {
        type: "event",
        name: "ConfidentialBridgeInitiated",
        inputs: [
            { name: "nonce", type: "uint256", indexed: true },
            { name: "localToken", type: "address", indexed: true },
            { name: "remoteToken", type: "bytes32", indexed: true },
            { name: "toSolana", type: "bytes32", indexed: false },
            { name: "encryptedAmount", type: "bytes32", indexed: false },
        ],
    },
    {
        type: "event",
        name: "ConfidentialBridgeInitiatedWithPlaintext",
        inputs: [
            { name: "nonce", type: "uint256", indexed: true },
            { name: "localToken", type: "address", indexed: true },
            { name: "remoteToken", type: "bytes32", indexed: true },
            { name: "toSolana", type: "bytes32", indexed: false },
            { name: "plaintextAmount", type: "uint256", indexed: false },
        ],
    },
] as const;

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
    // 1. Authorization Check
    const authHeader = req.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        const urlKey = req.nextUrl.searchParams.get('key');
        if (urlKey !== process.env.CRON_SECRET) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    // 2. Load Private Keys
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
    const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;

    if (!evmPrivateKey || !solanaPrivateKey) {
        return NextResponse.json({ error: "Missing EVM_PRIVATE_KEY or SOLANA_PRIVATE_KEY" }, { status: 500 });
    }

    try {
        // Setup clients
        const evmAccount = privateKeyToAccount(evmPrivateKey as `0x${string}`);
        const basePublicClient = createPublicClient({
            chain: baseSepolia,
            transport: http(BASE_RPC_URL),
        });

        const solanaConnection = new Connection(SOLANA_RPC_URL, "confirmed");

        // Decode Solana keypair
        let solanaKeypair: Keypair;
        if (solanaPrivateKey.startsWith("[")) {
            solanaKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solanaPrivateKey)));
        } else {
            try {
                // Base58 decode for standard Solana private key format
                const decoded = Uint8Array.from(Buffer.from(solanaPrivateKey, 'base64'));
                solanaKeypair = Keypair.fromSecretKey(decoded.length === 64 ? decoded : Uint8Array.from(JSON.parse(solanaPrivateKey)));
            } catch {
                solanaKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solanaPrivateKey)));
            }
        }

        console.log(`[Base -> Sol Relayer] EVM: ${evmAccount.address}, Sol: ${solanaKeypair.publicKey.toBase58()}`);

        // 3. Scan for recent events (look back ~100 blocks)
        const currentBlock = await basePublicClient.getBlockNumber();
        const LOOKBACK = 100n;
        const fromBlock = currentBlock - LOOKBACK;

        const logs = await basePublicClient.getLogs({
            address: CONFIDENTIAL_BRIDGE_ADDRESS,
            fromBlock,
            toBlock: currentBlock,
        });

        console.log(`Found ${logs.length} events from block ${fromBlock} to ${currentBlock}`);

        const results = [];

        for (const log of logs) {
            try {
                const decoded = decodeEventLog({
                    abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                    data: log.data,
                    topics: log.topics,
                });

                // Only process plaintext events (production flow)
                if (decoded.eventName === "ConfidentialBridgeInitiatedWithPlaintext") {
                    const args = decoded.args as { nonce: bigint; toSolana: `0x${string}`; plaintextAmount: bigint };
                    console.log(`Processing TX ${log.transactionHash}: Nonce ${args.nonce}`);

                    const success = await relayToSolana(
                        solanaConnection,
                        solanaKeypair,
                        args.toSolana,
                        args.plaintextAmount,
                        evmAccount.address
                    );

                    results.push({ 
                        tx: log.transactionHash, 
                        nonce: args.nonce.toString(),
                        status: success ? "relayed" : "failed" 
                    });
                }
            } catch (e: unknown) {
                const errMsg = e instanceof Error ? e.message : String(e);
                console.error(`Error processing log ${log.transactionHash}:`, errMsg);
                results.push({ tx: log.transactionHash, status: "error", error: errMsg });
            }
        }

        return NextResponse.json({
            success: true,
            scanned: logs.length,
            results
        });

    } catch (e: unknown) {
        console.error("Relayer error:", e);
        const errMsg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: errMsg }, { status: 500 });
    }
}

// --- HELPER: Relay to Solana (matching script logic) ---
async function relayToSolana(
    connection: Connection,
    payer: Keypair,
    toSolanaBytes32: Hex,
    plaintextAmount: bigint,
    baseSenderAddress: string
): Promise<boolean> {
    try {
        // 1. Convert Recipient from bytes32
        const recipientPubkey = new PublicKey(toBytes(toSolanaBytes32));
        console.log(`   Recipient: ${recipientPubkey.toBase58()}`);

        // 2. Encrypt for Solana TEE
        console.log(`   Encrypting ${plaintextAmount} for Solana TEE...`);
        const solanaCiphertext = await encryptValue(plaintextAmount);
        const encryptedAmountBytes = Uint8Array.from(hexToBuffer(solanaCiphertext));
        console.log(`   Ciphertext: ${encryptedAmountBytes.length} bytes`);

        // 3. Derive PDAs
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("confidential_vault"), recipientPubkey.toBuffer(), SOLANA_TOKEN_MINT.toBuffer()],
            BRIDGE_PROGRAM_ID
        );
        const [bridgeAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge_authority")],
            BRIDGE_PROGRAM_ID
        );
        const [bridgeState] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge")],
            BRIDGE_PROGRAM_ID
        );

        // Check vault exists
        const vaultInfo = await connection.getAccountInfo(vaultPda);
        if (!vaultInfo) {
            console.log(`   Vault does not exist for recipient: ${vaultPda.toBase58()}`);
            return false;
        }

        // 4. Build instruction (matching script)
        const discriminator = crypto.createHash("sha256")
            .update("global:relay_receive_confidential")
            .digest()
            .slice(0, 8);

        const baseSender = toBytes(baseSenderAddress).slice(0, 20);
        const encryptedLenBuf = Buffer.alloc(4);
        encryptedLenBuf.writeUInt32LE(encryptedAmountBytes.length, 0);

        const instructionData = Buffer.concat([
            discriminator,
            encryptedLenBuf,
            Buffer.from(encryptedAmountBytes),
            Buffer.from(baseSender),
        ]);

        const instruction = new TransactionInstruction({
            programId: BRIDGE_PROGRAM_ID,
            keys: [
                { pubkey: payer.publicKey, isSigner: true, isWritable: true },
                { pubkey: bridgeState, isSigner: false, isWritable: false },
                { pubkey: bridgeAuthority, isSigner: false, isWritable: true },
                { pubkey: vaultPda, isSigner: false, isWritable: true },
                { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: instructionData,
        });

        // 5. Send
        const transaction = new Transaction().add(instruction);
        const signature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [payer],
            { commitment: "confirmed" }
        );

        console.log(`   ✅ Relay Success: ${signature}`);
        return true;

    } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`   Relay Failed: ${errMsg}`);
        return false;
    }
}
