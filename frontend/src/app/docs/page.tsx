"use client";

import { Header } from "@/components/Header";
import BackgroundCanvas from "@/components/BackgroundCanvas";
import {
    Shield,
    ArrowRight,
    Droplets,
    Vault,
    Lock,
    Eye,
    ArrowLeftRight
} from "lucide-react";
import Link from "next/link";

export default function DocsPage() {
    return (
        <main className="min-h-screen relative overflow-hidden bg-[#0B0E14] text-white selection:bg-green-500/30">
            {/* Animated Background */}
            <BackgroundCanvas />

            {/* Content */}
            <div className="relative z-10 min-h-screen flex flex-col">
                <Header />

                <div className="flex-1 max-w-4xl mx-auto w-full px-4 py-8 md:py-12">
                    {/* Hero Section */}
                    <div className="mb-12 text-center">
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 mb-4">
                            <Shield className="w-4 h-4 text-green-500" />
                            <span className="text-xs font-medium text-green-400">INCO CONFIDENTIALITY LAYER</span>
                        </div>
                        <h1 className="text-3xl md:text-5xl font-bold mb-4 tracking-tight">
                            How to use <span className="text-transparent bg-clip-text bg-gradient-to-r from-green-400 to-emerald-600">DarkBridge</span>
                        </h1>
                        <p className="text-gray-400 max-w-2xl mx-auto text-lg">
                            A complete guide to bridging assets privately between Base and Solana using Inco&apos;s Trusted Execution Environment (TEE).
                        </p>
                    </div>

                    {/* Step 1: Getting Started */}
                    <section className="mb-12 relative group">
                        <div className="absolute -inset-4 bg-gradient-to-r from-green-500/5 to-transparent rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="relative">
                            <div className="flex items-center gap-4 mb-6">
                                <div className="w-10 h-10 rounded-xl bg-[#161B22] border border-white/10 flex items-center justify-center font-bold text-xl text-green-500">
                                    1
                                </div>
                                <h2 className="text-2xl font-bold">Getting Started</h2>
                            </div>

                            <div className="glass-card p-6 md:p-8 space-y-6">
                                <div>
                                    <h3 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
                                        <Droplets className="w-5 h-5 text-blue-400" />
                                        Get Test Tokens (Faucet)
                                    </h3>
                                    <p className="text-gray-400 mb-4 text-sm leading-relaxed">
                                        Before bridging, you need test tokens. Use the built-in faucet to mint cDARK tokens on Base Sepolia.
                                    </p>
                                    <div className="bg-black/30 rounded-lg p-4 border border-white/5">
                                        <ol className="list-decimal list-inside space-y-2 text-sm text-gray-300">
                                            <li>Click the <span className="text-white font-semibold">Menu</span> button in the top right.</li>
                                            <li>Locate the <span className="text-white font-semibold">Token Faucet</span> section.</li>
                                            <li>Click <span className="text-white font-semibold">&quot;Drip 1000 Tokens&quot;</span> to mint cDARK to your connected EVM wallet.</li>
                                        </ol>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Step 2: Bridging Base to Solana */}
                    <section className="mb-12 relative group">
                        <div className="absolute -inset-4 bg-gradient-to-r from-green-500/5 to-transparent rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="relative">
                            <div className="flex items-center gap-4 mb-6">
                                <div className="w-10 h-10 rounded-xl bg-[#161B22] border border-white/10 flex items-center justify-center font-bold text-xl text-green-500">
                                    2
                                </div>
                                <h2 className="text-2xl font-bold">Bridge from Base to Solana</h2>
                            </div>

                            <div className="glass-card p-6 md:p-8 space-y-8">
                                {/* Substep: Init Vault */}
                                <div>
                                    <h3 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
                                        <Vault className="w-5 h-5 text-yellow-500" />
                                        Initialize Solana Vault
                                    </h3>
                                    <p className="text-gray-400 mb-4 text-sm">
                                        First-time users must initialize a secure token account (Vault) on Solana to receive private assets.
                                    </p>
                                    <ul className="list-disc list-inside space-y-2 text-sm text-gray-300 ml-2">
                                        <li>Connect both your <span className="text-blue-400">Base</span> and <span className="text-green-400">Solana</span> wallets.</li>
                                        <li>If a vault is missing, an <span className="text-yellow-500">Initialize Vault</span> button will appear automatically.</li>
                                        <li>Click it and approve the Solana transaction to create your encrypted token store.</li>
                                    </ul>
                                </div>

                                <div className="h-px bg-white/5" />

                                {/* Substep: Bridge */}
                                <div>
                                    <h3 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
                                        <ArrowLeftRight className="w-5 h-5 text-purple-500" />
                                        Bridge Assets
                                    </h3>
                                    <p className="text-gray-400 mb-4 text-sm">
                                        Send tokens securely. The amount is encrypted the moment it leaves your wallet.
                                    </p>
                                    <div className="bg-black/30 rounded-lg p-4 border border-white/5">
                                        <ol className="list-decimal list-inside space-y-2 text-sm text-gray-300">
                                            <li>Enter the amount of cDARK to bridge.</li>
                                            <li>Click <span className="text-white font-semibold">&quot;Bridge Privately via Inco&quot;</span>.</li>
                                            <li>The transaction sends your tokens to the Inco Hyperlane gateway.</li>
                                            <li>Wait for the <span className="text-green-400">&quot;Relaying Privately...&quot;</span> status to complete.</li>
                                        </ol>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Step 3: Verify & Decrypt */}
                    <section className="mb-12 relative group">
                        <div className="absolute -inset-4 bg-gradient-to-r from-green-500/5 to-transparent rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="relative">
                            <div className="flex items-center gap-4 mb-6">
                                <div className="w-10 h-10 rounded-xl bg-[#161B22] border border-white/10 flex items-center justify-center font-bold text-xl text-green-500">
                                    3
                                </div>
                                <h2 className="text-2xl font-bold">Check Balance (Attested Decrypt)</h2>
                            </div>

                            <div className="glass-card p-6 md:p-8">
                                <h3 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
                                    <Eye className="w-5 h-5 text-green-400" />
                                    View Private Balance
                                </h3>
                                <p className="text-gray-400 mb-4 text-sm">
                                    Your balance on Solana is <strong>encrypted</strong> on-chain. To view it, you must perform an Attested Decrypt.
                                </p>
                                <div className="grid md:grid-cols-2 gap-4">
                                    <div className="bg-[#161B22] p-4 rounded-xl border border-white/5">
                                        <h4 className="font-medium text-white mb-2">How to Check:</h4>
                                        <ol className="list-decimal list-inside space-y-2 text-sm text-gray-300">
                                            <li>Open the <strong>Menu</strong> (top right).</li>
                                            <li>Look for the <strong>Solana Vault</strong> section.</li>
                                            <li>Click the <Eye className="w-3 h-3 inline mx-1" /> icon next to &quot;Encrypted Balance&quot;.</li>
                                            <li>Sign the signature request (this proves ownership).</li>
                                            <li>Your real balance will be revealed securely.</li>
                                        </ol>
                                    </div>
                                    <div className="bg-[#161B22] p-4 rounded-xl border border-white/5 flex flex-col justify-center">
                                        <div className="flex items-center justify-center gap-3 mb-2">
                                            <Lock className="w-6 h-6 text-gray-500" />
                                            <ArrowRight className="w-4 h-4 text-gray-600" />
                                            <Eye className="w-6 h-6 text-green-500" />
                                        </div>
                                        <p className="text-xs text-center text-gray-400">
                                            Balances remain hidden on the blockchain until you explicitly request to view them.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Step 4: Bridge Back */}
                    <section className="mb-12 relative group">
                        <div className="absolute -inset-4 bg-gradient-to-r from-green-500/5 to-transparent rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="relative">
                            <div className="flex items-center gap-4 mb-6">
                                <div className="w-10 h-10 rounded-xl bg-[#161B22] border border-white/10 flex items-center justify-center font-bold text-xl text-green-500">
                                    4
                                </div>
                                <h2 className="text-2xl font-bold">Bridge Back (Solana to Base)</h2>
                            </div>

                            <div className="glass-card p-6 md:p-8">
                                <p className="text-gray-400 mb-4 text-sm">
                                    The process works in reverse. Use the <ArrowLeftRight className="w-3 h-3 inline mx-1" /> swap button to switch direction.
                                </p>
                                <ul className="list-disc list-inside space-y-2 text-sm text-gray-300 ml-2">
                                    <li>Switch direction to <strong>Solana → Base</strong>.</li>
                                    <li>Enter amount (ensure you&apos;ve checked your balance first!).</li>
                                    <li>Click <strong>Bridge</strong>.</li>
                                    <li>Once confirmed on Base, the tokens will appear in your EVM wallet as standard ERC-20 cDARK tokens.</li>
                                </ul>
                            </div>
                        </div>
                    </section>

                    {/* CTA */}
                    <div className="text-center pt-8">
                        <Link href="/" className="inline-flex items-center gap-2 px-8 py-3 rounded-xl bg-green-500 hover:bg-green-400 text-black font-bold transition-all transform hover:scale-105">
                            <ArrowLeftRight className="w-5 h-5" />
                            Start Bridging
                        </Link>
                    </div>

                </div>
            </div>
        </main>
    );
}
