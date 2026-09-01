import assert from 'node:assert/strict';
import { resolveWanDisconnected } from '../lib/wan-status';

assert.strictEqual(resolveWanDisconnected({
  nodeInternetStatus: 'online',
  wanInternetStatus: '',
  wanIpAddress: '',
}), false, 'an online access-point mesh must not raise a WAN-disconnected alarm');

assert.strictEqual(resolveWanDisconnected({
  nodeInternetStatus: 'offline',
  wanInternetStatus: 'disconnected',
  wanIpAddress: '198.51.100.10',
}), true, 'an offline routed mesh must raise the WAN-disconnected alarm');

assert.strictEqual(resolveWanDisconnected({
  nodeInternetStatus: '',
  wanInternetStatus: '',
  wanIpAddress: '',
}), undefined, 'missing status must preserve the last known alarm state');

console.log('PASS: WAN alarms distinguish access-point mode from real disconnections.');
