'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="wrap" style={{ paddingTop: 80, paddingBottom: 80 }}>
      <h1>Something went wrong</h1>
      <p className="muted">The page couldn&rsquo;t load. Nothing you saved has been lost. Try again, and if it keeps happening let Jon or Knighty know.</p>
      <button className="btn" onClick={() => reset()}>Try again</button>
    </main>
  );
}
