import assert from 'node:assert/strict';
import { resolvePollCadence } from '../lib/poll-cadence';

const defaults = resolvePollCadence({});
assert.deepEqual(defaults, {
  performanceMs: 5 * 60_000,
  networkFeaturesMs: 5 * 60_000,
  speedTestStatusMs: 15 * 60_000,
  firmwareMs: 6 * 60 * 60_000,
});

const configured = resolvePollCadence({
  performancePollMinutes: 10,
  networkFeaturePollMinutes: '20',
  speedTestStatusPollMinutes: 30,
  firmwarePollHours: 12,
});
assert.deepEqual(configured, {
  performanceMs: 10 * 60_000,
  networkFeaturesMs: 20 * 60_000,
  speedTestStatusMs: 30 * 60_000,
  firmwareMs: 12 * 60 * 60_000,
});

const clamped = resolvePollCadence({
  performancePollMinutes: 0,
  networkFeaturePollMinutes: 99999,
  speedTestStatusPollMinutes: 'invalid',
  firmwarePollHours: 99999,
});
assert.deepEqual(clamped, {
  performanceMs: 60_000,
  networkFeaturesMs: 24 * 60 * 60_000,
  speedTestStatusMs: 15 * 60_000,
  firmwareMs: 7 * 24 * 60 * 60_000,
});

console.log('PASS: advanced polling cadences apply defaults, settings, and safe limits.');
