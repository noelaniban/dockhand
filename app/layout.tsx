import type { Metadata } from 'next';
import '@fontsource-variable/inter'; // self-hosted, so builds work offline
import './globals.css';

export const metadata: Metadata = {
  title: 'Dockhand control tower',
  description: 'Dockhand does the legwork. You make the call.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
