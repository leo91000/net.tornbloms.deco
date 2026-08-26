import assert from 'node:assert/strict';
import type { SpeedTestSnapshot } from '../lib/deco-features';
import {
  SpeedTestCoordinator,
  SpeedTestScheduler,
} from '../lib/speed-test-coordinator';

const idleSnapshot: SpeedTestSnapshot = {
  supported: true,
  status: 'idle',
  downMbps: 900,
  upMbps: 800,
  pingMs: 12,
  jitterMs: 0.5,
  lastRunAt: '2026-08-26T12:00:00.000Z',
};
const unsupportedSnapshot: SpeedTestSnapshot = {
  supported: false,
  status: 'unsupported',
  downMbps: 0,
  upMbps: 0,
  pingMs: 0,
  jitterMs: 0,
  lastRunAt: '',
};

class FakeScheduler implements SpeedTestScheduler {
  currentTime = 1_000;
  scheduled = new Set<unknown>();

  now(): number {
    return this.currentTime;
  }

  schedule(task: () => void): unknown {
    this.scheduled.add(task);
    return task;
  }

  cancel(timer: unknown): void {
    this.scheduled.delete(timer);
  }
}

async function main(): Promise<void> {
  const scheduler = new FakeScheduler();
  const applied: SpeedTestSnapshot[] = [];
  const completed: SpeedTestSnapshot[] = [];
  let starts = 0;
  const coordinator = new SpeedTestCoordinator(
    {
      startSpeedTest: async () => { starts += 1; },
      readSpeedTest: async () => idleSnapshot,
    },
    {
      apply: async (snapshot) => { applied.push(snapshot); },
      completed: async (snapshot) => { completed.push(snapshot); },
      failed: (error) => { throw error; },
    },
    async (task) => ({ started: true, value: await task() }),
    { scheduler },
  );

  await coordinator.start();
  assert.equal(starts, 1);
  assert.equal(applied.at(-1)?.status, 'running');
  assert.equal(scheduler.scheduled.size, 1);

  await coordinator.pollIfDue(true);
  assert.equal(applied.at(-1)?.status, 'idle');
  assert.deepEqual(completed, [idleSnapshot]);
  coordinator.stop();
  assert.equal(scheduler.scheduled.size, 0);

  const unsupportedApplied: SpeedTestSnapshot[] = [];
  const unsupportedCoordinator = new SpeedTestCoordinator(
    {
      startSpeedTest: async () => {},
      readSpeedTest: async () => unsupportedSnapshot,
    },
    {
      apply: async (snapshot) => { unsupportedApplied.push(snapshot); },
      completed: async () => {},
      failed: (error) => { throw error; },
    },
    async (task) => ({ started: true, value: await task() }),
    { scheduler },
  );
  await unsupportedCoordinator.pollIfDue(true);
  assert.equal(unsupportedApplied.length, 0, 'one failed capability probe must preserve prior state');
  await unsupportedCoordinator.pollIfDue(true);
  assert.deepEqual(unsupportedApplied, [unsupportedSnapshot]);

  console.log('PASS: speed tests own start, polling state, completion, cleanup, and support confirmation.');
}

void main();
