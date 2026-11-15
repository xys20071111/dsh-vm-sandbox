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

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect, createServer as netCreateServer } from 'node:net';
import { chmodSync, createWriteStream, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

import { SandboxProvider, SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox';
import z from '@deepseek-ai/schemastery';
import { KRUN_DIAGNOSIS_SKILL } from './diagnose-skill.js';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const GUEST_AGENT = join(PKG_DIR, 'guest', 'dsh-vm-agent-x86_64');
const GUEST_SETUP = join(PKG_DIR, 'guest', 'setup.sh');

const expandHome = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** DSH 数据目录：与 @deepseek-ai/dsh-home-paths 的 defaultDshHome 语义一致
 *  （DSH_HOME 环境变量覆盖，默认 ~/.dsh）。该包对本插件不可解析，故本地等价实现。 */
function dshHomeDir() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? env.trim() : join(homedir(), '.dsh');
}

/** 默认运行期状态目录（镜像库/注册表/数据盘/run/logs），见设计 §6 布局。 */
const DEFAULT_DATA_DIR = join(dshHomeDir(), 'storages', 'krun-vm');
/** 旧默认目录（v0.1）：首次激活时整体迁入 DEFAULT_DATA_DIR。 */
const LEGACY_DATA_DIR = join(homedir(), '.dsh-krun');

/** 旧默认目录一次性迁入新默认：仅目标不存在时整体迁移（同盘 rename 原子；
 *  跨设备 EXDEV 时退回复制 + 删除）；目标已存在则保留旧目录不动（不合并），
 *  失败不阻断激活。 */
function migrateLegacyDir(target, diag = () => {}) {
  try {
    if (!existsSync(LEGACY_DATA_DIR)) return;
    if (existsSync(target)) {
      diag(`migrate skipped: legacy ${LEGACY_DATA_DIR} kept (target exists)`);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    try {
      renameSync(LEGACY_DATA_DIR, target);
    } catch (err) {
      if (err?.code !== 'EXDEV') throw err;
      // 跨设备（旧目录与新 DSH 数据目录不同挂载点）：退回复制后删除
      cpSync(LEGACY_DATA_DIR, target, { recursive: true });
      rmSync(LEGACY_DATA_DIR, { recursive: true, force: true });
    }
    diag(`migrated ${LEGACY_DATA_DIR} -> ${target}`);
  } catch (err) {
    diag(`migrate FAILED (continuing with ${target}): ${err?.message ?? err}`);
  }
}

/** 运行期状态目录解析：显式 dataDir 优先，默认落 DSH 数据目录 storages/krun-vm（设计 §6）。
 *  纯函数（可独立测试）；走默认路径时顺带做旧目录迁移。 */
function resolveDataDir(config, diag = () => {}) {
  const dir = config.dataDir ? expandHome(config.dataDir) : DEFAULT_DATA_DIR;
  if (!config.dataDir) migrateLegacyDir(dir, diag);
  return dir;
}

/** 会话键：workspace + 模式 → 短哈希。 */
function sessionKey(ws, mode) {
  const h = createHash('sha1');
  h.update(ws);
  h.update('\0');
  h.update(mode);
  return h.digest('hex').slice(0, 16);
}

/** 镜像注册表：<dataDir>/registry.json —— 工作区绑定（workspace 绝对路径 → imageId）。
 *  多进程（live/headless）并发写经原子替换（tmp + rename）序列化，见设计 §14.8。 */
const REGISTRY = {
  path(dataDir) { return join(dataDir, 'registry.json'); },
  read(dataDir) {
    try {
      const raw = JSON.parse(readFileSync(REGISTRY.path(dataDir), 'utf8'));
      return { workspaces: raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {} };
    } catch { return { workspaces: {} }; }
  },
  write(dataDir, reg) {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${REGISTRY.path(dataDir)}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
    renameSync(tmp, REGISTRY.path(dataDir));
  },
};

/** execFile 的 Promise 包装（tar/du/apk 等外部工具）。 */
function runFile(file, args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(file, args, { timeout: 600000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; rej(err); } else res(stdout);
    });
  });
}

/** 解包 rootfs tarball（tar 自动识别 gz/xz/zst 压缩）。 */
async function extractRootfsTar(tarPath, dest) {
  await runFile('tar', ['-xf', tarPath, '-C', dest]);
}

/** 下载 URL 到临时文件（宿主网络直连）。 */
async function downloadTo(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url}: HTTP ${r.status}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

/** 容器导出（docker/podman export 的 tar 流落盘）。 */
function containerExportTar(engine, container, destTar) {
  return new Promise((res, rej) => {
    const p = spawn(engine, ['export', container], { stdio: ['ignore', 'pipe', 'inherit'] });
    const out = createWriteStream(destTar);
    p.stdout.pipe(out);
    p.on('error', rej);
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${engine} export ${container} exited ${code}`))));
    out.on('error', rej);
  });
}

/** guest 内系统包保障：Alpine 系经免 root loader-apk 装入（宿主网络，幂等——已存在则跳过）；
 *  非 Alpine 镜像要求自带。bash 是 bash 工具的硬前提；qcow2 数据层的首次格式化需要
 *  e2fsprogs（raw 路径宿主预格式化，不需要）。 */
async function ensureGuestPackages(rootfs, extra = []) {
  const has = (...paths) => paths.some((p) => existsSync(join(rootfs, p)));
  const need = [];
  if (!has('bin/bash', 'usr/bin/bash')) need.push('bash');
  for (const p of extra) {
    if (p === 'e2fsprogs' && has('usr/sbin/mkfs.ext4', 'sbin/mkfs.ext4')) continue;
    need.push(p);
  }
  if (need.length === 0) return { installed: [], warning: null };
  const apk = join(rootfs, 'sbin', 'apk');
  const libs = join(rootfs, 'lib');
  const loader = existsSync(libs)
    ? readdirSync(libs).find((f) => f.startsWith('ld-musl-'))
    : undefined;
  if (!existsSync(apk) || !loader) {
    return { installed: [], warning: `non-alpine image missing [${need.join(', ')}]` };
  }
  let stderr = '';
  try {
    await runFile(join(libs, loader), [apk, '--root', rootfs, 'add', ...need], {
      env: { LD_LIBRARY_PATH: `${libs}:${join(rootfs, 'usr', 'lib')}`, PATH: '/usr/bin:/bin' },
      timeout: 300000,
    });
  } catch (e) {
    stderr = String(e?.stderr || e?.message || e);
  }
  // 判定以产物落地为准（apk 对 chroot trigger 报 EPERM 可忽略）
  const ok = need.every((p) => (p === 'bash' ? has('bin/bash', 'usr/bin/bash') : p !== 'e2fsprogs' || has('usr/sbin/mkfs.ext4', 'sbin/mkfs.ext4')));
  return ok
    ? { installed: need, warning: null }
    : { installed: [], warning: stderr.slice(0, 300) || `apk add [${need.join(', ')}] produced no binaries` };
}

/** 目录树占用字节数（du -sb）。 */
async function duBytes(path) {
  try {
    const out = await runFile('du', ['-sb', path], { timeout: 120000 });
    return Number.parseInt(out.split('\t')[0], 10) || 0;
  } catch { return 0; }
}

/** 镜像库根：<dataDir>/images/<imageId>/{manifest.json, rootfs}（设计 §6）。 */
function imagesDir(dataDir) {
  return join(dataDir, 'images');
}

/** 镜像导入核心（纯文件操作，独立于 cordis 上下文，可独立调用/测试）。
 *  来源 v1（设计 §6）：tarball 本地路径 / URL / 目录树 / 容器导出（docker|podman）。 */
async function runImportJob(dataDir, job, req, diag = () => {}) {
  const id = `img-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const imgDir = join(imagesDir(dataDir), id);
  const rootfs = join(imgDir, 'rootfs');
  mkdirSync(rootfs, { recursive: true });
  let source;
  if (job.kind === 'tarball' || job.kind === 'url') {
    const src = job.kind === 'url'
      ? await downloadTo(String(req.url), join(mkdtempSync(join(tmpdir(), 'krun-import-')), 'image.tar'))
      : expandHome(String(req.path));
    await extractRootfsTar(src, rootfs);
    source = job.kind === 'url' ? String(req.url) : String(req.path);
  } else if (job.kind === 'dir') {
    const src = expandHome(String(req.path));
    if (!existsSync(src)) throw new Error(`source directory missing: ${src}`);
    cpSync(src, rootfs, { recursive: true });
    source = String(req.path);
  } else {
    const engine = String(req.engine ?? '') || (existsSync('/usr/bin/podman') ? 'podman' : 'docker');
    const tar = join(mkdtempSync(join(tmpdir(), 'krun-import-')), 'image.tar');
    await containerExportTar(engine, String(req.container), tar);
    await extractRootfsTar(tar, rootfs);
    source = `${engine}:${String(req.container)}`;
  }
  const pkgs = await ensureGuestPackages(rootfs, req.dataDiskFormat === 'qcow2' ? ['e2fsprogs'] : []);
  const manifest = {
    id,
    name: String(req.name ?? '') || basename(source || id),
    distro: String(req.distro ?? '') || (existsSync(join(rootfs, 'etc', 'alpine-release')) ? 'alpine' : 'linux'),
    arch: process.arch,
    created: new Date().toISOString(),
    source: `${job.kind}:${source ?? ''}`,
    format: 'dir',
    sizeBytes: await duBytes(imgDir),
    bashReady: existsSync(join(rootfs, 'bin', 'bash')) || existsSync(join(rootfs, 'usr', 'bin', 'bash')),
    ...(pkgs.warning ? { warning: pkgs.warning } : {}),
  };
  writeFileSync(join(imgDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  job.status = 'done';
  job.imageId = id;
  job.manifest = manifest;
  diag(`import done ${id} (${manifest.name})`);
  return manifest;
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
    /** 显式端口映射 ["host:guest", …]：应用层端口转发（vsock 通道，宿主监听 127.0.0.1:<host>）。
     *  network=none 档下的"零宿主端口占用 + 只暴露指定端口"组合即由此实现；
     *  tsi 档自动暴露之外这是额外直达通道。空 = 无转发。 */
    portMap: z.array(z.string()).default([]),
    /** 数据层盘格式：raw（ext4 稀疏盘，经典路径）/ qcow2（快照/克隆友好，需宿主 qemu-img，
     *  首次启动由 guest 内格式化）。 */
    dataDiskFormat: z.union([z.const('raw'), z.const('qcow2')]).default('raw'),
    /** 会话守护进程（serve）：注册表 + boot 子进程监督 + gc/转发监听。true = provider 经
     *  UNIX socket JSON 行协议调用（跨进程共享会话，live/headless 同 dataDir 共用一 VM）；
     *  false = 遗留直 spawn boot 路径。 */
    daemon: z.boolean().default(true),
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
    this.krunDataDir = resolveDataDir(config, (m) => this.krunDiag(m));
    this.krunBackendPath = expandHome(config.backendPath || join(PKG_DIR, 'bin', 'krun-backend'));
    /** key → { child, agentSock, ws, mode, logPath, lastUse, liveTerminals } */
    this.sessions = new Map();
    /** 单飞引导：同一 key 的并发 confine 共享一次启动 */
    this.booting = new Map();
    /** 镜像导入任务表：jobId → { id, kind, label, status, startedAt, error?, imageId?, manifest? } */
    this.krunJobs = new Map();
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
    // 人类命令（§8.2）：commands 为 base bundle 根作用域服务，此处注册为全局命令。
    ctx.inject(['commands'], (injectCtx) => {
      this.krunDiag('commands inject callback fired');
      this.krunRegisterCommands(injectCtx);
    });
    // 诊断 skill（仿 windows-acl）：skills 注册表根作用域可用，内联 runtime 注册。
    ctx.inject(['skills'], (injectCtx) => {
      this.krunDiag('skills inject callback fired');
      try {
        this.krunCtx.effect(() => {
          this.krunDiag('registered diagnose-krun-vm-sandbox');
          return injectCtx.skills.register({
            name: KRUN_DIAGNOSIS_SKILL.name,
            description: KRUN_DIAGNOSIS_SKILL.description,
            whenToUse: KRUN_DIAGNOSIS_SKILL.whenToUse,
            source: KRUN_DIAGNOSIS_SKILL.source,
            resourceBase: KRUN_DIAGNOSIS_SKILL.resourceBase,
            content: KRUN_DIAGNOSIS_SKILL.content,
          });
        }, 'krun-vm: diagnose skill');
      } catch (err) {
        this.krunDiag(`register skill THREW: ${err?.message ?? err}`);
      }
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
        dataDir: this.krunDataDir,
        bridgePath: join(PKG_DIR, 'bin', 'krun'),
        imageRootfs: this.krunConfig.imageRootfs,
        idleStopMs: this.krunConfig.idleStopMs,
        network: this.krunConfig.network,
        portMap: this.krunConfig.portMap ?? [],
        dataDiskFormat: this.krunConfig.dataDiskFormat ?? 'raw',
        resources: this.krunConfig.resources,
      },
      sessions: [...this.sessions.values()].map((s) => ({
        key: s.key, ws: s.ws, mode: s.mode, image: s.image,
        network: s.network ?? this.krunConfig.network,
        alive: s.daemonManaged ? true : !s.child.killed,
        uptimeMs: Date.now() - (s.startedAt ?? Date.now()),
        idleMs: Date.now() - (s.lastUse ?? Date.now()),
      })),
      images: this.krunListImages(),
      workspaces: REGISTRY.read(this.krunDataDir).workspaces,
      jobs: [...this.krunJobs.values()].slice(-20),
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
        await this.krunRefreshSessions().catch(() => {});
        sendJson(res, 200, this.krunStatusSnapshot());
      },
    }, 'krun-vm: GET /api/krun/status');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/stop',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        await this.krunRefreshSessions().catch(() => {});
        const stopped = await this.krunStopSession(String(body.key ?? ''));
        if (!stopped) { sendJson(res, 404, { ok: false, err: 'unknown session key' }); return; }
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
    registerRoute({
      kind: 'exact',
      path: '/api/krun/ensure',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        const ws = String(body.ws ?? '');
        const mode = body.mode === 'ro' ? 'ro' : 'rw';
        if (!ws.startsWith('/')) { sendJson(res, 400, { ok: false, err: 'ws must be an absolute path' }); return; }
        try {
          const session = await this.ensureSession({ mode, workspaceRoot: ws });
          session.lastUse = Date.now();
          sendJson(res, 200, { ok: true, key: session.key, ws: session.ws, mode: session.mode });
        } catch (err) {
          sendJson(res, 200, { ok: false, err: String(err?.message ?? err) });
        }
      },
    }, 'krun-vm: POST /api/krun/ensure');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/images',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
        sendJson(res, 200, {
          ok: true,
          images: this.krunListImages(),
          jobs: [...this.krunJobs.values()].slice(-20),
          workspaces: REGISTRY.read(this.krunDataDir).workspaces,
        });
      },
    }, 'krun-vm: GET /api/krun/images');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/images/import',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        const running = [...this.krunJobs.values()].find((j) => j.status === 'running');
        if (running) { sendJson(res, 409, { ok: false, err: `import job ${running.id} is running` }); return; }
        const kind = String(body.kind ?? '');
        if (!['tarball', 'url', 'dir', 'container'].includes(kind)) {
          sendJson(res, 400, { ok: false, err: `kind must be tarball|url|dir|container, got ${kind || '(empty)'}` });
          return;
        }
        if (kind === 'container' && !String(body.container ?? '').trim()) {
          sendJson(res, 400, { ok: false, err: 'container name is required' });
          return;
        }
        if (kind === 'url' && !String(body.url ?? '').trim()) {
          sendJson(res, 400, { ok: false, err: 'url is required' });
          return;
        }
        if ((kind === 'tarball' || kind === 'dir') && !String(body.path ?? '').trim()) {
          sendJson(res, 400, { ok: false, err: 'path is required' });
          return;
        }
        const job = {
          id: `job-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,
          kind,
          label: String(body.name ?? body.path ?? body.container ?? kind),
          status: 'running',
          startedAt: Date.now(),
        };
        this.krunJobs.set(job.id, job);
        // 异步执行：HTTP 立即返回 jobId，进度经 /api/krun/status|images 轮询
        this.krunRunImport(job, body).catch((err) => {
          job.status = 'error';
          job.error = String(err?.message ?? err);
        });
        sendJson(res, 200, { ok: true, jobId: job.id });
      },
    }, 'krun-vm: POST /api/krun/images/import');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/images/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        const id = String(body.id ?? '');
        sendJson(res, 200, { ok: true, ...(await this.krunDeleteImage(id)) });
      },
    }, 'krun-vm: POST /api/krun/images/delete');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/workspaces/bind',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        const ws = String(body.ws ?? '');
        const imageId = String(body.imageId ?? '');
        const rootfs = join(this.krunImagesDir(), imageId, 'rootfs');
        if (!ws.startsWith('/') || !existsSync(rootfs)) {
          sendJson(res, 400, { ok: false, err: `invalid ws or unknown image ${imageId}` });
          return;
        }
        const reg = REGISTRY.read(this.krunDataDir);
        const entry = { imageId, boundAt: new Date().toISOString() };
        const net = body.network === 'tsi' || body.network === 'none' ? body.network : undefined;
        if (net) entry.network = net;
        reg.workspaces[ws] = entry;
        REGISTRY.write(this.krunDataDir, reg);
        this.krunInvalidateWsCache(ws);
        this.krunDiag(`bind ${ws} -> ${imageId}${net ? ` (network ${net})` : ''}`);
        sendJson(res, 200, { ok: true });
      },
    }, 'krun-vm: POST /api/krun/workspaces/bind');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/workspaces/network',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        const ws = String(body.ws ?? '');
        const net = body.network;
        if (!ws.startsWith('/')) { sendJson(res, 400, { ok: false, err: 'ws must be an absolute path' }); return; }
        if (net !== 'tsi' && net !== 'none' && net !== null && net !== '') {
          sendJson(res, 400, { ok: false, err: "network must be tsi|none|'' (clear)" });
          return;
        }
        const reg = REGISTRY.read(this.krunDataDir);
        if (net === 'tsi' || net === 'none') {
          reg.workspaces[ws] = { ...(reg.workspaces[ws] ?? { imageId: null, boundAt: new Date().toISOString() }), network: net };
        } else if (reg.workspaces[ws]) {
          delete reg.workspaces[ws].network; // 恢复全局默认
        }
        REGISTRY.write(this.krunDataDir, reg);
        this.krunInvalidateWsCache(ws);
        this.krunDiag(`workspace network ${ws} -> ${net || '(default)'}`);
        sendJson(res, 200, { ok: true });
      },
    }, 'krun-vm: POST /api/krun/workspaces/network');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/workspaces/unbind',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        const ws = String(body.ws ?? '');
        const reg = REGISTRY.read(this.krunDataDir);
        if (!reg.workspaces[ws]) { sendJson(res, 404, { ok: false, err: 'not bound' }); return; }
        delete reg.workspaces[ws];
        REGISTRY.write(this.krunDataDir, reg);
        sendJson(res, 200, { ok: true });
      },
    }, 'krun-vm: POST /api/krun/workspaces/unbind');
    registerRoute({
      kind: 'exact',
      path: '/api/krun/workspaces/reset',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const body = await readBody(req);
        sendJson(res, 200, await this.krunResetWorkspaceData(String(body.ws ?? '')));
      },
    }, 'krun-vm: POST /api/krun/workspaces/reset');
  }

  /** 镜像库：<dataDir>/images/<imageId>/{manifest.json, rootfs}（设计 §6）。 */
  krunImagesDir() {
    return imagesDir(this.krunDataDir);
  }

  krunListImages() {
    const dir = this.krunImagesDir();
    let ids = [];
    try {
      ids = readdirSync(dir).filter((e) => existsSync(join(dir, e, 'manifest.json')));
    } catch { /* 目录不存在 = 无镜像 */ }
    const reg = REGISTRY.read(this.krunDataDir);
    const refCount = {};
    for (const b of Object.values(reg.workspaces)) {
      if (b?.imageId) refCount[b.imageId] = (refCount[b.imageId] ?? 0) + 1;
    }
    return ids.map((id) => {
      try {
        const m = JSON.parse(readFileSync(join(dir, id, 'manifest.json'), 'utf8'));
        return { ...m, id, refCount: refCount[id] ?? 0 };
      } catch {
        return { id, name: id, error: 'manifest unreadable', refCount: refCount[id] ?? 0 };
      }
    });
  }

  /** 引导镜像解析：工作区绑定 → 配置 imageRootfs（遗留单镜像路径，兼容既有部署）。 */
  krunResolveImage(ws) {
    const binding = REGISTRY.read(this.krunDataDir).workspaces[ws];
    if (binding?.imageId) {
      const rootfs = join(this.krunImagesDir(), binding.imageId, 'rootfs');
      if (existsSync(rootfs)) return rootfs;
    }
    const legacy = expandHome(this.krunConfig.imageRootfs);
    if (legacy && existsSync(legacy)) return legacy;
    return null;
  }

  /** 镜像导入任务（HTTP 层薄封装；核心见 runImportJob）。 */
  async krunRunImport(job, req) {
    await runImportJob(this.krunDataDir, job, req, (m) => this.krunDiag(m));
  }

  /** 删除镜像：有绑定或运行中会话引用时拒绝（设计 §6 user-only 语义）。 */
  async krunDeleteImage(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, err: `invalid image id ${id}` };
    const reg = REGISTRY.read(this.krunDataDir);
    const boundWs = Object.keys(reg.workspaces).filter((ws) => reg.workspaces[ws]?.imageId === id);
    if (boundWs.length > 0) return { ok: false, err: `bound by ${boundWs.length} workspace(s): ${boundWs.join(', ')}` };
    const imgDir = join(this.krunImagesDir(), id);
    for (const s of this.sessions.values()) {
      if (s.image === join(imgDir, 'rootfs')) return { ok: false, err: `in use by running session ${s.key}` };
    }
    if (!existsSync(imgDir)) return { ok: false, err: `unknown image ${id}` };
    rmSync(imgDir, { recursive: true, force: true });
    this.krunDiag(`image deleted ${id}`);
    return { ok: true };
  }

  /** 丢弃工作区数据层（容器级重置）：停会话 + 删数据盘。user-only 破坏类操作。 */
  async krunResetWorkspaceData(ws) {
    if (!ws.startsWith('/')) return { ok: false, err: 'ws must be an absolute path' };
    const stopped = [];
    const removed = [];
    for (const [key, s] of [...this.sessions]) {
      if (s.ws !== ws) continue;
      await this.krunStopSession(key);
      stopped.push(`${key}(${s.mode})`);
    }
    for (const mode of ['ro', 'rw']) {
      const img = join(this.krunDataDir, 'workspaces', `${sessionKey(ws, mode)}.img`);
      if (existsSync(img)) {
        rmSync(img, { force: true });
        removed.push(img);
      }
    }
    this.krunDiag(`reset ${ws}: stopped=[${stopped.join(',')}] removed=${removed.length}`);
    return { ok: true, stopped, removed };
  }

  /** /vm 命令组（设计 §8.2）：一个注册项解析 status|stop|reset 三个子命令。 */
  krunRegisterCommands(injectCtx) {
    const def = {
      name: 'vm',
      description: 'VM 沙盒（libkrun）管理：状态 / 停止会话 / 重置工作区数据层',
      input: { hint: 'status | stop [all|<key>|ro|rw] | reset confirm' },
      handler: async (invocation) => this.krunVmCommand(invocation),
    };
    try {
      this.krunCtx.effect(() => {
        this.krunDiag('registered /vm');
        return injectCtx.commands.register(def);
      }, 'krun-vm: /vm command');
    } catch (err) {
      this.krunDiag(`register /vm THREW: ${err?.message ?? err}`);
    }
  }

  async krunVmCommand(invocation) {
    const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0] ?? 'status';
    try {
      if (sub === 'status') return { kind: 'success', text: await this.krunVmStatusText(invocation) };
      if (sub === 'stop') return this.krunVmStop(parts[1]);
      if (sub === 'reset') return await this.krunVmReset(invocation, parts[1] === 'confirm');
      return { kind: 'error', text: '用法：/vm status ｜ /vm stop [all|<key>|ro|rw] ｜ /vm reset confirm' };
    } catch (err) {
      return { kind: 'error', text: `vm: ${err?.message ?? err}` };
    }
  }

  async krunVmStatusText(invocation) {
    await this.krunRefreshSessions().catch(() => {});
    const lines = [];
    const probe = this.krunProbeCache ?? await this.probe();
    lines.push(`环境：${probe.ok ? '可用' : `不可用（${probe.detail}）`}`);
    const images = this.krunListImages();
    const legacy = expandHome(this.krunConfig.imageRootfs);
    lines.push(`镜像：${images.length} 个导入镜像${legacy && existsSync(legacy) ? ' ＋ 默认 imageRootfs' : ''}`);
    for (const im of images) {
      lines.push(`  - ${im.name} (${im.id}) · ${im.arch} · ${Math.round((im.sizeBytes ?? 0) / 1048576)}MiB · 引用 ${im.refCount}`);
    }
    const sessions = [...this.sessions.values()];
    lines.push(`会话：${sessions.length} 个${this.krunConfig.network === 'none' ? ' · network=none' : ' · network=tsi'}`);
    for (const s of sessions) {
      lines.push(`  - ${s.key} · ${s.mode} · ${s.ws} · 运行 ${Math.round((Date.now() - (s.startedAt ?? Date.now())) / 1000)}s`);
    }
    const reg = REGISTRY.read(this.krunDataDir);
    const wsKeys = Object.keys(reg.workspaces);
    if (wsKeys.length > 0) {
      lines.push(`工作区绑定：${wsKeys.length} 个`);
      for (const ws of wsKeys) {
        const b = reg.workspaces[ws];
        lines.push(`  - ${ws} → ${b.imageId}${b.network ? `（网络 ${b.network}）` : '（网络默认）'}`);
      }
    }
    if (invocation) {
      try {
        const ws = await this.krunWorkingDirectory.ensure(invocation.agent, invocation.signal);
        const binding = reg.workspaces[ws];
        lines.push(`当前工作区：${ws}${binding ? `（绑定 ${binding.imageId}）` : '（默认镜像）'}`);
      } catch { /* 会话无工作区时跳过 */ }
    }
    return lines.join('\n');
  }

  async krunVmStop(filter) {
    await this.krunRefreshSessions().catch(() => {});
    const targets = [...this.sessions.values()].filter((s) => {
      if (!filter || filter === 'all') return true;
      if (filter === 'ro' || filter === 'rw') return s.mode === filter;
      return s.key.startsWith(filter);
    });
    if (targets.length === 0) return { kind: 'error', text: `无匹配会话（${filter ?? 'all'}）；当前 ${this.sessions.size} 个` };
    for (const s of targets) {
      await this.krunStopSession(s.key);
    }
    return { kind: 'success', text: `已停止 ${targets.length} 个会话：${targets.map((s) => `${s.key}(${s.mode})`).join(', ')}` };
  }

  async krunVmReset(invocation, confirmed) {
    const ws = await this.krunWorkingDirectory.ensure(invocation.agent, invocation.signal);
    const dataImgs = ['ro', 'rw']
      .map((mode) => join(this.krunDataDir, 'workspaces', `${sessionKey(ws, mode)}.img`))
      .filter((p) => existsSync(p));
    const live = [...this.sessions.values()].filter((s) => s.ws === ws);
    if (!confirmed) {
      const lines = [
        `将重置工作区数据层：${ws}`,
        `  停止会话：${live.length > 0 ? live.map((s) => `${s.key}(${s.mode})`).join(', ') : '（无）'}`,
        `  删除数据层：${dataImgs.length > 0 ? dataImgs.join(', ') : '（无数据层文件）'}`,
        '该操作丢弃 VM 内生成的系统级数据（apt 安装、编译产物等），不可恢复；工作区目录本身不受影响。',
        '确认执行请输入：/vm reset confirm',
      ];
      return { kind: 'success', text: lines.join('\n') };
    }
    const result = this.krunResetWorkspaceData(ws);
    return result.ok
      ? { kind: 'success', text: `已重置：停止 ${result.stopped.length} 个会话，删除 ${result.removed.length} 个数据层文件。下次命令将重新引导空白数据层。` }
      : { kind: 'error', text: `重置失败：${result.err}` };
  }

  /** agent 活跃连接查询（stat 协议，agent v2）；旧 agent/VM 已退出时返回 null。 */
  krunAgentStat(session, timeoutMs = 1500) {
    return new Promise((res) => {
      let buf = '';
      const s = netConnect({ path: session.agentSock }, () => {
        s.write(`${JSON.stringify({ type: 'stat' })}\n`);
      });
      const timer = setTimeout(() => { s.destroy(); res(null); }, timeoutMs);
      s.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        s.destroy();
        try { res(JSON.parse(buf.slice(0, nl))); } catch { res(null); }
      });
      s.on('error', () => { clearTimeout(timer); res(null); });
    });
  }

  /** 空闲回收：无活跃终端/连接且超过 idleStopMs 的会话优雅停机（数据层天然落盘）。
   *  daemon 模式：gc 在守护进程执行（stat 覆盖全部客户端的 exec/term/fwd 连接），
   *  响应的 stopped 键同步修剪本地缓存；legacy 模式：本方法自管（agent stat 探测）。 */
  async krunGcIdle() {
    const idle = this.krunConfig.idleStopMs ?? 600000;
    if (!idle) return;
    if (this.krunConfig.daemon ?? true) {
      const reply = await this.krunDaemonCall('session.gc', { idleMs: idle }).catch(() => null);
      if (reply?.ok) {
        for (const key of reply.stopped ?? []) this.sessions.delete(key);
      }
      return;
    }
    const now = Date.now();
    for (const [key, s] of [...this.sessions]) {
      if ((s.liveTerminals ?? 0) > 0) continue;
      if (now - (s.lastUse ?? now) <= idle) continue;
      const stat = await this.krunAgentStat(s);
      if (stat && (stat.execConns > 0 || stat.termConns > 0 || stat.fwdConns > 0)) {
        s.lastUse = now; // 有活动连接：视为在用，刷新计时
        continue;
      }
      s.child.kill('SIGTERM');
      this.sessions.delete(key);
    }
  }

  /** 工作区生效配置：镜像（绑定 → imageRootfs）+ 网络档（绑定 network → 全局默认）。
   *  网络按工作区覆盖是用户显式设置（设计 §10 workspaces[]），不走全局一刀切。 */
  krunWorkspaceSettings(ws) {
    const binding = REGISTRY.read(this.krunDataDir).workspaces[ws];
    const network = binding?.network === 'tsi' || binding?.network === 'none'
      ? binding.network
      : this.krunConfig.network;
    const image = this.krunResolveImage(ws);
    return { image, network, binding };
  }

  /** 工作区设置变更后失效本实例的会话缓存：下次 ensure 重新走指纹比对，
   *  档位/镜像变化的会话由守护进程停旧启新。 */
  krunInvalidateWsCache(ws) {
    for (const mode of ['ro', 'rw']) {
      this.sessions.delete(sessionKey(ws, mode));
    }
  }

  /** 环境探测（结果缓存到实例生命周期）：KVM 可用、后端就绪、镜像可用。 */
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
    // 镜像可用性：默认 imageRootfs（遗留路径）或已导入镜像任一即可
    const legacy = expandHome(this.krunConfig.imageRootfs);
    const imported = this.krunListImages();
    if ((!legacy || !existsSync(legacy)) && imported.length === 0) {
      problems.push('no image: imageRootfs not configured/missing and no imported images');
    }
    this.krunProbeCache = { ok: problems.length === 0, detail: problems.join('; ') };
    return this.krunProbeCache;
  }

  /** 把 guest 侧文件烤入镜像树（幂等）。agent 按宿主架构选择：guest 架构 = KVM 宿主
   *  架构；aarch64 预置二进制存在且宿主为 arm64 时使用（aarch64 引导待 aarch64 主机实测）。 */
  bakeGuestFiles(imageRootfs) {
    const agentBin = process.arch === 'arm64' && existsSync(join(PKG_DIR, 'guest', 'dsh-vm-agent-aarch64'))
      ? join(PKG_DIR, 'guest', 'dsh-vm-agent-aarch64')
      : GUEST_AGENT;
    const agentDst = join(imageRootfs, 'usr', 'bin', 'dsh-vm-agent');
    const setupDst = join(imageRootfs, 'dsh-setup');
    mkdirSync(dirname(agentDst), { recursive: true });
    writeFileSync(agentDst, readFileSync(agentBin));
    chmodSync(agentDst, 0o755);
    writeFileSync(setupDst, readFileSync(GUEST_SETUP));
    chmodSync(setupDst, 0o755);
    // DNS：minirootfs 不带 resolv.conf；tsi 档共享宿主网络（宿主 resolver 经代理可达），
    // 原样拷贝宿主 resolv.conf。none 档无网络，此文件无副作用。
    try {
      writeFileSync(join(imageRootfs, 'etc', 'resolv.conf'), readFileSync('/etc/resolv.conf'));
    } catch { /* 宿主无 resolv.conf 时跳过 */ }
  }

  /** 会话守护进程连接（懒建；失败重 spawn，ping 为就绪判据）。单连接 + 调用串行队列。 */
  krunDaemonSocket() {
    return join(this.krunDataDir, 'daemon.sock');
  }

  async krunDaemonConn() {
    if (this.krunDaemon) return this.krunDaemon.conn;
    const sockPath = this.krunDaemonSocket();
    const pingOnce = () => new Promise((res) => {
      const s = netConnect({ path: sockPath }, () => {
        s.write(`${JSON.stringify({ method: 'ping' })}\n`);
      });
      let buf = '';
      const timer = setTimeout(() => { s.destroy(); res(false); }, 1500);
      s.on('data', (d) => {
        buf += typeof d === 'string' ? d : d.toString('utf8');
        if (buf.includes('"krun-backend-serve"')) { clearTimeout(timer); s.destroy(); res(true); }
      });
      s.on('error', () => { clearTimeout(timer); s.destroy(); res(false); });
    });
    const spawnDaemon = () => new Promise((res) => {
      const env = { ...process.env };
      const libDir = expandHome(this.krunConfig.libDir);
      if (libDir) env.LD_LIBRARY_PATH = libDir;
      const child = spawn(this.krunBackendPath, ['serve', '--socket', sockPath], {
        env,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      this.krunDiag(`daemon spawned pid=${child.pid}`);
      res(child);
    });
    const deadline = Date.now() + 8000;
    let spawned = false;
    while (Date.now() < deadline) {
      if (await pingOnce()) break;
      if (!spawned) {
        spawned = true;
        await spawnDaemon();
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!(await pingOnce())) {
      throw new Error(`krun daemon not reachable at ${sockPath}`);
    }
    const conn = netConnect({ path: sockPath });
    await new Promise((res, rej) => {
      conn.once('connect', res);
      conn.once('error', rej);
    });
    this.krunDaemon = { conn };
    conn.on('error', () => { if (this.krunDaemon?.conn === conn) this.krunDaemon = null; });
    conn.on('close', () => { if (this.krunDaemon?.conn === conn) this.krunDaemon = null; });
    this.krunDiag('daemon connected');
    return conn;
  }

  /** 守护进程调用（串行队列：单连接上一问一答，严格有序）。 */
  krunDaemonCall(method, params) {
    const run = async () => {
      const conn = await this.krunDaemonConn();
      return new Promise((res, rej) => {
        let buf = '';
        const onData = (d) => {
          buf += typeof d === 'string' ? d : d.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          conn.removeListener('data', onData);
          try { res(JSON.parse(buf.slice(0, nl))); } catch (e) { rej(e); }
        };
        const onErr = (e) => {
          conn.removeListener('data', onData);
          if (this.krunDaemon?.conn === conn) this.krunDaemon = null;
          rej(e);
        };
        conn.on('data', onData);
        conn.once('error', onErr);
        conn.write(`${JSON.stringify({ method, params })}\n`);
      });
    };
    this.krunDaemonChain = (this.krunDaemonChain ?? Promise.resolve()).then(run, run);
    return this.krunDaemonChain;
  }

  /** 会话停止（按模式路由：daemon → session.stop；legacy → child.kill）。 */
  async krunStopSession(key) {
    const s = this.sessions.get(key);
    if (s?.daemonManaged) {
      const reply = await this.krunDaemonCall('session.stop', { key }).catch((e) => ({ ok: false, err: String(e) }));
      this.sessions.delete(key);
      return Boolean(reply.ok);
    }
    if (s) {
      s.child.kill('SIGTERM');
      this.sessions.delete(key);
      return true;
    }
    return false;
  }

  /** 守护进程会话清单 → 本地缓存重建（daemon 为准；保留终端计数）。 */
  async krunRefreshSessions() {
    if (!(this.krunConfig.daemon ?? true)) return;
    const reply = await this.krunDaemonCall('session.list', {}).catch(() => null);
    if (!reply?.ok) return;
    const fresh = new Map();
    for (const s of reply.sessions ?? []) {
      fresh.set(s.key, {
        key: s.key,
        child: null,
        agentSock: s.agentSock,
        ws: s.ws,
        mode: s.mode,
        image: s.image,
        network: this.krunWorkspaceSettings(s.ws).network,
        startedAt: Date.now() - (s.uptimeMs ?? 0),
        lastUse: Date.now() - (s.idleMs ?? 0),
        liveTerminals: this.sessions.get(s.key)?.liveTerminals ?? 0,
        daemonManaged: true,
        forwards: s.forwards ?? 0,
      });
    }
    this.sessions = fresh;
  }

  async waitForAgent(sockPath, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted while waiting for agent');
      if (existsSync(sockPath)) {
        // socket 文件在 VMM 绑定 vsock 端口时即出现（guest 侧 agent 可能还在引导，
        // 如 qcow2 首次 guest 内 mkfs）——以 ping/pong 确认 agent 真正就绪
        const ok = await new Promise((res) => {
          const s = netConnect({ path: sockPath }, () => {
            s.write(`${JSON.stringify({ type: 'ping' })}\n`);
          });
          let buf = '';
          const timer = setTimeout(() => { s.destroy(); res(false); }, 1200);
          s.on('data', (d) => {
            buf += d;
            if (buf.includes('"ok":true')) { clearTimeout(timer); s.destroy(); res(true); }
          });
          s.on('error', () => { clearTimeout(timer); s.destroy(); res(false); });
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

    const boot = this.bootSession({ key, ws, mode, policy }, signal)
      .then((session) => {
        // 缓存统一在 ensureSession 落账（daemon/legacy 两条引导路径共用）；
        // 单飞记录清除——否则 gc 回收后同 key 永远拿到已死的 boot promise
        this.sessions.set(key, session);
        this.booting.delete(key);
        return session;
      })
      .catch((err) => {
        this.booting.delete(key);
        throw err;
      });
    this.booting.set(key, boot);
    return boot;
  }

  /** 惰性引导一个会话；同 key 并发共享单次启动（daemon 模式下单飞在守护进程内）。 */
  async bootSession({ key, ws, mode, policy }, signal) {
    const probe = await this.probe();
    if (!probe.ok) throw new SandboxUnavailableError(policy.mode, `krun VM unavailable — ${probe.detail}`);

    // 镜像解析：工作区绑定 → 默认 imageRootfs（无镜像 fail-closed）
    const imageRootfs = this.krunResolveImage(ws);
    if (!imageRootfs) {
      throw new SandboxUnavailableError(policy.mode, `krun VM unavailable — no image for ${ws} (import an image or set imageRootfs)`);
    }
    this.bakeGuestFiles(imageRootfs);
    // qcow2 数据层首次启动在 guest 内格式化：镜像缺 e2fsprogs 时按需补装（宿主网络，幂等）
    if ((this.krunConfig.dataDiskFormat ?? 'raw') === 'qcow2') {
      const pkgs = await ensureGuestPackages(imageRootfs, ['e2fsprogs']);
      if (pkgs.warning) this.krunDiag(`guest pkgs warning: ${pkgs.warning}`);
    }

    const { network } = this.krunWorkspaceSettings(ws);
    if (this.krunConfig.daemon ?? true) {
      return this.bootSessionViaDaemon({ key, ws, mode, policy }, imageRootfs, network);
    }
    return this.bootSessionDirect({ key, ws, mode, policy }, imageRootfs, signal, network);
  }

  /** daemon 模式：引导委托给 serve 守护进程（会话注册表/监督/gc/转发监听都在那边）。
   *  network = 工作区覆盖档位（krunWorkspaceSettings），进指纹——档位变化自动停旧启新。 */
  async bootSessionViaDaemon({ key, ws, mode, policy }, imageRootfs, network) {
    const runDir = join(this.krunDataDir, 'run');
    const logDir = join(this.krunDataDir, 'logs');
    const sockPath = join(runDir, `${key}.sock`);
    const logPath = join(logDir, `${key}.log`);
    const dataImg = mode === 'rw' ? join(this.krunDataDir, 'workspaces', `${key}.img`) : undefined;
    const forwards = (this.krunConfig.portMap ?? []).map((entry) => {
      const [host, guest] = String(entry).split(':').map((v) => Number.parseInt(v, 10));
      if (!Number.isInteger(host) || !Number.isInteger(guest)) {
        throw new SandboxUnavailableError(policy.mode, `invalid portMap entry ${entry} (expect host:guest)`);
      }
      return { host, guest };
    });
    const fingerprint = createHash('sha1')
      .update(JSON.stringify({
        image: imageRootfs,
        vcpus: this.krunConfig.resources.vcpus,
        ram: this.krunConfig.resources.ramMib,
        network,
        portMap: this.krunConfig.portMap ?? [],
        dataFormat: this.krunConfig.dataDiskFormat ?? 'raw',
        dataImg,
      }))
      .digest('hex')
      .slice(0, 16);
    const reply = await this.krunDaemonCall('session.ensure', {
      key, ws, mode,
      image: imageRootfs,
      vcpus: this.krunConfig.resources.vcpus,
      ram: this.krunConfig.resources.ramMib,
      network,
      dataImg,
      dataFormat: this.krunConfig.dataDiskFormat ?? 'raw',
      agentSock: sockPath,
      logPath,
      forwards,
      fingerprint,
    }).catch((err) => ({ ok: false, err: `daemon call failed: ${err?.message ?? err}` }));
    if (!reply.ok) {
      throw new SandboxUnavailableError(policy.mode, `krun session boot failed — ${reply.err}; log: ${logPath}`);
    }
    this.krunDiag(`daemon session ${reply.reused ? 'reused' : 'booted'} key=${key}`);
    return {
      key,
      child: null,
      agentSock: sockPath,
      ws,
      mode,
      image: imageRootfs,
      network,
      logPath,
      lastUse: Date.now(),
      startedAt: Date.now(),
      liveTerminals: 0,
      daemonManaged: true,
      forwards: reply.session?.forwards ?? 0,
    };
  }

  /** 遗留直 spawn 路径（daemon:false）：一 VM 一子进程，provider 自管注册表/转发监听。 */
  async bootSessionDirect({ key, ws, mode, policy }, imageRootfs, signal, network) {
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
    if (network === 'none') confineArgs.push('--network', 'none');
    for (const pm of this.krunConfig.portMap ?? []) confineArgs.push('--forward', pm);
    if ((this.krunConfig.dataDiskFormat ?? 'raw') === 'qcow2') confineArgs.push('--data-format', 'qcow2');

    const env = { ...process.env };
    const libDir = expandHome(this.krunConfig.libDir);
    if (libDir) env.LD_LIBRARY_PATH = libDir;

    const out = openSync(logPath, 'a');
    const child = spawn(this.krunBackendPath, confineArgs, {
      env,
      stdio: ['ignore', out, out],
    });
    out.close?.();

    const session = { key, child, agentSock: sockPath, ws, mode, image: imageRootfs, logPath, lastUse: Date.now(), startedAt: Date.now(), liveTerminals: 0, fwdServers: [] };
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
    child.on('exit', () => {
      for (const srv of session.fwdServers ?? []) { try { srv.close(); } catch { /* 已关闭 */ } }
      this.sessions.delete(key);
    });
    // 应用层端口转发：宿主 127.0.0.1:<host> → run/<key>.fwd<vsock> → agent → guest 127.0.0.1:<guest>
    for (const [i, entry] of (this.krunConfig.portMap ?? []).entries()) {
      const [host, guest] = String(entry).split(':').map((v) => Number.parseInt(v, 10));
      if (!Number.isInteger(host) || !Number.isInteger(guest)) {
        throw new SandboxUnavailableError(policy.mode, `invalid portMap entry ${entry} (expect host:guest)`);
      }
      const fwdSock = `${sockPath}.fwd${4200 + i}`;
      const srv = netCreateServer((conn) => {
        const up = netConnect({ path: fwdSock }, () => {
          conn.pipe(up);
          up.pipe(conn);
        });
        up.on('error', () => conn.destroy());
        conn.on('error', () => up.destroy());
      });
      await new Promise((res, rej) => {
        srv.once('error', rej);
        srv.listen(host, '127.0.0.1', () => res());
      });
      session.fwdServers.push(srv);
    }
    this.booting.delete(key);
    return session;
  }

  /** disposer（插件卸载/HMR）：停全部会话并关停守护进程（§7——数据层天然落盘，
   *  重启后由持久数据层恢复）。legacy 会话 child.kill 直停。 */
  async stopAll() {
    for (const [, s] of this.sessions) {
      if (s.daemonManaged) continue; // daemon 会话由 shutdown 统一停
      s.child.kill('SIGTERM');
    }
    this.sessions.clear();
    if (this.krunDaemon) {
      try {
        await this.krunDaemonCall('shutdown', {});
      } catch { /* 连接已断 = 守护进程已退出 */ }
      this.krunDaemon = null;
    }
  }

  /** sandbox 接缝：把 argv 包装为 krun-exec 客户端调用。 */
  async confine(argv, policy, signal) {
    if (policy.mode === 'danger-full-access') {
      // executor 约定危险模式直接绕过 provider；到达此处属防御性错误
      throw new SandboxUnavailableError(policy.mode, 'danger-full-access must bypass the sandbox provider');
    }
    const session = await this.ensureSession(policy, signal);
    // exec 路径同样计入活跃（GC 计时刷新）；executor 以每次调用的 workdir spawn
    // 返回的 argv（LocalBashExecutor: cwd: spec.workdir），命令 cwd 由 krun-backend
    // exec 客户端以自身 getcwd() 取得——工作区在 guest 内挂同绝对路径，无需映射。
    session.lastUse = Date.now();
    if (session.daemonManaged) {
      // 守护进程侧计时同步（fire-and-forget；gc 据此 + agent stat 判定空闲）
      this.krunDaemonCall('session.touch', { key: session.key }).catch(() => {});
    }
    return {
      argv: [
        this.krunBackendPath,
        'exec',
        '--socket', session.agentSock,
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

// 导出：REGISTRY/runImportJob/imagesDir/resolveDataDir 供独立测试与脚本使用（镜像与
// 注册表是纯文件操作，不经 cordis 上下文；见设计 §4.1 职责分界）。
export { KrunSandboxProvider as default, KrunTerminalBackend, REGISTRY, runImportJob, imagesDir, resolveDataDir };
