"use client";

import { BridgeForm } from "@/components/BridgeForm";
import { Header } from "@/components/Header";
import BackgroundCanvas from "@/components/BackgroundCanvas";

export default function Home() {
    return (
        <main className="min-h-screen relative overflow-hidden">
            {/* Animated Background */}
            <BackgroundCanvas />

            {/* Content */}
            <div className="relative z-10 min-h-screen pb-20 pt-2 md:pt-4">
                <Header />

                <div className="max-w-6xl mx-auto px-3 md:px-4">
                    {/* Main Content - Bridge Form Only */}
                    <div className="mt-8 lg:mt-16">
                        <BridgeForm />
                    </div>

                    {/* Footer */}
                    <footer className="mt-20 text-center">
                        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-black/20 border border-white/5">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            <span className="text-xs text-gray-500">Protected by Inco Network TEE</span>
                        </div>
                    </footer>
                </div>
            </div>
        </main>
    );
}
