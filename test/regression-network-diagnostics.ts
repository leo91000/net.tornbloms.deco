import assert from 'node:assert/strict';
import { describeNetworkReachability } from '../lib/network-diagnostics';

const routed = describeNetworkReachability({
  sameSubnet: false,
  httpReachable: true,
  httpsReachable: true,
});
assert.match(routed, /container|routed/i);
assert.doesNotMatch(routed, /cannot reach/i);

const unreachable = describeNetworkReachability({
  sameSubnet: false,
  httpReachable: false,
  httpsReachable: false,
});
assert.match(unreachable, /unreachable/i);

console.log('PASS: Docker routing is not misreported as an unreachable subnet.');
