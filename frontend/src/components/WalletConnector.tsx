"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import dynamic from "next/dynamic";

// Dynamically import Solana wallet button to avoid SSR issues
const SolanaWalletButton = dynamic(
    () => import("./SolanaWalletButton"),
    { ssr: false }
);

export function WalletConnector() {
    return (
        <div className="flex flex-col gap-3">
            {/* EVM Wallet - RainbowKit */}
            <div className="evm-wallet-container">
                <ConnectButton
                    accountStatus="address"
                    chainStatus="icon"
                    showBalance={false}
                />
            </div>

            {/* Solana Wallet */}
            <div className="solana-wallet-container flex justify-end">
                <SolanaWalletButton />
            </div>
        </div>
    );
}