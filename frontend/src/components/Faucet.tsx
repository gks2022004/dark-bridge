"use client";

import { useState, useEffect } from "react";
import { useAccount, useChainId, useSwitchChain, useWalletClient, useWaitForTransactionReceipt } from "wagmi";
import { parseAbi, type Hash } from "viem";
import { baseSepolia } from "wagmi/chains";
import { CONFIDENTIAL_TOKEN_ADDRESS, INCO_PEPPER } from "@/lib/constants";
import { motion } from "framer-motion";
import { Droplets, ExternalLink, AlertCircle, CheckCircle, Loader2, Coins } from "lucide-react";

const TOKEN_ABI = parseAbi([
    "function faucetMint(address to, bytes encryptedAmount) external payable",
]);

export function Faucet() {
    const { address, isConnected, isConnecting } = useAccount();
    const chainId = useChainId();
    const { switchChain } = useSwitchChain();
    const { data: walletClient } = useWalletClient();

    const [hash, setHash] = useState<Hash | undefined>();
    const [isPending, setIsPending] = useState(false);
    const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

    const [error, setError] = useState<string | null>(null);
    const [mounted, setMounted] = useState(false);

    // Handle hydration
    useEffect(() => {
        setMounted(true);
    }, []);

    // Check if on correct chain
    const isWrongChain = isConnected && chainId !== baseSepolia.id;

    // Can mint when connected and on correct chain
    const canMint = mounted &&
                    isConnected &&
                    !!address &&
                    !isPending &&
                    !isConfirming &&
                    !isWrongChain;

    const handleSwitchChain = async () => {
        try {
            await switchChain({ chainId: baseSepolia.id });
        } catch (err) {
            console.error("Failed to switch chain:", err);
            setError("Failed to switch chain. Please switch manually in your wallet.");
        }
    };

    const handleMint = async () => {
        if (!address || !walletClient) {
            setError("Wallet not ready. Please try again.");
            return;
        }

        setError(null);
        setHash(undefined);
        setIsPending(true);

        try {
            // Mint 100 tokens (with 18 decimals)
            const mintAmount = BigInt(100) * BigInt(10 ** 18);

            console.log("Minting to:", address);
            console.log("Token contract:", CONFIDENTIAL_TOKEN_ADDRESS);
            console.log("Amount:", mintAmount.toString());

            // Client-side encrypt the amount using Inco zap
            const { Lightning } = await import("@inco/js/lite");
            const { handleTypes, supportedChains } = await import("@inco/js");
            const zap = await Lightning.latest(INCO_PEPPER, supportedChains.baseSepolia);

            console.log("Encrypting amount with Inco...");
            const ciphertext = await zap.encrypt(mintAmount, {
                accountAddress: address,
                dappAddress: CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}`,
                handleType: handleTypes.euint256,
            });

            console.log("Ciphertext ready, sending transaction...");

            // Inco fee for encryption (0.001 ETH)
            const incoFee = BigInt("1000000000000000");

            const txHash = await walletClient.writeContract({
                address: CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}`,
                abi: TOKEN_ABI,
                functionName: "faucetMint",
                args: [address, ciphertext],
                value: incoFee,
                chain: baseSepolia,
            });

            setHash(txHash);
        } catch (err: unknown) {
            console.error("Faucet error:", err);
            let errorMsg = "Transaction failed";
            const e = err as { message?: string; shortMessage?: string };
            if (e.message?.includes("user rejected") || e.message?.includes("User rejected")) {
                errorMsg = "Transaction rejected by user";
            } else if (e.shortMessage) {
                errorMsg = e.shortMessage;
            } else if (e.message) {
                errorMsg = e.message.slice(0, 300);
            }
            setError(errorMsg);
        } finally {
            setIsPending(false);
        }
    };

    // SSR fallback
    if (!mounted) {
        return (
            <div className="glass-card p-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                        <Droplets className="w-5 h-5 text-green-500" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-white">Faucet</h2>
                        <p className="text-sm text-gray-500">Loading...</p>
                    </div>
                </div>
            </div>
        );
    }

    // Not connected state
    if (!isConnected) {
        return (
            <div className="glass-card p-6">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                        <Droplets className="w-5 h-5 text-green-500" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-white">Faucet</h2>
                        <p className="text-sm text-gray-500">Connect EVM wallet for tokens</p>
                    </div>
                </div>
            </div>
        );
    }

    // Wrong chain state
    if (isWrongChain) {
        return (
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-card p-6"
            >
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
                        <AlertCircle className="w-5 h-5 text-yellow-500" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-white">Wrong Network</h2>
                        <p className="text-sm text-yellow-400">Switch to Base Sepolia</p>
                    </div>
                </div>
                <button
                    onClick={handleSwitchChain}
                    className="w-full py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 font-medium hover:bg-yellow-500/20 transition-colors"
                >
                    Switch Network
                </button>
            </motion.div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-card p-6"
        >
            {/* Header */}
            <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                    <Droplets className="w-5 h-5 text-green-500" />
                </div>
                <div>
                    <h2 className="text-lg font-semibold text-white">Faucet</h2>
                    <p className="text-xs text-gray-500">Get test tokens on Base Sepolia</p>
                </div>
            </div>

            {/* Token Amount Display */}
            <div className="flex items-center justify-between p-4 mb-4 rounded-xl bg-black/20 border border-white/5">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-indigo-500 flex items-center justify-center">
                        <Coins className="w-4 h-4 text-white" />
                    </div>
                    <div>
                        <p className="text-lg font-semibold text-white">100 cDARK</p>
                        <p className="text-xs text-gray-500">Confidential Token</p>
                    </div>
                </div>
                <span className="text-xs text-gray-500 uppercase tracking-wider">Free</span>
            </div>

            {/* Mint Button */}
            <button
                onClick={handleMint}
                disabled={!canMint}
                className="w-full py-3 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 font-medium hover:bg-green-500/20 hover:border-green-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
                {isConnecting ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Connecting...</span>
                    </>
                ) : isPending ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Confirm in wallet...</span>
                    </>
                ) : isConfirming ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Minting...</span>
                    </>
                ) : (
                    <>
                        <Droplets className="w-4 h-4" />
                        <span>Get 100 cDARK</span>
                    </>
                )}
            </button>

            {/* Fee Info */}
            <p className="mt-3 text-xs text-gray-500 text-center">
                Requires ~0.001 ETH for gas + Inco fee
            </p>

            {/* Success State */}
            {isSuccess && hash && (
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="mt-4 p-3 rounded-xl bg-green-500/5 border border-green-500/10"
                >
                    <div className="flex items-center gap-2 mb-2">
                        <CheckCircle className="w-4 h-4 text-green-500" />
                        <span className="text-sm font-medium text-green-400">Tokens minted!</span>
                    </div>
                    <a
                        href={`https://sepolia.basescan.org/tx/${hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                    >
                        <span>View on BaseScan</span>
                        <ExternalLink className="w-3 h-3" />
                    </a>
                </motion.div>
            )}

            {/* Error State */}
            {error && (
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="mt-4 p-3 rounded-xl bg-red-500/5 border border-red-500/10"
                >
                    <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <p className="text-sm text-red-400">{error}</p>
                    </div>
                </motion.div>
            )}
        </motion.div>
    );
}
