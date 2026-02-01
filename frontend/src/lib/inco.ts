/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// Inco SDK integration per SKILL.md
import { Lightning } from "@inco/js/lite";
import { handleTypes } from "@inco/js";
import { CONFIDENTIAL_BRIDGE_ADDRESS, INCO_PEPPER, BASE_CHAIN_ID } from "./constants";

// Relayer server URL
const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001";

let zapInstance: Awaited<ReturnType<typeof Lightning.latest>> | null = null;

export async function getZap() {
    if (!zapInstance) {
        // Initialize with devnet pepper to match contract's Lib.sol
        zapInstance = await Lightning.latest(INCO_PEPPER, BASE_CHAIN_ID);
    }
    return zapInstance;
}

export async function encryptAmount(
    amount: bigint,
    accountAddress: string
): Promise<string> {
    const zap = await getZap();

    const encrypted = await zap.encrypt(amount, {
        accountAddress: accountAddress as `0x${string}`,
        dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS,
        handleType: handleTypes.euint256,
    });

    // Return as hex string
    return typeof encrypted === "string"
        ? encrypted.startsWith("0x")
            ? encrypted
            : `0x${encrypted}`
        : `0x${Buffer.from(encrypted).toString("hex")}`;
}

export async function encryptAddress(
    address: string,
    accountAddress: string
): Promise<string> {
    const zap = await getZap();

    // Convert address to BigInt for euint160
    const addressAsBigInt = BigInt(address);

    const encrypted = await zap.encrypt(addressAsBigInt, {
        accountAddress: accountAddress as `0x${string}`,
        dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS,
        handleType: handleTypes.euint160,
    });

    return typeof encrypted === "string"
        ? encrypted.startsWith("0x")
            ? encrypted
            : `0x${encrypted}`
        : `0x${Buffer.from(encrypted).toString("hex")}`;
}

export async function attestedDecrypt(
    walletClient: unknown,
    handles: string[]
): Promise<{ handle: string; value: bigint; signatures: string[] }[]> {
    const zap = await getZap();

    const results = await zap.attestedDecrypt(
        walletClient as Parameters<typeof zap.attestedDecrypt>[0],
        handles as `0x${string}`[]
    );

    return results.map((r, i) => ({
        handle: handles[i], // Include the original handle
        value: r.plaintext.value as bigint,
        // Convert signatures to the format expected by the contract
        signatures: r.covalidatorSignatures as unknown as string[],
    }));
}

/**
 * Attested reveal for handles marked with e.reveal() in the contract.
 * This does NOT require user's wallet signature - works for public reveals.
 * Used by the relayer for cross-chain bridge transfers.
 */
export async function attestedReveal(
    handles: string[]
): Promise<{ value: bigint }[]> {
    const zap = await getZap();

    const results = await zap.attestedReveal(handles as `0x${string}`[]);

    return results.map((r) => ({
        value: (r.plaintext as any).value !== undefined 
            ? BigInt((r.plaintext as any).value) 
            : BigInt(r.plaintext as any),
    }));
}

/**
 * Sign a decrypt authorization for a handle.
 * This allows the relayer to decrypt the encrypted amount on the user's behalf.
 * 
 * @param walletClient - The user's wallet client (from wagmi)
 * @param handle - The encrypted handle (bytes32) from the bridge event
 * @param userAddress - The user's address
 * @returns The signature and EIP-712 domain data
 */
export async function signDecryptAuthorization(
    walletClient: any,
    handle: `0x${string}`,
    userAddress: `0x${string}`
): Promise<{ signature: string; eip712Domain: any }> {
    const zap = await getZap();
    
    // Build EIP-712 typed data for attestedDecrypt
    // This is what the Inco SDK uses internally
    const eip712Domain = {
        name: 'IncoAttestedDecrypt',
        version: '2',
        chainId: BASE_CHAIN_ID,
    };

    const types = {
        AttestedDecryptRequest: [
            { name: 'handles', type: 'bytes32[]' },
            { name: 'publicKey', type: 'bytes' },
        ],
    };

    const message = {
        handles: [handle],
        publicKey: '0x', // Empty public key for plaintext decrypt
    };

    // Sign the typed data
    const signature = await walletClient.signTypedData({
        domain: eip712Domain,
        types,
        primaryType: 'AttestedDecryptRequest',
        message,
    });

    return { signature, eip712Domain };
}

/**
 * Submit a decrypt authorization to the relayer server.
 * Call this after the bridge transaction confirms and you have the handle.
 */
export async function submitDecryptAuthorization(
    handle: string,
    userAddress: string,
    signature: string,
    eip712Domain: any,
    txHash: string
): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
        const response = await fetch(`${RELAYER_URL}/authorize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                handle,
                userAddress,
                signature,
                eip712Domain,
                txHash,
            }),
        });

        const data = await response.json();
        
        if (!response.ok) {
            return { success: false, error: data.error || 'Failed to submit authorization' };
        }

        return { success: true, message: data.message };
    } catch (error: any) {
        console.error('Failed to submit authorization:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Check the status of a bridge/authorization with the relayer.
 */
export async function checkRelayStatus(handle: string): Promise<{
    hasAuthorization: boolean;
    authProcessed: boolean;
    hasBridgeEvent: boolean;
    bridgeProcessed: boolean;
}> {
    try {
        const response = await fetch(`${RELAYER_URL}/status/${handle}`);
        return await response.json();
    } catch (error) {
        console.error('Failed to check status:', error);
        return {
            hasAuthorization: false,
            authProcessed: false,
            hasBridgeEvent: false,
            bridgeProcessed: false,
        };
    }
}

export { handleTypes };
