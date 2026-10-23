/**
 * Command-line alternative to the /setup page: issues first PINs to Jon and Knighty.
 * Only works while no admin has a PIN. Prints the PINs once to this terminal.
 * Usage: DATABASE_URL=... PIN_PEPPER=... npm run admin:setup
 */
import { bootstrapAdmins } from '../src/lib/setup';
import { closeDb } from '../src/lib/db';

async function main() {
  const issued = await bootstrapAdmins('cli');
  if (!issued) {
    console.log('An admin already has a PIN. Log in and use Admin → Members → Reset PIN instead.');
    return;
  }
  console.log('\nAdmin PINs (shown once, store them safely):\n');
  for (const i of issued) console.log(`  ${i.displayName.padEnd(10)} ${i.pin}`);
  console.log('');
}

main()
  .catch((e) => { console.error('[admin-setup] FAILED:', e.message); process.exitCode = 1; })
  .finally(() => closeDb());
