import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Beignet — Your everyday wallet',
  manifest: '/manifest.webmanifest',
  description:
    'A simple Lightning-first Bitcoin wallet, on this device or connected to your own host.',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
