import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env';

/**
 * Database access for the app.
 *
 * Uses node-postgres (`pg`), which sends ONE query at a time per connection and uses unnamed statements.
 * That is what Supabase's transaction pooler (port 6543) expects, and the pooler is the right choice on
 * Vercel because it allows hundreds of clients (the session pooler caps at ~15 and runs out quickly).
 *
 * A small tagged-template layer keeps the call sites simple and injection-safe:
 *   sql`select * from members where id = ${id}`     → parameterised query ($1)
 *   sql`... ${sql`and active`} ...`                 → nested fragment (never executed on its own)
 *   sql`... where id in ${sql(ids)}`                → ($1, $2, ...)
 *   sql.json(value)                                 → JSON parameter for jsonb columns
 *   sql.begin(async (tx) => { ... })                → transaction on a single connection
 * Result rows have snake_case columns converted to camelCase.
 */

type Row = Record<string, unknown>;

class Fragment {
  constructor(readonly strings: readonly string[], readonly values: readonly unknown[]) {}
}
class ListParam {
  constructor(readonly items: readonly unknown[]) {}
}
class JsonParam {
  constructor(readonly value: unknown) {}
}

type Runner = (text: string, params: unknown[]) => Promise<Row[]>;

/** A query is lazy: it only runs when awaited, so it can also be embedded as a fragment. */
class Query<T> extends Fragment implements Promise<T> {
  readonly [Symbol.toStringTag] = 'Query';
  private promise: Promise<T> | null = null;
  constructor(strings: readonly string[], values: readonly unknown[], private readonly run: Runner) {
    super(strings, values);
  }
  then<A = T, B = never>(onFulfilled?: ((value: T) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    if (!this.promise) {
      const params: unknown[] = [];
      const text = compile(this, params);
      this.promise = this.run(text, params) as Promise<T>;
    }
    return this.promise.then(onFulfilled, onRejected);
  }
  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.then(undefined, onRejected);
  }
  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.then().finally(onFinally);
  }
}

function compile(frag: Fragment, params: unknown[]): string {
  let text = frag.strings[0];
  frag.values.forEach((v, i) => {
    if (v instanceof Fragment) {
      text += compile(v, params);
    } else if (v instanceof ListParam) {
      if (!v.items.length) throw new Error('Empty list in an IN (...) clause');
      text += '(' + v.items.map((x) => { params.push(x); return '$' + params.length; }).join(', ') + ')';
    } else if (v instanceof JsonParam) {
      params.push(JSON.stringify(v.value ?? null));
      text += '$' + params.length;
    } else {
      params.push(v === undefined ? null : v);
      text += '$' + params.length;
    }
    text += frag.strings[i + 1];
  });
  return text;
}

const toCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function camelRows(rows: QueryResultRow[]): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const k of Object.keys(r)) out[toCamel(k)] = r[k];
    return out;
  });
}

export interface Sql {
  <T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Query<T>;
  (items: readonly unknown[]): ListParam;
  json(value: unknown): JsonParam;
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

function makeSql(run: Runner, begin: Sql['begin']): Sql {
  const tag = ((first: TemplateStringsArray | readonly unknown[], ...values: unknown[]) => {
    if (Array.isArray(first) && 'raw' in (first as object)) return new Query(first as readonly string[], values, run);
    return new ListParam(first as readonly unknown[]);
  }) as Sql;
  tag.json = (value: unknown) => new JsonParam(value);
  tag.begin = begin;
  return tag;
}

// ─── Pool ─────────────────────────────────────────────────────

const globalForDb = globalThis as unknown as { __ksbPool?: Pool };

function pool(): Pool {
  if (!globalForDb.__ksbPool) {
    const url = env.databaseUrl;
    const remote = !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    globalForDb.__ksbPool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX || 3),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      // Supabase accepts TLS; its certificate isn't in Node's default store, so encrypt without CA pinning.
      ssl: remote && !/sslmode=disable/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    globalForDb.__ksbPool.on('error', (e) => console.error('[db] idle client error', e.message));
  }
  return globalForDb.__ksbPool;
}

async function runOn(client: Pool | PoolClient, text: string, params: unknown[]): Promise<Row[]> {
  const res = await client.query(text, params);
  return camelRows(res.rows);
}

async function begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  // Queries inside a transaction run one after another on this single connection.
  let chain: Promise<unknown> = Promise.resolve();
  const run: Runner = (text, params) => {
    const p = chain.then(() => runOn(client, text, params));
    chain = p.catch(() => undefined);
    return p;
  };
  const nested: Sql['begin'] = () => { throw new Error('Nested transactions are not supported'); };
  const tx = makeSql(run, nested);
  try {
    await client.query('begin');
    const result = await fn(tx);
    await chain;
    await client.query('commit');
    return result;
  } catch (e) {
    try { await client.query('rollback'); } catch { /* connection already broken */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Shared client. Importing this module never opens a connection by itself. */
export const sql: Sql = makeSql((text, params) => runOn(pool(), text, params), begin);

export type Tx = Sql;
export type Db = Sql;

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

export async function closeDb() {
  if (globalForDb.__ksbPool) {
    await globalForDb.__ksbPool.end();
    globalForDb.__ksbPool = undefined;
  }
}
