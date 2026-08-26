import assert from 'node:assert/strict';
import { redactRequestPath, redactSensitiveData } from '../lib/redaction';

const original = {
  hostname: '192.168.1.1',
  password: 'owner-secret',
  nested: {
    token: 'cloud-secret',
    stok: 'session-secret',
    username: 'admin',
  },
};
const redacted = redactSensitiveData(original);

assert.equal(redacted.hostname, original.hostname);
assert.equal(redacted.password, '<REDACTED>');
assert.equal(redacted.nested.token, '<REDACTED>');
assert.equal(redacted.nested.stok, '<REDACTED>');
assert.equal(redacted.nested.username, 'admin');
assert.equal(original.password, 'owner-secret', 'redaction must not mutate the source object');
assert.equal(
  redactRequestPath(';stok=0123456789abcdef/admin/device'),
  ';stok=<REDACTED>/admin/device',
);

console.log('PASS: credentials and Deco session tokens are redacted from diagnostics.');
