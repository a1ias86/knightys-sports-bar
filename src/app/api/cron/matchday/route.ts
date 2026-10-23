import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/cron';
import { syncLineups, syncResults } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Frequent: line-ups before kick-off and results after full time. Makes no provider calls unless a
 * fixture is in its window, so running it every 15 minutes is cheap. Needs Vercel Pro or an external
 * scheduler (see docs/DEPLOYMENT.md), because Vercel Hobby only allows daily cron jobs.
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const lineups = await syncLineups();
  const results = await syncResults();
  return NextResponse.json({ lineups, results });
}
