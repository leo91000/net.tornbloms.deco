import assert from 'node:assert/strict';
import {
  MIN_POLL_INTERVAL_SECONDS,
  SingleFlightTask,
  normalizePollIntervalSeconds,
  tryApiCall,
} from '../lib/polling';

async function main() {
  assert.equal(normalizePollIntervalSeconds(1), MIN_POLL_INTERVAL_SECONDS);
  assert.equal(normalizePollIntervalSeconds(30), 30);
  assert.equal(normalizePollIntervalSeconds(Number.NaN), 30);

  const errors: unknown[] = [];
  const failedResult = await tryApiCall(
    async () => {
      throw new Error('router offline');
    },
    (error) => errors.push(error),
  );
  assert.equal(failedResult, null, 'a failed API call must not manufacture valid-looking data');
  assert.equal(errors.length, 1);

  const gate = new SingleFlightTask();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let executions = 0;
  const first = gate.run(async () => {
    executions += 1;
    await firstBlocked;
    return 'first';
  });
  const overlapping = await gate.run(async () => {
    executions += 1;
    return 'overlap';
  });
  assert.deepEqual(overlapping, { started: false });
  assert.equal(executions, 1, 'overlapping polls must be skipped');
  releaseFirst();
  assert.deepEqual(await first, { started: true, value: 'first' });
  assert.deepEqual(await gate.run(async () => 'next'), { started: true, value: 'next' });

  console.log('PASS: polling clamps unsafe intervals, preserves failures, and prevents overlap.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
