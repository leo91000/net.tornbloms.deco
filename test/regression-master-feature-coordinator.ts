import assert from 'node:assert/strict';
import type {
  RadioFeature,
  RadioFeatureSnapshot,
  SpeedTestSnapshot,
} from '../lib/deco-features';
import { MasterFeatureCoordinator } from '../lib/master-feature-coordinator';

async function main(): Promise<void> {
  const calls = { wireless: 0, radio: 0, firmware: 0, speed: 0 };
  const appliedRadio: Array<[RadioFeature, RadioFeatureSnapshot]> = [];
  const idleSpeed: SpeedTestSnapshot = {
    supported: true,
    status: 'idle',
    downMbps: 100,
    upMbps: 50,
    pingMs: 10,
    jitterMs: 1,
    lastRunAt: '2026-08-26T12:00:00.000Z',
  };
  const coordinator = new MasterFeatureCoordinator(
    {
      readWireless: async () => {
        calls.wireless += 1;
        return {
          mainSsid: 'Main',
          guestSsid: '',
          guestEnabled: false,
          iotSsid: '',
          iotEnabled: false,
          mloSsid: '',
          mloEnabled: false,
          supportedBands: ['5 GHz'],
          guestSupported: false,
          iotSupported: false,
          mloSupported: false,
        };
      },
      readRadioFeature: async () => {
        calls.radio += 1;
        return { supported: true, enabled: true };
      },
      checkFirmwareUpdate: async () => {
        calls.firmware += 1;
        return { available: false, version: '' };
      },
      startSpeedTest: async () => {},
      readSpeedTest: async () => {
        calls.speed += 1;
        return idleSpeed;
      },
    },
    {
      wireless: async () => {},
      radio: async (feature, snapshot) => { appliedRadio.push([feature, snapshot]); },
      firmware: async () => {},
      speedTest: {
        apply: async () => {},
        completed: async () => {},
        failed: (error) => { throw error; },
      },
      failed: (_feature, error) => { throw error; },
    },
    async (task) => ({ started: true, value: await task() }),
    { now: () => 7 * 60 * 60 * 1000 },
  );

  await coordinator.poll('NODE-A');
  assert.deepEqual(calls, { wireless: 1, radio: 2, firmware: 1, speed: 1 });
  assert.equal(appliedRadio.length, 2);

  await coordinator.poll('NODE-A');
  assert.deepEqual(calls, { wireless: 1, radio: 2, firmware: 1, speed: 1 });

  coordinator.resetPollSchedule();
  await coordinator.poll('NODE-A');
  assert.deepEqual(calls, { wireless: 2, radio: 4, firmware: 2, speed: 2 });
  coordinator.stop();

  console.log('PASS: master feature polling owns cadence and delegates stable snapshots through one interface.');
}

void main();
