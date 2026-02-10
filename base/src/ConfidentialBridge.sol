// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint256, ebool, eaddress, e, inco} from "@inco/lightning/Lib.sol";
import {DecryptionAttestation} from "@inco/lightning/lightning-parts/DecryptionAttester.types.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {OwnableRoles} from "solady/auth/OwnableRoles.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {EIP712} from "solady/utils/EIP712.sol";

import {ConfidentialCrossChainERC20} from "./ConfidentialCrossChainERC20.sol";
import {Pubkey} from "./libraries/SVMLib.sol";
import {Ix} from "./libraries/SVMBridgeLib.sol";

/// @title ConfidentialBridge
/// @notice Privacy extension for the Base-Solana bridge using Inco Lightning.
/// @dev Handles confidential token transfers with encrypted amounts on both chains.
/// @dev Now includes sender privacy (via relayers) and receiver privacy (via claims).
contract ConfidentialBridge is ReentrancyGuardTransient, OwnableRoles, Initializable, EIP712 {
    using e for *;
    using ECDSA for bytes32;

    //////////////////////////////////////////////////////////////
    ///                       Constants                        ///
    //////////////////////////////////////////////////////////////

    /// @notice The main bridge contract address.
    address public immutable BRIDGE;

    /// @notice The confidential token factory address.
    address public immutable CONFIDENTIAL_TOKEN_FACTORY;

    /// @notice Guardian role for token registration and pause.
    uint256 public constant GUARDIAN_ROLE = 1 << 0;

    /// @notice Relayer role for submitting private transactions on behalf of users.
    uint256 public constant RELAYER_ROLE = 1 << 1;

    /// @notice EIP-712 typehash for private bridge requests.
    bytes32 public constant PRIVATE_BRIDGE_TYPEHASH = keccak256(
        "PrivateBridge(address localToken,bytes32 commitment,bytes encryptedAmount,address sender,uint256 nonce,uint256 deadline)"
    );

    /// @notice EIP-712 typehash for claim requests.
    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 claimId,bytes32 secret,address claimer)"
    );

    //////////////////////////////////////////////////////////////
    ///                       Storage                          ///
    //////////////////////////////////////////////////////////////

    /// @notice Mapping of local tokens to their confidential counterparts.
    mapping(address => address) public confidentialTokens;

    /// @notice Nonce for confidential bridge messages.
    uint256 public confidentialNonce;

    /// @notice Mapping of nonce to expected encrypted amount handle for verification.
    /// @dev Used to prevent handle swapping attacks during cross-chain transfers.
    mapping(uint256 => bytes32) public expectedHandles;

    /// @notice Whether the bridge is paused.
    bool public paused;

    /// @notice Mapping of user address to their nonce for signature replay protection.
    mapping(address => uint256) public userNonces;

    /// @notice Struct for pending claims (receiver privacy).
    struct PendingClaim {
        bytes32 commitmentHash;      // Hash of the secret (keccak256(secret))
        address localToken;          // Token to be claimed
        euint256 encryptedAmount;    // Encrypted amount
        uint256 expiry;              // Claim expiration timestamp
        bool claimed;                // Whether already claimed
    }

    /// @notice Mapping of claim ID to pending claim data.
    mapping(uint256 => PendingClaim) public pendingClaims;

    /// @notice Counter for claim IDs.
    uint256 public claimIdCounter;

    /// @notice Struct for FULLY PRIVATE claims (recipient hidden via Inco TEE).
    /// Uses eaddress to store encrypted recipient - only revealed at claim time.
    struct PrivateClaim {
        address localToken;           // Token to be claimed
        euint256 encryptedAmount;     // Encrypted amount (Inco TEE)
        eaddress encryptedRecipient;  // Encrypted recipient address (Inco TEE) - HIDDEN!
        uint256 expiry;               // Claim expiration timestamp
        bool claimed;                 // Whether already claimed
    }

    /// @notice Mapping of private claim ID to claim data.
    mapping(uint256 => PrivateClaim) public privateClaims;

    /// @notice Counter for private claim IDs.
    uint256 public privateClaimIdCounter;

    /// @notice The designated bridge relayer for cross-chain transfers.
    /// @dev This address is granted e.allow() on bridged amounts so it can
    ///      perform attested decrypt on EVM and re-encrypt for Solana TEE.
    address public bridgeRelayer;

    //////////////////////////////////////////////////////////////
    ///                       Events                           ///
    //////////////////////////////////////////////////////////////

    /// @notice Emitted when a confidential bridge transfer is initiated.
    /// @dev PRIVACY: toSolanaHash is keccak256(toSolana) — the raw Solana recipient is NOT revealed on-chain.
    /// The relayer receives the plaintext toSolana via the /relay API endpoint.
    event ConfidentialBridgeInitiated(
        uint256 indexed nonce,
        address indexed localToken,
        Pubkey indexed remoteToken,
        bytes32 toSolanaHash,
        euint256 encryptedAmount
    );

    /// @notice Emitted when a confidential transfer is received from Solana.
    /// @dev PRIVACY: `toHash` is keccak256(abi.encodePacked(to)) — raw address is NOT on-chain.
    event ConfidentialBridgeReceived(
        uint256 indexed nonce,
        address indexed localToken,
        bytes32 indexed toHash,
        euint256 encryptedAmount
    );

    /// @notice Emitted when a fully private bridge is initiated (sender + receiver hidden).
    /// @dev Only reveals: nonce, token, commitment hash, encrypted amount.
    /// @dev Does NOT reveal: sender address, recipient address.
    event PrivateBridgeInitiated(
        uint256 indexed nonce,
        address indexed localToken,
        bytes32 indexed commitment,
        euint256 encryptedAmount
    );

    /// @notice Emitted when a claim is created for receiver privacy.
    event ClaimCreated(
        uint256 indexed claimId,
        address indexed localToken,
        bytes32 commitmentHash,
        uint256 expiry
    );

    /// @notice Emitted when a claim is successfully claimed.
    /// @dev Only the claimer address is revealed at claim time, not at bridge time.
    event ClaimRedeemed(
        uint256 indexed claimId,
        address indexed claimer
    );

    /// @notice Emitted when a FULLY PRIVATE claim is created (recipient hidden via Inco TEE).
    /// @dev The encryptedRecipient is NOT revealed in the event - only the claim ID!
    event PrivateClaimCreated(
        uint256 indexed claimId,
        address indexed localToken,
        uint256 expiry
    );

    /// @notice Emitted when a fully private claim is redeemed.
    /// @dev Only NOW is the recipient address revealed via Inco TEE decryption.
    event PrivateClaimRedeemed(
        uint256 indexed claimId,
        address indexed recipient
    );



    //////////////////////////////////////////////////////////////
    ///                       Errors                           ///
    //////////////////////////////////////////////////////////////

    error InsufficientFees();
    error ZeroAddress();
    error TokenNotRegistered();
    error SenderNotBridge();
    error HandleMismatch();
    error InvalidNonce();
    error Paused();
    error InvalidSignature();
    error SignatureExpired();
    error ClaimNotFound();
    error ClaimAlreadyClaimed();
    error ClaimExpired();
    error InvalidSecret();
    error ClaimNotExpired();
    error InvalidAttestation();  // For Inco TEE attestation errors
    error RecipientMismatch();   // When decrypted address doesn't match

    //////////////////////////////////////////////////////////////
    ///                       Events                           ///
    //////////////////////////////////////////////////////////////

    /// @notice Emitted when pause state changes.
    event PauseStateChanged(bool paused);

    /// @notice Emitted when bridge relayer is set.
    event BridgeRelayerSet(address indexed bridgeRelayer);

    //////////////////////////////////////////////////////////////
    ///                       Modifiers                        ///
    //////////////////////////////////////////////////////////////

    modifier requiresFee() {
        if (msg.value < inco.getFee()) revert InsufficientFees();
        _;
    }

    modifier onlyBridge() {
        if (msg.sender != BRIDGE) revert SenderNotBridge();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    //////////////////////////////////////////////////////////////
    ///                       Constructor                      ///
    //////////////////////////////////////////////////////////////

    /// @notice Constructs the ConfidentialBridge.
    /// @param bridge_ The main bridge contract address.
    /// @param confidentialTokenFactory_ The confidential token factory address.
    /// @param owner_ The owner of the bridge (also gets guardian role).
    constructor(address bridge_, address confidentialTokenFactory_, address owner_) {
        require(bridge_ != address(0), ZeroAddress());
        require(confidentialTokenFactory_ != address(0), ZeroAddress());
        require(owner_ != address(0), ZeroAddress());
        
        BRIDGE = bridge_;
        CONFIDENTIAL_TOKEN_FACTORY = confidentialTokenFactory_;

        // Initialize owner directly (not using proxy pattern for hackathon)
        _initializeOwner(owner_);
        _grantRoles(owner_, GUARDIAN_ROLE);
    }

    /// @notice Add additional guardians (owner only, for future use).
    /// @param guardians The addresses to grant guardian role.
    function addGuardians(address[] calldata guardians) external onlyOwner {
        for (uint256 i = 0; i < guardians.length; i++) {
            require(guardians[i] != address(0), ZeroAddress());
            _grantRoles(guardians[i], GUARDIAN_ROLE);
        }
    }

    /// @notice Add relayers who can submit transactions on behalf of users.
    /// @param relayers The addresses to grant relayer role.
    function addRelayers(address[] calldata relayers) external onlyOwner {
        for (uint256 i = 0; i < relayers.length; i++) {
            require(relayers[i] != address(0), ZeroAddress());
            _grantRoles(relayers[i], RELAYER_ROLE);
        }
    }

    /// @notice Remove a relayer.
    function removeRelayer(address relayer) external onlyOwner {
        _removeRoles(relayer, RELAYER_ROLE);
    }

    /// @notice Set the designated bridge relayer for cross-chain re-encryption.
    /// @dev The bridge relayer is granted e.allow() on all bridged amounts so it can
    ///      perform attested decrypt on EVM and re-encrypt for Solana TEE.
    /// @param _bridgeRelayer The address of the bridge relayer.
    function setBridgeRelayer(address _bridgeRelayer) external onlyOwner {
        require(_bridgeRelayer != address(0), ZeroAddress());
        bridgeRelayer = _bridgeRelayer;
        emit BridgeRelayerSet(_bridgeRelayer);
    }

    //////////////////////////////////////////////////////////////
    ///                       EIP-712 Functions                ///
    //////////////////////////////////////////////////////////////

    /// @notice Returns the EIP-712 domain name.
    function _domainNameAndVersion() internal pure override returns (string memory name, string memory version) {
        name = "ConfidentialBridge";
        version = "1";
    }

    /// @notice Returns the domain separator for EIP-712 signatures.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    //////////////////////////////////////////////////////////////
    ///                       Privacy Bridge Functions         ///
    //////////////////////////////////////////////////////////////

    /// @notice Bridge tokens with FULL PRIVACY via relayer (sender hidden) and commitment (receiver hidden).
    /// @dev Sender signs off-chain, relayer submits. Receiver claims with secret later.
    /// @param localToken The confidential token to bridge.
    /// @param commitment Hash of the secret that recipient will use to claim (keccak256(secret)).
    /// @param encryptedAmount Client-encrypted amount ciphertext.
    /// @param sender The actual sender (whose balance is debited).
    /// @param senderNonce The sender's nonce for replay protection.
    /// @param deadline Signature expiration timestamp.
    /// @param signature EIP-712 signature from the sender.
    function bridgePrivateViaRelayer(
        address localToken,
        bytes32 commitment,
        bytes calldata encryptedAmount,
        address sender,
        uint256 senderNonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable nonReentrant whenNotPaused requiresFee onlyRoles(RELAYER_ROLE) {
        // Validate inputs
        require(localToken != address(0), ZeroAddress());
        require(commitment != bytes32(0), ZeroAddress());
        require(sender != address(0), ZeroAddress());
        
        // Check deadline
        if (block.timestamp > deadline) revert SignatureExpired();
        
        // Check and increment nonce
        if (senderNonce != userNonces[sender]) revert InvalidNonce();
        userNonces[sender]++;
        
        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            PRIVATE_BRIDGE_TYPEHASH,
            localToken,
            commitment,
            keccak256(encryptedAmount),
            sender,
            senderNonce,
            deadline
        ));
        bytes32 digest = _hashTypedData(structHash);
        address recoveredSigner = digest.recover(signature);
        if (recoveredSigner != sender) revert InvalidSignature();

        // Create encrypted handle from ciphertext - tied to actual sender
        euint256 amount = encryptedAmount.newEuint256(sender);
        e.allow(amount, address(this));
        e.allow(amount, localToken);

        // Burn from sender's confidential balance
        ConfidentialCrossChainERC20(localToken).confidentialBurnFromHandle(
            sender,
            amount
        );

        // Get remote token mapping
        Pubkey remoteToken = Pubkey.wrap(
            ConfidentialCrossChainERC20(localToken).remoteToken()
        );

        // Increment nonce and store expected handle for verification
        uint256 nonce = confidentialNonce++;
        expectedHandles[nonce] = euint256.unwrap(amount);

        // Emit event that reveals NOTHING about sender or receiver
        // Only: nonce, token type, commitment hash, encrypted amount
        emit PrivateBridgeInitiated(
            nonce,
            localToken,
            commitment,
            amount
        );
    }

    /// @notice Bridge tokens with sender privacy only (via relayer).
    /// @dev Receiver address is visible, but sender is hidden.
    /// @param localToken The confidential token to bridge.
    /// @param toSolana The recipient's Solana pubkey (visible).
    /// @param encryptedAmount Client-encrypted amount ciphertext.
    /// @param sender The actual sender (whose balance is debited).
    /// @param senderNonce The sender's nonce for replay protection.
    /// @param deadline Signature expiration timestamp.
    /// @param signature EIP-712 signature from the sender.
    function bridgePrivateToSolanaViaRelayer(
        address localToken,
        bytes32 toSolana,
        bytes calldata encryptedAmount,
        address sender,
        uint256 senderNonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable nonReentrant whenNotPaused requiresFee onlyRoles(RELAYER_ROLE) {
        // Validate inputs
        require(localToken != address(0), ZeroAddress());
        require(toSolana != bytes32(0), ZeroAddress());
        require(sender != address(0), ZeroAddress());
        
        // Check deadline
        if (block.timestamp > deadline) revert SignatureExpired();
        
        // Check and increment nonce
        if (senderNonce != userNonces[sender]) revert InvalidNonce();
        userNonces[sender]++;
        
        // Verify signature using simple hash (for sender-only privacy variant)
        bytes32 messageHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            keccak256(abi.encodePacked(localToken, toSolana, encryptedAmount, senderNonce, deadline))
        ));
        address recoveredSigner = messageHash.recover(signature);
        if (recoveredSigner != sender) revert InvalidSignature();

        // Create encrypted handle from ciphertext
        euint256 amount = encryptedAmount.newEuint256(sender);
        e.allow(amount, address(this));
        e.allow(amount, localToken);

        // Burn from sender's confidential balance
        ConfidentialCrossChainERC20(localToken).confidentialBurnFromHandle(
            sender,
            amount
        );

        // Get remote token mapping
        Pubkey remoteToken = Pubkey.wrap(
            ConfidentialCrossChainERC20(localToken).remoteToken()
        );

        uint256 nonce = confidentialNonce++;
        expectedHandles[nonce] = euint256.unwrap(amount);

        // Emit event with HASHED recipient (privacy: raw toSolana is NOT on-chain)
        emit ConfidentialBridgeInitiated(
            nonce,
            localToken,
            remoteToken,
            keccak256(abi.encodePacked(toSolana)),
            amount
        );
    }

    //////////////////////////////////////////////////////////////
    ///                       Claim Functions (Receiver Privacy)///
    //////////////////////////////////////////////////////////////

    /// @notice Create a claim for receiver privacy on incoming bridge transfers.
    /// @dev Called by bridge when receiving from Solana with commitment instead of direct address.
    /// @param localToken The token for the claim.
    /// @param commitmentHash Hash of the secret (keccak256(secret)).
    /// @param encryptedAmount The encrypted amount.
    /// @param claimDuration How long the claim is valid (seconds).
    function createClaim(
        address localToken,
        bytes32 commitmentHash,
        bytes calldata encryptedAmount,
        uint256 claimDuration
    ) external payable onlyBridge nonReentrant requiresFee returns (uint256 claimId) {
        require(localToken != address(0), ZeroAddress());
        require(commitmentHash != bytes32(0), ZeroAddress());

        claimId = claimIdCounter++;
        
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));
        
        pendingClaims[claimId] = PendingClaim({
            commitmentHash: commitmentHash,
            localToken: localToken,
            encryptedAmount: amount,
            expiry: block.timestamp + claimDuration,
            claimed: false
        });

        emit ClaimCreated(claimId, localToken, commitmentHash, block.timestamp + claimDuration);
    }

    /// @notice Redeem a claim using the secret.
    /// @dev Anyone with the correct secret can claim. Receiver is only revealed at claim time.
    /// @param claimId The ID of the claim to redeem.
    /// @param secret The secret whose hash matches the commitment.
    function redeemClaim(
        uint256 claimId,
        bytes32 secret
    ) external payable nonReentrant requiresFee {
        PendingClaim storage claim = pendingClaims[claimId];
        
        // Validate claim exists
        if (claim.commitmentHash == bytes32(0)) revert ClaimNotFound();
        if (claim.claimed) revert ClaimAlreadyClaimed();
        if (block.timestamp > claim.expiry) revert ClaimExpired();
        
        // Verify secret
        bytes32 computedHash = keccak256(abi.encodePacked(secret));
        if (computedHash != claim.commitmentHash) revert InvalidSecret();
        
        // Mark as claimed
        claim.claimed = true;
        
        // Mint tokens to the claimer (msg.sender)
        // This is the first time the receiver address is revealed
        e.allow(claim.encryptedAmount, claim.localToken);
        ConfidentialCrossChainERC20(claim.localToken).confidentialMintFromHandle{value: msg.value}(
            msg.sender,
            claim.encryptedAmount
        );

        emit ClaimRedeemed(claimId, msg.sender);
    }

    /// @notice Reclaim expired unclaimed tokens (returns to bridge/guardian).
    /// @dev Only callable after claim expiry.
    /// @param claimId The ID of the expired claim.
    function reclaimExpired(uint256 claimId) external onlyRoles(GUARDIAN_ROLE) {
        PendingClaim storage claim = pendingClaims[claimId];
        
        if (claim.commitmentHash == bytes32(0)) revert ClaimNotFound();
        if (claim.claimed) revert ClaimAlreadyClaimed();
        if (block.timestamp <= claim.expiry) revert ClaimNotExpired();
        
        // Mark as claimed (to prevent double reclaim)
        claim.claimed = true;
        
        // Could emit an event or handle refund logic here
        // For now, just mark as processed
    }

    /// @notice Get the current nonce for a user (for signature construction).
    function getUserNonce(address user) external view returns (uint256) {
        return userNonces[user];
    }

    /// @notice Check if a claim is valid and unclaimed.
    function isClaimValid(uint256 claimId) external view returns (bool) {
        PendingClaim storage claim = pendingClaims[claimId];
        return claim.commitmentHash != bytes32(0) 
            && !claim.claimed 
            && block.timestamp <= claim.expiry;
    }

    //////////////////////////////////////////////////////////////
    ///              Inco TEE Private Claim Functions           ///
    //////////////////////////////////////////////////////////////

    /// @notice Create a FULLY PRIVATE claim with encrypted recipient (Inco TEE).
    /// @dev Recipient address is encrypted - only revealed when claiming via attestation.
    /// @param localToken The token for the claim.
    /// @param encryptedAmount The encrypted amount ciphertext.
    /// @param encryptedRecipient The encrypted recipient address ciphertext.
    /// @param claimDuration How long the claim is valid (seconds).
    function createPrivateClaim(
        address localToken,
        bytes calldata encryptedAmount,
        bytes calldata encryptedRecipient,
        uint256 claimDuration
    ) external payable nonReentrant requiresFee returns (uint256 claimId) {
        require(localToken != address(0), ZeroAddress());
        
        // Get fee for two ciphertext operations
        require(msg.value >= inco.getFee() * 2, InsufficientFees());

        claimId = privateClaimIdCounter++;
        
        // Create encrypted handles from ciphertexts
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        eaddress recipient = encryptedRecipient.newEaddress(msg.sender);
        
        // Allow this contract to use the handles
        e.allow(amount, address(this));
        e.allow(recipient, address(this));
        
        // IMPORTANT: Allow the USER who created the claim to view their encrypted data
        // This enables attestedDecrypt() so user can verify and claim with signature
        e.allow(amount, msg.sender);
        e.allow(recipient, msg.sender);
        
        privateClaims[claimId] = PrivateClaim({
            localToken: localToken,
            encryptedAmount: amount,
            encryptedRecipient: recipient,
            expiry: block.timestamp + claimDuration,
            claimed: false
        });

        // Event does NOT reveal recipient - only claim ID and token!
        emit PrivateClaimCreated(claimId, localToken, block.timestamp + claimDuration);
    }

    /// @notice Claim tokens from a fully private claim using Inco TEE attestation.
    /// @dev Caller must prove they own the encrypted address via Inco attested decrypt.
    /// @param claimId The ID of the private claim.
    /// @param decryptedRecipient The plaintext address from Inco attested decrypt.
    /// @param decryption The decryption attestation from Inco TEE.
    /// @param signatures The covalidator signatures proving the decryption.
    function claimWithAttestation(
        uint256 claimId,
        address decryptedRecipient,
        DecryptionAttestation memory decryption,
        bytes[] memory signatures
    ) external payable nonReentrant requiresFee {
        PrivateClaim storage claim = privateClaims[claimId];
        
        // Validate claim exists
        if (eaddress.unwrap(claim.encryptedRecipient) == bytes32(0)) revert ClaimNotFound();
        if (claim.claimed) revert ClaimAlreadyClaimed();
        if (block.timestamp > claim.expiry) revert ClaimExpired();
        
        // Verify the decryption attestation from Inco TEE using the real verifier
        // This cryptographically proves that encryptedRecipient decrypts to decryptedRecipient
        if (!inco.incoVerifier().isValidDecryptionAttestation(decryption, signatures)) {
            revert InvalidAttestation();
        }

        // Verify the handle in the attestation matches the stored encrypted recipient
        if (eaddress.unwrap(claim.encryptedRecipient) != decryption.handle) {
            revert HandleMismatch();
        }

        // Verify the decrypted address matches the claimed recipient
        address attestedRecipient = address(uint160(uint256(decryption.value)));
        if (attestedRecipient != decryptedRecipient) revert RecipientMismatch();
        
        // Mark as claimed
        claim.claimed = true;
        
        // Mint tokens to the decrypted recipient address
        // This is the FIRST TIME the recipient is revealed!
        e.allow(claim.encryptedAmount, claim.localToken);
        ConfidentialCrossChainERC20(claim.localToken).confidentialMintFromHandle{value: msg.value}(
            decryptedRecipient,
            claim.encryptedAmount
        );

        emit PrivateClaimRedeemed(claimId, decryptedRecipient);
    }

    /// @notice Check if a private claim is valid and unclaimed.
    function isPrivateClaimValid(uint256 claimId) external view returns (bool) {
        PrivateClaim storage claim = privateClaims[claimId];
        return eaddress.unwrap(claim.encryptedRecipient) != bytes32(0) 
            && !claim.claimed 
            && block.timestamp <= claim.expiry;
    }

    //////////////////////////////////////////////////////////////
    ///                       Bridge Functions                 ///
    //////////////////////////////////////////////////////////////

    /// @notice Bridge tokens privately to Solana.
    /// @dev Burns encrypted tokens on Base and emits commitment for Solana relay.
    /// @param localToken The confidential token to bridge.
    /// @param toSolana The recipient's Solana pubkey.
    /// @param encryptedAmount Client-encrypted amount ciphertext.
    function bridgePrivateToSolana(
        address localToken,
        bytes32 toSolana,
        bytes calldata encryptedAmount
    ) external payable nonReentrant whenNotPaused requiresFee {
        require(localToken != address(0), ZeroAddress());
        require(toSolana != bytes32(0), ZeroAddress());

        // Create encrypted handle from ciphertext (only done ONCE here)
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        // Allow this contract, token contract, sender, and relayer to use the handle
        e.allow(amount, address(this));
        e.allow(amount, localToken);
        e.allow(amount, msg.sender);
        
        // Grant relayer access to decrypt the amount via attestedDecrypt
        require(bridgeRelayer != address(0), "Bridge relayer not set");
        e.allow(amount, bridgeRelayer);

        // Burn from sender's confidential balance using the handle (not the raw ciphertext)
        // This avoids calling newEuint256 twice on the same ciphertext
        ConfidentialCrossChainERC20(localToken).confidentialBurnFromHandle(
            msg.sender,
            amount
        );

        // Get remote token mapping
        Pubkey remoteToken = Pubkey.wrap(
            ConfidentialCrossChainERC20(localToken).remoteToken()
        );

        // Increment nonce and store expected handle for verification
        uint256 nonce = confidentialNonce++;
        expectedHandles[nonce] = euint256.unwrap(amount);

        // PRIVACY: Emit hash of recipient — raw toSolana is NOT on-chain
        emit ConfidentialBridgeInitiated(
            nonce,
            localToken,
            remoteToken,
            keccak256(abi.encodePacked(toSolana)),
            amount
        );
    }

    /// @notice Bridge tokens privately to Solana with custom instructions.
    /// @param localToken The confidential token to bridge.
    /// @param toSolana The recipient's Solana pubkey.
    /// @param encryptedAmount Client-encrypted amount ciphertext.
    /// @param ixs Optional Solana instructions to execute after bridging.
    function bridgePrivateToSolanaWithInstructions(
        address localToken,
        bytes32 toSolana,
        bytes calldata encryptedAmount,
        Ix[] calldata ixs
    ) external payable nonReentrant whenNotPaused requiresFee {
        // Same logic as bridgePrivateToSolana but includes instructions
        require(localToken != address(0), ZeroAddress());
        require(toSolana != bytes32(0), ZeroAddress());

        // Create encrypted handle from ciphertext (only done ONCE here)
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        // Allow this contract, token contract, sender, and relayer to use the handle
        e.allow(amount, address(this));
        e.allow(amount, localToken);
        e.allow(amount, msg.sender);
        
        // Grant relayer access to decrypt the amount via attestedDecrypt
        require(bridgeRelayer != address(0), "Bridge relayer not set");
        e.allow(amount, bridgeRelayer);

        // Burn from sender's confidential balance using the handle
        ConfidentialCrossChainERC20(localToken).confidentialBurnFromHandle(
            msg.sender,
            amount
        );

        Pubkey remoteToken = Pubkey.wrap(
            ConfidentialCrossChainERC20(localToken).remoteToken()
        );

        uint256 nonce = confidentialNonce++;
        expectedHandles[nonce] = euint256.unwrap(amount);

        // PRIVACY: Emit hash of recipient — raw toSolana is NOT on-chain
        emit ConfidentialBridgeInitiated(
            nonce,
            localToken,
            remoteToken,
            keccak256(abi.encodePacked(toSolana)),
            amount
        );

        // TODO: Serialize and emit instructions for Solana relay
    }


    /// @notice Receive confidential tokens from Solana.
    /// @dev Called by the main bridge when relaying from Solana.
    /// @dev SECURITY: Verifies that the received handle matches the expected handle from the outgoing message.
    /// @param nonce The bridge message nonce for verification.
    /// @param localToken The confidential token to mint.
    /// @param to The recipient on Base.
    /// @param encryptedAmount The encrypted amount to mint.
    function receiveFromSolana(
        uint256 nonce,
        address localToken,
        address to,
        bytes calldata encryptedAmount
    ) external payable onlyBridge nonReentrant {
        require(localToken != address(0), ZeroAddress());
        require(to != address(0), ZeroAddress());

        // Create handle from the received encrypted amount
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        bytes32 receivedHandle = euint256.unwrap(amount);

        // CRITICAL SECURITY CHECK: Verify handle matches expected
        bytes32 expected = expectedHandles[nonce];
        if (expected == bytes32(0)) revert InvalidNonce();
        if (receivedHandle != expected) revert HandleMismatch();

        // Clear the expected handle to prevent replay
        delete expectedHandles[nonce];

        // Mint confidential tokens to recipient
        ConfidentialCrossChainERC20(localToken).confidentialMint{value: msg.value}(
            to,
            encryptedAmount
        );

        // PRIVACY: Emit hash of recipient — raw address is NOT on-chain
        emit ConfidentialBridgeReceived(nonce, localToken, keccak256(abi.encodePacked(to)), amount);
    }

    /// @notice Receive confidential tokens from Solana (legacy, no handle verification).
    /// @dev Deprecated: Use receiveFromSolana with nonce parameter for security.
    /// @dev This function is kept for backward compatibility but should not be used.
    function receiveFromSolanaLegacy(
        address localToken,
        address to,
        bytes calldata encryptedAmount
    ) external payable onlyBridge nonReentrant {
        require(localToken != address(0), ZeroAddress());
        require(to != address(0), ZeroAddress());

        // Mint confidential tokens to recipient
        ConfidentialCrossChainERC20(localToken).confidentialMint{value: msg.value}(
            to,
            encryptedAmount
        );

        euint256 amount = encryptedAmount.newEuint256(msg.sender);

        // Emit event without nonce (legacy)
        // PRIVACY: Emit hash of recipient — raw address is NOT on-chain
        emit ConfidentialBridgeReceived(0, localToken, keccak256(abi.encodePacked(to)), amount);
    }

    //////////////////////////////////////////////////////////////
    ///                       View Functions                   ///
    //////////////////////////////////////////////////////////////

    /// @notice Get the Inco fee required for operations.
    function getIncoFee() external view returns (uint256) {
        return inco.getFee();
    }

    /// @notice Check if a token has a confidential counterpart.
    function hasConfidentialToken(address localToken) external view returns (bool) {
        return confidentialTokens[localToken] != address(0);
    }

    /// @notice Get the expected handle for a given nonce.
    /// @dev Returns bytes32(0) if nonce is invalid or already consumed.
    function getExpectedHandle(uint256 nonce) external view returns (bytes32) {
        return expectedHandles[nonce];
    }

    //////////////////////////////////////////////////////////////
    ///                       Admin Functions                  ///
    //////////////////////////////////////////////////////////////

    /// @notice Register a confidential token mapping.
    /// @dev Only guardians can register tokens.
    function registerConfidentialToken(
        address originalToken,
        address confidentialToken
    ) external onlyRoles(GUARDIAN_ROLE) {
        require(originalToken != address(0), ZeroAddress());
        require(confidentialToken != address(0), ZeroAddress());
        confidentialTokens[originalToken] = confidentialToken;
    }

    /// @notice Pause or unpause the bridge.
    /// @dev Only guardians can pause.
    function setPaused(bool _paused) external onlyRoles(GUARDIAN_ROLE) {
        paused = _paused;
        emit PauseStateChanged(_paused);
    }

    /// @notice Grant guardian role to an address.
    /// @dev Only owner can grant roles.
    function grantGuardian(address guardian) external onlyOwner {
        require(guardian != address(0), ZeroAddress());
        _grantRoles(guardian, GUARDIAN_ROLE);
    }

    /// @notice Revoke guardian role from an address.
    /// @dev Only owner can revoke roles.
    function revokeGuardian(address guardian) external onlyOwner {
        _removeRoles(guardian, GUARDIAN_ROLE);
    }
}
