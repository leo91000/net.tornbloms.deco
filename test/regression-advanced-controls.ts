import assert from 'node:assert/strict';
import {
  buildBackhaulDiagnostic,
  countPrioritizedClients,
  normalizeClientMac,
  normalizePauseDurationMinutes,
} from '../lib/advanced-controls';

assert.equal(normalizeClientMac('aa:bb:cc:dd:ee:ff'), 'AA-BB-CC-DD-EE-FF');
assert.throws(() => normalizeClientMac('not-a-mac'), /Invalid client MAC/);
assert.equal(normalizePauseDurationMinutes('30'), 30);
assert.throws(() => normalizePauseDurationMinutes(0), /between 1 and 10080/);
assert.throws(() => normalizePauseDurationMinutes(1.5), /whole number/);

assert.equal(countPrioritizedClients([
  { enable_priority: true },
  { enable_priority: false },
  { enable_priority: true },
]), 2);

assert.deepEqual(buildBackhaulDiagnostic({
  group_status: 'connected',
  connection_type: ['wired', 'band6'],
  signal_level: { band6: '1' },
}), {
  connection: 'Wired + WiFi 6 GHz',
  degraded: false,
  reason: '',
  signal2g: '–',
  signal5g: '–',
  signal6g: 'Weak',
});

assert.equal(buildBackhaulDiagnostic({
  group_status: 'connected',
  connection_type: ['band6'],
  signal_level: { band6: '1' },
}).degraded, true);

assert.deepEqual(buildBackhaulDiagnostic({
  group_status: 'disconnected',
  connection_type: [],
  signal_level: {},
}), {
  connection: '–',
  degraded: true,
  reason: 'Disconnected from mesh',
  signal2g: '–',
  signal5g: '–',
  signal6g: '–',
});

console.log('PASS: advanced controls validate pauses, QoS visibility, and backhaul health.');
