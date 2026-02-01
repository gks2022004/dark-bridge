"use client";

import { useState, useEffect } from "react";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { BRIDGE_PROGRAM_ID, SOLANA_CDARK_TOKEN_MINT, INCO_LIGHTNING_PROGRAM_ID } from "@/lib/constants";
import { decrypt } from "@inco/solana-sdk/attested-decrypt";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, RefreshCw, Lock, Eye, ExternalLink, Loader2, AlertCircle, CheckCircle } from "lucide-react";

// Inco Lightning Program ID on Solana Devnet
const INCO_LIGHTNING_ID = new PublicKey(INCO_LIGHTNING_PROGRAM_ID);

// Vault seed prefix
const VAULT_SEED_PREFIX = "confidential_vault";

function readU128LE(buffer: Uint8Array): bigint {
    let result = BigInt(0);
    for (let i = 0; i < Math.min(16, buffer.length); i++) {
        result += BigInt(buffer[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

function deriveVaultPda(owner: PublicKey, tokenMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from(VAULT_SEED_PREFIX),
            owner.toBuffer(),
            tokenMint.toBuffer(),
        ],
        new PublicKey(BRIDGE_PROGRAM_ID)
    );
}

interface VaultData {
    owner: string;
    tokenMint: string;
    bridgeAuthority: string;
    encryptedBalanceHandle: bigint;
    bump: number;
}

// Helper to convert handle to 16-byte little-endian buffer
function handleToBuffer(handle: bigint): Buffer {
    const buffer = Buffer.alloc(16);
    let h = handle;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(h & BigInt(0xff));
        h >>= BigInt(8);
    }
    return buffer;
}

// Derive the allowance PDA for grant_handle_access
function deriveAllowancePDA(handle: bigint, allowedAddress: PublicKey): [PublicKey, number] {
    const handleBuffer = handleToBuffer(handle);
    return PublicKey.findProgramAddressSync(
        [handleBuffer, allowedAddress.toBuffer()],
        INCO_LIGHTNING_ID
    );
}

// Pre-computed discriminator for grant_handle_access
// sha256("global:grant_handle_access")[0:8] = 24470d30a07322ff
const GRANT_HANDLE_ACCESS_DISCRIMINATOR = Buffer.from([0x24, 0x47, 0x0d, 0x30, 0xa0, 0x73, 0x22, 0xff]);

export function VaultBalance() {
    const { publicKey, connected, signMessage, signTransaction } = useWallet();
    const { connection } = useConnection();

    const [vaultExists, setVaultExists] = useState<boolean | null>(null);
    const [vaultData, setVaultData] = useState<VaultData | null>(null);
    const [vaultPda, setVaultPda] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [decryptedBalance, setDecryptedBalance] = useState<bigint | null>(null);
    const [decrypting, setDecrypting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string>("");
    const [lastHandle, setLastHandle] = useState<string>("");

    const tokenMint = new PublicKey(SOLANA_CDARK_TOKEN_MINT);

    // Fetch vault data when wallet connects
    useEffect(() => {
        if (connected && publicKey && connection) {
            fetchVaultData();
        } else {
            setVaultExists(null);
            setVaultData(null);
            setDecryptedBalance(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, publicKey]);

    // Auto-poll for vault updates every 10 seconds
    useEffect(() => {
        if (!connected || !publicKey) return;

        const interval = setInterval(async () => {
            // Silently check for updates
            try {
                const [pda] = deriveVaultPda(publicKey, tokenMint);
                const accountInfo = await connection.getAccountInfo(pda);

                if (accountInfo) {
                    const data = accountInfo.data;
                    // Correct offset: discriminator (8) + owner (32) + token_mint (32) = 72
                    const encryptedBalance = data.subarray(8 + 32 + 32, 8 + 32 + 32 + 16);
                    const newHandle = readU128LE(encryptedBalance).toString();

                    // If handle changed, refresh the full data
                    if (newHandle !== lastHandle) {
                        console.log("Vault handle changed! Refreshing...", newHandle);
                        setLastHandle(newHandle);
                        setDecryptedBalance(null); // Reset decrypted balance
                        setError(null);
                        fetchVaultData();
                    }
                }
            } catch {
                // Silent fail for polling
            }
        }, 10000); // Poll every 10 seconds

        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, publicKey, lastHandle, connection]);

    const fetchVaultData = async () => {
        if (!publicKey || !connection) return;

        setLoading(true);
        setError(null);

        try {
            const [pda] = deriveVaultPda(publicKey, tokenMint);
            setVaultPda(pda.toBase58());

            const accountInfo = await connection.getAccountInfo(pda);

            if (!accountInfo) {
                setVaultExists(false);
                setVaultData(null);
                return;
            }

            setVaultExists(true);

            // Parse vault data
            // Structure: discriminator (8) + owner (32) + token_mint (32) + encrypted_balance (16) + bridge_authority (32) + bump (1)
            const data = accountInfo.data;

            const ownerBytes = data.subarray(8, 8 + 32);
            const tokenMintBytes = data.subarray(8 + 32, 8 + 32 + 32);
            const encryptedBalance = data.subarray(8 + 32 + 32, 8 + 32 + 32 + 16);
            const bridgeAuthorityBytes = data.subarray(8 + 32 + 32 + 16, 8 + 32 + 32 + 16 + 32);
            const bump = data[8 + 32 + 32 + 16 + 32];

            console.log("Parsed vault - encrypted balance bytes:", Buffer.from(encryptedBalance).toString('hex'));
            console.log("Parsed vault - handle:", readU128LE(encryptedBalance).toString());

            setVaultData({
                owner: new PublicKey(ownerBytes).toBase58(),
                tokenMint: new PublicKey(tokenMintBytes).toBase58(),
                bridgeAuthority: new PublicKey(bridgeAuthorityBytes).toBase58(),
                encryptedBalanceHandle: readU128LE(encryptedBalance),
                bump: bump ?? 0,
            });

            // Track the handle for change detection
            setLastHandle(readU128LE(encryptedBalance).toString());
        } catch (err: unknown) {
            const error = err as Error;
            console.error("Error fetching vault:", error);
            setError(error.message || "Failed to fetch vault");
        } finally {
            setLoading(false);
        }
    };

    const handleDecrypt = async () => {
        if (!publicKey || !signMessage || !signTransaction || !connection || !vaultData) {
            setError("Wallet not connected or missing required capabilities");
            return;
        }

        if (vaultData.encryptedBalanceHandle === BigInt(0)) {
            setError("Vault has no balance to decrypt");
            return;
        }

        setDecrypting(true);
        setError(null);
        setStatus("Starting attested decrypt...");

        try {
            const handle = vaultData.encryptedBalanceHandle;
            const [allowancePDA] = deriveAllowancePDA(handle, publicKey);

            // Step 1: Check permissions on Solana
            setStatus("Checking permissions on Solana...");
            const allowanceInfo = await connection.getAccountInfo(allowancePDA, "confirmed");
            const permissionsConfirmedOnChain = allowanceInfo !== null;

            if (permissionsConfirmedOnChain) {
                console.log("Allowance already exists on Solana.");
            } else {
                // Grant handle access
                setStatus("Granting handle access (waiting for signature)...");
                console.log("Allowance PDA:", allowancePDA.toBase58());

                // Build grant_handle_access instruction
                const handleBuffer = handleToBuffer(handle);
                const instructionData = Buffer.concat([
                    GRANT_HANDLE_ACCESS_DISCRIMINATOR,
                    handleBuffer,
                ]);

                const instruction = new TransactionInstruction({
                    programId: new PublicKey(BRIDGE_PROGRAM_ID),
                    keys: [
                        { pubkey: publicKey, isSigner: true, isWritable: true },
                        { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
                        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                        { pubkey: allowancePDA, isSigner: false, isWritable: true },
                        { pubkey: publicKey, isSigner: false, isWritable: false },
                    ],
                    data: instructionData,
                });

                const tx = new Transaction().add(instruction);
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
                tx.recentBlockhash = blockhash;
                tx.feePayer = publicKey;

                try {
                    const signedTx = await signTransaction(tx);
                    setStatus("Sending transaction...");
                    const sig = await connection.sendRawTransaction(signedTx.serialize());
                    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
                    console.log("Handle access granted:", sig);
                    setStatus("Permissions granted on Solana!");

                    // Initial wait for propagation
                    await new Promise(r => setTimeout(r, 2000));
                } catch (grantErr: unknown) {
                    const grantError = grantErr as Error & { logs?: string[] };
                    console.error("Grant handle access error:", grantError);
                    // Check if race condition occurred (account created by another request)
                    if (grantError.message?.includes("already in use") ||
                        grantError.logs?.some((l: string) => l.includes("already in use"))) {
                        console.log("Allowance already exists (caught error), continuing...");
                    } else {
                        throw grantErr;
                    }
                }
            }

            // Step 2: Use Inco SDK for attested decrypt with Aggressive Retry Logic
            // The Covalidator API *will* lag behind Solana. We must wait for it.
            // Inco team recommends: 1-2 second backoff before retry, exponential growth

            let attempts = 0;
            const maxAttempts = 3; // Quick failure detection
            let success = false;
            const baseDelayMs = 1500; // Start with 1.5s as recommended by Inco
            const maxDelayMs = 10000; // Cap at 10s
            const backoffFactor = 1.5;

            while (attempts < maxAttempts && !success) {
                attempts++;
                try {
                    setStatus(attempts === 1
                        ? "Requesting decryption from Inco Network..."
                        : `Syncing with Inco Network (${attempts}/${maxAttempts})...`
                    );

                    const result = await decrypt([handle.toString()], {
                        address: publicKey,
                        signMessage: signMessage,
                    });

                    console.log("Decrypt result:", result);

                    if (result.plaintexts && result.plaintexts.length > 0) {
                        const plaintext = BigInt(result.plaintexts[0]);
                        setDecryptedBalance(plaintext);
                        setStatus("Decryption successful!");
                        success = true;
                    } else {
                        throw new Error("No plaintext returned from decryption");
                    }
                } catch (decryptErr: unknown) {
                    const decError = decryptErr as Error;
                    console.error(`Decrypt attempt ${attempts} failed:`, decError);

                    const errString = JSON.stringify(decError) + (decError.message || "");
                    const isPermissionError = errString.includes("not allowed");
                    const isRateLimitError = errString.includes("rate limit") || errString.includes("too many");

                    // Calculate exponential backoff delay with jitter
                    const exponentialDelay = Math.min(
                        baseDelayMs * Math.pow(backoffFactor, attempts - 1),
                        maxDelayMs
                    );
                    // Add ±200ms jitter to prevent thundering herd
                    const jitter = Math.random() * 400 - 200;
                    const delayMs = Math.max(1000, exponentialDelay + jitter);

                    // If it's a permission/rate error, it means Inco hasn't synced yet
                    if ((isPermissionError || isRateLimitError) && attempts < maxAttempts) {
                        console.log(`TEE not synced yet, waiting ${Math.round(delayMs)}ms before retry...`);
                        await new Promise(r => setTimeout(r, delayMs));
                    } else {
                        // If it's another error or we've run out of attempts
                        if (attempts === maxAttempts) throw decError;
                        await new Promise(r => setTimeout(r, delayMs));
                    }
                }
            }

        } catch (err: unknown) {
            const error = err as Error;
            console.error("Decrypt error:", error);

            // Format error message for user
            let errorMsg = error.message || "Decryption failed";
            if (JSON.stringify(error).includes("not allowed")) {
                errorMsg = "Sync timeout: Inco nodes haven't seen your permission yet. Please wait 1 minute and try again.";
            } else if (error.message?.includes("No ciphertext")) {
                errorMsg = "Handle expired/invalid. Please bridge fresh tokens.";
            }

            setError(errorMsg);
            setStatus("");
        } finally {
            setDecrypting(false);
        }
    };

    if (!connected) {
        return (
            <div className="glass-card p-6">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                        <Wallet className="w-5 h-5 text-purple-500" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-white">Solana Vault</h2>
                        <p className="text-sm text-gray-500">Connect wallet to view</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-card p-6"
        >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                        <Wallet className="w-5 h-5 text-purple-500" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-white">Solana Vault</h2>
                        <p className="text-xs text-gray-500">Encrypted Balance</p>
                    </div>
                </div>
                <button
                    onClick={fetchVaultData}
                    disabled={loading}
                    className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 transition-colors disabled:opacity-50"
                >
                    <RefreshCw className={`w-4 h-4 text-gray-400 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Vault Address */}
            {vaultPda && (
                <a
                    href={`https://explorer.solana.com/address/${vaultPda}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 mb-4 p-3 rounded-xl bg-black/20 border border-white/5 hover:border-purple-500/30 transition-colors group"
                >
                    <span className="text-xs text-gray-500 truncate flex-1 font-mono">{vaultPda}</span>
                    <ExternalLink className="w-3 h-3 text-gray-500 group-hover:text-purple-400 transition-colors" />
                </a>
            )}

            {/* Loading State */}
            {loading && (
                <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
                </div>
            )}

            {/* No Vault State */}
            {!loading && vaultExists === false && (
                <div className="p-4 rounded-xl bg-yellow-500/5 border border-yellow-500/10">
                    <div className="flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm text-yellow-400 font-medium">No vault found</p>
                            <p className="text-xs text-yellow-500/70 mt-1">
                                Bridge tokens from Base to Solana to create your vault
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Vault Data */}
            {!loading && vaultExists && vaultData && (
                <div className="space-y-4">
                    {/* Encrypted Balance Handle */}
                    <div className="p-4 rounded-xl bg-black/20 border border-white/5">
                        <div className="flex items-center gap-2 mb-2">
                            <Lock className="w-4 h-4 text-gray-500" />
                            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Encrypted Handle</span>
                        </div>
                        <p className="text-sm font-mono text-white break-all">
                            {vaultData.encryptedBalanceHandle === BigInt(0)
                                ? <span className="text-gray-600">0 (empty)</span>
                                : vaultData.encryptedBalanceHandle.toString()}
                        </p>
                    </div>

                    {/* Decrypted Balance */}
                    <AnimatePresence>
                        {decryptedBalance !== null && (
                            <motion.div
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                className="p-4 rounded-xl bg-green-500/5 border border-green-500/10"
                            >
                                <div className="flex items-center gap-2 mb-2">
                                    <CheckCircle className="w-4 h-4 text-green-500" />
                                    <span className="text-xs font-medium text-green-500 uppercase tracking-wider">Decrypted Balance</span>
                                </div>
                                <p className="text-2xl font-bold text-green-400">
                                    {(Number(decryptedBalance) / 1e18).toFixed(4)} <span className="text-lg text-green-500/70">cDARK</span>
                                </p>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Decrypt Button */}
                    {vaultData.encryptedBalanceHandle !== BigInt(0) && decryptedBalance === null && (
                        <button
                            onClick={handleDecrypt}
                            disabled={decrypting}
                            className="w-full py-3 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 font-medium hover:bg-purple-500/20 hover:border-purple-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            {decrypting ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    <span>{status || "Decrypting..."}</span>
                                </>
                            ) : (
                                <>
                                    <Eye className="w-4 h-4" />
                                    <span>Decrypt Balance</span>
                                </>
                            )}
                        </button>
                    )}

                    {/* Clear Button */}
                    {decryptedBalance !== null && (
                        <button
                            onClick={() => {
                                setDecryptedBalance(null);
                                setStatus("");
                            }}
                            className="w-full py-2 rounded-xl bg-white/5 border border-white/5 text-gray-400 text-sm font-medium hover:bg-white/10 transition-colors"
                        >
                            Clear & Decrypt Again
                        </button>
                    )}

                    {/* Status */}
                    {status && !decryptedBalance && !decrypting && (
                        <p className="text-sm text-purple-400 text-center">{status}</p>
                    )}
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="mt-4 p-3 rounded-xl bg-red-500/5 border border-red-500/10">
                    <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm text-red-400">{error}</p>
                            {error.includes("Handle expired") && (
                                <p className="text-xs text-red-400/70 mt-2">
                                    Use the Faucet to get cDARK, then bridge to Solana
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </motion.div>
    );
}
