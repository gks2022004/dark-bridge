"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, useWalletClient, usePublicClient } from "wagmi";
import { parseAbi, parseUnits, toHex } from "viem";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
    CONFIDENTIAL_BRIDGE_ADDRESS,
    CONFIDENTIAL_TOKEN_ADDRESS,
    INCO_PEPPER,
} from "@/lib/constants";
import {
    checkVaultExists,
    initializeVault,
    getDefaultTokenMint,
    bridgeConfidentialOutDirect,
    getVaultBalance,
    deriveVaultPda,
} from "@/lib/solana";
import { PublicKey } from "@solana/web3.js";
import { motion, AnimatePresence } from "framer-motion";
import {
    Shield,
    ArrowLeftRight,
    Lock,
    Loader2,
    CheckCircle2
} from "lucide-react";

// ABI for bridge operations
const BRIDGE_ABI = parseAbi([
    "function bridgePrivateToSolana(address localToken, bytes32 toSolana, bytes encryptedAmount) external payable",
    "function getIncoFee() external view returns (uint256)",
    "function getUserNonce(address user) external view returns (uint256)",
]);

// Direction enum
type Direction = "base-to-solana" | "solana-to-base";

// Chain configuration
const CHAINS = {
    base: { id: "base", name: "Base", icon: "https://avatars.githubusercontent.com/u/108554348", color: "#0052FF" },
    solana: { id: "solana", name: "Solana", icon: "https://cryptologos.cc/logos/solana-sol-logo.svg", color: "#14f195" },
};

const DarkSolanaIcon = () => (
    <svg viewBox="0 0 32 32" className="w-full h-full">
        <circle cx="16" cy="16" r="16" fill="#000000" />
        <path d="M10 18.5l2-2h10l-2 2H10zm0-3l2 2h10l-2-2H10zm12-4l-2 2H10l2-2h10z" fill="#22c55e" />
    </svg>
);



export function BridgeForm() {
    const { address: evmAddress, isConnected: isEvmConnected } = useAccount();

    const { data: walletClient } = useWalletClient();
    const publicClient = usePublicClient();
    const { publicKey: solanaPublicKey, connected: isSolanaConnected, signTransaction, sendTransaction } = useWallet();
    const { connection } = useConnection();

    const [direction, setDirection] = useState<Direction>("base-to-solana");
    const [amount, setAmount] = useState("");
    const [loading, setLoading] = useState(false);
    const [txHash, setTxHash] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string>("");
    const [vaultExists, setVaultExists] = useState<boolean | null>(null);
    const [, setCheckingVault] = useState(false);
    const [initializingVault, setInitializingVault] = useState(false);
    const [waitingForRelay, setWaitingForRelay] = useState(false);
    const [, setRelayComplete] = useState(false);
    const [, setRelayTxHash] = useState<string | null>(null);
    const [, setIsSwapping] = useState(false);

    const [rotation, setRotation] = useState(0);

    // Get the token mint (matches remoteToken from EVM contract)
    const getTokenMint = useCallback(() => {
        return getDefaultTokenMint();
    }, []);

    // Check if Solana vault exists when wallet connects
    useEffect(() => {
        if (isSolanaConnected && solanaPublicKey) {
            checkVault();
        } else {
            setVaultExists(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSolanaConnected, solanaPublicKey]);

    const checkVault = async () => {
        if (!solanaPublicKey) return;

        setCheckingVault(true);
        try {
            const tokenMint = getTokenMint();
            const exists = await checkVaultExists(connection, solanaPublicKey, tokenMint);
            setVaultExists(exists);
        } catch (err) {
            console.error("Error checking vault:", err);
            setVaultExists(null);
        } finally {
            setCheckingVault(false);
        }
    };

    // Relayer HTTP endpoint for TX hash lookups
    const RELAYER_API_URL = process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001";

    const pollForRelayCompletion = useCallback(async (
        targetChain: "solana" | "base", 
        startBlockParam: bigint | null, 
        initialValue: bigint | null = null,
        initialSolanaSig: string | null = null,
        sourceTxHash: string | null = null  // Base TX hash for relayer lookup
    ) => {
        if (!publicClient || !evmAddress) return;

        let attempts = 0;
        const maxAttempts = 150; // 5 minutes with faster polling

        // Use passed startBlock or get current block as fallback
        let startBlock: bigint;
        if (startBlockParam !== null) {
            startBlock = startBlockParam;
        } else {
            try {
                startBlock = await publicClient.getBlockNumber();
            } catch {
                startBlock = 0n;
            }
        }
        console.log("Polling from block:", startBlock.toString());

        // Pad address to 32 bytes for topic matching (EVM indexed address format)
        const paddedAddress = ("0x" + evmAddress.slice(2).toLowerCase().padStart(64, "0")) as `0x${string}`;

        const poll = async () => {
            attempts++;

            if (attempts > maxAttempts) {
                setWaitingForRelay(false);
                setStatus("Relay timeout. Check explorer manually.");
                return;
            }

            // Poll every 2 seconds for first 30 attempts, then every 5 seconds
            const pollInterval = attempts < 30 ? 2000 : 5000;

            try {
                if (targetChain === "solana") {
                    // FIRST: Try to get TX hash directly from relayer API
                    if (sourceTxHash) {
                        try {
                            const response = await fetch(`${RELAYER_API_URL}/tx/${sourceTxHash}`);
                            if (response.ok) {
                                const data = await response.json();
                                if (data.solanaTxHash) {
                                    console.log("Got Solana TX from relayer API:", data.solanaTxHash);
                                    setTxHash(data.solanaTxHash);
                                    setRelayTxHash(data.solanaTxHash);
                                    setWaitingForRelay(false);
                                    setRelayComplete(true);
                                    setStatus("Tokens minted on Solana");
                                    return;
                                }
                            }
                        } catch {
                            console.log("Relayer API not available, falling back to blockchain polling");
                        }
                    }

                    // FALLBACK: Check Solana for new transactions on the vault PDA
                    if (!solanaPublicKey || !connection) {
                        setTimeout(poll, pollInterval);
                        return;
                    }

                    const tokenMint = getTokenMint();
                    const [vaultPda] = deriveVaultPda(new PublicKey(solanaPublicKey.toBase58()), tokenMint);
                    
                    // Get recent signatures for the vault - returned NEWEST FIRST
                    const signatures = await connection.getSignaturesForAddress(vaultPda, { limit: 10 });
                    
                    console.log(`Found ${signatures.length} vault signatures, initial was: ${initialSolanaSig?.slice(0, 20)}...`);
                    
                    // Find the FIRST new transaction after the initial one
                    // Signatures are returned NEWEST first, so we need to find the one 
                    // that's right before (newer than) our initialSolanaSig
                    // 
                    // Example: [tx5_newest, tx4, tx3, tx2_initial, tx1_older]
                    // We want tx3 (the first one after initial)
                    let newTx = null;
                    let foundInitial = initialSolanaSig === null; // If no initial, any new one is valid
                    let lastNewSig = null;
                    
                    for (const sig of signatures) {
                        if (initialSolanaSig && sig.signature === initialSolanaSig) {
                            // Found the initial signature, the previous one we saw is our target
                            foundInitial = true;
                            break;
                        }
                        // Track the latest confirmed sig we've seen as we iterate
                        if (sig.confirmationStatus === 'confirmed' || sig.confirmationStatus === 'finalized') {
                            lastNewSig = sig;
                        }
                    }
                    
                    // If we found initial and have a new sig before it, that's our transaction
                    if (foundInitial && lastNewSig) {
                        newTx = lastNewSig;
                        console.log(`Found new tx (first after initial): ${newTx.signature.slice(0, 20)}...`);
                    }

                    // Also check if vault balance changed as a backup
                    const currentHandle = await getVaultBalance(connection, solanaPublicKey, tokenMint);
                    const balanceChanged = currentHandle !== null && initialValue !== null && currentHandle !== initialValue;

                    if (newTx) {
                        console.log("Found new Solana vault transaction:", newTx.signature);
                        setTxHash(newTx.signature);
                        setRelayTxHash(newTx.signature);
                        setWaitingForRelay(false);
                        setRelayComplete(true);
                        setStatus("Tokens minted on Solana");
                    } else if (balanceChanged && lastNewSig) {
                        // Balance changed and we have a new signature
                        console.log("Vault balance changed, using first new signature:", lastNewSig.signature);
                        setTxHash(lastNewSig.signature);
                        setRelayTxHash(lastNewSig.signature);
                        setWaitingForRelay(false);
                        setRelayComplete(true);
                        setStatus("Tokens minted on Solana");
                    } else {
                        setTimeout(poll, pollInterval);
                    }
                } else {
                    // Check Base for ANY log from confidential token contract
                    // No event signature filter - just scan for logs containing our address
                    const currentBlock = await publicClient.getBlockNumber();
                    
                    console.log(`Polling Base: block ${startBlock} to ${currentBlock}`);
                    
                    const logs = await publicClient.getLogs({
                        address: CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}`,
                        fromBlock: startBlock,
                        toBlock: currentBlock,
                    });

                    console.log(`Found ${logs.length} total logs from token contract`);

                    // Find the NEWEST log containing our address (logs are in ascending order, so reverse to find newest first)
                    const matchingLogs = logs.filter(log => 
                        log.topics.some(topic => 
                            topic?.toLowerCase() === paddedAddress.toLowerCase()
                        )
                    );
                    
                    console.log(`Found ${matchingLogs.length} logs matching our address`);
                    
                    // Get the newest matching log (last in the array)
                    const mintLog = matchingLogs.length > 0 ? matchingLogs[matchingLogs.length - 1] : null;

                    if (mintLog && mintLog.transactionHash) {
                        console.log("Found mint log for address:", evmAddress);
                        console.log("Block:", mintLog.blockNumber, "TX:", mintLog.transactionHash);
                        // Update txHash to show the Base destination TX
                        setTxHash(mintLog.transactionHash);
                        setRelayTxHash(mintLog.transactionHash);
                        setWaitingForRelay(false);
                        setRelayComplete(true);
                        setStatus("Tokens minted on Base");
                    } else {
                        setTimeout(poll, pollInterval);
                    }
                }
            } catch (err) {
                console.error("Poll error:", err);
                setTimeout(poll, pollInterval);
            }
        };

        // Start polling immediately (1 second delay to let relayer start)
        setTimeout(poll, 1000);
    }, [publicClient, evmAddress, connection, solanaPublicKey, getTokenMint, RELAYER_API_URL]);

    const handleInitializeVault = async () => {
        if (!solanaPublicKey || !signTransaction) {
            setError("Solana wallet not connected");
            return;
        }

        setInitializingVault(true);
        setError(null);

        try {
            const tokenMint = getTokenMint();
            setStatus("Initializing Solana vault...");

            const signature = await initializeVault(
                connection,
                solanaPublicKey,
                tokenMint,
                signTransaction
            );

            console.log("Vault initialized:", signature);
            setVaultExists(true);
            setStatus("Vault initialized successfully!");

            // Clear status after 3 seconds
            setTimeout(() => setStatus(""), 3000);
        } catch (err: unknown) {
            const error = err as Error & { message?: string };
            console.error("Vault init error:", error);
            let errorMsg = "Failed to initialize vault";
            if (error.message?.includes("already exists") || error.message?.includes("already in use")) {
                setVaultExists(true);
                errorMsg = "Vault already exists";
            } else if (error.message?.includes("insufficient")) {
                errorMsg = "Insufficient SOL for rent. Get devnet SOL from faucet.";
            } else if (error.message) {
                errorMsg = error.message.slice(0, 100);
            }
            setError(errorMsg);
        } finally {
            setInitializingVault(false);
        }
    };

    const handleBridge = async () => {
        if (!walletClient || !evmAddress || !publicClient) {
            setError("EVM wallet not connected");
            return;
        }

        if (direction === "base-to-solana" && !solanaPublicKey) {
            setError("Please connect your Solana wallet to receive tokens");
            return;
        }

        if (!amount || parseFloat(amount) <= 0) {
            setError("Please enter a valid amount");
            return;
        }

        // Auto-initialize vault if needed
        if (direction === "base-to-solana" && vaultExists === false && signTransaction) {
            setLoading(true);
            setError(null);
            try {
                await handleInitializeVault();
                // Re-check vault status
                await checkVault();
            } catch {
                setLoading(false);
                return;
            }
        }

        setLoading(true);
        setError(null);
        setTxHash(null);
        setStatus("");
        setWaitingForRelay(false);
        setRelayComplete(false);
        setRelayTxHash(null);

        try {
            if (direction === "base-to-solana") {
                await bridgeBaseToSolana();
            } else {
                await bridgeSolanaToBase();
            }
        } catch (err: unknown) {
            const error = err as Error & { message?: string; shortMessage?: string };
            console.error("Bridge error:", error);
            let errorMsg = "Transaction failed";
            if (error.message?.includes("insufficient funds")) {
                errorMsg = "Insufficient ETH for gas + Inco fee";
            } else if (error.message?.includes("user rejected")) {
                errorMsg = "Transaction rejected";
            } else if (error.shortMessage) {
                errorMsg = error.shortMessage;
            } else if (error.message) {
                errorMsg = error.message.slice(0, 150);
            }
            setError(errorMsg);
        } finally {
            setLoading(false);
        }
    };

    const bridgeBaseToSolana = async () => {
        if (!walletClient || !evmAddress || !publicClient || !solanaPublicKey) return;

        // Step 0: Capture initial Solana Vault balance
        let initialHandle: bigint | null = null;
        const tokenMint = getTokenMint();
        try {
            initialHandle = await getVaultBalance(connection, solanaPublicKey, tokenMint);
            console.log("Initial Solana Vault Handle:", initialHandle);
        } catch (e) {
            console.warn("Could not get initial vault balance (maybe vault not created yet):", e);
        }

        // Step 1: Parse amount and encrypt client-side using Inco SDK
        const amountWei = parseUnits(amount, 18);

        setStatus("Encrypting amount...");
        const { Lightning } = await import("@inco/js/lite");
        const { supportedChains, handleTypes } = await import("@inco/js");
        const zap = await Lightning.latest(INCO_PEPPER, supportedChains.baseSepolia);

        // Encrypt the amount client-side — bound to user's address for Inco validation
        const encryptedAmount = await zap.encrypt(amountWei, {
            accountAddress: evmAddress,
            dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS as `0x${string}`,
            handleType: handleTypes.euint256,
        });

        // Normalize encrypted amount to hex string
        let encryptedHex: `0x${string}`;
        if (typeof encryptedAmount === 'string') {
            encryptedHex = (encryptedAmount.startsWith('0x')
                ? encryptedAmount
                : `0x${encryptedAmount}`) as `0x${string}`;
        } else if (typeof encryptedAmount === 'object' && encryptedAmount !== null && 'length' in encryptedAmount) {
            encryptedHex = `0x${Buffer.from(encryptedAmount as Uint8Array).toString('hex')}` as `0x${string}`;
        } else {
            encryptedHex = encryptedAmount as `0x${string}`;
        }

        // Step 2: Convert Solana pubkey to bytes32
        const solanaPubkeyBytes = solanaPublicKey.toBytes();
        const solanaBytes32 = toHex(solanaPubkeyBytes, { size: 32 });

        // Capture the latest signature for the vault PDA RIGHT BEFORE sending TX
        let initialSolanaSig: string | null = null;
        try {
            const [vaultPda] = deriveVaultPda(new PublicKey(solanaPublicKey.toBase58()), tokenMint);
            const sigs = await connection.getSignaturesForAddress(vaultPda, { limit: 1 });
            if (sigs.length > 0) {
                initialSolanaSig = sigs[0].signature;
                console.log("Initial vault signature (captured right before bridge):", initialSolanaSig);
            }
        } catch (e) {
            console.warn("Could not get initial vault signature:", e);
        }

        // Step 3: Get user's nonce from the ConfidentialBridge contract
        setStatus("Getting nonce...");
        const senderNonce = await publicClient.readContract({
            address: CONFIDENTIAL_BRIDGE_ADDRESS as `0x${string}`,
            abi: BRIDGE_ABI,
            functionName: "getUserNonce",
            args: [evmAddress],
        });
        console.log("User nonce:", senderNonce.toString());

        // Step 4: Set deadline (5 minutes from now)
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

        // Step 5: Sign the message off-chain using personal_sign
        // The contract verifies: keccak256("\x19Ethereum Signed Message:\n32", keccak256(abi.encodePacked(localToken, toSolana, encryptedAmount, senderNonce, deadline)))
        setStatus("Signing private bridge request...");
        const { keccak256: keccak256Hash, encodePacked, toBytes: viemToBytes } = await import("viem");

        const innerHash = keccak256Hash(
            encodePacked(
                ["address", "bytes32", "bytes", "uint256", "uint256"],
                [
                    CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}`,
                    solanaBytes32 as `0x${string}`,
                    encryptedHex,
                    senderNonce,
                    deadline,
                ]
            )
        );

        // personal_sign will prefix with "\x19Ethereum Signed Message:\n32" automatically
        const signature = await walletClient.signMessage({
            message: { raw: viemToBytes(innerHash) },
        });
        console.log("Signed message, signature:", signature.slice(0, 20) + "...");

        // Step 6: Send to relayer API — relayer calls bridgePrivateToSolanaViaRelayer
        // The user's address is NOT the tx.from — only the relayer appears as sender
        setStatus("Submitting via relayer (sender privacy)...");
        const relayPayload = {
            localToken: CONFIDENTIAL_TOKEN_ADDRESS,
            toSolana: solanaBytes32,
            encryptedAmount: encryptedHex,
            sender: evmAddress,
            senderNonce: senderNonce.toString(),
            deadline: deadline.toString(),
            signature: signature,
            plaintextAmount: amountWei.toString(),
        };

        console.log("Posting to relayer /relay-bridge-to-solana:", { ...relayPayload, encryptedAmount: relayPayload.encryptedAmount.slice(0, 20) + "..." });
        const relayResponse = await fetch(`${RELAYER_API_URL}/relay-bridge-to-solana`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(relayPayload),
        });
        const relayData = await relayResponse.json();
        console.log("Relayer response:", relayData);

        if (!relayResponse.ok) {
            throw new Error(relayData.error || "Relayer failed to submit bridge transaction");
        }

        const baseTxHash = relayData.baseTxHash as string;
        console.log("Base TX (via relayer):", baseTxHash);
        // Don't set txHash to Base TX — we want to show the Solana destination TX

        // Step 7: Wait for Solana relay
        // The relayer also forwards the plaintext to Solana
        if (relayData.solanaTxHash) {
            console.log("Relay completed! Solana TX:", relayData.solanaTxHash);
            setTxHash(relayData.solanaTxHash);
            setRelayTxHash(relayData.solanaTxHash);
            setRelayComplete(true);
            setStatus("Tokens minted on Solana");
            return;
        }

        setStatus("Bridge submitted — waiting for Solana relay...");
        setWaitingForRelay(true);

        // Poll for relay completion - pass Base TX hash for direct relayer lookup
        const startBlock = await publicClient.getBlockNumber();
        pollForRelayCompletion("solana", startBlock, initialHandle, initialSolanaSig, baseTxHash);
    };

    const bridgeSolanaToBase = async () => {
        if (!solanaPublicKey || !sendTransaction || !evmAddress || !publicClient) {
            setError("Please connect both wallets");
            return;
        }

        // Step 0: Capture initial Base Token Balance
        let initialBalance: bigint | null = null;
        try {
            initialBalance = await publicClient.readContract({
                address: CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}`,
                abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
                functionName: "balanceOf",
                args: [evmAddress],
            });
            console.log("Initial Base Balance:", initialBalance.toString());
        } catch (e) {
            console.warn("Could not get initial base balance:", e);
        }

        const tokenMint = getTokenMint();

        // Step 1: Parse amount
        const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1e18));
        console.log("Amount to bridge:", amountBigInt.toString());

        // IMPORTANT: Capture Base block RIGHT BEFORE sending Solana TX
        let startBlock: bigint | null = null;
        try {
            startBlock = await publicClient.getBlockNumber();
            console.log("Captured start block RIGHT BEFORE Solana TX:", startBlock.toString());
        } catch (e) {
            console.warn("Could not get block number:", e);
        }

        // Step 2: Build and send bridge_confidential_out transaction directly
        // The user signs a real Solana transaction (amounts stay encrypted on-chain)
        setStatus("Signing bridge transaction...");
        const result = await bridgeConfidentialOutDirect(
            connection,
            solanaPublicKey,
            tokenMint,
            evmAddress,
            amountBigInt,
            sendTransaction,
        );

        const solanaTxSig = result.solanaTxHash;
        console.log("Solana TX signature (via relayer):", solanaTxSig);
        // Don't set txHash to Solana TX — we want to show the Base destination TX

        // Step 3: Now the relayer has already submitted the Solana TX.
        // We need to relay the plaintext to Base via /relay-to-base.
        // The relayer endpoint /relay-bridge-out returns solanaTxHash after confirmation.
        setStatus("Sending to relayer for Base minting...");
        const relayPayload = {
            solanaTxHash: solanaTxSig,
            plaintextAmount: amountBigInt.toString(),
            destinationEvm: evmAddress,
            localToken: CONFIDENTIAL_TOKEN_ADDRESS,
        };

        console.log("Posting to relayer /relay-to-base:", relayPayload);
        try {
            const relayResponse = await fetch(`${RELAYER_API_URL}/relay-to-base`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(relayPayload),
            });
            const relayData = await relayResponse.json();
            console.log("Relayer response:", relayData);

            if (relayResponse.ok && relayData.txHash) {
                console.log("Relay completed! Base TX:", relayData.txHash);
                setTxHash(relayData.txHash);
                setRelayTxHash(relayData.txHash);
                setRelayComplete(true);
                setStatus("Tokens minted on Base");
                return;
            }

            if (!relayResponse.ok) {
                console.warn("Relayer returned error:", relayData.error);
            }
        } catch (relayError) {
            console.warn("Could not reach relayer API (will poll for completion):", relayError);
        }

        setStatus("Bridge submitted — waiting for Base mint...");
        setWaitingForRelay(true);

        // Poll for relay completion - pass the startBlock we captured before sending
        pollForRelayCompletion("base", startBlock, initialBalance);
    };

    // Check if both wallets are connected (required for both directions)
    const canBridge = isEvmConnected && isSolanaConnected;

    if (!isEvmConnected) {
        return (
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-card p-8 text-center max-w-md mx-auto"
            >
                <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-green-500/20 to-green-600/10 border border-green-500/20 flex items-center justify-center">
                    <Shield className="w-10 h-10 text-green-500" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Connect Wallet</h2>
                <p className="text-gray-400 mb-6">
                    Connect your SVM and EVM wallet to access the private cross-chain bridge powered by Inco TEE.
                </p>
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/20">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-sm text-green-400">Waiting for connection...</span>
                </div>
            </motion.div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-lg mx-auto"
        >
            {/* Top Badges */}


            {/* Main Card */}
            <div className="glass-card p-0 md:p-1">
                <div className="glass-card-inner p-4 md:p-6 space-y-4">

                    {/* Chain Selector */}
                    {/* Chain Selector */}
                    {/* Chain Selector */}
                    <div className="chain-selector p-1.5 bg-[#0B0E14] rounded-3xl border border-white/5">
                        <div className="flex flex-col md:grid md:grid-cols-[1fr,auto,1fr] items-center gap-1">
                            {/* From Chain */}
                            <motion.div
                                className="relative p-3 md:p-4 rounded-2xl bg-[#161B22] w-full h-20 md:h-24 flex flex-row items-center gap-4 transition-colors hover:bg-[#1a201a]"
                                whileHover={{ scale: 1.01 }}
                                whileTap={{ scale: 0.99 }}
                            >
                                <div className={`w-12 h-12 rounded-xl overflow-hidden shadow-lg ${direction === "base-to-solana" ? "shadow-blue-900/20" : "shadow-purple-900/20"} bg-[#1c2128] flex items-center justify-center border border-white/5`}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={direction === "base-to-solana" ? CHAINS.base.icon : CHAINS.solana.icon}
                                        alt="From Chain"
                                        className="w-8 h-8 object-contain"
                                    />
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-0.5">FROM</span>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl font-bold text-white tracking-wide">
                                            {direction === "base-to-solana" ? CHAINS.base.name : CHAINS.solana.name}
                                        </span>
                                    </div>
                                </div>
                            </motion.div>

                            {/* Swap Button */}
                            <div className="relative z-10 -my-3 md:-my-0 md:-mx-5 h-full flex items-center justify-center">
                                <motion.button
                                    onClick={() => {
                                        setIsSwapping(true);
                                        setDirection(d => d === "base-to-solana" ? "solana-to-base" : "base-to-solana");
                                        setRotation(prev => prev + 180 + (Math.floor(Math.random() * 3) + 1) * 360);
                                        setTimeout(() => setIsSwapping(false), 500);
                                    }}
                                    className="w-10 h-10 rounded-full bg-[#1c2128] border border-white/10 flex items-center justify-center hover:border-green-500/50 hover:bg-[#252a25] transition-all shadow-xl z-20"
                                    animate={{ rotate: rotation }}
                                    whileHover={{ scale: 1.1 }}
                                    whileTap={{ scale: 0.9 }}
                                    transition={{ duration: 0.4, ease: "circOut" }}
                                >
                                    <ArrowLeftRight className="w-4 h-4 text-green-500" />
                                </motion.button>
                            </div>

                            {/* To Chain */}
                            <motion.div
                                className="relative p-3 md:p-4 rounded-2xl bg-[#161B22] w-full h-20 md:h-24 flex flex-row-reverse items-center gap-4 text-right transition-colors hover:bg-[#1a201a]"
                                whileHover={{ scale: 1.01 }}
                                whileTap={{ scale: 0.99 }}
                            >
                                <div className={`w-12 h-12 rounded-xl overflow-hidden shadow-lg ${direction === "base-to-solana" ? "shadow-purple-900/20" : "shadow-blue-900/20"} bg-[#1c2128] flex items-center justify-center border border-white/5`}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={direction === "base-to-solana" ? CHAINS.solana.icon : CHAINS.base.icon}
                                        alt="To Chain"
                                        className="w-8 h-8 object-contain"
                                    />
                                </div>
                                <div className="flex flex-col items-end">
                                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-0.5">TO</span>
                                    <div className="flex items-center gap-2 flex-row-reverse">
                                        <span className="text-xl font-bold text-white tracking-wide">
                                            {direction === "base-to-solana" ? CHAINS.solana.name : CHAINS.base.name}
                                        </span>
                                        {/* No chevron on TO side usually, or keep it consistent? Image shows icon on right for TO side. */}
                                    </div>
                                </div>
                            </motion.div>
                        </div>
                    </div>

                    {/* Amount Input */}
                    <div className="input-dark p-4 md:p-5">
                        <div className="flex items-center justify-between">
                            <input
                                type="number"
                                min="0"
                                value={amount}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    if (val === "" || parseFloat(val) >= 0) {
                                        setAmount(val);
                                    }
                                }}
                                placeholder="0"
                                className="w-full bg-transparent text-3xl md:text-4xl font-light text-white placeholder-gray-700 focus:outline-none"
                            />
                            <div className="token-badge flex items-center gap-2 shrink-0">
                                <div className="w-6 h-6 rounded-full overflow-hidden">
                                    <DarkSolanaIcon />
                                </div>
                                <span className="font-semibold text-white">cDARK</span>
                            </div>
                        </div>

                    </div>

                    {/* Info Box */}
                    <div className="info-box flex items-start gap-3">
                        <Lock className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                        <div className="text-sm text-green-500/80 leading-relaxed">
                            {error ? (
                                <span className="text-red-400">{error}</span>
                            ) : status ? (
                                <span>{status}</span>
                            ) : waitingForRelay ? (
                                <span>Waiting for relayer to complete cross-chain transfer...</span>
                            ) : (
                                <span>Transaction encrypted via INCO Network. Amount and addresses hidden from validators.</span>
                            )}
                        </div>
                    </div>

                    {/* TX Hash - Show after relay completes with destination chain TX */}
                    {txHash && !waitingForRelay && !loading && (
                        <motion.div 
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="bg-gradient-to-r from-green-500/10 to-green-600/5 border border-green-500/20 rounded-2xl p-4"
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-green-500/20 flex items-center justify-center">
                                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-400 uppercase tracking-wider">
                                            {direction === "base-to-solana" ? "Solana Transaction" : "Base Transaction"}
                                        </p>
                                        <p className="text-sm font-mono text-white mt-0.5">
                                            {txHash.slice(0, 16)}...{txHash.slice(-12)}
                                        </p>
                                    </div>
                                </div>
                                <a
                                    href={
                                        txHash.startsWith("0x")
                                            ? `https://sepolia.basescan.org/tx/${txHash}`
                                            : `https://explorer.solana.com/tx/${txHash}?cluster=devnet`
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/20 hover:bg-green-500/30 border border-green-500/30 text-green-400 text-sm font-medium transition-all hover:scale-105"
                                >
                                    View
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                </a>
                            </div>
                        </motion.div>
                    )}

                    {/* Initialize Vault Button (if needed) */}
                    <AnimatePresence>
                        {direction === "base-to-solana" && isSolanaConnected && vaultExists === false && (
                            <motion.button
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                onClick={handleInitializeVault}
                                disabled={initializingVault}
                                className="w-full py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 font-medium text-sm uppercase tracking-wider hover:bg-yellow-500/20 transition-colors disabled:opacity-50"
                            >
                                {initializingVault ? (
                                    <span className="flex items-center justify-center gap-2">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Initializing...
                                    </span>
                                ) : (
                                    "Initialize Solana Vault"
                                )}
                            </motion.button>
                        )}
                    </AnimatePresence>

                    {/* Main Action Button */}
                    <motion.button
                        onClick={handleBridge}
                        disabled={loading || !canBridge || !amount || initializingVault || waitingForRelay}
                        className="w-full py-4 rounded-2xl bg-[#0B0E14] border border-white/5 text-white font-medium text-lg tracking-wide relative overflow-hidden group disabled:opacity-50 disabled:cursor-not-allowed"
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.99 }}
                    >
                        {/* Shimmer effect on hover */}
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />

                        <span className="relative z-10 flex items-center justify-center gap-2">
                            {status === 'success' ? (
                                <>
                                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                                    <span className="text-green-500">Bridge Complete</span>
                                </>
                            ) : loading ? (
                                <>
                                    <Loader2 className="w-5 h-5 animate-spin text-green-500" />
                                    <span className="text-green-500 animate-pulse">Running TEE Encrypted Transaction...</span>
                                </>
                            ) : waitingForRelay ? (
                                <>
                                    <Loader2 className="w-5 h-5 animate-spin text-green-500" />
                                    <span className="text-green-500 animate-pulse">Relaying Privately...</span>
                                </>
                            ) : error ? (
                                error
                            ) : (!amount || parseFloat(amount) <= 0) ? (
                                <>
                                    <Shield className="w-5 h-5 text-gray-500" />
                                    <span className="text-gray-500">Enter Amount</span>
                                </>
                            ) : !canBridge ? (
                                "Connect Wallets"
                            ) : (
                                <>
                                    <motion.div
                                        animate={{
                                            scale: [1, 1.1, 1],
                                            filter: ["drop-shadow(0 0 0px #22c55e)", "drop-shadow(0 0 8px #22c55e)", "drop-shadow(0 0 0px #22c55e)"]
                                        }}
                                        transition={{ duration: 2, repeat: Infinity }}
                                        className="relative"
                                    >
                                        <Lock className="w-5 h-5 text-green-500" />
                                    </motion.div>
                                    <span className="text-green-500 font-bold group-hover:text-green-400 transition-colors uppercase tracking-widest text-sm">
                                        Bridge Privately via Inco
                                    </span>
                                </>
                            )}
                        </span>
                    </motion.button>
                </div>
            </div>


        </motion.div>
    );
}
