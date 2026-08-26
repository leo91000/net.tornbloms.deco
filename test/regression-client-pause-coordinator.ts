import assert from 'node:assert/strict';
import {
  ClientPauseCoordinator,
  ClientPauseScheduler,
  PausedClients,
} from '../lib/client-pause-coordinator';

class FakeScheduler implements ClientPauseScheduler {
  currentTime = 10_000;
  scheduled = new Map<unknown, { task: () => void; delayMs: number }>();

  now(): number {
    return this.currentTime;
  }

  schedule(task: () => void, delayMs: number): unknown {
    const timer = Symbol('timer');
    this.scheduled.set(timer, { task, delayMs });
    return timer;
  }

  cancel(timer: unknown): void {
    this.scheduled.delete(timer);
  }

  runNext(): void {
    const [timer, scheduled] = this.scheduled.entries().next().value as [
      unknown,
      { task: () => void; delayMs: number },
    ];
    this.scheduled.delete(timer);
    scheduled.task();
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main(): Promise<void> {
  const scheduler = new FakeScheduler();
  const accessChanges: Array<[string, boolean]> = [];
  const persisted: PausedClients[] = [];
  const restored: string[] = [];
  let connected = true;
  let refreshes = 0;
  const coordinator = new ClientPauseCoordinator({
    ensureConnected: async () => connected,
    setClientAccess: async (mac, allowed) => { accessChanges.push([mac, allowed]); },
    persist: async (state) => { persisted.push(state); },
    clearPersistence: async () => { persisted.push({}); },
    refresh: async () => { refreshes += 1; },
  }, {
    restored: (mac) => { restored.push(mac); },
    retrying: () => undefined,
    rollbackFailed: () => undefined,
    removalRestoreFailed: () => undefined,
  }, { scheduler, retryDelayMs: 1234 });

  await coordinator.pause('aa:bb:cc:dd:ee:ff', 2);
  assert.deepEqual(accessChanges, [['AA-BB-CC-DD-EE-FF', false]]);
  assert.deepEqual(persisted.at(-1), {
    'AA-BB-CC-DD-EE-FF': { restoreAt: 130_000 },
  });
  assert.equal([...scheduler.scheduled.values()][0].delayMs, 120_000);

  scheduler.runNext();
  await settle();
  assert.deepEqual(accessChanges.at(-1), ['AA-BB-CC-DD-EE-FF', true]);
  assert.deepEqual(persisted.at(-1), {});
  assert.deepEqual(restored, ['AA-BB-CC-DD-EE-FF']);
  assert.equal(refreshes, 1);

  await coordinator.restore({
    invalid: { restoreAt: 1 },
    '11-22-33-44-55-66': { restoreAt: 20_000 },
  });
  assert.deepEqual(persisted.at(-1), {
    '11-22-33-44-55-66': { restoreAt: 20_000 },
  });

  connected = false;
  scheduler.runNext();
  await settle();
  assert.equal([...scheduler.scheduled.values()][0].delayMs, 1234);
  connected = true;
  scheduler.runNext();
  await settle();
  assert.deepEqual(accessChanges.at(-1), ['11-22-33-44-55-66', true]);

  await coordinator.pause('22-33-44-55-66-77', 1);
  await coordinator.shutdownAndRestore();
  assert.deepEqual(accessChanges.at(-1), ['22-33-44-55-66-77', true]);
  assert.deepEqual(persisted.at(-1), {});
  assert.equal(scheduler.scheduled.size, 0);

  const rollbackScheduler = new FakeScheduler();
  const rollbackAccess: boolean[] = [];
  const rollbackCoordinator = new ClientPauseCoordinator({
    ensureConnected: async () => true,
    setClientAccess: async (_mac, allowed) => { rollbackAccess.push(allowed); },
    persist: async () => { throw new Error('store unavailable'); },
    clearPersistence: async () => undefined,
    refresh: async () => undefined,
  }, {
    restored: () => undefined,
    retrying: () => undefined,
    rollbackFailed: () => undefined,
    removalRestoreFailed: () => undefined,
  }, { scheduler: rollbackScheduler });
  await assert.rejects(
    rollbackCoordinator.pause('33-44-55-66-77-88', 1),
    /store unavailable/,
  );
  assert.deepEqual(rollbackAccess, [false, true]);
  assert.equal(rollbackScheduler.scheduled.size, 0);

  console.log('PASS: client pause lifecycle owns persistence, timers, retries, and removal cleanup.');
}

void main();
