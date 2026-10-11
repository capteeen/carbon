import type { Metadata } from 'next';
import { ReceiptsView } from '@/components/ReceiptsView';
import { listReceipts } from '@/server/readmodel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Receipts' };

export default async function ReceiptsPage() {
  return <ReceiptsView rows={await listReceipts()} />;
}
