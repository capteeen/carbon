'use client';
/**
 * Solana wallet context. wallets=[] lets the adapter discover Wallet Standard
 * wallets (Phantom, Solflare, Backpack) that the browser actually has installed.
 * Nothing auto-connects: the user picks a wallet.
 */
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { clusterApiUrl } from '@solana/web3.js';
import type { ReactNode } from 'react';

const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl('devnet');

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
