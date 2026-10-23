/**
 * Integration-test helpers. Requires TEST_DATABASE_URL pointing at a THROWAWAY database whose name
 * contains "test" (the schema is dropped and rebuilt on every run).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !/test/i.test(new URL(testUrl).pathname)) {
  throw new Error('Set TEST_DATABASE_URL to a disposable database whose name contains "test".');
}
process.env.DATABASE_URL = testUrl;
process.env.PIN_PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef';
process.env.APP_ENV = 'test';

export async function resetDatabase() {
  const admin = postgres(testUrl!, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe('drop schema public cascade; create schema public;');
    const dir = join(process.cwd(), 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await admin.unsafe(readFileSync(join(dir, f), 'utf8'));
    }
    await admin.unsafe(readFileSync(join(process.cwd(), 'db', 'seed.sql'), 'utf8'));
  } finally {
    await admin.end();
  }
}

export async function runSeedAgain() {
  const admin = postgres(testUrl!, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(readFileSync(join(process.cwd(), 'db', 'seed.sql'), 'utf8'));
  } finally {
    await admin.end();
  }
}
