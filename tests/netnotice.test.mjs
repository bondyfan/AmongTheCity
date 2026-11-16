// ---- co-op close notices: every deliberate server close gets its own Czech line ----
// The close codes mirror server-city/hub.js CLOSE. A silence reap (4003) once
// fell through to "Server spadl", which told a player with a frozen tab that
// the server had crashed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE_CODES, closeNotice, connectNotice } from '../js/netnotice.js';
import { CLOSE } from '../server-city/hub.js';

test('the client knows every deliberate close code the server sends', () => {
  assert.equal(CLOSE_CODES.REPLACED, CLOSE.REPLACED);
  assert.equal(CLOSE_CODES.IDLE, CLOSE.IDLE);
  assert.equal(CLOSE_CODES.SILENT, CLOSE.SILENT);
  assert.equal(CLOSE_CODES.LIMIT, CLOSE.LIMIT);
  assert.equal(CLOSE_CODES.UNMEASURED, CLOSE.UNMEASURED);
});

test('each deliberate close reads as itself, not as a crash', () => {
  const crash = closeNotice({});
  assert.match(crash, /spadl/);
  for (const flag of ['limit', 'unmeasured', 'idle', 'silent', 'replaced']) {
    const n = closeNotice({ [flag]: true });
    assert.notEqual(n, crash, flag);
    assert.match(n, /sám/, flag);
  }
  assert.match(closeNotice({ silent: true }), /neodpovídala/);
  assert.match(connectNotice({ code: 'unmeasured' }), /ověřit/);
  assert.match(connectNotice({ code: 'limit' }), /limit/);
});
