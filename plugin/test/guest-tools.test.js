import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bakeHostCaBundle } from '../guest-tools.js';

test('bakes a host CA bundle into a minimal guest rootfs', () => {
  const root = mkdtempSync(join(tmpdir(), 'krun-rootfs-'));
  const source = join(root, 'host-ca.pem');
  const guest = join(root, 'image');
  try {
    mkdirSync(join(guest, 'etc'), { recursive: true });
    writeFileSync(source, 'test CA data');
    assert.equal(bakeHostCaBundle(guest, [source]), true);
    assert.equal(readFileSync(join(guest, 'etc', 'ssl', 'certs', 'ca-certificates.crt'), 'utf8'), 'test CA data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses to traverse a symlink in the guest rootfs CA path', () => {
  const root = mkdtempSync(join(tmpdir(), 'krun-rootfs-link-'));
  const source = join(root, 'host-ca.pem');
  const guest = join(root, 'image');
  try {
    mkdirSync(join(guest, 'etc'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    writeFileSync(source, 'test CA data');
    symlinkSync(join(root, 'outside'), join(guest, 'etc', 'ssl'));
    assert.throws(() => bakeHostCaBundle(guest, [source]), /real directory/);
    assert.deepEqual(readdirSync(join(root, 'outside')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
