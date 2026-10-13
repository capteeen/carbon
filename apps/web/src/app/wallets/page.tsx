import type { Metadata } from 'next';
import { WalletsView } from '@/components/WalletsView';
import { argonWallets, network } from '@/server/env';
import { listLaunchWallets } from '@/server/readmodel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Wallets' };

export default async function WalletsPage() {
  return <WalletsView rows={await listLaunchWallets()} argon={argonWallets()} network={network()} />;
}
