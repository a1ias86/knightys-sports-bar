import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Liveness + database check for monitoring. Reveals nothing sensitive. */
export async function GET() {
  try {
    await sql`select 1`;
    return NextResponse.json({ ok: true, db: 'ok' });
  } catch {
    return NextResponse.json({ ok: false, db: 'unreachable' }, { status: 503 });
  }
}
