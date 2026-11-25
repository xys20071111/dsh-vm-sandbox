import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestFiles, guestFilesLimits } from '../guest-files.js';

const fake = async (argv) => ({ stdout: JSON.stringify({ ok: true, entries: [], data: '', size: 0 }) });

test('guest files calls only the provided guest command channel', async () => {
  const calls = [];
  const files = new GuestFiles({ exec: async (...args) => { calls.push(args); return { stdout: JSON.stringify({ ok: true, entries: [] }) }; } });
  assert.deepEqual(await files.list('/'), []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0][0], 'python3');
  assert.equal(calls[0][1].cwd, '/');
});

test('rejects unsafe and shared paths before guest command', async () => {
  let count = 0;
  const files = new GuestFiles({ exec: async () => { count++; return fake(); } });
  for (const path of ['../etc/passwd', 'a/../b', '/mnt/dsh-shares/private', 'mnt/dsh-shares/x', 'a//b', 'a\0b']) {
    await assert.rejects(files.list(path));
  }
  assert.equal(count, 0);
});

test('enforces IO limit and exposes fixed dedicated root', async () => {
  const files = new GuestFiles({ exec: async () => fake(), maxFileBytes: 8 });
  await assert.rejects(files.write('x', Buffer.alloc(9).toString('base64')));
  assert.equal(guestFilesLimits.root, '/root/vm-files');
  assert.equal(guestFilesLimits.maxFileBytes, 64 * 1024);
});

test('converts guest error response into a rejected operation', async () => {
  const files = new GuestFiles({ exec: async () => ({ stdout: JSON.stringify({ ok: false, error: 'symlink refused' }) }) });
  await assert.rejects(files.read('link'), /symlink refused/);
});
