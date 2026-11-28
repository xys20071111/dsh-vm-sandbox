export const HOST_SANDBOX_PRESET = 'host-sandbox';
export const VM_SANDBOX_PRESET = 'virtual-machine';

const presetCache = new WeakMap();

/** Read the latest durable permission preset from the Session event log. */
export function permissionPresetOf(session) {
  const end = session.seq;
  const cached = presetCache.get(session);
  if (cached?.seq === end) return cached.preset;

  let preset = cached?.preset;
  const events = session.snapshotEvents(cached?.seq ?? 0, end);
  for (const event of events) {
    if (event.type === 'permission/preset') preset = event.data.preset;
  }
  presetCache.set(session, { seq: end, preset });
  return preset;
}

/** Resolve a permission preset identity to a sandbox backend. */
export function resolveSandboxBackend(preset, fallback = 'vm') {
  if (preset === HOST_SANDBOX_PRESET) return 'native';
  if (preset === VM_SANDBOX_PRESET) return 'vm';
  if (fallback !== 'native' && fallback !== 'vm') {
    throw new TypeError(`unsupported default sandbox backend: ${fallback}`);
  }
  return fallback;
}
