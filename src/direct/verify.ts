import { BURN_ADDRESS, GASZIP_DEPOSIT, LIFI_DIAMOND, RELAY_DEPOSIT_NATIVE, ZERODUST_ADDRESS, type DirectPlan, type PlanMode } from './plan';

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

export function verifyPlan(plan: DirectPlan, ctx: PlanContext): void {
  const fail = (why: string): never => { throw new Error(`Plan refused: ${why}`); };
  if (plan.chainId !== ctx.chainId) fail('it is for another chain');
  if (plan.txs.length < 1 || plan.txs.length > 2) fail('expected one or two transactions');
  if (BigInt(plan.balance) !== ctx.balance) fail('the balance changed since it was planned; check again');

  const price = BigInt(plan.txs[0]!.gasPrice);
  plan.txs.forEach((t, i) => {
    if (t.nonce !== ctx.nonce + i) fail('nonces are stale or out of order; check again');
    if (BigInt(t.gasPrice) !== price || price <= 0n) fail('gas prices differ');
    if (BigInt(t.gas) < 21_000n || BigInt(t.value) < 0n) fail('a transaction has impossible gas or value');
    if (t.kind === 'fee' && i !== 0) fail('the fee must come first');
  });

  const [first] = plan.txs;
  const last = plan.txs[plan.txs.length - 1]!;
  const fee = first!.kind === 'fee' ? first! : null;
  if (fee) {
    if (!eq(fee.to, ZERODUST_ADDRESS) || fee.data !== '0x') fail('the fee does not go to ZeroDust as a plain transfer');
    if (BigInt(fee.value) * MAX_FEE_SHARE > ctx.balance) fail('the fee is above 5% of the balance');
    if (ctx.mode === 'burn' || ctx.mode === 'donate') fail('burn and donate carry no fee');
  }
  if (last.kind === 'fee') fail('the plan only pays the fee');

  const spend = totalSpend(plan);
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
      return;
    case 'donate':
      if (plan.route !== 'donate' || !eq(last.to, ZERODUST_ADDRESS) || last.data !== '0x') fail('the donation does not go to ZeroDust');
      return;
    case 'exit':
      if (plan.route !== 'lifi' || last.kind !== 'swap' || !eq(last.to, LIFI_DIAMOND)) fail('the swap does not go to LI.FI\'s contract');
      if (ctx.toChainId === ctx.chainId) fail('a swap exit must leave the chain');
      return;
    case 'route':
      break;
  }
  if (last.kind !== 'sweep') fail('the last transaction is not the sweep');
  if (ctx.toChainId === ctx.chainId) {
    if (plan.route !== 'transfer' || !eq(last.to, ctx.recipient) || last.data !== '0x') fail('the transfer does not go to the address you set');
    if (eq(ctx.recipient, ctx.from)) fail('a same-chain sweep needs another address');
    return;
  }
  if (plan.route === 'gaszip') {
    if (!eq(last.to, GASZIP_DEPOSIT)) fail('the deposit does not go to Gas.zip');
    // 0x01 + short sends to the depositor, 0x02 + recipient + short to another address
    const toSelf = eq(ctx.recipient, ctx.from);
    const ok = toSelf
      ? /^0x01[0-9a-f]{4}$/i.test(last.data)
      : new RegExp(`^0x02${recipientBody}[0-9a-f]{4}$`, 'i').test(last.data);
    if (!ok) fail('the Gas.zip deposit does not name the address you set');
    return;
  }
  if (plan.route === 'relay') {
    if (!last.data.toLowerCase().startsWith(RELAY_DEPOSIT_NATIVE)) fail('the Relay call is not a plain deposit');
    if (!eq(`0x${last.data.slice(34, 74)}`, ctx.from)) fail('the Relay deposit does not credit this wallet');
    return;
  }
  fail(`unknown route ${plan.route}`);
}
