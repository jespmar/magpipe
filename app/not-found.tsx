import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 ambient px-4 text-center">
      <span className="eyebrow">Off the map</span>
      <h1 className="page-title">This bird flew off</h1>
      <Link href="/" className="text-body-sm text-cyan hover:text-ghost">
        Back to the nest
      </Link>
    </main>
  );
}
