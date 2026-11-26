import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CA_SOURCES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];

function ensureRealDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`expected a real directory: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try { mkdirSync(path, { mode: 0o755 }); } catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`expected a real directory: ${path}`);
  }
}

/**
 * Bake the host trust bundle into a guest rootfs for first-boot HTTPS package setup.
 * Never follows a symlink inside the selected rootfs, and atomically replaces any
 * guest-side ca-certificates.crt symlink rather than writing through it.
 */
export function bakeHostCaBundle(rootfs, sources = DEFAULT_CA_SOURCES) {
  const source = sources.find((candidate) => existsSync(candidate));
  if (!source) return false;

  const rootStat = lstatSync(rootfs);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`rootfs must be a real directory: ${rootfs}`);
  const etc = join(rootfs, 'etc');
  const ssl = join(etc, 'ssl');
  const certs = join(ssl, 'certs');
  ensureRealDirectory(etc);
  ensureRealDirectory(ssl);
  ensureRealDirectory(certs);

  const target = join(certs, 'ca-certificates.crt');
  const temp = join(certs, `.ca-certificates.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, readFileSync(source), { flag: 'wx', mode: 0o644 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return true;
}
