import assert from 'node:assert/strict';
import { SharedAuthenticationCoordinator } from '../lib/shared-authentication';

async function main() {
  const coordinator = new SharedAuthenticationCoordinator();
  let authenticated = false;
  let attempts = 0;
  const authenticate = async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    authenticated = true;
    return true;
  };

  const [first, concurrent] = await Promise.all([
    coordinator.authenticate('deco', () => authenticated, authenticate),
    coordinator.authenticate('deco', () => authenticated, authenticate),
  ]);
  assert.equal(first, true);
  assert.equal(concurrent, true);
  assert.equal(attempts, 1);

  await coordinator.authenticate('deco', () => authenticated, authenticate);
  assert.equal(attempts, 1, 'a later device reuses the authenticated shared session');

  await coordinator.authenticate('deco', () => authenticated, authenticate, true);
  assert.equal(attempts, 2, 'an expired session can explicitly force authentication');

  console.log('PASS: Deco devices share one cached and serialized authentication session.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
