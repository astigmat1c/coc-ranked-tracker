import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ranked Tracker',
  description: 'Clash of Clans ranked league standings, season history, and player comparison.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              Ranked Tracker
            </Link>
            <nav className="flex items-center gap-4 text-sm text-[var(--text-secondary)]">
              <Link href="/rankings" className="hover:text-[var(--text-primary)]">
                Rankings
              </Link>
              <Link href="/compare" className="hover:text-[var(--text-primary)]">
                Compare
              </Link>
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>

        <footer className="mx-auto max-w-7xl px-4 py-8 text-xs text-[var(--text-muted)]">
          Data from the official Clash of Clans API. This site is not affiliated with, endorsed by,
          or sponsored by Supercell.
        </footer>
      </body>
    </html>
  );
}
