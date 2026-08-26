import assert from 'node:assert/strict';
import { DeviceFlowRegistration } from '../lib/flow-registration';

class FakeFlowCard {
  runListeners = 0;
  autocompleteListeners = 0;
  runListener: ((args: any, state?: any) => unknown) | undefined;

  registerRunListener(listener: (args: any, state?: any) => unknown): void {
    this.runListeners += 1;
    this.runListener = listener;
  }

  registerArgumentAutocompleteListener(): void {
    this.autocompleteListeners += 1;
  }
}

const cards = new Map<string, FakeFlowCard>();
const getCard = (id: string): FakeFlowCard => {
  if (!cards.has(id)) cards.set(id, new FakeFlowCard());
  return cards.get(id)!;
};

const flow = {
  getDeviceTriggerCard: getCard,
  getTriggerCard: getCard,
  getConditionCard: getCard,
  getActionCard: getCard,
};
const registration = new DeviceFlowRegistration();
const trackedClients = {};
const dependencies = {
  buildClientAutocomplete: async () => [],
  buildMeshClientAutocomplete: async () => [],
  getMasterDevice: () => undefined,
  getTrackedClients: () => trackedClients,
};

registration.register(flow, dependencies);
registration.register(flow, dependencies);

assert.equal(getCard('client_state_changed').runListeners, 1);
assert.equal(getCard('any_client_state_changed').runListeners, 1);
assert.equal(getCard('client_node_changed').runListeners, 1);
assert.equal(getCard('client_node_changed').autocompleteListeners, 1);
assert.equal(getCard('client_priority_changed').runListeners, 1);
assert.equal(getCard('client_priority_changed').autocompleteListeners, 1);
assert.equal(getCard('client_is_online').runListeners, 1);
assert.equal(getCard('client_speed_above').autocompleteListeners, 1);
assert.equal(getCard('block_client').runListeners, 1);
assert.equal(getCard('run_speedtest').runListeners, 1);
assert.equal(getCard('get_client_statistics').autocompleteListeners, 1);
assert.equal(getCard('client_joined_mesh').runListeners, 1);
assert.equal(getCard('client_present_in_mesh').autocompleteListeners, 1);

console.log('PASS: all Deco Flow listeners are registered centrally and only once.');
