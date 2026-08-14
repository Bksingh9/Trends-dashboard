/**
 * `npm run doctor` — live preflight for every connector.
 *
 * Prints what actually works, what is missing, and which env var unblocks the
 * most. Exits non-zero only when a credential is present but broken; a merely
 * unconfigured connector is not a failure, it is a known blocker.
 */
import { runDoctor, type Check } from '../lib/connectors/doctor';

const ICON: Record<Check['status'], string> = {
  ok: '\x1b[32m✓\x1b[0m',
  blocked: '\x1b[33m○\x1b[0m',
  failed: '\x1b[31m✗\x1b[0m',
  skipped: '\x1b[90m–\x1b[0m',
};

async function main() {
  const report = await runDoctor();

  console.log('\nCompanion dashboard — connection doctor');
  console.log(`${new Date(report.generatedAt).toISOString()}\n`);

  for (const c of report.checks) {
    console.log(`${ICON[c.status]} ${c.label}`);
    console.log(`   ${c.detail}`);
    if (c.needs?.length) console.log(`   \x1b[90mneeds: ${c.needs.join(', ')}\x1b[0m`);
    if (c.nextStep) console.log(`   \x1b[36m→ ${c.nextStep}\x1b[0m`);
    if (c.closes) console.log(`   \x1b[90mcloses: ${c.closes}\x1b[0m`);
    console.log();
  }

  const { ok, blocked, failed, skipped } = report.summary;
  console.log(`${ok} ok · ${blocked} blocked · ${failed} failed · ${skipped} skipped`);
  console.log(`connectors configured: ${report.connectorsConfigured}/${report.connectorsTotal}\n`);

  if (report.unblockOrder.length) {
    console.log('Set these next, highest leverage first:');
    for (const u of report.unblockOrder) {
      console.log(`  ${u.envVar.padEnd(24)} unblocks ${u.unblocks.length}: ${u.unblocks.join(', ')}`);
    }
    console.log();
  }

  // A missing credential is a known blocker, not a broken build. A present but
  // failing one is a real problem worth a non-zero exit.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
