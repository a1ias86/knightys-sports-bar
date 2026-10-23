import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="wrap" style={{ paddingTop: 80, paddingBottom: 80 }}>
      <h1>Offside</h1>
      <p className="muted">That page doesn&rsquo;t exist.</p>
      <Link className="btn" href="/">Back to the dashboard</Link>
    </main>
  );
}
