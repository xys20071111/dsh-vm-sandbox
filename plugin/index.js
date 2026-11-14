// @local/dsh-krun-vm — libkrun microVM sandbox backend.
//
// 作为 sandbox 接缝（ctx.sandbox）的 Provider 挂载：confine() 把受限命令包装为
// krun-backend exec 客户端调用，经 VMM 监听的 agent.sock 桥接到 guest 内的
// dsh-vm-agent。会话按 (workspaceRoot, mode) 惰性启动（每会话一个
// krun-backend boot 子进程——krun_start_enter 在成功路径会 exit() 整个进程），
// 只读镜像根 + guest 内 overlay 合成 + ext4 数据盘 + 工作区同绝对路径共享。
// fail-closed：探测或引导失败时抛 SandboxUnavailableError，绝不静默放行。
//
// 注意：与官方 provider（dsh-sandbox-local）保持一致，全部使用普通实例属性，
// 不用 V8 `#private` 字段——cordis 的 context 包装下方法 receiver 可能不是
// 原实例，#private 会触发 "Receiver must be an instance of class …"。
//
// 镜像约定：imageRootfs 指向一个准备好的 Linux rootfs 目录树（只读使用）；
// 引导前本插件把 guest/dsh-vm-agent 与 guest/setup.sh 烤入镜像树（幂等覆盖）。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { SandboxProvider, SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox';
import z from '@deepseek-ai/schemastery';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const GUEST_AGENT = join(PKG_DIR, 'guest', 'dsh-vm-agent-x86_64');
const GUEST_SETUP = join(PKG_DIR, 'guest', 'setup.sh');

const expandHome = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** 会话键：workspace + 模式 → 短哈希。 */
function sessionKey(ws, mode) {
  const h = createHash('sha1');
  h.update(ws);
  h.update('\0');
  h.update(mode);
  return h.digest('hex').slice(0, 16);
}

export class KrunSandboxProvider extends SandboxProvider {
  // cordis 4.1：ctx 上未声明的服务属性访问直接抛错（"cannot get property … without inject"）。
  // timer 由 base bundle 提供（@deepseek-ai/cordis-plugin-timer）；
  // workingDirectory 为根作用域服务，供终端 spawn 时解析会话工作目录。
  // 注意：terminals 服务被 web-app 的 persistent-shell 组 isolate（每 shell 组独立实例），
  // 根作用域 inject 永远等不到——krun 终端后端由 ./terminal-backend.js 经
  // persistent-shell 组的 insert 补丁在该组内注册（见 cordis.patch.yml）。
  static inject = ['timer', 'workingDirectory'];

  static Config = z.object({
    enabled: z.boolean().default(true),
    /** 准备好的 Linux rootfs 目录树（只读使用）。空 = 未配置 → fail-closed。 */
    imageRootfs: z.string().default(''),
    /** krun-backend 二进制路径；空 = 使用包内 bin/krun-backend。 */
    backendPath: z.string().default(''),
    /** 含 libkrunfw.so.5 的目录（boot 子进程需要）；空 = 依赖环境 LD_LIBRARY_PATH。 */
    libDir: z.string().default(''),
    /** 会话状态目录（数据盘/agent socket/日志）；空 = ~/.dsh-krun。 */
    dataDir: z.string().default(''),
    resources: z.object({
      vcpus: z.natural().default(2),
      ramMib: z.natural().default(2048),
    }).default({ vcpus: 2, ramMib: 2048 }),
    bootTimeoutMs: z.natural().default(20000),
    /** 会话空闲回收（毫秒）；0 = 常驻不回收。默认 10 分钟。 */
    idleStopMs: z.natural().default(600000),
    /** 网络档位：tsi = 共享宿主网络（guest 监听端口自动占宿主同号端口）；
     *  none = 隔离（vsock 控制通道保留，宿主零端口占用）。
     *  本版 schemastery 无 enumerator，枚举 = union(const)。 */
    network: z.union([z.const('tsi'), z.const('none')]).default('tsi'),
    /** 显式端口映射 ["host:guest", …]；空 = libkrun 自动暴露 guest 全部监听端口。 */
    portMap: z.array(z.string()).default([]),
  });

  /** 诊断标记：追加到 <dataDir>/diag.log（激活/路由排查用；一次性手段，收敛后移除）。 */
  krunDiag(msg) {
    try {
      mkdirSync(this.krunDataDir, { recursive: true });
      writeFileSync(join(this.krunDataDir, 'diag.log'), `${new Date().toISOString()} pid=${process.pid} ${msg}\n`, { flag: 'a' });
    } catch { /* 诊断失败不影响主流程 */ }
  }

  constructor(ctx, config) {
    super(ctx);
    this.krunConfig = config;
    this.krunCtx = ctx;
    this.krunDataDir = expandHome(config.dataDir || join(homedir(), '.dsh-krun'));
    this.krunBackendPath = expandHome(config.backendPath || join(PKG_DIR, 'bin', 'krun-backend'));
    /** key → { child, agentSock, ws, mode, logPath, lastUse, liveTerminals } */
    this.sessions = new Map();
    /** 单飞引导：同一 key 的并发 confine 共享一次启动 */
    this.booting = new Map();
    this.krunProbeCache = undefined;
    this.krunDiag(`constructor pid=${process.pid}`);
    this.krunWorkingDirectory = ctx.workingDirectory;
    ctx.effect(() => () => this.stopAll());
    // 空闲回收：ctx.interval 是自动清理的 fiber effect（timer 服务已声明 inject）
    ctx.effect(() => ctx.interval(() => this.krunGcIdle(), 60000));
    // 管理界面数据通道：同源 HTTP 路由（本地部署；详见设计文档 §8）
    ctx.inject(['webServer'], (injectCtx) => {
      this.krunDiag('webServer inject callback fired');
      this.krunRegisterRoutes(injectCtx.webServer);
    });
  }

  krunRegisterRoutes(webServer) {
    this.krunDiag(`krunRegisterRoutes webServer=${typeof webServer?.register}`);
    const sendJson = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const readBody = (req) => new Promise((res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { try { res.resolve(JSON.parse(raw || '{}')); } catch { res({}); } });
    });
    this.krunStatusSnapshot = () => ({
      ok: true,
      probe: this.krunProbeCache ?? null,
      config: {
        enabled: this.krunConfig.enabled,
        imageRootfs: this.krunConfig.imageRootfs,
        idleStopMs: this.krunConfig.idleStopMs,
        network: this.krunConfig.network,
        portMap: this.krunConfig.portMap ?? [],
        resources: this.krunConfig.resources,
      },
      sessions: [...this.sessions.values()].map((s) => ({
        key: s.key, ws: s.ws, mode: s.mode,
        alive: !s.child.killed,
        uptimeMs: Date.now() - (s.startedAt ?? Date.now()),
      })),
    });
    const registerRoute = (route, label) => {
      try {
        // 注意：krunRegisterRoutes 是类方法，构造函数的 ctx 参数不在作用域内——
        // 用构造时保存的 this.krunCtx（早先的裸 ctx 在此抛 ReferenceError 且被
        // try/catch 吞掉，路由静默缺失 = 管理页 404 的根因）。
        this.krunCtx.effect(() => {
          const dispose = webServer.register(route);
          this.krunDiag(`registered ${route.path}`);
          return dispose;
        }, label);
      } catch (err) {
        this.krunDiag(`register ${route.path} THREW: ${err?.message ?? err}`);
      }
    };
    registerRoute({
      kind: 'exact',
      path: '/api/krun/status',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
        sendJson(res, 200, this.krunStatusSnapshot());
      },
    }, 'krun-vm: GET /api/krun/status');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/stop',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        const s = this.sessions.get(String(body.key ?? ''));
        if (!s) { sendJson(res, 404, { ok: false, err: 'unknown session key' }); return; }
        s.child.kill('SIGTERM');
        sendJson(res, 200, { ok: true });
      },
    }, 'krun-vm: POST /api/krun/stop');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/probe',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        this.krunProbeCache = undefined;
        sendJson(res, 200, { ok: true, probe: (await this.probe()) });
      },
    }, 'krun-vm: POST /api/krun/probe');
  }

  /** 空闲回收：无活跃终端且超过 idleStopMs 的会话优雅停机（数据层天然落盘）。 */
  krunGcIdle() {
    const idle = this.krunConfig.idleStopMs ?? 600000;
    if (!idle) return;
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if ((s.liveTerminals ?? 0) > 0) continue;
      if (now - (s.lastUse ?? now) > idle) {
        s.child.kill('SIGTERM');
        this.sessions.delete(key);
      }
    }
  }

  /** 环境探测（结果缓存到实例生命周期）：KVM 可用、后端与镜像就绪。 */
  async probe() {
    if (this.krunProbeCache) return this.krunProbeCache;
    const problems = [];
    if (!this.krunConfig.enabled) problems.push('disabled by config');
    try {
      const fsPromises = await import('node:fs/promises');
      const kvm = await fsPromises.open('/dev/kvm', 'r+');
      await kvm.close();
    } catch {
      problems.push('/dev/kvm not accessible');
    }
    if (!existsSync(this.krunBackendPath)) problems.push(`backend missing: ${this.krunBackendPath}`);
    const imageRootfs = expandHome(this.krunConfig.imageRootfs);
    if (!imageRootfs || !existsSync(imageRootfs)) {
      problems.push(`imageRootfs not configured or missing: ${imageRootfs || '(empty)'}`);
    }
    this.krunProbeCache = { ok: problems.length === 0, detail: problems.join('; ') };
    return this.krunProbeCache;
  }

  /** 把 guest 侧文件烤入镜像树（幂等）。 */
  bakeGuestFiles(imageRootfs) {
    const agentDst = join(imageRootfs, 'usr', 'bin', 'dsh-vm-agent');
    const setupDst = join(imageRootfs, 'dsh-setup');
    mkdirSync(dirname(agentDst), { recursive: true });
    writeFileSync(agentDst, readFileSync(GUEST_AGENT));
    chmodSync(agentDst, 0o755);
    writeFileSync(setupDst, readFileSync(GUEST_SETUP));
    chmodSync(setupDst, 0o755);
    // DNS：minirootfs 不带 resolv.conf；tsi 档共享宿主网络（宿主 resolver 经代理可达），
    // 原样拷贝宿主 resolv.conf。none 档无网络，此文件无副作用。
    try {
      writeFileSync(join(imageRootfs, 'etc', 'resolv.conf'), readFileSync('/etc/resolv.conf'));
    } catch { /* 宿主无 resolv.conf 时跳过 */ }
  }

  async waitForAgent(sockPath, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted while waiting for agent');
      if (existsSync(sockPath)) {
        const ok = await new Promise((res) => {
          const s = netConnect({ path: sockPath }, () => {
            s.destroy();
            res(true);
          });
          s.on('error', () => {
            s.destroy();
            res(false);
          });
        });
        if (ok) return;
      }
      await new Promise((res) => setTimeout(res, 150));
    }
    throw new Error(`agent socket not ready within ${timeoutMs}ms: ${sockPath}`);
  }

  /** 惰性引导一个会话；同 key 并发共享单次启动。 */
  async ensureSession(policy, signal) {
    const ws = canonicalPath(policy.workspaceRoot);
    const mode = policy.mode === 'read-only' ? 'ro' : 'rw';
    const key = sessionKey(ws, mode);

    const existing = this.sessions.get(key);
    if (existing) return existing;

    const pending = this.booting.get(key);
    if (pending) return pending;

    const boot = this.bootSession({ key, ws, mode, policy }, signal).catch((err) => {
      this.booting.delete(key);
      throw err;
    });
    this.booting.set(key, boot);
    return boot;
  }

  async bootSession({ key, ws, mode, policy }, signal) {
    const probe = await this.probe();
    if (!probe.ok) throw new SandboxUnavailableError(policy.mode, `krun VM unavailable — ${probe.detail}`);

    const imageRootfs = expandHome(this.krunConfig.imageRootfs);
    this.bakeGuestFiles(imageRootfs);

    const runDir = join(this.krunDataDir, 'run');
    const logDir = join(this.krunDataDir, 'logs');
    const sockPath = join(runDir, `${key}.sock`);
    const logPath = join(logDir, `${key}.log`);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    // 关键：VMM 对 listen 模式的 vsock port 绑定在已存在的 socket 文件上会 EEXIST
    // （VM 退出不清理该文件），引导前必须移除陈旧 socket。
    rmSync(sockPath, { force: true });

    const confineArgs = [
      'boot',
      '--rootfs', imageRootfs,
      '--setup', mode,
      '--ws-path', ws,
      '--vcpus', String(this.krunConfig.resources.vcpus),
      '--ram', String(this.krunConfig.resources.ramMib),
      '--agent-sock', sockPath,
    ];
    if (mode === 'rw') {
      const img = join(this.krunDataDir, 'workspaces', `${key}.img`);
      mkdirSync(dirname(img), { recursive: true });
      confineArgs.push('--data-img', img);
    }
    if (this.krunConfig.network === 'none') confineArgs.push('--network', 'none');
    for (const pm of this.krunConfig.portMap ?? []) confineArgs.push('--port-map', pm);

    const env = { ...process.env };
    const libDir = expandHome(this.krunConfig.libDir);
    if (libDir) env.LD_LIBRARY_PATH = libDir;

    const out = openSync(logPath, 'a');
    const child = spawn(this.krunBackendPath, confineArgs, {
      env,
      stdio: ['ignore', out, out],
    });
    out.close?.();

    const session = { key, child, agentSock: sockPath, ws, mode, logPath, lastUse: Date.now(), startedAt: Date.now(), liveTerminals: 0 };
    const aborter = new AbortController();
    const onAbort = () => aborter.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.waitForAgent(sockPath, this.krunConfig.bootTimeoutMs, aborter.signal);
    } catch (err) {
      child.kill('SIGTERM');
      throw new SandboxUnavailableError(policy.mode, `krun session boot failed — ${err.message}; log: ${logPath}`);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    child.on('exit', () => this.sessions.delete(key));
    this.sessions.set(key, session);
    this.booting.delete(key);
    return session;
  }

  stopAll() {
    for (const [, s] of this.sessions) {
      s.child.kill('SIGTERM');
    }
    this.sessions.clear();
  }

  /** sandbox 接缝：把 argv 包装为 krun-exec 客户端调用。 */
  async confine(argv, policy, signal) {
    if (policy.mode === 'danger-full-access') {
      // executor 约定危险模式直接绕过 provider；到达此处属防御性错误
      throw new SandboxUnavailableError(policy.mode, 'danger-full-access must bypass the sandbox provider');
    }
    const session = await this.ensureSession(policy, signal);
    // 命令的宿主 cwd（executor 以会话 cwd spawn 本 argv）与 guest 内路径相同
    const cwd = process.cwd();
    return {
      argv: [
        this.krunBackendPath,
        'exec',
        '--socket', session.agentSock,
        '--cwd', cwd,
        '--env', `DSH_SANDBOX_MODE=${policy.mode}`,
        '--',
        ...argv,
      ],
      enforcement: 'full',
      // guest 内核的文件效果拒绝方言：只读会话整棵根 EROFS
      denialSignatures: ['Read-only file system', 'Operation not permitted'],
      runnerFailureRules: [
        {
          fatalSignatures: [
            'exec: connect',
            'agent socket not ready',
            'krun session boot failed',
          ],
        },
      ],
    };
  }
}

/** 把 argv 包装为 VM 内 bash 会话的终端后端（type: 'krun'）。 */
class KrunTerminalBackend {
  type = 'krun';

  constructor(provider) {
    this.provider = provider;
  }

  async spawn(spec) {
    spec.signal?.throwIfAborted();
    const ws = await this.provider.krunWorkingDirectory.ensure(spec.owner, spec.signal);
    const session = await this.provider.ensureSession(
      { mode: 'workspace-write', workspaceRoot: ws },
      spec.signal,
    );
    session.lastUse = Date.now();
    session.liveTerminals = (session.liveTerminals ?? 0) + 1;

    const conn = netConnect({ path: session.agentSock });
    await new Promise((res, rej) => {
      const t = setTimeout(() => { conn.destroy(); rej(new Error('terminal connect timeout')); }, 10000);
      conn.once('connect', () => { clearTimeout(t); res(); });
      conn.once('error', (e) => { clearTimeout(t); conn.destroy(); rej(e); });
    });
    conn.write(`${JSON.stringify({ type: 'term', cwd: ws })}\n`);

    const term = new KrunTerminalSession(conn, session, spec.sessionId);
    await term.krunReady(800, spec.signal);
    return term;
  }
}

/** TerminalBackendSession 实现：滚动缓冲 + 静默检测的交互发送。 */
class KrunTerminalSession {
  motd = '';
  exited = false;
  exitCode = null;
  exitedSignal = null;
  lines = [];
  partial = '';
  totalLines = 0;
  truncated = false;
  lastOutputAt = Date.now();
  activeSend = null;

  constructor(conn, session, sessionId) {
    this.conn = conn;
    this.sessionRef = session;
    this.sessionId = sessionId;
    this.outputCursor = 0;
    this.outputTail = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      this.appendOutput(chunk);
      this.lastOutputAt = Date.now();
      session.lastUse = Date.now();
    });
    conn.on('close', () => {
      this.exited = true;
      if (this.exitCode === null) this.exitCode = null;
      session.liveTerminals = Math.max(0, (session.liveTerminals ?? 1) - 1);
    });
    conn.on('error', () => {});
  }

  appendOutput(text) {
    this.outputTail += text;
    if (this.outputTail.length > 8000) this.outputTail = this.outputTail.slice(-8000);
    const combined = this.partial + text;
    const parts = combined.split('\n');
    this.partial = parts.pop() ?? '';
    for (const l of parts) {
      this.lines.push(l);
      this.totalLines += 1;
    }
    if (this.lines.length > 1000) {
      this.lines.splice(0, this.lines.length - 1000);
      this.truncated = true;
    }
  }

  /** 等待初始输出成为 motd（静默或超时）。 */
  krunReady(ms, signal) {
    const deadline = Date.now() + ms;
    return new Promise((res) => {
      const tick = () => {
        if (signal?.aborted || Date.now() - this.lastOutputAt > 300 || Date.now() > deadline) {
          this.motd = this.outputTail.slice(-1000);
          res();
        } else setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    });
  }

  startSend({ text, submit, signal }) {
    if (this.activeSend) throw new Error('krun terminal: another send is active');
    if (this.exited) {
      return {
        done: Promise.resolve({ viewport: '', waitReason: 'session_exit', sessionStatus: this.status(), truncated: false }),
        readOutput: () => ({ delta: '', truncated: false }),
        cancel: () => false,
      };
    }
    const before = this.outputTail.length;
    const op = {
      session: this,
      settled: false,
      cancelled: false,
      done: null,
    };
    op.done = new Promise((res) => {
      const deadline = Date.now() + 20000;
      const tick = () => {
        if (op.settled) return;
        if (this.exited || signal?.aborted || op.cancelled || Date.now() - this.lastOutputAt > 400 || Date.now() > deadline) {
          op.settled = true;
          const delta = this.outputTail.slice(before);
          const viewport = delta.length > 4000 ? delta.slice(-4000) : delta;
          res({
            viewport,
            waitReason: this.exited ? 'session_exit' : signal?.aborted || op.cancelled ? 'stdin_read' : Date.now() > deadline ? 'timeout' : 'inferred_idle',
            sessionStatus: this.status(),
            truncated: false,
          });
        } else setTimeout(tick, 50);
      };
      this.conn.write(text + (submit ? '\r' : ''));
      this.lastOutputAt = Date.now();
      setTimeout(tick, 60);
    });
    this.activeSend = {
      cancel: () => { op.cancelled = true; return true; },
      readOutput: () => ({ delta: this.outputTail.slice(before), truncated: false }),
    };
    const active = this.activeSend;
    op.done.finally(() => { if (this.activeSend === active) this.activeSend = null; }).catch(() => {});
    return active;
  }

  read({ offset = 0, count = 50 } = {}) {
    const newestStart = this.lines.length;
    const end = Math.max(0, newestStart - (offset ?? 0));
    const begin = Math.max(0, end - (count ?? 50));
    const text = this.lines.slice(begin, end).join('\n') + (end === this.lines.length && this.partial ? `\n${this.partial}` : '');
    return { text, totalLines: this.totalLines, lineBegin: begin, lineEnd: end, truncated: this.truncated };
  }

  async signal(sig) {
    const map = { SIGINT: '\x03', SIGTSTP: '\x1a', SIGHUP: '\x04' };
    this.conn.write(map[sig] ?? '\x03');
    return { delivered: true, targetPgid: 0 };
  }

  status() {
    return this.exited
      ? { kind: 'exited', exitCode: this.exitCode, signal: this.exitedSignal }
      : { kind: 'running' };
  }

  async close() {
    this.conn.destroy();
  }
}

export { KrunSandboxProvider as default, KrunTerminalBackend };
