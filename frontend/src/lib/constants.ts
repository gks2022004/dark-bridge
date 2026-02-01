// Contract addresses - NEW deployment with bridgePrivateToSolanaPlaintext (production ready)
export const CONFIDENTIAL_BRIDGE_ADDRESS = "0xD705858A979a4ab42e7a2e43e8CcC726Dbd87369" as const;
export const CONFIDENTIAL_TOKEN_ADDRESS = "0xFBAD5A940d89e504C5f8C9e0fC3A976A82334565" as const;

// Bridge relayer address (owner/deployer)
export const BRIDGE_RELAYER_ADDRESS = "0xF8AF04bF0Ac151f2050436603d81Ba20f449028F" as const;

// Solana
export const BRIDGE_PROGRAM_ID = "EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9";
export const SOLANA_RPC_URL = "https://api.devnet.solana.com";

// The Solana token mint for cDARK (from remoteToken on EVM contract)
// bytes32: 0x1cd8d28fb7697151a7202ba6f1aee1df7b201b5bce634fe0d48e0aadc8435fde
// base58: 2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH
export const SOLANA_CDARK_TOKEN_MINT = "2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH" as const;

// Inco Lightning Program ID on Solana Devnet
export const INCO_LIGHTNING_PROGRAM_ID = "5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj" as const;

// Base Sepolia
export const BASE_RPC_URL = "https://sepolia.base.org";
export const BASE_CHAIN_ID = 84532;

// Inco
export const INCO_PEPPER = "devnet" as const;
