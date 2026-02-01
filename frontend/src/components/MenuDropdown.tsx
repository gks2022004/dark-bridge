"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X, Droplets, Vault, Github, FileText, Settings } from "lucide-react";
import { Faucet } from "./Faucet";
import { VaultBalance } from "./VaultBalance";

export function MenuDropdown() {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Close on escape key
    useEffect(() => {
        function handleEscape(event: KeyboardEvent) {
            if (event.key === "Escape") {
                setIsOpen(false);
            }
        }

        document.addEventListener("keydown", handleEscape);
        return () => document.removeEventListener("keydown", handleEscape);
    }, []);

    return (
        <div ref={dropdownRef} className="relative">
            {/* Menu Button */}
            <motion.button
                onClick={() => setIsOpen(!isOpen)}
                className="w-10 h-10 rounded-xl bg-[#141914] border border-white/10 flex items-center justify-center hover:border-green-500/30 transition-colors"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
            >
                <AnimatePresence mode="wait">
                    {isOpen ? (
                        <motion.div
                            key="close"
                            initial={{ rotate: -90, opacity: 0 }}
                            animate={{ rotate: 0, opacity: 1 }}
                            exit={{ rotate: 90, opacity: 0 }}
                            transition={{ duration: 0.15 }}
                        >
                            <X className="w-5 h-5 text-green-400" />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="menu"
                            initial={{ rotate: 90, opacity: 0 }}
                            animate={{ rotate: 0, opacity: 1 }}
                            exit={{ rotate: -90, opacity: 0 }}
                            transition={{ duration: 0.15 }}
                        >
                            <Menu className="w-5 h-5 text-gray-400" />
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.button>

            {/* Dropdown Panel */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: -10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -10, scale: 0.95 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="absolute right-0 top-14 w-[calc(100vw-32px)] md:w-[380px] max-h-[80vh] overflow-auto z-50"
                    >
                        {/* Dropdown Container */}
                        <div className="glass-card p-1 shadow-2xl shadow-black/50">
                            <div className="glass-card-inner p-4 space-y-4">
                                {/* Header */}
                                <div className="flex items-center justify-between pb-3 border-b border-white/5">
                                    <div className="flex items-center gap-2">
                                        <Settings className="w-4 h-4 text-green-500" />
                                        <span className="text-sm font-semibold text-white">Tools & Settings</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                        <span className="text-[10px] text-green-400 uppercase tracking-wider">Active</span>
                                    </div>
                                </div>

                                {/* Quick Links */}
                                {/* Quick Links */}
                                <div className="grid grid-cols-2 gap-2">
                                    <a
                                        href="https://github.com/gks2022004/dark-bridge"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="quick-link-btn"
                                    >
                                        <Github className="w-4 h-4" />
                                        <span>GitHub</span>
                                    </a>
                                    <Link
                                        href="/docs"
                                        className="quick-link-btn"
                                    >
                                        <FileText className="w-4 h-4" />
                                        <span>Docs</span>
                                    </Link>
                                </div>

                                {/* Divider with Label */}
                                <div className="flex items-center gap-3 pt-2">
                                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                                    <span className="text-[10px] text-gray-500 uppercase tracking-widest">Wallet Tools</span>
                                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                                </div>

                                {/* Section: Solana Vault */}
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 px-1">
                                        <Vault className="w-3.5 h-3.5 text-purple-400" />
                                        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Solana Vault</span>
                                    </div>
                                    <div className="dropdown-section">
                                        <VaultBalance />
                                    </div>
                                </div>

                                {/* Section: Faucet */}
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 px-1">
                                        <Droplets className="w-3.5 h-3.5 text-green-400" />
                                        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Token Faucet</span>
                                    </div>
                                    <div className="dropdown-section">
                                        <Faucet />
                                    </div>
                                </div>

                                {/* Footer */}
                                <div className="pt-3 border-t border-white/5">
                                    <div className="flex items-center justify-between text-[10px] text-gray-600">
                                        <span>DarkBridge v1.0</span>
                                        <span>Powered by Inco TEE</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
