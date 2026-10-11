'use client';
/**
 * Connect a Solana wallet (Wallet Standard: Phantom, Solflare, Backpack, ...).
 * Lists only wallets the browser really has; Carbon never holds the user's keys.
 */
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { encodeSignature } from '@/lib/signing';

export function useSigner() {
  const w = useWallet();
  const address = w.publicKey?.toBase58() ?? null;
  const signText = useCallback(
    async (text: string): Promise<string> => {
      if (!w.signMessage) throw new Error('This wallet cannot sign messages');
      const sig = await w.signMessage(new TextEncoder().encode(text));
      return encodeSignature(sig);
    },
    [w],
  );
  const signTx = useCallback(
    async (txBase64: string): Promise<string> => {
      if (!w.signTransaction) throw new Error('This wallet cannot sign transactions');
      const bytes = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(bytes);
      const signed = await w.signTransaction(tx);
      let bin = '';
      for (const b of signed.serialize()) bin += String.fromCharCode(b);
      return btoa(bin);
    },
    [w],
  );
  return { connected: w.connected, address, signText, signTx, disconnect: w.disconnect };
}

export function WalletConnect() {
  const { wallets, select, connect, connected, connecting, publicKey, wallet, disconnect } = useWallet();
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Connect once the chosen wallet is selected in the provider (select() is async state).
  useEffect(() => {
    if (!pending || !wallet || connected || connecting) return;
    setPending(false);
    connect().catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not connect'));
  }, [pending, wallet, connected, connecting, connect]);
  const available = wallets.filter((x) => x.readyState === WalletReadyState.Installed || x.readyState === WalletReadyState.Loadable);

  // Installed wallets are only known in the browser: render the list after mount (no hydration mismatch).
  if (!mounted) return <p className="meta" data-testid="wallet-connect">// detecting wallets…</p>;
  if (connected && publicKey) {
    return (
      <div className="row" data-testid="wallet-connected">
        <span className="meta">// {wallet?.adapter.name} · </span>
        <code>{publicKey.toBase58()}</code>
        <button type="button" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div data-testid="wallet-connect">
      {available.length === 0 ? (
        <p className="meta">// No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.</p>
      ) : (
        <div className="row">
          {available.map((x) => (
            <button
              key={x.adapter.name}
              type="button"
              disabled={connecting}
              onClick={() => {
                setErr(null);
                select(x.adapter.name);
                setPending(true);
              }}
            >
              {x.adapter.name}
            </button>
          ))}
        </div>
      )}
      {err ? <p className="error-text">{err}</p> : null}
      {connecting ? <p className="meta">// connecting…</p> : null}
    </div>
  );
}
