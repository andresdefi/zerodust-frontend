import type { Metadata } from 'next';

import { LegalArticle } from '@/components/layout/legal-article';

export const metadata: Metadata = {
  title: 'Privacy Policy - ZeroDust',
  description: 'What data ZeroDust collects and how it is used.',
};

export default function PrivacyPage() {
  return (
    <LegalArticle>
      <h1>Privacy Policy</h1>
        <p className="lead">Last updated: July 2026</p>

        <h2>No accounts</h2>
        <p>
          ZeroDust has no sign-up, no login, and no user accounts. We do not ask for your name,
          email address, or any other identifying information, and we do not have a way to link a
          wallet address to a person.
        </p>

        <h2>What we store</h2>
        <p>To operate the sweep service, we record:</p>
        <ul>
          <li>the wallet address being swept and the destination address you specify;</li>
          <li>source and destination chain IDs, amounts, and fee values;</li>
          <li>the signatures you submit, and the resulting transaction hashes;</li>
          <li>sweep status and timestamps.</li>
        </ul>
        <p>
          This record is what lets you query the status of a sweep and lets us diagnose failures.
          We also process IP addresses transiently for rate limiting and abuse prevention.
        </p>

        <h2>What we never store</h2>
        <p>
          We never receive or store private keys or seed phrases. Signing happens in your wallet or
          on your own machine; only the resulting signatures are transmitted.
        </p>

        <h2>On-chain data is public</h2>
        <p>
          Every sweep is a public blockchain transaction. Addresses, amounts, and timestamps are
          permanently visible to anyone, on every block explorer, independently of this site. No
          privacy policy can change that — please account for it before sweeping.
        </p>

        <h2>Third parties</h2>
        <p>Operating the service involves:</p>
        <ul>
          <li>public and commercial RPC providers, which observe request data including addresses;</li>
          <li>a price feed used to compute the service fee;</li>
          <li>Gas.zip, for cross-chain sweeps;</li>
          <li>our hosting and database providers.</li>
        </ul>
        <p>We do not sell data, and we do not share it for advertising.</p>

        <h2>Analytics</h2>
        <p>
          We use privacy-preserving, cookie-free analytics to count page views and understand which
          pages are used. It does not track individuals across sites and does not attempt to
          identify you.
        </p>

        <h2>Retention</h2>
        <p>
          Sweep records are retained as long as needed to operate and support the service. Because
          the underlying transactions are on a public blockchain, deleting our records would not
          remove the transaction data itself.
        </p>

        <h2>Contact</h2>
        <p>
        Privacy questions can be raised as an issue on the{' '}
        <a href="https://github.com/andresdefi/zerodust">public repository</a>.
      </p>
    </LegalArticle>
  );
}
