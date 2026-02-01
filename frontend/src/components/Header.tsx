"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAccount } from "wagmi";
import Image from "next/image";
import { MenuDropdown } from "./MenuDropdown";

const SolanaWalletButton = dynamic(
    () => import("./SolanaWalletButton"),
    { ssr: false }
);

export function Header() {
    const { connected: isSolanaConnected } = useWallet();
    const { isConnected: isEvmConnected } = useAccount();

    return (
        <header className="relative z-50 flex items-center justify-between py-3 px-4 md:py-4 md:px-6">
            {/* Logo */}
            <div className="flex items-center gap-2">
                <div className="w-14 h-14 md:w-16 md:h-16 rounded-xl overflow-hidden flex items-center justify-center bg-gradient-to-br from-purple-900/30 to-indigo-900/30 border border-purple-500/20 shadow-lg shadow-purple-500/10">
                    <Image 
                        src="/darklogo.png" 
                        alt="DarkBridge Logo" 
                        width={56} 
                        height={56} 
                        className="object-contain w-[85%] h-[85%] drop-shadow-[0_0_8px_rgba(139,92,246,0.5)]"
                    />
                </div>
                <div>
                    <h1 className="text-xl md:text-2xl font-bold tracking-wider text-white">DARKBRIDGE</h1>
                    <p className="text-[10px] text-gray-500 tracking-[0.2em] uppercase font-medium">Private Cross-Chain</p>
                </div>
            </div>

            {/* Right Side */}
            <div className="flex items-center gap-3">
                {/* EVM Status Pill */}
                {isEvmConnected && (
                    <div className="hidden md:flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/20">
                        <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
                        <span className="text-xs font-semibold text-blue-400 uppercase tracking-wide">Base</span>
                    </div>
                )}

                {/* Solana Status Pill */}
                {isSolanaConnected && (
                    <div className="hidden md:flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/20">
                        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                        <span className="text-xs font-semibold text-green-400 uppercase tracking-wide">Solana</span>
                    </div>
                )}

                {/* Wallet Buttons */}
                <div className="flex items-center gap-2">
                    <div className="[&_button]:!h-10 [&_button]:!px-4 [&_button]:!text-sm [&_button]:!rounded-xl [&_button]:!bg-[#161B22] [&_button]:!border [&_button]:!border-green-500/20 hover:[&_button]:!border-green-500/50 [&_button]:!text-white [&_button]:!font-medium">
                        <SolanaWalletButton />
                    </div>
                    <div className="!h-10">
                        <ConnectButton.Custom>
                            {({
                                account,
                                chain,
                                openAccountModal,
                                openChainModal,
                                openConnectModal,
                                authenticationStatus,
                                mounted,
                            }) => {
                                const ready = mounted && authenticationStatus !== 'loading';
                                const connected =
                                    ready &&
                                    account &&
                                    chain &&
                                    (!authenticationStatus ||
                                        authenticationStatus === 'authenticated');

                                return (
                                    <div
                                        {...(!ready && {
                                            'aria-hidden': true,
                                            'style': {
                                                opacity: 0,
                                                pointerEvents: 'none',
                                                userSelect: 'none',
                                            },
                                        })}
                                    >
                                        {(() => {
                                            if (!connected) {
                                                return (
                                                    <button
                                                        onClick={openConnectModal}
                                                        type="button"
                                                        className="!bg-[#161B22] !h-[40px] !px-4 !text-sm !rounded-xl !border !border-green-500/20 !text-white !font-medium hover:!bg-[#1a201a] hover:!border-green-500/50 transition-all !font-sans"
                                                    >
                                                        Connect EVM Wallet
                                                    </button>
                                                );
                                            }

                                            if (chain.unsupported) {
                                                return (
                                                    <button
                                                        onClick={openChainModal}
                                                        type="button"
                                                        className="!bg-red-500/10 !h-[40px] !px-4 !text-sm !rounded-xl !border !border-red-500/20 !text-red-500 !font-medium hover:!bg-red-500/20 transition-all !font-sans"
                                                    >
                                                        Wrong network
                                                    </button>
                                                );
                                            }

                                            return (
                                                <div style={{ display: 'flex', gap: 12 }}>
                                                    <button
                                                        onClick={openAccountModal}
                                                        type="button"
                                                        className="!bg-[#161B22] !h-[40px] !px-4 !text-sm !rounded-xl !border !border-green-500/20 !text-white !font-medium hover:!bg-[#1a201a] hover:!border-green-500/50 transition-all !font-sans flex items-center gap-2"
                                                    >
                                                        {account.displayName}
                                                    </button>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                );
                            }}
                        </ConnectButton.Custom>
                    </div>
                </div>

                {/* Menu Dropdown (contains Faucet & Vault) */}
                <MenuDropdown />
            </div>
        </header>
    );
}
