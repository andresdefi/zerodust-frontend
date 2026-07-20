'use client';

import Link from 'next/link';
import { Github, FileText, ExternalLink } from 'lucide-react';

// X (Twitter) logo component
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const footerLinks = {
  product: [
    { label: 'How it works', href: '#how-it-works' },
    { label: 'Supported Chains', href: '#chains' },
    { label: 'Fees', href: '#fees' },
  ],
  resources: [
    { label: 'Documentation', href: '/docs' },
    { label: 'GitHub', href: 'https://github.com/andresdefi/zerodust', external: true },
    { label: 'SDK', href: 'https://www.npmjs.com/package/@zerodust/sdk', external: true },
  ],
  legal: [
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Privacy Policy', href: '/privacy' },
  ],
};

const socialLinks = [
  { icon: XLogo, href: 'https://x.com/zerodustxyz', label: 'X (Twitter)' },
  { icon: Github, href: 'https://github.com/andresdefi/zerodust', label: 'GitHub' },
  { icon: FileText, href: '/docs', label: 'Docs' },
];

export function Footer() {
  return (
    <footer className="border-t border-sand-200 dark:border-dark-border bg-sand-50/50 dark:bg-dark-surface/50">
      <div className="container mx-auto px-4">
        {/* Main footer content */}
        <div className="py-12 md:py-16">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-12">
            {/* Brand column */}
            <div className="lg:col-span-1">
              <Link href="/" className="inline-block mb-4">
                <span className="text-xl font-bold tracking-tight">
                  <span className="text-brand-primary dark:text-brand-light">Zero</span>
                  <span className="text-sand-500 dark:text-sand-400">Dust</span>
                </span>
              </Link>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6 max-w-xs">
                Sweep your leftover balance to zero. Exit any blockchain without leaving dust behind.
              </p>
              {/* Social links */}
              <div className="flex items-center gap-3">
                {socialLinks.map((social) => (
                  <Link
                    key={social.label}
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-social"
                    aria-label={social.label}
                  >
                    <social.icon className="w-5 h-5" />
                  </Link>
                ))}
              </div>
            </div>

            {/* Product links */}
            <div>
              <h3 className="text-sm font-semibold mb-4">Product</h3>
              <ul className="space-y-3">
                {footerLinks.product.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Resources links */}
            <div>
              <h3 className="text-sm font-semibold mb-4">Resources</h3>
              <ul className="space-y-3">
                {footerLinks.resources.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      target={link.external ? '_blank' : undefined}
                      rel={link.external ? 'noopener noreferrer' : undefined}
                      className="text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors inline-flex items-center gap-1"
                    >
                      {link.label}
                      {link.external && <ExternalLink className="w-3 h-3" />}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Legal links */}
            <div>
              <h3 className="text-sm font-semibold mb-4">Legal</h3>
              <ul className="space-y-3">
                {footerLinks.legal.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="py-6 border-t border-light-border dark:border-dark-border">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-sm text-zinc-500 dark:text-zinc-500">
              &copy; {new Date().getFullYear()} ZeroDust. All rights reserved.
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-500">
              Built by{' '}
              <Link
                href="https://x.com/AndresDefi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-primary hover:text-brand-dark transition-colors"
              >
                andresdefi
              </Link>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
