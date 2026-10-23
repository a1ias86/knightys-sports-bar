import { NextResponse } from 'next/server';
import { currentMember } from '@/lib/session';
import { exportCompetition } from '@/lib/export';
import { sql } from '@/lib/db';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const me = await currentMember();
  if (!me || me.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403 });
  const data = await exportCompetition();
  await audit(sql, { id: me.id, displayName: me.displayName }, 'export.downloaded', null, null, {});
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="knightys-backup-${data.exportedAt.slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    },
  });
}
