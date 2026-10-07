import { verifyAcrossDeposit } from './across';
import { decodeFunctionData, parseAbi } from 'viem';
import { tokenExitFor } from './plan';
import { BURN_ADDRESS, GASLIMIT_CHAINS, GASZIP_DEPOSIT, LIFI_DIAMOND, PAYMASTER_GENERAL, RELAY_DEPOSIT_NATIVE, ZERODUST_ADDRESS, ZK_PAYMASTERS, type DirectPlan, type PlanMode } from './plan';

const OFT_SEND = parseAbi(['function sendFrom(address from, uint16 dstChainId, bytes32 toAddress, uint256 amount, (address refundAddress, address zroPaymentAddress, bytes adapterParams) callParams) payable']);

// The API is untrusted input: before anything is signed, the page checks the
// plan against what the owner asked for and against chain state it read
// itself. A plan that fails any check is refused, never "fixed".

export interface PlanContext {
  chainId: number;
  toChainId: number;
  from: string;
  recipient: string;
  mode: PlanMode;
  /** The wallet's balance and next nonce, read by the page from the chain's RPC */
  balance: bigint;
  nonce: number;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Wei the set spends: every value plus every gas x price */
export function totalSpend(plan: Pick<DirectPlan, 'txs'>): bigint {
  return plan.txs.reduce((sum, t) => sum + BigInt(t.value) + BigInt(t.gas) * BigInt(t.gasPrice), 0n);
}

/** The service fee is at most 5% of the balance (the schedule's highest rate) */
export const MAX_FEE_SHARE = 20n; // 1/20 = 5%

/** What the caller still has to confirm on-chain or in time before signing */
export interface PlanChecks {
  /** Across: the destination swap's 0x Settler (confirm in 0x's registry) and when the deposit expires */
  across?: { settler: string; expiresAt: number };
}

export function verifyPlan(plan: DirectPlan, ctx: PlanContext): PlanChecks {
  const fail = (why: string): never => { throw new Error(`Plan refused: ${why}`); };
  const gasLimitChain = GASLIMIT_CHAINS.has(ctx.chainId);
  // ZK-stack chains: the paymaster pays the gas, so only values leave the wallet
  const paymaster = ZK_PAYMASTERS[ctx.chainId];
  if (plan.chainId !== ctx.chainId) fail('it is for another chain');
  if (plan.txs.length < 1 || plan.txs.length > 2) fail('expected one or two transactions');
  if (BigInt(plan.balance) !== ctx.balance) fail('the balance changed since it was planned; check again');

  const price = BigInt(plan.txs[0]!.gasPrice);
  plan.txs.forEach((t, i) => {
    if (t.nonce !== ctx.nonce + i) fail('nonces are stale or out of order; check again');
    if (BigInt(t.gasPrice) !== price || price <= 0n) fail('gas prices differ');
    if (BigInt(t.gas) < 21_000n || BigInt(t.value) < 0n) fail('a transaction has impossible gas or value');
    if (t.kind === 'fee' && i !== 0) fail('the fee must come first');
    // A chain that charges the whole limit: a plain transfer is exactly 21,000, never more
    if (gasLimitChain && t.data === '0x' && BigInt(t.gas) !== 21_000n) fail('a plain transfer asks for more than 21,000 gas');
    if (paymaster) {
      if (!t.paymaster || !eq(t.paymaster, paymaster)) fail('a transaction does not use ZeroDust\'s paymaster');
      if (!t.paymasterInput?.toLowerCase().startsWith(PAYMASTER_GENERAL)) fail('the paymaster input is not the general flow');
      if (!t.gasPerPubdata || BigInt(t.gasPerPubdata) <= 0n) fail('a transaction has no gas per pubdata limit');
    } else if (t.paymaster !== undefined || t.paymasterInput !== undefined) {
      fail('a paymaster appears on a chain that does not use one');
    }
  });

  const [first] = plan.txs;
  const last = plan.txs[plan.txs.length - 1]!;
  const fee = first!.kind === 'fee' ? first! : null;
  if (fee && paymaster) {
    // The fee transaction pays the service fee and prepays both transactions' gas to the paymaster
    if (!eq(fee.to, paymaster) || fee.data !== '0x') fail('the fee does not go to the paymaster as a plain transfer');
    const service = BigInt(plan.fee);
    const gasFee = BigInt(plan.gasFee ?? '-1');
    if (gasFee < 0n || BigInt(fee.value) !== service + gasFee) fail('the fee transaction is not the fee plus the gas');
    if (service * MAX_FEE_SHARE > ctx.balance) fail('the fee is above 5% of the balance');
    const maxGas = plan.txs.reduce((sum, t) => sum + BigInt(t.gas) * BigInt(t.gasPrice), 0n);
    if (gasFee > maxGas) fail('it prepays more gas than both transactions may cost');
    if ((ctx.mode === 'burn' || ctx.mode === 'donate') && service !== 0n) fail('burn and donate carry no fee');
  } else if (fee) {
    if (!eq(fee.to, ZERODUST_ADDRESS) || fee.data !== '0x') fail('the fee does not go to ZeroDust as a plain transfer');
    if (BigInt(fee.value) * MAX_FEE_SHARE > ctx.balance) fail('the fee is above 5% of the balance');
    if (ctx.mode === 'burn' || ctx.mode === 'donate') fail('burn and donate carry no fee');
  }
  if (last.kind === 'fee') fail('the plan only pays the fee');

  // Where a paymaster pays the gas, only the values leave the wallet
  const spend = paymaster ? plan.txs.reduce((sum, t) => sum + BigInt(t.value), 0n) : totalSpend(plan);
  if (ctx.mode === 'exit') {
    if (spend > ctx.balance) fail('it spends more than the balance');
    if (!plan.leftoverMax || BigInt(plan.leftoverMax) < ctx.balance - spend) fail('the swap leftover is not bounded');
  } else if (spend !== ctx.balance) {
    fail('it would not leave exactly 0');
  }

  const recipientBody = ctx.recipient.slice(2).toLowerCase();
  switch (ctx.mode) {
    case 'burn':
      if (plan.route !== 'burn' || !eq(last.to, BURN_ADDRESS) || last.data !== '0x') fail('the burn does not go to the burn address');
      return {};
    case 'donate':
      if (plan.route !== 'donate' || !eq(last.to, ZERODUST_ADDRESS) || last.data !== '0x') fail('the donation does not go to ZeroDust');
      return {};
    case 'exit': {
      if (ctx.toChainId === ctx.chainId) fail('a swap exit must leave the chain');
      const tokenExit = tokenExitFor(ctx.chainId, ctx.toChainId);
      if (!tokenExit) {
        if (plan.route !== 'lifi' || last.kind !== 'swap' || !eq(last.to, LIFI_DIAMOND)) fail('the swap does not go to LI.FI\'s contract');
        return {};
      }
      // The chain's own bridge: sendFrom(wallet, destination, recipient, amount, refund elsewhere than the wallet)
      if (plan.route !== 'oft' || last.kind !== 'sweep' || !eq(last.to, tokenExit.oft)) fail(`the transfer does not go to ${tokenExit.bridge}`);
      let args: readonly [string, number, string, bigint, { refundAddress: string; zroPaymentAddress: string }];
      try {
        args = decodeFunctionData({ abi: OFT_SEND, data: last.data as `0x${string}` }).args as typeof args;
      } catch {
        return fail('the bridge call is not a sendFrom');
      }
      const [from, dst, to, amount, params] = args;
      if (!eq(from, ctx.from)) fail('the bridge transfer sends from another wallet');
      if (dst !== tokenExit.lzChainId) fail('the bridge transfer goes to another chain');
      if (to.toLowerCase() !== `0x${recipientBody.padStart(64, '0')}`) fail('the bridge transfer pays someone else');
      // A refund to the wallet would leave dust; ZeroDust or the burn address only
      if (!eq(params.refundAddress, ZERODUST_ADDRESS) && !eq(params.refundAddress, BURN_ADDRESS)) fail('the bridge fee refund does not go to ZeroDust');
      if (BigInt(params.zroPaymentAddress) !== 0n) fail('the bridge transfer pays in ZRO');
      if (amount === 0n || amount >= BigInt(last.value)) fail('the bridged amount does not fit in the value sent');
      if (BigInt(plan.receive) !== amount) fail('the amount shown is not the amount bridged');
      return {};
    }
    case 'route':
      break;
  }
  if (last.kind !== 'sweep') fail('the last transaction is not the sweep');
  if (ctx.toChainId === ctx.chainId) {
    if (plan.route !== 'transfer' || !eq(last.to, ctx.recipient) || last.data !== '0x') fail('the transfer does not go to the address you set');
    if (eq(ctx.recipient, ctx.from)) fail('a same-chain sweep needs another address');
    return {};
  }
  if (plan.route === 'gaszip') {
    if (!eq(last.to, GASZIP_DEPOSIT)) fail('the deposit does not go to Gas.zip');
    // 0x01 + short sends to the depositor, 0x02 + recipient + short to another address
    const toSelf = eq(ctx.recipient, ctx.from);
    const ok = toSelf
      ? /^0x01[0-9a-f]{4}$/i.test(last.data)
      : new RegExp(`^0x02${recipientBody}[0-9a-f]{4}$`, 'i').test(last.data);
    if (!ok) fail('the Gas.zip deposit does not name the address you set');
    return {};
  }
  if (plan.route === 'relay') {
    if (!last.data.toLowerCase().startsWith(RELAY_DEPOSIT_NATIVE)) fail('the Relay call is not a plain deposit');
    if (!eq(`0x${last.data.slice(34, 74)}`, ctx.from)) fail('the Relay deposit does not credit this wallet');
    return {};
  }
  if (plan.route === 'across') {
    // Its swap refunds gas, so only where the whole limit is charged does it leave exactly 0
    if (!gasLimitChain) fail('Across is only used on chains that charge the whole gas limit');
    if (BigInt(plan.receive) <= 0n) fail('it shows nothing arriving');
    try {
      const across = verifyAcrossDeposit(last, {
        chainId: ctx.chainId, toChainId: ctx.toChainId, from: ctx.from, recipient: ctx.recipient,
        value: BigInt(last.value), minNative: BigInt(plan.receive),
      });
      return { across };
    } catch (error) {
      return fail((error as Error).message);
    }
  }
  return fail(`unknown route ${plan.route}`);
}
