import assert from 'node:assert/strict';
import type { DecoClient } from '../lib/client';
import {
  MeshTrackedClient,
  reconcileMeshClients,
  reconcileNodeClients,
} from '../lib/client-tracker';

function client(overrides: Partial<DecoClient> = {}): DecoClient {
  return {
    access_host: 'NODE-A',
    client_mesh: false,
    client_type: 'phone',
    connection_type: 'wireless',
    down_speed: 10,
    enable_priority: false,
    interface: 'host',
    ip: '192.168.1.10',
    mac: 'AA-BB-CC-DD-EE-FF',
    name: 'UGhvbmU=',
    online: true,
    owner_id: '',
    remain_time: 0,
    space_id: '',
    up_speed: 5,
    wire_type: '',
    ...overrides,
  };
}

const decodeName = () => 'Phone';
const nodeNames = new Map([
  ['NODE-A', 'Living Room'],
  ['NODE-B', 'Office'],
]);

const joined = reconcileNodeClients({
  tracked: {},
  previousClients: [],
  clients: [client()],
  nodeNames,
  decodeName,
  now: 1_000,
});
assert.deepEqual(joined.events.map((event) => event.type), ['state', 'first-seen']);
assert.equal(joined.tracked['AA-BB-CC-DD-EE-FF'].decoNode, 'Living Room');
assert.equal(joined.tracked['AA-BB-CC-DD-EE-FF'].firstSeen, 1_000);

const roamed = reconcileNodeClients({
  tracked: joined.tracked,
  previousClients: joined.currentClients,
  clients: [client({ access_host: 'NODE-B', enable_priority: true, remain_time: 120 })],
  nodeNames,
  decodeName,
  now: 2_000,
});
assert.deepEqual(roamed.events.map((event) => event.type), ['node-changed', 'priority-changed']);
assert.equal(roamed.tracked['AA-BB-CC-DD-EE-FF'].decoNode, 'Office');
assert.equal(roamed.tracked['AA-BB-CC-DD-EE-FF'].firstSeen, 1_000);

const offline = reconcileNodeClients({
  tracked: roamed.tracked,
  previousClients: roamed.currentClients,
  clients: [],
  decodeName,
  now: 3_000,
});
assert.equal(offline.events.length, 1);
assert.equal(offline.events[0].type, 'state');
assert.equal(offline.tracked['AA-BB-CC-DD-EE-FF'].online, false);
assert.equal(offline.tracked['AA-BB-CC-DD-EE-FF'].downSpeed, 0);

const meshJoined = reconcileMeshClients({
  tracked: {},
  clients: [client()],
  nodeNames,
  decodeName,
  now: 1_000,
});
assert.deepEqual(meshJoined.events.map((event) => event.type), ['joined']);

const legacyTracked = {
  ...meshJoined.tracked,
  'AA-BB-CC-DD-EE-FF': {
    ...meshJoined.tracked['AA-BB-CC-DD-EE-FF'],
    missedPolls: undefined,
  },
} as unknown as Record<string, MeshTrackedClient>;
const firstMiss = reconcileMeshClients({
  tracked: legacyTracked,
  clients: [],
  decodeName,
  now: 2_000,
});
assert.equal(firstMiss.events.length, 0);
assert.equal(firstMiss.tracked['AA-BB-CC-DD-EE-FF'].missedPolls, 1);

const secondMiss = reconcileMeshClients({
  tracked: firstMiss.tracked,
  clients: [],
  decodeName,
  now: 3_000,
});
assert.deepEqual(secondMiss.events.map((event) => event.type), ['left']);
assert.equal(secondMiss.tracked['AA-BB-CC-DD-EE-FF'].online, false);

console.log('PASS: client tracking reconciles joins, roaming, priority, offline state, and mesh grace.');
