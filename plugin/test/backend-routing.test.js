import assert from 'node:assert/strict';
import test from 'node:test';
import { HOST_SANDBOX_PRESET, permissionPresetOf, resolveSandboxBackend, VM_SANDBOX_PRESET } from '../backend-routing.js';

test('reads the latest permission preset from durable Session events, including later changes', () => {
  const events = [
    { seq: 0, type: 'permission/preset', data: { preset: VM_SANDBOX_PRESET } },
    { seq: 1, type: 'turn/start', data: {} },
  ];
  const session = {
    seq: 2,
    snapshotEvents(from = 0, to = this.seq) {
      return events.filter(event => event.seq >= from && event.seq < to);
    },
  };
  assert.equal(permissionPresetOf(session), VM_SANDBOX_PRESET);
  events.push({ seq: 2, type: 'permission/preset', data: { preset: HOST_SANDBOX_PRESET } });
  session.seq = 3;
  assert.equal(permissionPresetOf(session), HOST_SANDBOX_PRESET);
});

test('permission preset identity selects the corresponding sandbox backend', () => {
  assert.equal(resolveSandboxBackend(HOST_SANDBOX_PRESET), 'native');
  assert.equal(resolveSandboxBackend(VM_SANDBOX_PRESET), 'vm');
});

test('unrelated and absent presets use the configured fallback', () => {
  assert.equal(resolveSandboxBackend('workspace-write'), 'vm');
  assert.equal(resolveSandboxBackend(undefined, 'native'), 'native');
});

test('rejects an invalid fallback instead of guessing a backend', () => {
  assert.throws(() => resolveSandboxBackend(undefined, 'other'), /unsupported default sandbox backend/);
});
