'use client';

import Link from 'next/link';

import { usePathname } from 'next/navigation';
import { useState } from 'react';

const navigation = [
  {
    title: 'Getting Started',
    items: [
      { title: 'Introduction', href: '/docs' },
      { title: 'Quick Start', href: '/docs/getting-started' },
    ],
  },
  {
    title: 'SDK',
    items: [
      { title: 'Overview', href: '/docs/sdk' },
      { title: 'Client', href: '/docs/sdk/client' },
      { title: 'Agent', href: '/docs/sdk/agent' },
      { title: 'Errors', href: '/docs/sdk/errors' },
    ],
  },
  {
    title: 'AI Integrations',
    items: [
      { title: 'Overview', href: '/docs/integrations' },
      { title: 'MCP Server', href: '/docs/integrations/mcp' },
      { title: 'LangChain', href: '/docs/integrations/langchain' },
      { title: 'Vercel AI SDK', href: '/docs/integrations/ai-sdk' },
    ],
  },
  {
    title: 'API',
    items: [{ title: 'REST API', href: '/docs/api' }],
  },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="space-y-6">
      {navigation.map((section) => (
        <div key={section.title}>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-2 px-3">
            {section.title}
          </h4>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const isActive = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={`block px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-brand-primary/10 text-brand-primary dark:text-brand-light font-medium'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/50'
                    }`}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex gap-8">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block w-56 shrink-0">
          <div className="sticky top-24">
            <SidebarContent />
          </div>
        </aside>

        {/* Mobile sidebar toggle */}
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="lg:hidden fixed bottom-6 right-6 z-50 btn-primary p-3 rounded-full shadow-lg"
          aria-label="Toggle docs navigation"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {mobileOpen ? (
              <path d="M18 6L6 18M6 6l12 12" />
            ) : (
              <>
                <path d="M3 12h18M3 6h18M3 18h18" />
              </>
            )}
          </svg>
        </button>

        {/* Mobile sidebar overlay */}
        {mobileOpen && (
          <>
            <div
              className="lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              onClick={() => setMobileOpen(false)}
            />
            <aside className="lg:hidden fixed inset-y-0 left-0 z-40 w-64 bg-light-surface dark:bg-dark-surface border-r border-light-border dark:border-dark-border p-6 pt-20 overflow-y-auto">
              <SidebarContent onNavigate={() => setMobileOpen(false)} />
            </aside>
          </>
        )}

        {/* Content */}
        <main className="min-w-0 flex-1 max-w-3xl">
          {/* Typography for docs pages comes from mdx-components.tsx, which maps
              each MDX element to explicit classes. A `.tsx` page added here
              would inherit no styling — see LegalArticle for that case. */}
          <article>{children}</article>
        </main>
      </div>
    </div>
  );
}
