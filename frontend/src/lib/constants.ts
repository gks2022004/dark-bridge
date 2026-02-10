// Contract addresses - deployment with encrypted bridge (privacy-preserving)
export const CONFIDENTIAL_BRIDGE_ADDRESS = "0x04423E2D4e74b8C5D17730143400ca43fC800f73" as const;
export const CONFIDENTIAL_TOKEN_ADDRESS = "0xeC7f5bDafE9934658d717E9a13Ae4259858b5F0b" as const;

// Bridge relayer address (owner/deployer)
export const BRIDGE_RELAYER_ADDRESS = "0xF8AF04bF0Ac151f2050436603d81Ba20f449028F" as const;

// Solana
export const BRIDGE_PROGRAM_ID = "EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9";
export const SOLANA_RPC_URL = "https://api.devnet.solana.com";

// The Solana token mint for cDARK (from remoteToken on EVM contract)
// bytes32: 0x223403719246903aaf8dc5029034932739e7641a28e51c89c199ab62e27d5598
// base58: 3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V
export const SOLANA_CDARK_TOKEN_MINT = "3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V" as const;

// Inco Lightning Program ID on Solana Devnet
export const INCO_LIGHTNING_PROGRAM_ID = "5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj" as const;

// Base Sepolia
export const BASE_RPC_URL = "https://sepolia.base.org";
export const BASE_CHAIN_ID = 84532;

// Inco
export const INCO_PEPPER = "devnet" as const;
