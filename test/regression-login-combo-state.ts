// Regression test for the combo-state-poisoning bug:
//
// attemptLogin() mutates the shared HttpClient's forceJsonContentType/
// forceJsonBody on every attempt, including failed ones. Previously,
// buildLoginCombos() read those same mutated fields as "the known-good
// combo to try first" on every call to authenticate() — so if a 403
// (RETRY:, router session limit) interrupted authenticate() mid-way
// through trying combos, whichever combo happened to be active when the
// 403 hit stayed active. Every subsequent outer pairing retry
// (driver.ts's SESSION_LIMIT_RETRY_BACKOFF_MS loop) then re-read that
// poisoned state and retried only that one (possibly wrong) combo,
// instead of the actual cached/last-known-good combo ever getting a
// fair shot again.
//
// This script drives DecoAPIWrapper.authenticate() twice against a fake
// attemptLogin that reproduces the exact failure shape from the field
// report: combo 1 (true/false — the actually-correct combo per a HAR
// capture of a successful browser login) fails with a format error,
// combo 2 flips state to jsonBody=true, and *that* attempt is the one
// that gets a 403. The fix must leave this.c back at the original
// baseline (true/false) afterwards, so the next authenticate() call
// tries the correct combo first again — not jsonBody=true forever.
//
// Run with: npx tsc -p test/tsconfig.json && node test/dist/regression-login-combo-state.js

import DecoAPIWrapper from '../lib/client';

async function main() {
  const api = new (DecoAPIWrapper as any)('127.0.0.1', { log: () => {}, error: () => {} }) as any;

  // Known-good baseline, as if restored from device store for an
  // already-paired device (matches the HttpClient defaults).
  api.c.forceJsonContentType = true;
  api.c.forceJsonBody = false;
  const baseline = { contentType: api.c.forceJsonContentType, jsonBody: api.c.forceJsonBody };

  // Skip real network calls (DNS/ping) made at the top of authenticate().
  api.pingHost = async () => true;

  let call = 0;
  // Fake attemptLogin: mirrors the real method's contract — it mutates
  // this.c per combo, then throws. buildLoginCombos() tries the baseline
  // combo twice first (raw password, then hashed password — see
  // buildLoginCombos), so the first combo that's actually *different* from
  // the baseline is the 5th call ({contentType:true, jsonBody:true}). Calls
  // 1-4 fail with a generic FORMAT error (as real "wrong combo" responses
  // do) so the loop advances that far, then call 5 flips jsonBody=true and
  // throws RETRY: (403) — matching the field report's "HTTP 500 advancing
  // through combos, then persistent 403s" shape.
  api.attemptLogin = async function (_password: string, combo: { contentType: boolean; jsonBody: boolean; hashed: boolean }) {
    call += 1;
    this.c.forceJsonContentType = combo.contentType;
    this.c.forceJsonBody = combo.jsonBody;
    if (call <= 4) {
      throw new Error('FORMAT: simulated mismatch');
    }
    if (call === 5) {
      assert(combo.jsonBody === true, `expected the 5th combo to be the jsonBody=true one, got ${JSON.stringify(combo)}`);
      throw Object.assign(new Error('RETRY: Router rejected login (session limit). Will retry automatically.'), { isBodyFormatError: false });
    }
    throw new Error(`unexpected call ${call}`);
  };

  let threw = false;
  try {
    await api.authenticate('irrelevant-password');
  } catch (e: any) {
    threw = true;
    assert(String(e.message).startsWith('RETRY:'), `expected RETRY: error, got: ${e.message}`);
  }
  assert(threw, 'authenticate() should have thrown on the simulated 403');

  // This is the crux of the bug: after the 403 throw, state must be back
  // at the original baseline, not stuck on the jsonBody=true combo that
  // was active when the 403 hit.
  assert(
    api.c.forceJsonContentType === baseline.contentType && api.c.forceJsonBody === baseline.jsonBody,
    `combo state was not restored after RETRY: — expected contentType=${baseline.contentType} jsonBody=${baseline.jsonBody}, ` +
      `got contentType=${api.c.forceJsonContentType} jsonBody=${api.c.forceJsonBody}`,
  );

  // Simulate the outer pairing retry loop calling authenticate() again
  // (driver.ts does this after each SESSION_LIMIT_RETRY_BACKOFF_MS delay).
  // It must try the baseline combo first again, not jsonBody=true.
  let secondCallCombo: { contentType: boolean; jsonBody: boolean } | null = null as any;
  api.attemptLogin = async function (_password: string, combo: { contentType: boolean; jsonBody: boolean; hashed: boolean }) {
    if (secondCallCombo === null) {
      secondCallCombo = { contentType: combo.contentType, jsonBody: combo.jsonBody };
    }
    this.c.forceJsonContentType = combo.contentType;
    this.c.forceJsonBody = combo.jsonBody;
    throw Object.assign(new Error('RETRY: Router rejected login (session limit). Will retry automatically.'), { isBodyFormatError: false });
  };

  try {
    await api.authenticate('irrelevant-password');
  } catch {
    // expected — the retry loop in driver.ts is what stops retrying, not authenticate() itself
  }

  assert(
    secondCallCombo !== null && secondCallCombo.contentType === baseline.contentType && secondCallCombo.jsonBody === baseline.jsonBody,
    `outer retry did not get a fair shot at the baseline combo — first combo tried was ${JSON.stringify(secondCallCombo)}`,
  );

  console.log('PASS: combo state is not poisoned across outer pairing retries after a 403/RETRY.');
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
