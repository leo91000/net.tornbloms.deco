import assert from 'node:assert/strict';
import { DeviceFlowRegistration } from '../lib/flow-registration';

class FakeFlowCard {
  runListeners = 0;
  autocompleteListeners = 0;

  registerRunListener(): void {
    this.runListeners += 1;
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
};
const registration = new DeviceFlowRegistration();

registration.register(flow, async () => []);
registration.register(flow, async () => []);

assert.equal(getCard('client_state_changed').runListeners, 1);
assert.equal(getCard('any_client_state_changed').runListeners, 1);
assert.equal(getCard('client_node_changed').runListeners, 1);
assert.equal(getCard('client_node_changed').autocompleteListeners, 1);

console.log('PASS: global device Flow listeners are registered only once.');
