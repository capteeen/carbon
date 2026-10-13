import Link from 'next/link';

export default function NotFound() {
  return (
    <div>
      <h1 className="section-title">Not found</h1>
      <p className="meta">// No launch or page with this address exists in the Argon log.</p>
      <Link href="/">Back to ARGON</Link>
    </div>
  );
}
