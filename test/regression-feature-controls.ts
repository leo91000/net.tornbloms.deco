import assert from 'node:assert/strict';
import {
  buildWirelessSnapshot,
  buildWirelessToggleRequest,
  buildClientAccessRequest,
  findFirmwareUpdate,
} from '../lib/deco-features';

const encoded = (value: string) => Buffer.from(value).toString('base64');

const wireless = {
  band2_4: {
    host: { ssid: encoded('Maison'), enable: true, channel: 6, channel_width: 'HT40' },
    guest: { ssid: encoded('Invites'), enable: true },
  },
  band5_1: {
    host: { ssid: encoded('Maison'), enable: true, channel: 44, channel_width: 'HT160' },
    guest: { ssid: encoded('Invites'), enable: false },
  },
  band6: {
    host: { ssid: encoded('Maison'), enable: true, channel: 37, channel_width: 'HT320' },
    guest: { ssid: encoded('Invites'), enable: false },
  },
  iot: { host: { ssid: encoded('Objets'), enable: true, password: encoded('secret') } },
  mlo: { host: { ssid: encoded('Maison MLO'), enable: false, password: encoded('secret') } },
};

const snapshot = buildWirelessSnapshot(wireless);
assert.equal(snapshot.mainSsid, 'Maison');
assert.equal(snapshot.guestSsid, 'Invites');
assert.equal(snapshot.guestEnabled, true);
assert.equal(snapshot.iotSsid, 'Objets');
assert.equal(snapshot.iotEnabled, true);
assert.equal(snapshot.mloSsid, 'Maison MLO');
assert.equal(snapshot.mloEnabled, false);
assert.deepEqual(snapshot.supportedBands, ['2.4 GHz', '5 GHz', '6 GHz']);
assert.equal(JSON.stringify(snapshot).includes('secret'), false);

assert.deepEqual(buildWirelessToggleRequest(wireless, 'guest', false), {
  operation: 'write',
  params: {
    band2_4: { guest: { enable: false } },
    band5_1: { guest: { enable: false } },
    band6: { guest: { enable: false } },
  },
});
assert.deepEqual(buildWirelessToggleRequest(wireless, 'iot', false), {
  operation: 'write',
  params: { iot: { host: { enable: false } } },
});
assert.throws(
  () => buildWirelessToggleRequest(wireless, 'unsupported' as any, true),
  /Unsupported wireless network/,
);

assert.deepEqual(buildClientAccessRequest('AA:BB:CC:DD:EE:FF', false), {
  path: '/admin/client',
  form: 'block',
  body: { operation: 'write', params: { mac: 'AA-BB-CC-DD-EE-FF' } },
});
assert.throws(() => buildClientAccessRequest('not-a-mac', true), /Invalid client MAC/);

assert.deepEqual(findFirmwareUpdate({ fw_list: [{
  mac: 'AA-BB-CC-DD-EE-FF',
  need_to_upgrade: true,
  new_version: '1.4.0',
}] }, 'AA:BB:CC:DD:EE:FF'), { available: true, version: '1.4.0' });
assert.deepEqual(findFirmwareUpdate({ fw_list: [] }, 'AA:BB:CC:DD:EE:FF'), {
  available: false,
  version: '',
});

console.log('PASS: feature controls are minimal, validated, and never expose Wi-Fi passwords.');
