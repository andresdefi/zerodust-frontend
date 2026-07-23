// ZeroDust Backend API Service

// Use local proxy in development to avoid CORS issues
const API_URL = typeof window !== 'undefined' && window.location.hostname === 'localhost'
  ? '/api/proxy'
  : (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001');

export interface ChainBalance {
  chainId: number;
  name: string;
  nativeToken: string;
  balance: string;
  balanceFormatted: string;
  canSweep: boolean;
  minBalance: string;
}

export interface BalancesResponse {
  address: string;
  chains: ChainBalance[];
}

export interface QuoteRequest {
  fromChainId: number;
  toChainId: number;
  userAddress: string;
  destination: string;
}

export interface QuoteResponse {
  quoteId: string;
  version: number;
  userBalance: string;
  estimatedReceive: string;
  mode: number; // 0 = transfer, 1 = call
  fees: {
    overheadGasUnits: string;
    protocolFeeGasUnits: string;
    extraFeeWei: string;
    reimbGasPriceCapWei: string;
    maxTotalFeeWei: string;
  };
  intent: {
    mode: number;
    destination: string;
    destinationChainId: string;
    callTarget: string;
    routeHash: string;
    minReceive: string;
  };
  deadline: number;
  nonce: number;
  authNonce: number;  // Transaction count for EIP-7702 authorization
  validForSeconds: number;
}

// EIP-712 types for signing (must match backend exactly!)
export const SWEEP_INTENT_TYPES = {
  SweepIntent: [
    { name: 'mode', type: 'uint8' },
    { name: 'user', type: 'address' },
    { name: 'destination', type: 'address' },
    { name: 'destinationChainId', type: 'uint256' },
    { name: 'callTarget', type: 'address' },
    { name: 'routeHash', type: 'bytes32' },
    { name: 'minReceive', type: 'uint256' },
    { name: 'maxTotalFeeWei', type: 'uint256' },
    { name: 'overheadGasUnits', type: 'uint256' },
    { name: 'protocolFeeGasUnits', type: 'uint256' },
    { name: 'extraFeeWei', type: 'uint256' },
    { name: 'reimbGasPriceCapWei', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export interface EIP7702Authorization {
  chainId: number;
  contractAddress: string;
  nonce: number;
  yParity: number;
  r: string;
  s: string;
}

export interface SweepRequest {
  quoteId: string;
  signature: string;
  eip7702Authorization: EIP7702Authorization;
  revokeAuthorization?: EIP7702Authorization;
}

// Two-step sweep request (no EIP-7702 auth needed - user is already registered)
export interface SweepTwoStepRequest {
  quoteId: string;
  signature: string;
}

export interface SweepResponse {
  sweepId: string;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed';
  sweepType: 'same-chain' | 'cross-chain';
  isExisting: boolean;
  version: number;
}

export interface SweepStatusResponse {
  sweepId: string;
  status: 'pending' | 'queued' | 'processing' | 'bridging' | 'completed' | 'failed';
  txHash?: string;
  destinationTxHash?: string;
  error?: string;
  completedAt?: string;
  userReceived?: string;
  fromChainId?: number;
  toChainId?: number;
}

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new ApiError(response.status, error.error || error.message || `HTTP ${response.status}`, error.code);
  }

  return response.json();
}

export const api = {
  /**
   * Get balances for an address across all supported chains
   */
  async getBalances(address: string, testnet = false): Promise<BalancesResponse> {
    return fetchApi<BalancesResponse>(`/balances/${address}?testnet=${testnet}`);
  },

  /**
   * Get a quote for sweeping a wallet
   */
  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const params = new URLSearchParams({
      fromChainId: request.fromChainId.toString(),
      toChainId: request.toChainId.toString(),
      userAddress: request.userAddress,
      destination: request.destination,
    });
    return fetchApi<QuoteResponse>(`/quote?${params.toString()}`);
  },

  /**
   * Submit a signed sweep request (one-step - requires EIP-7702 auth)
   */
  async submitSweep(request: SweepRequest): Promise<SweepResponse> {
    return fetchApi<SweepResponse>('/sweep', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  /**
   * Submit a signed sweep request (two-step - user already registered)
   * This is for the two-step flow where user's EOA is already delegated to the contract
   */
  async submitSweepTwoStep(request: SweepTwoStepRequest): Promise<SweepResponse> {
    return fetchApi<SweepResponse>('/sweep/two-step', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  /**
   * Get the status of a sweep
   */
  async getSweepStatus(sweepId: string): Promise<SweepStatusResponse> {
    return fetchApi<SweepStatusResponse>(`/sweep/${sweepId}`);
  },

  /**
   * Poll for sweep completion
   * For cross-chain sweeps, returns when status is 'bridging' (source tx confirmed)
   * or 'completed'/'failed' (final states)
   */
  async pollSweepStatus(
    sweepId: string,
    onUpdate?: (status: SweepStatusResponse) => void,
    maxAttempts = 60,
    intervalMs = 2000
  ): Promise<SweepStatusResponse> {
    let lastStatus: SweepStatusResponse | null = null;
    let networkErrors = 0;
    const maxNetworkErrors = 3;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await this.getSweepStatus(sweepId);
        lastStatus = status;
        networkErrors = 0; // Reset on success

        if (onUpdate) {
          onUpdate(status);
        }

        // Terminal states - stop polling
        if (status.status === 'completed' || status.status === 'failed') {
          return status;
        }

        // For cross-chain 'bridging': keep polling but use longer interval
        // The bridge monitor checks Gas.zip every 10s, so we poll every 5s for updates
        const pollInterval = status.status === 'bridging' ? 5000 : intervalMs;
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (err) {
        networkErrors++;
        console.warn(`Poll attempt ${i + 1} failed:`, err);

        // If we have a last known status with txHash, return it instead of failing
        if (lastStatus?.txHash && networkErrors >= maxNetworkErrors) {
          console.warn('Max network errors reached, returning last known status');
          return lastStatus;
        }

        // Allow a few retries for transient network issues
        if (networkErrors >= maxNetworkErrors) {
          throw new Error('Unable to check sweep status. Please check the transaction on the block explorer.');
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    // If we have a status with txHash but timed out, return it
    if (lastStatus?.txHash) {
      return lastStatus;
    }

    throw new Error('Sweep status check timed out');
  },

  /**
   * Build EIP-712 domain for signing
   * NOTE: Uses the USER's address as verifyingContract (EIP-7702), not the contract address
   */
  buildEIP712Domain(chainId: number, userAddress: string) {
    return {
      name: 'ZeroDust',
      version: '3',
      chainId: chainId,
      verifyingContract: userAddress as `0x${string}`,
    };
  },

  /**
   * Build the message to sign for sweep
   * Field order must match SWEEP_INTENT_TYPES exactly!
   */
  buildSweepIntentMessage(quote: QuoteResponse, userAddress: string) {
    return {
      mode: quote.intent.mode,
      user: userAddress as `0x${string}`,
      destination: quote.intent.destination as `0x${string}`,
      destinationChainId: BigInt(quote.intent.destinationChainId),
      callTarget: quote.intent.callTarget as `0x${string}`,
      routeHash: quote.intent.routeHash as `0x${string}`,
      minReceive: BigInt(quote.intent.minReceive),
      maxTotalFeeWei: BigInt(quote.fees.maxTotalFeeWei),
      overheadGasUnits: BigInt(quote.fees.overheadGasUnits),
      protocolFeeGasUnits: BigInt(quote.fees.protocolFeeGasUnits),
      extraFeeWei: BigInt(quote.fees.extraFeeWei),
      reimbGasPriceCapWei: BigInt(quote.fees.reimbGasPriceCapWei),
      deadline: BigInt(quote.deadline),
      nonce: BigInt(quote.nonce),
    };
  },
};

export { ApiError };
