import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/cron';
import { syncFixtures, syncSquads, syncResults } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Daily: refresh fixtures (postponements, kick-off changes), squads, and pick up any missed results. */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const fixtures = await syncFixtures();
  const squads = await syncSquads();
  const results = await syncResults({ limit: 6 });
  return NextResponse.json({ fixtures, squads, results });
}
