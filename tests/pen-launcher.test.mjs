import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePenBridge } from '../scripts/ensure-pen.mjs';

const session = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1', HYPRLAND_INSTANCE_SIGNATURE: 'current-session', XDG_RUNTIME_DIR: '/run/user/1000' };

test('opening Notesgood imports only display variables, then restarts only its pen bridge', () => {
  const calls = [], env = { ...session, XAUTHORITY: '/tmp/session-auth', PRIVATE_KEY: 'never-import-this' };
  assert.equal(ensurePenBridge({ env, run: (...args) => calls.push(args) }), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ['/run/current-system/sw/bin/systemctl', ['--user', 'import-environment', 'DISPLAY', 'WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'XDG_RUNTIME_DIR', 'XAUTHORITY']]);
  assert.deepEqual(calls[1].slice(0, 2), ['/run/current-system/sw/bin/systemctl', ['--user', 'restart', 'notesgood-pen.service']]);
  assert.equal(calls[0][2].env, env);
  assert.equal(calls[1][2].env, env);
});

test('missing graphical session variables never start a bridge on the wrong display', () => {
  for (const missing of ['DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'XDG_RUNTIME_DIR']) {
    const env = { ...session }; delete env[missing];
    assert.equal(ensurePenBridge({ env, run: () => assert.fail('No service calls without a complete session') }), false);
  }
});

test('a pen-service failure does not block launching Notesgood', () => {
  for (const failAt of [1, 2]) {
    const warnings = []; let calls = 0;
    assert.doesNotThrow(() => assert.equal(ensurePenBridge({ env: session, run: () => { if (++calls === failAt) throw Error('Unavailable'); }, warn: text => warnings.push(text) }), false));
    assert.equal(calls, failAt);
    assert.equal(warnings.length, 1);
  }
});
