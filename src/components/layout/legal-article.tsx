import type { ReactNode } from 'react';

/**
 * Wrapper for long-form legal copy (terms, privacy).
 *
 * The docs section gets its typography from `mdx-components.tsx`, which only
 * applies to `.mdx` files. These pages are `.tsx`, so the element styles are
 * declared here instead — deliberately mirroring the MDX ones so legal pages
 * and docs read as the same site.
 */
export function LegalArticle({ children }: { children: ReactNode }) {
  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <article
        className={[
          'mx-auto max-w-3xl',
          '[&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:mb-2 [&_h1]:text-zinc-900 dark:[&_h1]:text-zinc-100',
          '[&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:mt-10 [&_h2]:mb-4 [&_h2]:pb-2 [&_h2]:border-b [&_h2]:border-light-border dark:[&_h2]:border-dark-border [&_h2]:text-zinc-900 dark:[&_h2]:text-zinc-100',
          '[&_p]:text-zinc-600 dark:[&_p]:text-zinc-300 [&_p]:leading-relaxed [&_p]:mb-4',
          '[&_ul]:list-disc [&_ul]:list-inside [&_ul]:space-y-1.5 [&_ul]:mb-4 [&_ul]:text-zinc-600 dark:[&_ul]:text-zinc-300',
          '[&_a]:text-brand-primary dark:[&_a]:text-brand-light [&_a]:font-medium hover:[&_a]:underline',
          '[&_strong]:font-semibold [&_strong]:text-zinc-900 dark:[&_strong]:text-zinc-100',
          '[&_.lead]:text-sm [&_.lead]:text-zinc-500 dark:[&_.lead]:text-zinc-400 [&_.lead]:mb-10',
        ].join(' ')}
      >
        {children}
      </article>
    </div>
  );
}
