"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export default function SolanaWalletButton() {
    const { publicKey } = useWallet();
    const base58 = publicKey?.toBase58();
    const content = base58 ? base58.slice(0, 4) + '..' + base58.slice(-4) : 'Connect SVM Wallet';

    return (
        <WalletMultiButton className="!bg-[#161B22] !h-[40px] !px-4 !text-sm !rounded-xl !border !border-green-500/20 !text-white !font-medium hover:!bg-[#1a201a] hover:!border-green-500/50 transition-all !font-sans">
            {content}
        </WalletMultiButton>
    );
}
