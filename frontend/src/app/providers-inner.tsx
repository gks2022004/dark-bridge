"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { wagmiConfig } from "@/lib/evm";
import { useState, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { SOLANA_RPC_URL } from "@/lib/constants";

// Required CSS for wallet adapters
import "@solana/wallet-adapter-react-ui/styles.css";
import "@rainbow-me/rainbowkit/styles.css";

export function ProvidersInner({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(() => new QueryClient());

    // Explicitly include popular Solana wallets for better detection reliability
    const wallets = useMemo(
        () => [
            new PhantomWalletAdapter(),
            new SolflareWalletAdapter(),
        ],
        []
    );

    return (
        <ConnectionProvider endpoint={SOLANA_RPC_URL}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <WagmiProvider config={wagmiConfig}>
                        <QueryClientProvider client={queryClient}>
                            <RainbowKitProvider>
                                {children}
                            </RainbowKitProvider>
                        </QueryClientProvider>
                    </WagmiProvider>
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}
