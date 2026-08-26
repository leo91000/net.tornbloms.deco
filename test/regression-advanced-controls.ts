import assert from 'node:assert/strict';
import {
  buildBackhaulDiagnostic,
  buildClientStatistics,
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

assert.deepEqual(buildClientStatistics({
  name: 'Laptop',
  mac: 'AA-BB-CC-DD-EE-FF',
  ip: '192.168.1.42',
  online: true,
  decoNode: 'Living Room',
  connectionType: 'wireless',
  interface: 'host',
  downSpeed: 123,
  upSpeed: 45,
  prioritized: true,
}), {
  name: 'Laptop',
  mac: 'AA-BB-CC-DD-EE-FF',
  ip: '192.168.1.42',
  online: true,
  decoNode: 'Living Room',
  connectionType: 'wireless',
  network: 'host',
  downKiloBytesPerSecond: 123,
  upKiloBytesPerSecond: 45,
  prioritized: true,
});
assert.deepEqual(buildClientStatistics({
  mac: 'AA-BB-CC-DD-EE-FF',
  online: false,
  downSpeed: 999,
  upSpeed: 999,
}), {
  name: 'AA-BB-CC-DD-EE-FF',
  mac: 'AA-BB-CC-DD-EE-FF',
  ip: '',
  online: false,
  decoNode: '',
  connectionType: '',
  network: '',
  downKiloBytesPerSecond: 0,
  upKiloBytesPerSecond: 0,
  prioritized: false,
});

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
