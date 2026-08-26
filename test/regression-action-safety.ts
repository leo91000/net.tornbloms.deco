import assert from 'node:assert/strict';
import { assertDangerousActionAllowed } from '../lib/action-safety';

assert.throws(() => assertDangerousActionAllowed({}), /disabled/i);
assert.doesNotThrow(() => assertDangerousActionAllowed({ allowDangerousActions: true }));

console.log('PASS: disruptive router actions require an explicit opt-in.');
