export const API_URL = 'https://api.zerodust.xyz';

/**
 * ZeroDustPermissionRouter v2 (CREATE2, the same address on every chain it is on) and
 * MetaMask's DelegationManager. Pinned here, never taken from the API: a quote or batch
 * naming another contract is refused before MetaMask is asked for anything.
 */
export const PERMISSION_ROUTER = '0x369A97dd256F7eb37fF7116C4EcBd50318eBb286';
export const DELEGATION_MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
/** The router's EIP-712 domain version (name "ZeroDust", verifyingContract = router, no chain id) */
export const PERMISSION_DOMAIN_VERSION = 'permission-2';
