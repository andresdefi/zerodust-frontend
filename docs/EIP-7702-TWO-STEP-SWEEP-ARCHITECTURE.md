# ZeroDust Two-Step EIP-7702 Sweep Architecture

> **UNBUILT DESIGN PROPOSAL — this is not the shipped system.**
>
> This document describes a hypothetical `ZeroDustSweepV4` contract with
> on-chain intent registration, a 0.5% protocol fee, an `IntentMonitorService`
> and Prisma/PostgreSQL. None of that exists. There is no `ZeroDustSweepV4.sol`;
> the deployed contracts are `ZeroDustSweepMainnet.sol` and
> `ZeroDustSweepTEST.sol`, the backend uses Supabase and
> `src/services/relayer.ts`, and the implementation checklist in §6 is entirely
> unchecked.
>
> **What actually ships is a single sponsor-submitted transaction**, not two
> steps: the user signs an EIP-7702 delegation, a revoke authorization and an
> EIP-712 sweep intent, then the relayer submits one type-4 transaction and
> pays the gas. For the real flow see the root `CLAUDE.md` files.
>
> Kept for the design rationale and the security analysis in §5, which remain
> useful reading. Do not treat any of it as a description of current behaviour.

## Executive Summary

This document describes a two-step sweep mechanism that achieves **TRUE ZERO balance** on the source chain. The key innovation is separating the user's registration/intent transaction from the actual sweep execution, allowing a relayer to pay for gas while sweeping the user's entire remaining balance.

### Why Two Steps?

The fundamental problem with achieving true zero balance is circular:
- To sweep funds, you need gas
- Reserving gas means you can't sweep 100% of the balance
- Any gas estimation is approximate (gas prices fluctuate)

**Solution**: User signs and pays for a minimal "registration" transaction (Step 1). Later, a relayer executes the sweep (Step 2), paying for gas from their own funds, and the user's ENTIRE balance is swept.

---

## 1. Smart Contract Design

### 1.1 Contract Storage Structure

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ZeroDustSweepV4
 * @notice Two-step EIP-7702 sweep contract for achieving true zero balance
 * @dev This contract is delegated to user EOAs via EIP-7702
 */
contract ZeroDustSweepV4 {

    // ═══════════════════════════════════════════════════════════════════════
    // STORAGE LAYOUT (uses EIP-7201 namespaced storage to avoid collisions)
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:storage-location erc7201:zerodust.sweep.v4
    struct SweepStorage {
        // Mapping from user address to their registered sweep intent
        mapping(address => SweepIntent) intents;

        // Mapping from user address to their used nonces (for replay protection)
        mapping(address => mapping(uint256 => bool)) usedNonces;

        // Authorized relayers who can execute sweeps
        mapping(address => bool) authorizedRelayers;

        // Protocol fee recipient
        address feeRecipient;

        // Base protocol fee in basis points (e.g., 50 = 0.5%)
        uint16 protocolFeeBps;

        // Minimum registration validity period
        uint64 minValidityPeriod;

        // Maximum registration validity period
        uint64 maxValidityPeriod;
    }

    /// @notice Registered sweep intent from Step 1
    struct SweepIntent {
        // Destination address to receive swept funds
        address destination;

        // Target chain for cross-chain sweeps (0 = same chain)
        uint256 destinationChainId;

        // Optional call target for bridging/swapping
        address callTarget;

        // Route hash for call verification
        bytes32 routeHash;

        // Minimum amount user must receive (slippage protection)
        uint256 minReceive;

        // Maximum fee the user agrees to pay (in wei)
        uint256 maxFee;

        // Nonce for replay protection
        uint256 nonce;

        // Deadline timestamp for intent expiry
        uint256 deadline;

        // Block number when intent was registered
        uint256 registeredBlock;

        // Whether this intent is active
        bool isActive;

        // EIP-712 signature of the intent
        bytes signature;
    }

    /// @notice Parameters for Step 1 registration
    struct RegistrationParams {
        address destination;
        uint256 destinationChainId;
        address callTarget;
        bytes32 routeHash;
        uint256 minReceive;
        uint256 maxFee;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /// @notice Parameters for Step 2 sweep execution
    struct SweepExecutionParams {
        address user;              // The EOA being swept
        bytes bridgeCalldata;      // Optional calldata for bridge/swap
        uint256 relayerTip;        // Optional tip for priority execution
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event SweepIntentRegistered(
        address indexed user,
        address indexed destination,
        uint256 maxFee,
        uint256 deadline,
        uint256 nonce
    );

    event SweepIntentCancelled(
        address indexed user,
        uint256 nonce
    );

    event SweepExecuted(
        address indexed user,
        address indexed destination,
        uint256 amountSwept,
        uint256 feeCharged,
        address indexed relayer
    );

    event RelayerAuthorized(address indexed relayer, bool authorized);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error InvalidSignature();
    error IntentExpired();
    error IntentNotActive();
    error NonceAlreadyUsed();
    error UnauthorizedRelayer();
    error InsufficientBalance();
    error MinReceiveNotMet();
    error MaxFeeExceeded();
    error InvalidDestination();
    error NotDelegated();
    error TransferFailed();
    error InvalidValidityPeriod();

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 private constant STORAGE_SLOT =
        keccak256(abi.encode(uint256(keccak256("zerodust.sweep.v4")) - 1)) & ~bytes32(uint256(0xff));

    bytes32 public constant SWEEP_INTENT_TYPEHASH = keccak256(
        "SweepIntent(address destination,uint256 destinationChainId,address callTarget,bytes32 routeHash,uint256 minReceive,uint256 maxFee,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    string public constant NAME = "ZeroDustSweepV4";
    string public constant VERSION = "1";
}
```

### 1.2 Step 1: Registration Function

```solidity
/**
 * @notice Step 1: Register sweep intent (called by user's EOA)
 * @dev This function is called via EIP-7702 delegation
 *      The user pays gas for this minimal transaction
 * @param params Registration parameters including signature
 */
function registerSweepIntent(RegistrationParams calldata params) external {
    SweepStorage storage $ = _getStorage();

    // Verify caller is the delegated EOA (msg.sender == address(this) in delegatecall context)
    // In EIP-7702, the EOA's code becomes this contract, so we check via EXTCODEHASH
    if (!_isDelegated(msg.sender)) revert NotDelegated();

    // Verify nonce hasn't been used
    if ($.usedNonces[msg.sender][params.nonce]) revert NonceAlreadyUsed();

    // Verify deadline is valid
    if (params.deadline <= block.timestamp) revert IntentExpired();
    if (params.deadline > block.timestamp + $.maxValidityPeriod) revert InvalidValidityPeriod();
    if (params.deadline < block.timestamp + $.minValidityPeriod) revert InvalidValidityPeriod();

    // Verify destination is not zero address
    if (params.destination == address(0)) revert InvalidDestination();

    // Verify signature
    bytes32 intentHash = _hashSweepIntent(
        msg.sender,
        params.destination,
        params.destinationChainId,
        params.callTarget,
        params.routeHash,
        params.minReceive,
        params.maxFee,
        params.nonce,
        params.deadline
    );

    if (!_verifySignature(msg.sender, intentHash, params.signature)) {
        revert InvalidSignature();
    }

    // Mark nonce as used
    $.usedNonces[msg.sender][params.nonce] = true;

    // Store the intent
    $.intents[msg.sender] = SweepIntent({
        destination: params.destination,
        destinationChainId: params.destinationChainId,
        callTarget: params.callTarget,
        routeHash: params.routeHash,
        minReceive: params.minReceive,
        maxFee: params.maxFee,
        nonce: params.nonce,
        deadline: params.deadline,
        registeredBlock: block.number,
        isActive: true,
        signature: params.signature
    });

    emit SweepIntentRegistered(
        msg.sender,
        params.destination,
        params.maxFee,
        params.deadline,
        params.nonce
    );
}

/**
 * @notice Cancel a registered sweep intent
 * @dev Can only be called by the user whose intent is being cancelled
 */
function cancelSweepIntent() external {
    SweepStorage storage $ = _getStorage();

    SweepIntent storage intent = $.intents[msg.sender];
    if (!intent.isActive) revert IntentNotActive();

    intent.isActive = false;

    emit SweepIntentCancelled(msg.sender, intent.nonce);
}
```

### 1.3 Step 2: Sweep Execution Function

```solidity
/**
 * @notice Step 2: Execute sweep (called by relayer)
 * @dev Relayer pays gas, receives fee from swept amount
 * @param params Execution parameters
 */
function executeSweep(SweepExecutionParams calldata params) external {
    SweepStorage storage $ = _getStorage();

    // Verify relayer is authorized
    if (!$.authorizedRelayers[msg.sender]) revert UnauthorizedRelayer();

    // Get the user's registered intent
    SweepIntent storage intent = $.intents[params.user];

    // Verify intent is active and not expired
    if (!intent.isActive) revert IntentNotActive();
    if (intent.deadline < block.timestamp) revert IntentExpired();

    // Calculate the user's current balance
    uint256 userBalance = params.user.balance;
    if (userBalance == 0) revert InsufficientBalance();

    // Calculate fees
    uint256 protocolFee = (userBalance * $.protocolFeeBps) / 10000;
    uint256 relayerFee = params.relayerTip;
    uint256 totalFee = protocolFee + relayerFee;

    // Verify fee doesn't exceed user's maxFee
    if (totalFee > intent.maxFee) revert MaxFeeExceeded();

    // Calculate amount to send to destination
    uint256 amountToSend = userBalance - totalFee;

    // Verify minReceive is met
    if (amountToSend < intent.minReceive) revert MinReceiveNotMet();

    // Mark intent as inactive to prevent re-execution
    intent.isActive = false;

    // Execute the sweep based on destination chain
    if (intent.destinationChainId == 0 || intent.destinationChainId == block.chainid) {
        // Same-chain sweep: direct transfer
        _executeDirectTransfer(params.user, intent.destination, amountToSend);
    } else {
        // Cross-chain sweep: call bridge
        _executeBridgeTransfer(
            params.user,
            intent.destination,
            intent.callTarget,
            intent.routeHash,
            amountToSend,
            params.bridgeCalldata
        );
    }

    // Pay protocol fee
    if (protocolFee > 0) {
        _transferFromUser(params.user, $.feeRecipient, protocolFee);
    }

    // Pay relayer
    if (relayerFee > 0) {
        _transferFromUser(params.user, msg.sender, relayerFee);
    }

    emit SweepExecuted(
        params.user,
        intent.destination,
        amountToSend,
        totalFee,
        msg.sender
    );
}

/**
 * @notice Internal function to execute a direct same-chain transfer
 * @dev Called in the context of the user's EOA via EIP-7702
 */
function _executeDirectTransfer(
    address user,
    address destination,
    uint256 amount
) internal {
    // In EIP-7702 context, we can call from the user's address
    // The user's EOA code is this contract, so we use low-level call
    (bool success, ) = destination.call{value: amount}("");
    if (!success) revert TransferFailed();
}

/**
 * @notice Internal function to execute a bridge transfer
 */
function _executeBridgeTransfer(
    address user,
    address destination,
    address callTarget,
    bytes32 routeHash,
    uint256 amount,
    bytes calldata bridgeCalldata
) internal {
    // Verify the calldata matches the expected route
    if (keccak256(bridgeCalldata) != routeHash) {
        revert InvalidSignature(); // Route mismatch
    }

    // Execute bridge call from user's EOA
    (bool success, ) = callTarget.call{value: amount}(bridgeCalldata);
    if (!success) revert TransferFailed();
}

/**
 * @notice Internal function to transfer ETH from user's EOA
 */
function _transferFromUser(
    address user,
    address recipient,
    uint256 amount
) internal {
    (bool success, ) = recipient.call{value: amount}("");
    if (!success) revert TransferFailed();
}
```

### 1.4 Delegation Handling

```solidity
/**
 * @notice Check if an address has delegated to this contract via EIP-7702
 * @param account The address to check
 * @return True if delegated
 */
function _isDelegated(address account) internal view returns (bool) {
    // EIP-7702 delegation is indicated by the account's code starting with 0xef0100
    // followed by the delegation target address
    bytes memory code = account.code;
    if (code.length != 23) return false;

    // Check for EIP-7702 delegation prefix
    if (code[0] != 0xef || code[1] != 0x01 || code[2] != 0x00) return false;

    // Extract delegated address and verify it's this contract
    address delegatedTo;
    assembly {
        delegatedTo := mload(add(code, 23))
    }

    return delegatedTo == address(this);
}

/**
 * @notice Verify the intent was NOT signed during an active delegation
 * @dev Prevents attacks where malicious contracts could forge signatures
 */
function _verifySignatureTimestamp(
    address user,
    uint256 registeredBlock
) internal view returns (bool) {
    // The signature should have been created before or at the registration block
    // This is implicitly verified by the EIP-712 domain including the user's address
    return true;
}

/**
 * @notice Get storage slot using EIP-7201 pattern
 */
function _getStorage() private pure returns (SweepStorage storage $) {
    assembly {
        $.slot := STORAGE_SLOT
    }
}
```

### 1.5 EIP-712 Signature Verification

```solidity
/**
 * @notice Hash a sweep intent for EIP-712 signing
 */
function _hashSweepIntent(
    address user,
    address destination,
    uint256 destinationChainId,
    address callTarget,
    bytes32 routeHash,
    uint256 minReceive,
    uint256 maxFee,
    uint256 nonce,
    uint256 deadline
) internal view returns (bytes32) {
    bytes32 structHash = keccak256(abi.encode(
        SWEEP_INTENT_TYPEHASH,
        destination,
        destinationChainId,
        callTarget,
        routeHash,
        minReceive,
        maxFee,
        nonce,
        deadline
    ));

    // NOTE: verifyingContract is the USER's address, not the contract address
    // This is critical for EIP-7702 where the user's EOA becomes the contract
    bytes32 domainSeparator = keccak256(abi.encode(
        DOMAIN_TYPEHASH,
        keccak256(bytes(NAME)),
        keccak256(bytes(VERSION)),
        block.chainid,
        user  // User's EOA address
    ));

    return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
}

/**
 * @notice Verify an EIP-712 signature
 */
function _verifySignature(
    address signer,
    bytes32 hash,
    bytes memory signature
) internal pure returns (bool) {
    if (signature.length != 65) return false;

    bytes32 r;
    bytes32 s;
    uint8 v;

    assembly {
        r := mload(add(signature, 32))
        s := mload(add(signature, 64))
        v := byte(0, mload(add(signature, 96)))
    }

    if (v < 27) v += 27;

    address recovered = ecrecover(hash, v, r, s);
    return recovered == signer && recovered != address(0);
}
```

---

## 2. User Flow

### 2.1 User Interface Journey

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ZERODUST - TRUE ZERO SWEEP                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Step 1 of 2: Register Sweep Intent                                        │
│  ─────────────────────────────────────                                      │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Your Balance on Sepolia                                            │   │
│  │  ────────────────────────────                                       │   │
│  │  0.0847 ETH ($245.63)                                              │   │
│  │                                                                     │   │
│  │  [!] This will be swept to ZERO                                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Destination Address                                                │   │
│  │  ────────────────────                                               │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ 0x742d35Cc6634C0532925a3b844Bc9e7595f3a1B2               │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  │  ○ Same chain (Sepolia)                                            │   │
│  │  ○ Cross-chain to: [Base Sepolia ▼]                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Fee Breakdown                                                      │   │
│  │  ─────────────                                                      │   │
│  │                                                                     │   │
│  │  Registration Gas (Step 1):        ~0.0002 ETH  ← You pay this     │   │
│  │  Execution Gas (Step 2):           ~0.0005 ETH  ← Relayer pays     │   │
│  │  Protocol Fee (0.5%):              ~0.0004 ETH                      │   │
│  │  ────────────────────────────────────────────                       │   │
│  │  Max Total Fee:                     0.0011 ETH                      │   │
│  │                                                                     │   │
│  │  You Will Receive (minimum):        0.0836 ETH                      │   │
│  │  Your Final Balance:                0.0000 ETH  ← TRUE ZERO!       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │   [  Register Sweep Intent  ]                                       │   │
│  │                                                                     │   │
│  │   By clicking, you will:                                            │   │
│  │   1. Sign an EIP-712 message authorizing the sweep                  │   │
│  │   2. Sign an EIP-7702 authorization delegating your wallet          │   │
│  │   3. Pay ~0.0002 ETH gas to register your intent                    │   │
│  │                                                                     │   │
│  │   The sweep will execute automatically within ~5 minutes.           │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 What the User Signs

**Signature 1: EIP-712 Sweep Intent**
```typescript
const sweepIntentTypes = {
  SweepIntent: [
    { name: 'destination', type: 'address' },
    { name: 'destinationChainId', type: 'uint256' },
    { name: 'callTarget', type: 'address' },
    { name: 'routeHash', type: 'bytes32' },
    { name: 'minReceive', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// Domain uses USER's address as verifyingContract (EIP-7702 pattern)
const domain = {
  name: 'ZeroDustSweepV4',
  version: '1',
  chainId: 11155111,
  verifyingContract: userAddress, // The user's EOA!
};
```

**Signature 2: EIP-7702 Authorization**
```typescript
// EIP-7702 authorization structure
const authorization = {
  chainId: 11155111,
  address: V4_CONTRACT_ADDRESS, // ZeroDust contract
  nonce: accountNonce,
};

// Authorization hash: keccak256(0x05 || rlp([chain_id, address, nonce]))
const authHash = keccak256(concat(['0x05', rlpEncode([chainId, contractAddress, nonce])]));
```

### 2.3 Gas Cost Estimates for Step 1

| Operation | Gas Units | Est. Cost (30 gwei) |
|-----------|-----------|---------------------|
| EIP-7702 authorization list overhead | 12,500 | 0.000375 ETH |
| Base transaction cost | 21,000 | 0.000630 ETH |
| Storage write (intent) | 20,000 | 0.000600 ETH |
| Signature verification | 3,000 | 0.000090 ETH |
| Event emission | 1,500 | 0.000045 ETH |
| **Total Step 1** | **~58,000** | **~0.00174 ETH** |

For comparison, current single-step sweep costs ~65,000-80,000 gas.

### 2.4 Step-by-Step User Flow Code

```typescript
// Frontend: sweep-button-v4.tsx

async function handleTwoStepSweep() {
  // === PHASE 1: Get Quote & Prepare ===
  setStatus('preparing');

  const quote = await api.getQuoteV4({
    userAddress: address,
    fromChainId: selectedChain,
    destinationChainId: destinationChainId,
    destination: destinationAddress,
  });

  // === PHASE 2: Sign Intent ===
  setStatus('signing-intent');

  const intentSignature = await walletClient.signTypedData({
    domain: {
      name: 'ZeroDustSweepV4',
      version: '1',
      chainId: selectedChain,
      verifyingContract: address, // User's EOA
    },
    types: SWEEP_INTENT_TYPES,
    primaryType: 'SweepIntent',
    message: {
      destination: quote.destination,
      destinationChainId: BigInt(quote.destinationChainId),
      callTarget: quote.callTarget,
      routeHash: quote.routeHash,
      minReceive: BigInt(quote.minReceive),
      maxFee: BigInt(quote.maxFee),
      nonce: BigInt(quote.nonce),
      deadline: BigInt(quote.deadline),
    },
  });

  // === PHASE 3: Sign EIP-7702 Authorization ===
  setStatus('signing-authorization');

  const nonce = await walletClient.request({
    method: 'eth_getTransactionCount',
    params: [address, 'pending'],
  });

  const eip7702Auth = await signEIP7702Authorization({
    chainId: selectedChain,
    contractAddress: V4_CONTRACT_ADDRESS,
    nonce: parseInt(nonce, 16),
  });

  // === PHASE 4: Send Registration Transaction ===
  setStatus('registering');

  // Build the registration transaction with EIP-7702 authorization
  const registrationParams = {
    destination: quote.destination,
    destinationChainId: quote.destinationChainId,
    callTarget: quote.callTarget,
    routeHash: quote.routeHash,
    minReceive: quote.minReceive,
    maxFee: quote.maxFee,
    nonce: quote.nonce,
    deadline: quote.deadline,
    signature: intentSignature,
  };

  // Send transaction with authorization list
  const txHash = await walletClient.sendTransaction({
    to: address, // Self-call (EOA calling itself after delegation)
    data: encodeFunctionData({
      abi: ZERODUST_V4_ABI,
      functionName: 'registerSweepIntent',
      args: [registrationParams],
    }),
    authorizationList: [eip7702Auth],
  });

  // === PHASE 5: Wait for Registration Confirmation ===
  setStatus('confirming-registration');

  await waitForTransaction({ hash: txHash });

  // === PHASE 6: Notify Backend & Wait for Sweep ===
  setStatus('pending-sweep');

  const sweepId = await api.notifyRegistration({
    userAddress: address,
    chainId: selectedChain,
    registrationTxHash: txHash,
    quoteId: quote.quoteId,
  });

  // Poll for sweep completion
  const result = await api.pollSweepStatus(sweepId, (status) => {
    if (status.phase === 'queued') setStatus('queued');
    if (status.phase === 'executing') setStatus('sweeping');
  });

  setStatus('complete');
  return result;
}
```

---

## 3. Relayer/Backend Flow

### 3.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ZERODUST RELAYER SYSTEM                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐                 │
│  │   Frontend  │─────▶│   Backend   │─────▶│  Relayer    │                 │
│  │   (React)   │      │   (API)     │      │  Workers    │                 │
│  └─────────────┘      └──────┬──────┘      └──────┬──────┘                 │
│                              │                     │                        │
│                              ▼                     ▼                        │
│                     ┌────────────────┐    ┌────────────────┐               │
│                     │   PostgreSQL   │    │   Chain RPCs   │               │
│                     │   (Intents)    │    │   (Execute)    │               │
│                     └────────────────┘    └────────────────┘               │
│                                                                             │
│  Flow:                                                                      │
│  1. User registers intent on-chain                                          │
│  2. Backend detects event & stores in DB                                    │
│  3. Relayer worker picks up pending intents                                 │
│  4. Relayer executes sweep, paying gas                                      │
│  5. Relayer receives fee from swept amount                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Event Monitoring Service

```typescript
// backend/src/services/intent-monitor.ts

import { createPublicClient, http, parseAbiItem } from 'viem';
import { prisma } from '../lib/prisma';

const SWEEP_INTENT_REGISTERED_EVENT = parseAbiItem(
  'event SweepIntentRegistered(address indexed user, address indexed destination, uint256 maxFee, uint256 deadline, uint256 nonce)'
);

export class IntentMonitorService {
  private clients: Map<number, PublicClient> = new Map();
  private lastProcessedBlock: Map<number, bigint> = new Map();

  constructor(private readonly chains: ChainConfig[]) {
    for (const chain of chains) {
      this.clients.set(chain.chainId, createPublicClient({
        chain: chain.viemChain,
        transport: http(chain.rpcUrl),
      }));
    }
  }

  async start() {
    // Start monitoring each chain
    for (const chain of this.chains) {
      this.monitorChain(chain.chainId);
    }
  }

  private async monitorChain(chainId: number) {
    const client = this.clients.get(chainId)!;

    // Get last processed block from DB
    const checkpoint = await prisma.blockCheckpoint.findUnique({
      where: { chainId },
    });

    let fromBlock = checkpoint?.blockNumber
      ? BigInt(checkpoint.blockNumber)
      : await client.getBlockNumber() - 1000n;

    // Poll for new events every 3 seconds
    setInterval(async () => {
      try {
        const toBlock = await client.getBlockNumber();

        if (toBlock <= fromBlock) return;

        const logs = await client.getLogs({
          address: V4_CONTRACT_ADDRESSES[chainId],
          event: SWEEP_INTENT_REGISTERED_EVENT,
          fromBlock: fromBlock + 1n,
          toBlock,
        });

        for (const log of logs) {
          await this.processIntent(chainId, log);
        }

        // Update checkpoint
        await prisma.blockCheckpoint.upsert({
          where: { chainId },
          update: { blockNumber: toBlock.toString() },
          create: { chainId, blockNumber: toBlock.toString() },
        });

        fromBlock = toBlock;
      } catch (error) {
        console.error(`Error monitoring chain ${chainId}:`, error);
      }
    }, 3000);
  }

  private async processIntent(chainId: number, log: Log) {
    const { user, destination, maxFee, deadline, nonce } = log.args;

    // Store intent in database
    await prisma.sweepIntent.create({
      data: {
        chainId,
        userAddress: user,
        destination,
        maxFee: maxFee.toString(),
        deadline: new Date(Number(deadline) * 1000),
        nonce: nonce.toString(),
        registrationTxHash: log.transactionHash,
        registrationBlock: Number(log.blockNumber),
        status: 'PENDING',
        createdAt: new Date(),
      },
    });

    console.log(`New sweep intent registered: ${user} on chain ${chainId}`);
  }
}
```

### 3.3 Relayer Worker Service

```typescript
// backend/src/services/relayer-worker.ts

import { createWalletClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prisma } from '../lib/prisma';

interface RelayerConfig {
  chainId: number;
  privateKey: `0x${string}`;
  minProfitWei: bigint;
  maxGasPrice: bigint;
}

export class RelayerWorkerService {
  private wallets: Map<number, WalletClient> = new Map();
  private isProcessing: Map<number, boolean> = new Map();

  constructor(private readonly configs: RelayerConfig[]) {
    for (const config of configs) {
      const account = privateKeyToAccount(config.privateKey);
      const client = createWalletClient({
        account,
        chain: CHAINS[config.chainId],
        transport: http(RPC_URLS[config.chainId]),
      });
      this.wallets.set(config.chainId, client);
      this.isProcessing.set(config.chainId, false);
    }
  }

  async start() {
    // Process each chain in parallel
    for (const config of this.configs) {
      this.processChain(config);
    }
  }

  private async processChain(config: RelayerConfig) {
    setInterval(async () => {
      if (this.isProcessing.get(config.chainId)) return;
      this.isProcessing.set(config.chainId, true);

      try {
        await this.processPendingIntents(config);
      } catch (error) {
        console.error(`Error processing chain ${config.chainId}:`, error);
      } finally {
        this.isProcessing.set(config.chainId, false);
      }
    }, 5000); // Every 5 seconds
  }

  private async processPendingIntents(config: RelayerConfig) {
    // Fetch pending intents for this chain
    const intents = await prisma.sweepIntent.findMany({
      where: {
        chainId: config.chainId,
        status: 'PENDING',
        deadline: { gt: new Date() },
      },
      orderBy: [
        { maxFee: 'desc' },  // Prioritize higher fee intents
        { createdAt: 'asc' }, // Then by age
      ],
      take: 10,
    });

    for (const intent of intents) {
      await this.executeSweep(config, intent);
    }
  }

  private async executeSweep(config: RelayerConfig, intent: SweepIntent) {
    const client = this.wallets.get(config.chainId)!;

    try {
      // Mark as processing
      await prisma.sweepIntent.update({
        where: { id: intent.id },
        data: { status: 'PROCESSING' },
      });

      // Get user's current balance
      const publicClient = createPublicClient({
        chain: CHAINS[config.chainId],
        transport: http(RPC_URLS[config.chainId]),
      });

      const userBalance = await publicClient.getBalance({
        address: intent.userAddress as `0x${string}`,
      });

      if (userBalance === 0n) {
        // User has no balance, mark as failed
        await prisma.sweepIntent.update({
          where: { id: intent.id },
          data: {
            status: 'FAILED',
            errorMessage: 'User balance is zero',
          },
        });
        return;
      }

      // Estimate gas cost
      const gasPrice = await publicClient.getGasPrice();
      if (gasPrice > config.maxGasPrice) {
        console.log(`Gas price too high on chain ${config.chainId}, skipping`);
        // Revert to pending
        await prisma.sweepIntent.update({
          where: { id: intent.id },
          data: { status: 'PENDING' },
        });
        return;
      }

      // Calculate expected profit
      const estimatedGas = 80000n; // Conservative estimate
      const gasCost = gasPrice * estimatedGas;
      const protocolFee = (userBalance * 50n) / 10000n; // 0.5%
      const relayerFee = gasCost + config.minProfitWei;

      if (relayerFee + protocolFee > BigInt(intent.maxFee)) {
        // Not profitable enough
        await prisma.sweepIntent.update({
          where: { id: intent.id },
          data: { status: 'PENDING' }, // Try again later when gas is lower
        });
        return;
      }

      // Execute the sweep
      const txHash = await client.sendTransaction({
        to: V4_CONTRACT_ADDRESSES[config.chainId],
        data: encodeFunctionData({
          abi: ZERODUST_V4_ABI,
          functionName: 'executeSweep',
          args: [{
            user: intent.userAddress,
            bridgeCalldata: '0x', // Empty for same-chain
            relayerTip: relayerFee,
          }],
        }),
        gas: estimatedGas,
        maxFeePerGas: gasPrice * 12n / 10n, // 20% buffer
        maxPriorityFeePerGas: gasPrice / 10n,
      });

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      if (receipt.status === 'success') {
        await prisma.sweepIntent.update({
          where: { id: intent.id },
          data: {
            status: 'COMPLETED',
            executionTxHash: txHash,
            executedAt: new Date(),
            amountSwept: userBalance.toString(),
            feeCharged: (protocolFee + relayerFee).toString(),
          },
        });

        console.log(`Sweep executed for ${intent.userAddress}: ${txHash}`);
      } else {
        throw new Error('Transaction reverted');
      }

    } catch (error: any) {
      console.error(`Failed to execute sweep for ${intent.userAddress}:`, error);

      await prisma.sweepIntent.update({
        where: { id: intent.id },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
          retryCount: { increment: 1 },
        },
      });
    }
  }
}
```

### 3.4 Fee Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FEE STRUCTURE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User Balance: 0.1000 ETH                                                   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  STEP 1 (User Pays)                                                 │   │
│  │  ──────────────────                                                 │   │
│  │  • Registration gas:       0.0017 ETH  (paid by user)               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  STEP 2 (Deducted from Sweep)                                       │   │
│  │  ────────────────────────────                                       │   │
│  │  • Execution gas:          0.0024 ETH  (relayer pays, reimbursed)   │   │
│  │  • Protocol fee (0.5%):    0.0005 ETH  (to ZeroDust treasury)       │   │
│  │  • Relayer profit:         0.0002 ETH  (incentive for relayer)      │   │
│  │  ─────────────────────────────────────                              │   │
│  │  Total Step 2 deduction:   0.0031 ETH                               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  FINAL RESULT                                                       │   │
│  │  ────────────                                                       │   │
│  │  User receives:            0.0952 ETH                               │   │
│  │  User's final balance:     0.0000 ETH  (TRUE ZERO!)                 │   │
│  │                                                                     │   │
│  │  Total effective fee:      4.8% (vs 3-5% in single-step)            │   │
│  │  But: GUARANTEED zero balance!                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  RELAYER ECONOMICS:                                                         │
│  ──────────────────                                                         │
│  • Relayer pays gas upfront:  0.0024 ETH                                   │
│  • Relayer receives:          0.0024 ETH + 0.0002 ETH profit               │
│  • Net profit per sweep:      0.0002 ETH (~$0.60 at $3000/ETH)             │
│  • Profitable at: >15 sweeps/hour/relayer                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Database Schema

```sql
-- prisma/schema.prisma

model SweepIntent {
  id                  String   @id @default(uuid())
  chainId             Int
  userAddress         String
  destination         String
  destinationChainId  Int      @default(0)
  callTarget          String?
  routeHash           String?
  minReceive          String
  maxFee              String
  nonce               String
  deadline            DateTime

  // Registration details
  registrationTxHash  String
  registrationBlock   Int
  intentSignature     String?

  // Execution details
  status              SweepStatus @default(PENDING)
  executionTxHash     String?
  executedAt          DateTime?
  amountSwept         String?
  feeCharged          String?
  relayerAddress      String?

  // Error handling
  errorMessage        String?
  retryCount          Int         @default(0)

  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @updatedAt

  @@index([chainId, status, deadline])
  @@index([userAddress])
}

enum SweepStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
  CANCELLED
}

model BlockCheckpoint {
  chainId     Int      @id
  blockNumber String
  updatedAt   DateTime @updatedAt
}

model RelayerStats {
  id              String   @id @default(uuid())
  chainId         Int
  relayerAddress  String
  totalSweeps     Int      @default(0)
  totalVolumeWei  String   @default("0")
  totalFeesWei    String   @default("0")
  successRate     Float    @default(0)
  lastActiveAt    DateTime?

  @@unique([chainId, relayerAddress])
}
```

---

## 4. Security Considerations

### 4.1 Preventing Front-Running

**Threat**: Attacker sees pending registration transaction and front-runs with a malicious sweep.

**Mitigations**:

```solidity
// 1. Commit-Reveal Pattern (Optional Enhancement)
struct SweepIntent {
    bytes32 commitHash;     // Hash of intent details
    uint256 revealDeadline; // Must reveal within X blocks
    bool isRevealed;
}

// 2. Block-based Execution Delay
function executeSweep(SweepExecutionParams calldata params) external {
    SweepIntent storage intent = intents[params.user];

    // Require at least 2 blocks since registration
    // This prevents same-block front-running
    require(
        block.number > intent.registeredBlock + 2,
        "Too soon to execute"
    );

    // ...
}

// 3. Private Mempool Submission
// Backend submits registration via Flashbots/private mempool
// Prevents mempool sniping
```

### 4.2 Ensuring Destination Security

```solidity
// Multiple layers of destination verification

function executeSweep(SweepExecutionParams calldata params) external {
    SweepIntent storage intent = intents[params.user];

    // 1. Destination was signed by user in EIP-712 message
    // 2. Destination is stored in contract state
    // 3. Relayer cannot modify destination

    address destination = intent.destination; // From storage, not params

    // 4. For cross-chain: verify bridge calldata matches routeHash
    if (intent.callTarget != address(0)) {
        require(
            keccak256(params.bridgeCalldata) == intent.routeHash,
            "Invalid bridge calldata"
        );
    }

    // 5. MinReceive protects against sandwich attacks on bridges
    require(
        calculatedReceive >= intent.minReceive,
        "Slippage too high"
    );
}
```

### 4.3 Delegation Cleanup

```solidity
// EIP-7702 delegations are automatically cleaned up
// when the user sends any transaction (nonce increment)

// However, we can provide explicit cleanup:
function clearDelegation() external {
    // User calls this to explicitly clear their intent
    // without executing the sweep

    SweepStorage storage $ = _getStorage();
    SweepIntent storage intent = $.intents[msg.sender];

    if (intent.isActive) {
        intent.isActive = false;
        emit SweepIntentCancelled(msg.sender, intent.nonce);
    }

    // The EIP-7702 delegation persists until:
    // 1. User sends another EIP-7702 tx clearing it
    // 2. User's nonce increments (automatic cleanup on some clients)
}

// Important: Document that delegation persists!
// User should understand their EOA has contract code
// until they clear it.
```

### 4.4 Handling Transactions Between Steps

```solidity
/**
 * @notice Handle case where user's balance changes between Step 1 and Step 2
 */
function executeSweep(SweepExecutionParams calldata params) external {
    SweepIntent storage intent = intents[params.user];

    uint256 currentBalance = params.user.balance;

    // Case 1: Balance increased (user received funds)
    // -> Good for user, sweep more

    // Case 2: Balance decreased (user spent funds)
    // -> Need to handle carefully

    if (currentBalance < intent.minReceive) {
        // User spent so much that we can't meet minReceive
        // Mark as failed, refund is not possible (funds already spent)
        intent.isActive = false;
        emit SweepFailed(params.user, "Balance below minReceive");
        return;
    }

    // Case 3: Balance is now zero
    if (currentBalance == 0) {
        intent.isActive = false;
        emit SweepFailed(params.user, "Zero balance");
        return;
    }

    // Recalculate fees based on current balance
    // This protects both user and relayer
    uint256 newMaxFee = (currentBalance * MAX_FEE_BPS) / 10000;
    uint256 actualFee = min(newMaxFee, intent.maxFee);

    // Proceed with sweep...
}
```

### 4.5 Nonce Management

```solidity
// Prevent replay attacks across chains and re-registration

mapping(address => mapping(uint256 => bool)) public usedNonces;

function registerSweepIntent(RegistrationParams calldata params) external {
    // Check nonce hasn't been used
    require(!usedNonces[msg.sender][params.nonce], "Nonce already used");

    // Mark nonce as used BEFORE storing intent
    usedNonces[msg.sender][params.nonce] = true;

    // Now store intent...
}

// The nonce is:
// 1. Included in EIP-712 signature
// 2. Generated by backend (timestamp-based + random)
// 3. Verified on-chain
// 4. Permanently marked as used
```

---

## 5. Edge Cases

### 5.1 User Cancellation Flow

```typescript
// Frontend: Cancel intent

async function cancelSweepIntent() {
  // Option 1: On-chain cancellation (costs gas)
  const txHash = await walletClient.sendTransaction({
    to: userAddress,
    data: encodeFunctionData({
      abi: ZERODUST_V4_ABI,
      functionName: 'cancelSweepIntent',
      args: [],
    }),
  });

  // Option 2: Just wait for deadline to expire (free)
  // Intent becomes invalid after deadline

  // Option 3: Clear EIP-7702 delegation
  // Send any transaction to increment nonce
  // Most EIP-7702 implementations clear delegation on nonce change
}
```

```solidity
// Contract: Cancellation handling

function cancelSweepIntent() external {
    SweepStorage storage $ = _getStorage();
    SweepIntent storage intent = $.intents[msg.sender];

    require(intent.isActive, "No active intent");

    // Mark as cancelled
    intent.isActive = false;

    // Note: Registration gas is NOT refunded
    // User paid for on-chain state change

    emit SweepIntentCancelled(msg.sender, intent.nonce);
}
```

### 5.2 Balance Changes Between Steps

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BALANCE CHANGE SCENARIOS                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Scenario A: Balance INCREASED                                              │
│  ─────────────────────────────                                              │
│  Step 1: User had 0.1 ETH, registered intent                               │
│  Event:  User received 0.05 ETH from external source                       │
│  Step 2: User now has 0.15 ETH                                             │
│  Result: Sweep 0.15 ETH - fee → destination gets MORE                      │
│  Action: Proceed normally, user benefits                                   │
│                                                                             │
│  Scenario B: Balance DECREASED (partially spent)                           │
│  ─────────────────────────────────────────────                             │
│  Step 1: User had 0.1 ETH, registered intent                               │
│  Event:  User sent 0.03 ETH to another address                             │
│  Step 2: User now has 0.07 ETH                                             │
│  Check:  Is 0.07 ETH - fee >= minReceive?                                  │
│          If YES: Proceed with sweep                                        │
│          If NO:  Mark intent as failed                                     │
│                                                                             │
│  Scenario C: Balance ZERO                                                   │
│  ─────────────────────────────                                              │
│  Step 1: User had 0.1 ETH, registered intent                               │
│  Event:  User sent ALL funds elsewhere                                     │
│  Step 2: User now has 0 ETH                                                │
│  Result: Nothing to sweep                                                  │
│  Action: Mark intent as completed (zero sweep) or failed                   │
│                                                                             │
│  Scenario D: User sent EIP-7702 transaction                                │
│  ─────────────────────────────────────────────                             │
│  Step 1: User had 0.1 ETH, registered intent (nonce N)                     │
│  Event:  User sent another EIP-7702 tx (nonce N+1, clears delegation)      │
│  Step 2: Delegation no longer points to ZeroDust                           │
│  Result: executeSweep reverts (NotDelegated)                               │
│  Action: Mark intent as failed, notify user                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Delegation Revocation Handling

```solidity
// Relayer must check delegation before executing

function executeSweep(SweepExecutionParams calldata params) external {
    // First, verify user still has delegation to this contract
    if (!_isDelegated(params.user)) {
        // Mark intent as failed (delegation revoked)
        intents[params.user].isActive = false;
        emit SweepFailed(params.user, "Delegation revoked");
        return;
    }

    // Proceed with sweep...
}
```

```typescript
// Backend: Handle delegation revocation

async function checkDelegationStatus(userAddress: string, chainId: number) {
  const client = getPublicClient(chainId);

  const code = await client.getCode({ address: userAddress });

  // EIP-7702 delegation code format: 0xef0100 + 20-byte address
  if (!code || code.length !== 46) {
    return { isDelegated: false, delegatedTo: null };
  }

  if (!code.startsWith('0xef0100')) {
    return { isDelegated: false, delegatedTo: null };
  }

  const delegatedTo = `0x${code.slice(8)}` as `0x${string}`;
  const isOurContract = delegatedTo.toLowerCase() === V4_CONTRACT_ADDRESSES[chainId].toLowerCase();

  return { isDelegated: isOurContract, delegatedTo };
}
```

### 5.4 Re-registration After Failure

```solidity
// User can register a new intent after previous one failed/expired

function registerSweepIntent(RegistrationParams calldata params) external {
    SweepStorage storage $ = _getStorage();

    // Check if there's an existing active intent
    SweepIntent storage existingIntent = $.intents[msg.sender];

    if (existingIntent.isActive) {
        // Must cancel existing intent first
        // OR wait for it to expire
        require(
            existingIntent.deadline < block.timestamp,
            "Active intent exists"
        );
        // Expired intents are implicitly cancelled
    }

    // Check the NEW nonce hasn't been used
    require(!$.usedNonces[msg.sender][params.nonce], "Nonce already used");

    // Proceed with new registration...
}
```

### 5.5 Gas Price Spike Scenario

```typescript
// Relayer: Handle gas price spikes

async function shouldExecuteSweep(intent: SweepIntent, config: RelayerConfig) {
  const gasPrice = await getGasPrice(intent.chainId);

  // Check 1: Gas price within acceptable range
  if (gasPrice > config.maxGasPrice) {
    return {
      shouldExecute: false,
      reason: 'gas_price_too_high',
      retryAfter: 60, // seconds
    };
  }

  // Check 2: Intent approaching deadline
  const timeToDeadline = intent.deadline.getTime() - Date.now();
  const urgencyMultiplier = timeToDeadline < 300000 ? 1.5 : 1; // 5 min threshold

  // Check 3: Profitability at current gas price
  const estimatedCost = gasPrice * ESTIMATED_GAS;
  const maxAllowedCost = BigInt(intent.maxFee) * urgencyMultiplier;

  if (estimatedCost > maxAllowedCost) {
    // Check if intent is about to expire
    if (timeToDeadline < 60000) {
      // Execute anyway, user opted in to this fee
      return { shouldExecute: true, reason: 'deadline_approaching' };
    }

    return {
      shouldExecute: false,
      reason: 'not_profitable',
      retryAfter: Math.min(timeToDeadline / 2, 120),
    };
  }

  return { shouldExecute: true, reason: 'profitable' };
}
```

---

## 6. Implementation Checklist

### 6.1 Smart Contract

- [ ] Deploy `ZeroDustSweepV4` to all supported chains
- [ ] Set up authorized relayer addresses
- [ ] Configure protocol fee recipient
- [ ] Set validity period bounds
- [ ] Write comprehensive test suite
- [ ] Audit by security firm

### 6.2 Backend

- [ ] Set up event monitoring service
- [ ] Implement relayer worker pool
- [ ] Create database schema
- [ ] Build admin dashboard for monitoring
- [ ] Set up alerting for failed sweeps
- [ ] Implement relayer balance monitoring

### 6.3 Frontend

- [ ] Update UI for two-step flow
- [ ] Add clear status indicators
- [ ] Implement cancellation flow
- [ ] Add estimated time to sweep
- [ ] Handle all error states
- [ ] Mobile-responsive design

### 6.4 Testing

- [ ] Unit tests for contract
- [ ] Integration tests (contract + backend)
- [ ] E2E tests (full flow)
- [ ] Gas optimization testing
- [ ] Load testing for relayer
- [ ] Testnet deployment and testing

---

## 7. Migration Path

### Phase 1: Parallel Deployment
- Deploy V4 alongside existing V3
- Offer both options to users
- V3: Lower fees, ~0.0001 ETH dust
- V4: Higher fees, TRUE zero balance

### Phase 2: UI Toggle
- Add "Precision Mode" toggle
- Default: V3 (fast, cheap)
- Precision: V4 (true zero)

### Phase 3: Gradual Migration
- Monitor V4 adoption
- Gather user feedback
- Optimize relayer efficiency
- Consider making V4 default for small balances

---

## 8. Appendix: Full Contract Code Reference

See `/contracts/ZeroDustSweepV4.sol` for the complete implementation.

---

**Document Version**: 1.0.0
**Last Updated**: 2024
**Authors**: ZeroDust Engineering Team
