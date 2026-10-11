import { readFile } from 'node:fs/promises';
import type { Metadata } from 'next';
import { Markdown } from '@/components/Markdown';
import { howDocPath } from '@/lib/how-path';

// Built once from docs/how.md; the doc's generated blocks are checked against code by test/how.test.tsx.
export const dynamic = 'force-static';
export const metadata: Metadata = { title: 'How it works' };

export default async function HowPage() {
  const source = await readFile(howDocPath(), 'utf8');
  return <Markdown source={source} />;
}
