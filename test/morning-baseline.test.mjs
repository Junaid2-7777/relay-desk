import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const comparison = fileURLToPath(new URL('../scripts/compare-morning.mjs', import.meta.url));

test('the morning baseline pairs fixture inputs, permission scopes and outcomes through one checkpoint', async () => {
  const { stdout } = await run(process.execPath, [comparison]);
  const report = JSON.parse(stdout);
  assert.equal(report.passed, true);
  assert.equal(report.cutoff, 'first-morning-checkpoint');
  const paired = { sameFixtureInputs: true, sameAuthority: true, sameOutcome: true };
  assert.deepEqual(report.pairing, { cold: paired, warm: paired });

  for (const [scenario, arms] of Object.entries(report.scenarios)) {
    const warm = scenario === 'warm';
    for (const [mode, arm] of Object.entries(arms)) {
      const manual = mode === 'manual';
      const { total } = arm.counts;
      assert.equal(total.attentionOccasions, 1);
      assert.equal(arm.counts.setup.consentChoices, warm ? 0 : 2);
      assert.equal(total.humanLookups, manual ? (warm ? 7 : 1) : 0);
      assert.equal(total.checkClicks, manual ? 0 : 1);
      assert.equal(total.distinctBillDecisions, warm ? 1 : 0);
      assert.equal(total.billDecisionsTaken, 0);
      assert.equal(total.repeatPrompts, 0);
      assert.equal(arm.observed.independentReadback.reservations, warm ? 1 : 0);
      assert.equal(arm.observed.independentReadback.payments, 0);
      if (warm) assert.equal(arm.scriptedActions.ongoing[1].action, 'bill-decision-presented');
    }
  }
  assert.deepEqual(report.scenarios.warm.manual.observed.nativeReadCounts, { bill: 1, refund: 2, visit: 5 });
  assert.deepEqual(report.scenarios.warm['fixed-rule'].observed.nativeReadCounts, { bill: 1, refund: 2, visit: 6 });
});
