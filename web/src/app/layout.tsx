import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { WalletProviders } from "@/components/WalletProviders";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GaslessSwap · Solana",
  description: "Swap Solana tokens with best-price Jupiter routing and sponsored gas.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full w-full flex-col">
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
