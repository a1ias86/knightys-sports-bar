import postgres from 'postgres';
import { env } from './env';

/**
 * One shared postgres.js client per server instance.
 * `prepare: false` keeps it compatible with Supabase's transaction pooler (port 6543) on Vercel.
 */
type Sql = postgres.Sql<Record<string, never>>;

const globalForDb = globalThis as unknown as { __ksbSql?: Sql };

function createClient(url: string): Sql {
  return postgres(url, {
    prepare: false,
    max: Number(process.env.DB_POOL_MAX || 5),
    idle_timeout: 20,
    connect_timeout: 15,
    transform: { column: { from: postgres.toCamel }, undefined: null },
    onnotice: () => {},
  }) as unknown as Sql;
}

export function getSql(): Sql {
  if (!globalForDb.__ksbSql) globalForDb.__ksbSql = createClient(env.databaseUrl);
  return globalForDb.__ksbSql;
}

/** Lazily-connected client; importing this module never opens a connection by itself. */
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply(_t, _this, args) {
    return (getSql() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_t, prop) {
    const real = getSql() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Db = Sql | Tx;

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

export async function closeDb() {
  if (globalForDb.__ksbSql) {
    await globalForDb.__ksbSql.end({ timeout: 5 });
    globalForDb.__ksbSql = undefined;
  }
}
