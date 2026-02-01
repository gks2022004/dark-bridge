import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { baseSepolia } from "wagmi/chains";

// RainbowKit configuration with Base Sepolia
// Note: For production, register at https://cloud.walletconnect.com to get a project ID
export const wagmiConfig = getDefaultConfig({
    appName: "Privacy Bridge",
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "YOUR_PROJECT_ID",
    chains: [baseSepolia],
    ssr: true,
});
