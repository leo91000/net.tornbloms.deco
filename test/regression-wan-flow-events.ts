import assert from 'node:assert/strict';
import { buildWanFlowEvents } from '../lib/wan-flow-events';

const offlineEvents = buildWanFlowEvents({
  cachedDisconnected: false,
  fallbackDisconnected: false,
  currentDisconnected: true,
  ipVersion: 'ipv4',
});
assert.deepStrictEqual(offlineEvents, [
  {
    cardId: 'alarm_wan_state_changed',
    tokens: { wan_state: false, ip_version: 'ipv4' },
  },
  {
    cardId: 'alarm_wan_state_false',
    tokens: { wan_state: false, ip_version: 'ipv4' },
  },
]);

const recoveredEvents = buildWanFlowEvents({
  cachedDisconnected: true,
  fallbackDisconnected: false,
  currentDisconnected: false,
  ipVersion: 'ipv4',
});
assert.deepStrictEqual(recoveredEvents, [
  {
    cardId: 'alarm_wan_state_changed',
    tokens: { wan_state: true, ip_version: 'ipv4' },
  },
  {
    cardId: 'alarm_wan_state_true',
    tokens: { wan_state: true, ip_version: 'ipv4' },
  },
], 'cached Homey state must detect recovery after an app restart');

assert.deepStrictEqual(buildWanFlowEvents({
  cachedDisconnected: false,
  fallbackDisconnected: true,
  currentDisconnected: false,
  ipVersion: 'ipv6',
}), [], 'unchanged states must not retrigger Flow cards');

console.log('PASS: WAN transitions emit correctly oriented changed and online/offline Flow events.');
