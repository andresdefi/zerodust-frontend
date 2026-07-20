import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // The sweep UI is per-wallet and has nothing to index.
        disallow: ['/api/', '/app'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
