import type { Metadata } from 'next';

import { LegalArticle } from '@/components/layout/legal-article';

export const metadata: Metadata = {
  title: 'Terms of Service - ZeroDust',
  description: 'Terms governing use of the ZeroDust sweep service.',
};

export default function TermsPage() {
  return (
    <LegalArticle>
      <h1>Terms of Service</h1>
        <p className="lead">Last updated: July 2026</p>

        <h2>1. What ZeroDust does</h2>
        <p>
          ZeroDust sweeps the native gas token balance of an address on a supported EVM chain,
          leaving a balance of exactly zero. You sign an EIP-7702 authorization and an EIP-712
          sweep intent; a relayer operated by ZeroDust submits the resulting transaction and pays
          the gas, and is reimbursed out of the swept balance.
        </p>

        <h2>2. Non-custodial</h2>
        <p>
          ZeroDust never takes custody of your funds. Each sweep is a single atomic transaction:
          your balance moves directly to the destination you signed for. ZeroDust cannot initiate a
          transfer without a valid signature from you, cannot alter the destination after you sign,
          and cannot take more than the maximum fee you signed.
        </p>
        <p>
          The delegation you sign is limited to one specific contract, one specific chain, and one
          specific account nonce. It can be used once and is revoked after the sweep.
        </p>

        <h2>3. Fees</h2>
        <p>
          The relayer is reimbursed for gas out of the swept amount. A service fee of 1% applies,
          with a minimum of $0.05 and a maximum of $0.50. Balances worth under $1 are swept without
          a service fee. Every quote states the maximum total fee before you sign, and that maximum
          is enforced on-chain — the transaction cannot charge more.
        </p>

        <h2>4. No warranty</h2>
        <p>
          ZeroDust is provided &ldquo;as is&rdquo;, without warranty of any kind. The smart contract
          has <strong>not been independently audited</strong>. Blockchain transactions are
          irreversible. You are responsible for verifying the destination address before signing;
          funds sent to an address you do not control cannot be recovered by anyone, including us.
        </p>

        <h2>5. Availability</h2>
        <p>
          The service depends on third parties including RPC providers, price feeds, and — for
          cross-chain sweeps — the Gas.zip bridge. It may be unavailable, paused per-chain, or
          discontinued at any time without notice. Quotes expire within 60 seconds.
        </p>

        <h2>6. Cross-chain sweeps</h2>
        <p>
          For cross-chain sweeps, funds are routed through a third-party bridge. Once funds enter
          the bridge, delivery is the bridge operator&rsquo;s responsibility, not ZeroDust&rsquo;s.
          Bridge delays and failures are outside our control.
        </p>

        <h2>7. Your responsibilities</h2>
        <p>
          You are responsible for the security of your own keys, for complying with the laws that
          apply to you, and for any tax consequences of your transactions. Do not use ZeroDust
          where doing so would be unlawful.
        </p>

        <h2>8. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, ZeroDust and its operator are not liable for any
          indirect, incidental, or consequential damages, or for any loss of funds arising from
          smart contract vulnerabilities, bridge failures, chain reorganisations, or your own
          errors in specifying a destination.
        </p>

        <h2>9. Changes</h2>
        <p>
          These terms may be updated. Continued use of the service after a change constitutes
          acceptance of the revised terms.
        </p>

        <h2>10. Contact</h2>
        <p>
        Questions about these terms can be raised as an issue on the{' '}
        <a href="https://github.com/andresdefi/zerodust">public repository</a>.
      </p>
    </LegalArticle>
  );
}
