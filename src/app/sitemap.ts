import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

export const dynamic = 'force-static';

/** Docs routes, mirroring the `page.mdx` files under `src/app/docs`. */
const DOCS_PATHS = [
  '/docs',
  '/docs/getting-started',
  '/docs/api',
  '/docs/sdk',
  '/docs/sdk/client',
  '/docs/sdk/agent',
  '/docs/sdk/errors',
  '/docs/integrations',
  '/docs/integrations/mcp',
  '/docs/integrations/langchain',
  '/docs/integrations/ai-sdk',
];

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1 },
    ...DOCS_PATHS.map((path) => ({
      url: `${SITE_URL}${path}`,
      changeFrequency: 'monthly' as const,
      priority: path === '/docs' ? 0.8 : 0.6,
    })),
    { url: `${SITE_URL}/terms`, changeFrequency: 'yearly' as const, priority: 0.3 },
    { url: `${SITE_URL}/privacy`, changeFrequency: 'yearly' as const, priority: 0.3 },
  ];
}
