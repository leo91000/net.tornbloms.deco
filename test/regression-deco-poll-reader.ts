import assert from 'assert';
import { DecoPollReader } from '../lib/deco-poll-reader';
import type { DecoClient, DeviceListResponse } from '../lib/client';

const master = {
  mac: 'AA',
  device_id: 'master-id',
  role: 'master',
} as DeviceListResponse['result']['device_list'][number];
const satellite = {
  mac: 'BB',
  device_id: 'satellite-id',
  role: 'slave',
} as DeviceListResponse['result']['device_list'][number];
const client = {
  mac: 'CC',
  access_host: '1',
} as DecoClient;

function responseFor(form: string, deviceMac: string) {
  if (form === 'device_list') {
    return { error_code: 0, result: { device_list: [master, satellite] } };
  }
  if (form === 'performance') {
    return { error_code: 0, result: { cpu_usage: 0.1, mem_usage: 0.2 } };
  }
  if (form === 'wan_ipv4') return { error_code: 0, result: {} };
  if (form === 'internet') return { error_code: 0, result: {} };
  if (form === 'client_list') {
    return { error_code: 0, result: { client_list: [{ ...client, mac: deviceMac }] } };
  }
  throw new Error(`Unexpected form ${form}`);
}

async function readFor(deviceMac: string, includePerformance: boolean) {
  const calls: string[] = [];
  const reader = new DecoPollReader({
    async custom<T>(_endpoint: string, params: { form: string }, body: Buffer): Promise<T> {
      calls.push(params.form);
      const parsed = JSON.parse(body.toString()) as { params?: { device_mac?: string } };
      return responseFor(params.form, parsed.params?.device_mac ?? deviceMac) as T;
    },
  }, {
    error: () => undefined,
  });
  return { result: await reader.read(deviceMac, includePerformance), calls };
}

async function main() {
  const masterRead = await readFor('AA', true);
  assert.deepStrictEqual(masterRead.calls, [
    'device_list',
    'performance',
    'wan_ipv4',
    'internet',
    'client_list',
  ]);
  assert.strictEqual(masterRead.result.status, 'ok');
  if (masterRead.result.status === 'ok') {
    assert.strictEqual(masterRead.result.isMaster, true);
    assert.strictEqual(masterRead.result.clients[0].access_host, 'AA');
  }

  const satelliteRead = await readFor('BB', true);
  assert.deepStrictEqual(satelliteRead.calls, ['device_list', 'client_list']);
  assert.strictEqual(satelliteRead.result.status, 'ok');
  if (satelliteRead.result.status === 'ok') {
    assert.strictEqual(satelliteRead.result.isMaster, false);
    assert.strictEqual(satelliteRead.result.performance, undefined);
  }

  const steadyMasterRead = await readFor('AA', false);
  assert.deepStrictEqual(steadyMasterRead.calls, [
    'device_list',
    'wan_ipv4',
    'internet',
    'client_list',
  ]);

  console.log('PASS: poll reader plans master and satellite requests and normalises node-scoped clients.');
}

void main();
