import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Providers } from '@/components/providers';
import { Header } from '@/components/layout/header';
import { Footer } from '@/components/layout/footer';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
});

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ZeroDust - Sweep Your Dust to Zero',
  description: 'Exit any blockchain with exactly 0 balance. Sweep leftover ETH from unused chains to your main wallet.',
  keywords: ['ethereum', 'dust', 'sweep', 'wallet', 'crypto', 'defi', 'eip-7702'],
  authors: [{ name: 'ZeroDust' }],
  openGraph: {
    title: 'ZeroDust - Sweep Your Dust to Zero',
    description: 'Exit any blockchain with exactly 0 balance.',
    url: 'https://zerodust.xyz',
    siteName: 'ZeroDust',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ZeroDust - Sweep Your Dust to Zero',
    description: 'Exit any blockchain with exactly 0 balance.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${jetbrains.variable} font-sans antialiased`}>
        <Providers>
          <div className="min-h-screen flex flex-col">
            <Header />
            <main className="flex-1">
              {children}
            </main>
            <Footer />
          </div>
        </Providers>
      </body>
    </html>
  );
}
