// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint256, ebool, e, inco} from "@inco/lightning/Lib.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {DecryptionAttestation} from "@inco/lightning/lightning-parts/DecryptionAttester.types.sol";

/// @title ConfidentialCrossChainERC20
/// @notice A cross-chain ERC20 token with encrypted balances using Inco Lightning.
/// @dev Balances are stored as encrypted handles (euint256) and operations are performed
///      on encrypted values without revealing the underlying amounts.
contract ConfidentialCrossChainERC20 is Initializable {
    using e for *;

    //////////////////////////////////////////////////////////////
    ///                       Constants                        ///
    //////////////////////////////////////////////////////////////

    /// @notice The bridge contract address that has minting and burning privileges.
    address private immutable _BRIDGE;

    //////////////////////////////////////////////////////////////
    ///                       Storage                          ///
    //////////////////////////////////////////////////////////////

    /// @notice The name of the token.
    string private _name;

    /// @notice The symbol of the token.
    string private _symbol;

    /// @notice The identifier of the corresponding token on the remote chain.
    bytes32 private _remoteToken;

    /// @notice The number of decimal places for this token.
    uint8 private _decimals;

    /// @notice Encrypted total supply.
    euint256 public totalSupply;

    /// @notice Encrypted balances for each address.
    mapping(address => euint256) internal _balances;

    /// @notice Encrypted allowances.
    mapping(address => mapping(address => euint256)) internal _allowances;

    /// @notice The underlying ERC20 token (for deposit/withdraw).
    address private _underlyingToken;

    /// @notice Authorized minter address (relayer) for cross-chain operations.
    address private _authorizedMinter;

    /// @notice Whether the testnet faucet is enabled (disabled on mainnet).
    bool public faucetEnabled;

    //////////////////////////////////////////////////////////////
    ///                       Events                           ///
    //////////////////////////////////////////////////////////////

    /// @notice Emitted on encrypted transfer.
    event ConfidentialTransfer(address indexed from, address indexed to, euint256 amount);

    /// @notice Emitted on encrypted approval.
    event ConfidentialApproval(address indexed owner, address indexed spender, euint256 amount);

    /// @notice Emitted on encrypted mint.
    event ConfidentialMint(address indexed to, euint256 amount);

    /// @notice Emitted on encrypted burn.
    event ConfidentialBurn(address indexed from, euint256 amount);

    /// @notice Emitted when plaintext tokens are deposited and encrypted.
    event Deposit(address indexed from, euint256 encryptedAmount);

    /// @notice Emitted when encrypted tokens are withdrawn using attestation.
    event Withdraw(address indexed to);

    //////////////////////////////////////////////////////////////
    ///                       Errors                           ///
    //////////////////////////////////////////////////////////////

    /// @notice Thrown when the sender is not the bridge.
    error SenderIsNotBridge();

    /// @notice Thrown when insufficient fee is provided.
    error InsufficientFees();

    /// @notice Thrown when a zero address is provided.
    error ZeroAddress();

    /// @notice Thrown when attestation signature is invalid.
    error InvalidAttestation();

    /// @notice Thrown when handle in attestation doesn't match balance.
    error HandleMismatch();

    /// @notice Thrown when no underlying token is set.
    error NoUnderlyingToken();

    //////////////////////////////////////////////////////////////
    ///                       Modifiers                        ///
    //////////////////////////////////////////////////////////////

    /// @notice Only allows the Bridge to call.
    modifier onlyBridge() {
        require(msg.sender == _BRIDGE, SenderIsNotBridge());
        _;
    }

    /// @notice Requires Inco fee payment.
    modifier requiresFee() {
        if (msg.value < inco.getFee()) revert InsufficientFees();
        _;
    }

    //////////////////////////////////////////////////////////////
    ///                       Constructor                      ///
    //////////////////////////////////////////////////////////////

    /// @notice Constructs the ConfidentialCrossChainERC20 contract.
    /// @param bridge_ Address of the bridge contract with mint/burn privileges.
    /// @param authorizedMinter_ Address authorized to call faucetMint (relayer/deployer).
    constructor(address bridge_, address authorizedMinter_) {
        require(bridge_ != address(0), ZeroAddress());
        _BRIDGE = bridge_;
        _authorizedMinter = authorizedMinter_;
        faucetEnabled = true; // Enabled by default on testnet
    }

    /// @notice Initializes the token.
    /// @param remoteToken_ Identifier of the corresponding token on the remote chain.
    /// @param name_ ERC20 name of the token.
    /// @param symbol_ ERC20 symbol of the token.
    /// @param decimals_ ERC20 decimals for the token.
    function initialize(
        bytes32 remoteToken_,
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) external initializer {
        require(remoteToken_ != bytes32(0), ZeroAddress());
        _remoteToken = remoteToken_;
        _decimals = decimals_;
        _name = name_;
        _symbol = symbol_;
    }

    /// @notice Initializes the token with underlying token for deposits.
    /// @param remoteToken_ Identifier of the corresponding token on the remote chain.
    /// @param name_ ERC20 name of the token.
    /// @param symbol_ ERC20 symbol of the token.
    /// @param decimals_ ERC20 decimals for the token.
    /// @param underlyingToken_ The underlying ERC20 token for deposit/withdraw.
    function initializeWithUnderlying(
        bytes32 remoteToken_,
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address underlyingToken_
    ) external initializer {
        require(remoteToken_ != bytes32(0), ZeroAddress());
        _remoteToken = remoteToken_;
        _decimals = decimals_;
        _name = name_;
        _symbol = symbol_;
        _underlyingToken = underlyingToken_;
    }

    //////////////////////////////////////////////////////////////
    ///                       View Functions                   ///
    //////////////////////////////////////////////////////////////

    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function decimals() public view returns (uint8) {
        return _decimals;
    }

    function bridge() public view returns (address) {
        return _BRIDGE;
    }

    function remoteToken() public view returns (bytes32) {
        return _remoteToken;
    }

    /// @notice Returns the encrypted balance handle for an address.
    /// @dev The actual value can only be decrypted by authorized parties.
    function balanceOf(address owner) public view returns (euint256) {
        return _balances[owner];
    }

    /// @notice Returns the encrypted allowance handle.
    function allowance(address owner, address spender) public view returns (euint256) {
        return _allowances[owner][spender];
    }

    //////////////////////////////////////////////////////////////
    ///                       Transfer Functions               ///
    //////////////////////////////////////////////////////////////

    /// @notice Transfer tokens with encrypted amount (from client ciphertext).
    /// @param to Recipient address.
    /// @param encryptedAmount Client-encrypted amount ciphertext.
    function transfer(
        address to,
        bytes calldata encryptedAmount
    ) external payable requiresFee returns (bool) {
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Transfer tokens with an existing encrypted handle.
    /// @param to Recipient address.
    /// @param amount Encrypted amount handle.
    function transfer(address to, euint256 amount) public returns (bool) {
        e.allow(amount, address(this));
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice TransferFrom with encrypted amount (from client ciphertext).
    function transferFrom(
        address from,
        address to,
        bytes calldata encryptedAmount
    ) external payable requiresFee returns (bool) {
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));
        ebool isAllowed = _updateAllowance(from, msg.sender, amount);
        _transferWithCheck(from, to, amount, isAllowed);
        return true;
    }

    /// @notice TransferFrom with existing encrypted handle.
    function transferFrom(
        address from,
        address to,
        euint256 amount
    ) public returns (bool) {
        e.allow(amount, address(this));
        ebool isAllowed = _updateAllowance(from, msg.sender, amount);
        _transferWithCheck(from, to, amount, isAllowed);
        return true;
    }

    //////////////////////////////////////////////////////////////
    ///                       Approval Functions               ///
    //////////////////////////////////////////////////////////////

    /// @notice Approve spender with encrypted amount (from client ciphertext).
    function approve(
        address spender,
        bytes calldata encryptedAmount
    ) external payable requiresFee returns (bool) {
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        _approve(msg.sender, spender, amount);
        return true;
    }

    /// @notice Approve spender with existing encrypted handle.
    function approve(address spender, euint256 amount) public returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    //////////////////////////////////////////////////////////////
    ///                       Bridge Functions                 ///
    //////////////////////////////////////////////////////////////

    /// @notice Confidentially mint tokens (bridge only).
    /// @param to Recipient address.
    /// @param encryptedAmount Encrypted amount to mint.
    function confidentialMint(
        address to,
        bytes calldata encryptedAmount
    ) external payable onlyBridge requiresFee {
        require(to != address(0), ZeroAddress());

        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));

        // Add to balance
        if (euint256.unwrap(_balances[to]) == bytes32(0)) {
            _balances[to] = amount;
        } else {
            _balances[to] = e.add(_balances[to], amount);
        }
        e.allow(_balances[to], address(this));
        e.allow(_balances[to], to);

        // Update total supply (kept encrypted for privacy)
        totalSupply = e.add(totalSupply, amount);
        e.allow(totalSupply, address(this));

        emit ConfidentialMint(to, amount);
    }

    /// @notice Confidentially burn tokens (bridge only) from ciphertext.
    /// @param from Address to burn from.
    /// @param encryptedAmount Encrypted amount to burn (ciphertext bytes).
    function confidentialBurn(
        address from,
        bytes calldata encryptedAmount
    ) external payable onlyBridge requiresFee {
        require(from != address(0), ZeroAddress());

        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));

        _burnInternal(from, amount);
    }

    /// @notice Confidentially burn tokens (bridge only) from existing handle.
    /// @dev Used when the handle has already been created from ciphertext.
    /// @param from Address to burn from.
    /// @param amount Encrypted amount handle to burn.
    function confidentialBurnFromHandle(
        address from,
        euint256 amount
    ) external onlyBridge {
        require(from != address(0), ZeroAddress());
        // Verify bridge has access to this handle
        require(msg.sender.isAllowed(amount), "Unauthorized handle access");
        e.allow(amount, address(this));

        _burnInternal(from, amount);
    }

    /// @notice Confidentially mint tokens from an existing handle (bridge only).
    /// @dev Used for claim-based privacy where handle already exists.
    /// @param to Recipient address.
    /// @param amount Encrypted amount handle to mint.
    function confidentialMintFromHandle(
        address to,
        euint256 amount
    ) external payable onlyBridge {
        require(to != address(0), ZeroAddress());
        // Verify bridge has access to this handle
        require(msg.sender.isAllowed(amount), "Unauthorized handle access");
        e.allow(amount, address(this));

        // Add to balance
        if (euint256.unwrap(_balances[to]) == bytes32(0)) {
            _balances[to] = amount;
        } else {
            _balances[to] = e.add(_balances[to], amount);
        }
        e.allow(_balances[to], address(this));
        e.allow(_balances[to], to);

        // Update total supply (kept encrypted for privacy)
        totalSupply = e.add(totalSupply, amount);
        e.allow(totalSupply, address(this));

        emit ConfidentialMint(to, amount);
    }

    /// @notice Internal burn logic shared by both confidentialBurn variants.
    function _burnInternal(address from, euint256 amount) internal {
        // Check balance and subtract
        ebool hasSufficient = e.ge(_balances[from], amount);
        euint256 actualBurn = e.select(hasSufficient, amount, e.asEuint256(0));

        _balances[from] = e.sub(_balances[from], actualBurn);
        e.allow(_balances[from], address(this));
        e.allow(_balances[from], from);

        // Update total supply
        totalSupply = e.sub(totalSupply, actualBurn);
        e.allow(totalSupply, address(this));

        emit ConfidentialBurn(from, actualBurn);
    }

    //////////////////////////////////////////////////////////////
    ///                   Deposit / Withdraw Functions          ///
    //////////////////////////////////////////////////////////////

    /// @notice Deposit plaintext ERC20 tokens and receive encrypted balance.
    /// @dev Transfers underlying tokens from sender and mints equivalent encrypted balance.
    /// @param amount The plaintext amount to deposit.
    function deposit(uint256 amount) external payable requiresFee {
        if (_underlyingToken == address(0)) revert NoUnderlyingToken();
        require(amount > 0, ZeroAddress());

        // Transfer underlying tokens from sender to this contract
        IERC20(_underlyingToken).transferFrom(msg.sender, address(this), amount);

        // Create encrypted handle from plaintext amount (trivial encrypt)
        euint256 encrypted = e.asEuint256(amount);

        // Add to sender's encrypted balance
        if (euint256.unwrap(_balances[msg.sender]) == bytes32(0)) {
            _balances[msg.sender] = encrypted;
        } else {
            _balances[msg.sender] = e.add(_balances[msg.sender], encrypted);
        }
        e.allow(_balances[msg.sender], address(this));
        e.allow(_balances[msg.sender], msg.sender);

        // Update total supply (kept encrypted for privacy)
        totalSupply = e.add(totalSupply, encrypted);
        e.allow(totalSupply, address(this));

        emit Deposit(msg.sender, encrypted);
    }

    /// @notice Withdraw encrypted balance to plaintext ERC20 using attested decryption.
    /// @dev Verifies covalidator signatures and transfers underlying tokens.
    /// @param decryption The decryption attestation containing handle and plaintext value.
    /// @param signatures The covalidator signatures over the attestation.
    function withdrawWithAttestation(
        DecryptionAttestation memory decryption,
        bytes[] memory signatures
    ) external {
        if (_underlyingToken == address(0)) revert NoUnderlyingToken();

        // 1. Verify covalidator signatures
        if (!inco.incoVerifier().isValidDecryptionAttestation(decryption, signatures)) {
            revert InvalidAttestation();
        }

        // 2. Verify handle matches sender's balance
        if (euint256.unwrap(_balances[msg.sender]) != decryption.handle) {
            revert HandleMismatch();
        }

        // 3. Extract plaintext amount from attestation
        uint256 amount = uint256(decryption.value);
        require(amount > 0, ZeroAddress());

        // 4. Zero out encrypted balance (user is withdrawing everything)
        _balances[msg.sender] = e.asEuint256(0);
        e.allow(_balances[msg.sender], address(this));
        e.allow(_balances[msg.sender], msg.sender);

        // 5. Update total supply (kept encrypted for privacy)
        totalSupply = e.sub(totalSupply, e.asEuint256(amount));
        e.allow(totalSupply, address(this));

        // 6. Transfer underlying tokens to sender
        IERC20(_underlyingToken).transfer(msg.sender, amount);

        emit Withdraw(msg.sender);
    }

    /// @notice Get the underlying ERC20 token address.
    function underlyingToken() external view returns (address) {
        return _underlyingToken;
    }

    /// @notice Set the underlying ERC20 token address (bridge only).
    /// @dev Can only be set once.
    function setUnderlyingToken(address token) external onlyBridge {
        require(_underlyingToken == address(0), "Already set");
        require(token != address(0), ZeroAddress());
        _underlyingToken = token;
    }

    /// @notice Set the authorized minter for cross-chain relayer operations (bridge only).
    /// @param minter The address authorized to call faucetMint.
    function setAuthorizedMinter(address minter) external onlyBridge {
        require(minter != address(0), ZeroAddress());
        _authorizedMinter = minter;
    }

    /// @notice Enable or disable the testnet faucet (bridge only).
    /// @dev Disable for mainnet deployment to restrict minting to bridge/authorized minter only.
    function setFaucetEnabled(bool enabled) external onlyBridge {
        faucetEnabled = enabled;
    }

    /// @notice Set the remote token (bridge only).
    /// @dev Can only be set once.
    function setRemoteToken(bytes32 remoteToken_) external onlyBridge {
        require(_remoteToken == bytes32(0), "Already set");
        require(remoteToken_ != bytes32(0), ZeroAddress());
        _remoteToken = remoteToken_;
    }



    /// @notice Mint tokens using encrypted amount (privacy-preserving).
    /// @dev When faucetEnabled: callable by anyone (testnet faucet mode).
    ///      When disabled: only bridge or authorized minter (production mode).
    /// @param to Recipient address.
    /// @param encryptedAmount Client-side encrypted amount ciphertext.
    function faucetMint(
        address to,
        bytes calldata encryptedAmount
    ) external payable requiresFee {
        if (!faucetEnabled) {
            require(msg.sender == _BRIDGE || msg.sender == _authorizedMinter, SenderIsNotBridge());
        }
        require(to != address(0), ZeroAddress());

        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));

        // Add to balance
        if (euint256.unwrap(_balances[to]) == bytes32(0)) {
            _balances[to] = amount;
        } else {
            _balances[to] = e.add(_balances[to], amount);
        }
        e.allow(_balances[to], address(this));
        e.allow(_balances[to], to);

        // Update total supply (kept encrypted for privacy)
        totalSupply = e.add(totalSupply, amount);
        e.allow(totalSupply, address(this));

        emit ConfidentialMint(to, amount);
    }

    //////////////////////////////////////////////////////////////
    ///                       Internal Functions               ///
    //////////////////////////////////////////////////////////////

    function _transfer(address from, address to, euint256 amount) internal {
        // Check balance
        ebool hasSufficient = e.ge(_balances[from], amount);
        _transferWithCheck(from, to, amount, hasSufficient);
    }

    function _transferWithCheck(
        address from,
        address to,
        euint256 amount,
        ebool isTransferable
    ) internal {
        // Select actual transfer amount (0 if not transferable)
        euint256 transferValue = e.select(isTransferable, amount, e.asEuint256(0));

        // Update destination balance
        if (euint256.unwrap(_balances[to]) == bytes32(0)) {
            _balances[to] = transferValue;
        } else {
            _balances[to] = e.add(_balances[to], transferValue);
        }
        e.allow(_balances[to], address(this));
        e.allow(_balances[to], to);

        // Update source balance
        _balances[from] = e.sub(_balances[from], transferValue);
        e.allow(_balances[from], address(this));
        e.allow(_balances[from], from);

        emit ConfidentialTransfer(from, to, transferValue);
    }

    function _approve(address owner, address spender, euint256 amount) internal {
        _allowances[owner][spender] = amount;
        e.allow(amount, address(this));
        e.allow(amount, owner);
        e.allow(amount, spender);

        emit ConfidentialApproval(owner, spender, amount);
    }

    function _updateAllowance(
        address owner,
        address spender,
        euint256 amount
    ) internal returns (ebool) {
        euint256 currentAllowance = _allowances[owner][spender];
        ebool allowedTransfer = e.ge(currentAllowance, amount);
        ebool canTransfer = e.ge(_balances[owner], amount);
        ebool isTransferable = e.select(canTransfer, allowedTransfer, e.asEbool(false));

        // Update allowance
        _allowances[owner][spender] = e.select(
            isTransferable,
            e.sub(currentAllowance, amount),
            currentAllowance
        );
        e.allow(_allowances[owner][spender], address(this));
        e.allow(_allowances[owner][spender], owner);
        e.allow(_allowances[owner][spender], spender);

        return isTransferable;
    }
}
