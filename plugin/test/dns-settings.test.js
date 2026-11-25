import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatResolvConf, normalizeDnsServers, readDnsSettings, resolveHostDnsServers, writeDnsSettings, writeGuestResolvConf } from '../dns-settings.js';

test('DNS input accepts IPv4/IPv6, trims and deduplicates', () => {
  assert.deepEqual(normalizeDnsServers(' 1.1.1.1, 2606:4700:4700::1111 1.1.1.1 '), ['1.1.1.1', '2606:4700:4700::1111']);
  assert.throws(() => normalizeDnsServers('resolver.example'), /invalid DNS server/);
  assert.throws(() => normalizeDnsServers('1.1.1.1 8.8.8.8 9.9.9.9 149.112.112.112 208.67.222.222 8.26.56.26 8.20.247.20'), /at most 6/);
});

test('resolv.conf uses configured nameservers and TCP DNS', () => {
  assert.equal(formatResolvConf(['1.1.1.1', '2001:4860:4860::8888']),
    '# Managed by DSH krun-vm; generated at VM startup.\nnameserver 1.1.1.1\nnameserver 2001:4860:4860::8888\noptions use-vc\n');
  assert.deepEqual(resolveHostDnsServers(() => 'search local\nnameserver 127.0.0.53\nnameserver 192.0.2.53\n'), ['127.0.0.53', '192.0.2.53']);
});

test('guest resolv.conf atomically replaces the image symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'krun-dns-root-'));
  try {
    mkdirSync(join(root, 'etc'));
    mkdirSync(join(root, 'run', 'systemd', 'resolve'), { recursive: true });
    writeFileSync(join(root, 'run', 'systemd', 'resolve', 'stub-resolv.conf'), 'stale');
    symlinkSync('/run/systemd/resolve/stub-resolv.conf', join(root, 'etc', 'resolv.conf'));
    writeGuestResolvConf(root, ['9.9.9.9']);
    assert.equal(readFileSync(join(root, 'etc', 'resolv.conf'), 'utf8'),
      '# Managed by DSH krun-vm; generated at VM startup.\nnameserver 9.9.9.9\noptions use-vc\n');
    assert.equal(readFileSync(join(root, 'run', 'systemd', 'resolve', 'stub-resolv.conf'), 'utf8'), 'stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DNS config persists and empty selection restores automatic host DNS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krun-dns-config-'));
  try {
    assert.deepEqual(writeDnsSettings(dir, ['8.8.8.8', '2001:4860:4860::8888']), ['8.8.8.8', '2001:4860:4860::8888']);
    assert.deepEqual(readDnsSettings(dir), ['8.8.8.8', '2001:4860:4860::8888']);
    writeDnsSettings(dir, []);
    assert.deepEqual(readDnsSettings(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
