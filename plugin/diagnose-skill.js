// krun VM 沙盒诊断 skill（仿 windows-acl 的 diagnose-windows-sandbox-acl）。
// 以 ctx.skills.register 内联注册（runtime 层，根作用域 = 全局）；
// 排障知识以本仓库实测记录（设计文档附录 C）为准，路径一律用占位符。

export const KRUN_DIAGNOSIS_SKILL = {
  name: 'diagnose-krun-vm-sandbox',
  description:
    'Use when confined commands fail with a krun VM Runner failure, the VM sandbox is unavailable, VM sessions will not boot, agent sockets or boot logs point to krun problems, or VM networking/port-forwarding behaves unexpectedly. Expected sandbox denials (read-only EROFS, workspace-write outside workspace) are not diagnosis targets.',
  whenToUse:
    'Trigger on "Runner failure", "krun session boot failed", "krun VM unavailable", agent socket errors, or before reporting the VM sandbox broken. Do not trigger for ordinary command failures inside a working VM.',
  source: 'bundled',
  resourceBase: { kind: 'opaque', description: 'krun-vm plugin; all paths are placeholders resolvable from /vm status or the plugin config' },
  content: `# Diagnose krun VM sandbox failures

The krun sandbox runs confined commands inside a libkrun microVM. A broken VM surfaces as
**Runner failure** (the command did not run — sandbox problem), never as an ordinary command
failure. Diagnose from the structured error outward; never retry a failing boot more than twice.

Placeholders below: \`<dataDir>\` = the plugin's dataDir (see \`/vm status\` or
\`GET /api/krun/status\`, default \`~/.dsh/storages/krun-vm\`); \`<plugin>\` = the
\`@local/dsh-krun-vm\` package directory (\`config.backendPath\` names its
\`bin/krun-backend\`); \`<libDir>\` = the directory holding \`libkrunfw.so.5\`
(\`config.libDir\`).

## Step 1 — read the facts you already have

- The bash tool's structured error names the mode and the runner-failure detail, and quotes the
  **boot log path**. That log is the first thing to read.
- \`<dataDir>/diag.log\` is the activation/routing trail: constructor → \`webServer inject\` →
  route registrations → \`commands inject\` → \`registered /vm\`. Missing lines mean the
  plugin did not activate (config error, missing service) rather than a VM problem.
- \`GET /api/krun/status\` (or the Settings → "VM sandbox" page) reports probe results,
  live sessions, imported images, and workspace bindings.

## Step 2 — probe the environment

\`\`\`bash
LD_LIBRARY_PATH=<libDir> <plugin>/bin/krun-backend probe
\`\`\`

Checks \`/dev/kvm\` write access, libkrun feature flags, and max vCPUs. \`/dev/kvm not
accessible\` = permission problem (kvm group); everything else failing together usually means
\`libkrunfw.so.5\` is not loadable (wrong \`libDir\`).

## Step 3 — read the boot log

\`<dataDir>/logs/<key>.log\` where \`key = sha1("<workspace-abs-path>\\0<mode>").slice(0,16)\`
(\`mode\` is \`ro\` or \`rw\`). One \`booting (setup mode=…)\` line per VM start; multiple lines
prove idle-recycle reboots (normal). Common endings:

| Log tail | Meaning |
|---|---|
| \`add_vsock_port agent: -17\` / EEXIST | stale socket file was not cleaned — provider removes it before boot; if you boot manually, \`rm\` the stale \`run/<key>.sock\` first |
| \`mke2fs failed\` / \`spawn …mke2fs\` | host e2fsprogs missing for a raw data layer (\`KRUN_MKE2FS\` env or install e2fsprogs) |
| \`spawn qemu-img\` | qcow2 data layer requires host \`qemu-img\` (qemu-utils) |
| \`mkfs.ext4: not found\` (guest) | image lacks e2fsprogs for qcow2 first-boot formatting — provider auto-installs on alpine; glibc images must ship it |
| \`Read-only file system\` in \`ro\` sessions | expected EROFS denial, not a fault |
| setup lines end without agent listening | guest orchestration failed — read upward from the last SETUP line |
| \`Image not formatted\` / EXDEV on rename | overlay layer-directory rename is EXDEV by design (docker overlay2 parity); restructure the command |

## Step 4 — composition checks

\`\`\`bash
dsh --profile web --dump-config | grep -A14 'id: sandbox-vm'
\`\`\`

The base \`sandbox\` line must show \`disabled: true\` and \`sandbox-vm\` must appear with its
config; \`sandbox-policy\` and \`bash-sandbox\` lines unchanged. A wrong composition breaks
activation before any VM work.

## Step 5 — activation-level smoke without touching the live session

\`\`\`bash
dsh headless --patch harness/krun-overlay-headless-test.yml "run: uname -r"
\`\`\`

Boots an isolated VM (own session key). If headless works while the live session fails, suspect
the live profile patch or the running process's plugin version (plugin updates need a dsh
restart).

## Step 6 — verify intent before repair

- Idle recycle kills sessions after \`idleStopMs\`; the next confined command boots again.
  Data-layer contents survive (\`workspaces/<key>.img\`).
- \`network: none\` isolates the guest (no outbound, no host ports). Port exposure needs
  \`network: tsi\` (auto, guest port = host port) or \`portMap\` entries (vsock app-layer
  forward, host binds 127.0.0.1:<host>).
- Sidebar "new terminal" shows \`krun\` only when the terminal-controller
  \`shellCandidates\` patch is wired; agent-side \`terminal_open {"type":"krun"}\` is the
  always-available path.

Destructive repair is user-only: workspace data-layer reset (\`/vm reset confirm\`) discards
everything the VM wrote outside the workspace — present the plan and get explicit approval.
Image deletion is refused while a binding or running session references it.`,
};
