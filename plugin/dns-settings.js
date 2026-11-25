import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

const MAX_DNS_SERVERS = 6;

export function normalizeDnsServers(input) {
  const values = Array.isArray(input)
    ? input.map((value) => String(value).trim()).filter(Boolean)
    : typeof input === 'string'
      ? input.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean)
      : null;
  if (!values) throw new TypeError('DNS servers must be a string or array of IP addresses');
  if (values.length > MAX_DNS_SERVERS) throw new TypeError(`at most ${MAX_DNS_SERVERS} DNS servers are allowed`);
  const result = [];
  for (const value of values) {
    // resolv.conf accepts IPv6 zone IDs on some systems, but portable static nameserver
    // entries should be plain IPv4/IPv6 literals only.
    if (!isIP(value)) throw new TypeError(`invalid DNS server IP address: ${value}`);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

export function resolveHostDnsServers(readFile = readFileSync) {
  let content = '';
  try { content = String(readFile('/etc/resolv.conf', 'utf8')); } catch { /* no host resolver config */ }
  const servers = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*nameserver\s+(\S+)/i);
    if (match && isIP(match[1]) && !servers.includes(match[1])) servers.push(match[1]);
  }
  return servers.slice(0, MAX_DNS_SERVERS);
}

export function formatResolvConf(input) {
  const servers = normalizeDnsServers(input);
  if (!servers.length) throw new TypeError('at least one DNS server is required to write resolv.conf');
  // TSI reliably carries TCP sockets to host-side resolvers, including systemd-resolved's
  // loopback stub. Force TCP DNS so a guest does not depend on UDP/loopback semantics.
  return `# Managed by DSH krun-vm; generated at VM startup.\n${servers.map((server) => `nameserver ${server}`).join('\n')}\noptions use-vc\n`;
}

export function writeGuestResolvConf(rootfs, input) {
  const etcPath = join(rootfs, 'etc');
  const etcStat = lstatSync(etcPath);
  if (!etcStat.isDirectory() || etcStat.isSymbolicLink()) throw new Error('rootfs /etc must be a real directory');
  const target = join(etcPath, 'resolv.conf');
  const temp = join(etcPath, `.resolv.conf.dsh-${process.pid}-${createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8)}`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o644);
    writeFileSync(fd, formatResolvConf(input));
    closeSync(fd);
    fd = undefined;
    // Rename replaces an existing symlink itself instead of following it into the rootfs.
    renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}

export function readDnsSettings(dataDir, fallback = []) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'dns.json'), 'utf8'));
    return normalizeDnsServers(parsed.servers);
  } catch {
    return normalizeDnsServers(fallback);
  }
}

export function writeDnsSettings(dataDir, servers) {
  const normalized = normalizeDnsServers(servers);
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'dns.json');
  const temp = `${target}.tmp-${process.pid}-${createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8)}`;
  writeFileSync(temp, `${JSON.stringify({ servers: normalized }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { renameSync(temp, target); } catch (error) { rmSync(temp, { force: true }); throw error; }
  return normalized;
}
