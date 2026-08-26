import assert from 'node:assert/strict';
import { MeshClientCache } from '../lib/mesh-client-cache';

const cache = new MeshClientCache<{ mac: string; name: string }>();
cache.setNodeClients('router', 'node-a', [
  { mac: 'AA:AA', name: 'phone' },
  { mac: 'BB:BB', name: 'laptop' },
], 1_000);
cache.setNodeClients('router', 'node-b', [
  { mac: 'aa:aa', name: 'phone-roamed' },
  { mac: 'CC:CC', name: 'tablet' },
], 1_100);

const fresh = cache.getSnapshot('router', 2_000, 1_200);
assert.equal(fresh.nodeCount, 2);
assert.equal(fresh.clients.length, 3, 'the same MAC reported by two nodes must be deduplicated');
assert.equal(fresh.clients.find((client) => client.mac.toUpperCase() === 'AA:AA')?.name, 'phone-roamed');

const stale = cache.getSnapshot('router', 50, 1_200);
assert.deepEqual(stale, { clients: [], nodeCount: 0 });

console.log('PASS: mesh snapshots count polled nodes, expire stale data, and deduplicate clients.');
