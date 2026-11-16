# DeepSeek Harness 插件设计：基于 libkrun 的虚拟机沙盒模式

> 设计文档 · 2026-11-14 · 基于本机实际运行的 DSH `0.2.2-rc.1`（profile `web`）与 libkrun `stable-1.19.x` API 调研结果。
> 所有引用的 DSH 服务、事件、插槽与插槽路径均已通过 `cordis_inspect_query` / 已安装包 `README.md` 与 `lib/types/*.d.ts` 核实；libkrun API 均引自 `stable-1.19.x` 分支 `include/libkrun.h` 与官方文档。

---

## 1. 目标与范围

为 DeepSeek Harness（DSH）增加一种**虚拟机沙盒模式**：把当前工作区（项目文件夹）挂载进一个由 libkrun 驱动的轻量 microVM，此后

- 所有 **shell 命令**（`bash`/`pwsh` 工具、后台任务、Web 终端）都在 VM 内执行；
- 工作区目录与宿主机**双向实时共享**（同一份文件），文件读写工具（read/edit/glob/grep 等）继续走宿主机，看到的与 VM 内完全一致；
- 系统级副作用（`apt install`、编译产物、包管理器缓存等运行时生成的数据）持久化在"工作区数据层"，**覆盖在 VM 根文件系统 `/` 上**，VM 重启后保留；
- 系统镜像本身**只读**，可被多个工作区共享复用。

镜像的创建/导入/管理与 VM 的生命周期通过一个 **Host 服务**提供，并在 DSH Web GUI 中提供**管理页面**。

**范围裁剪（v1）**
- 平台：Linux/x86_64 + KVM 优先（本机已具备 `/dev/kvm`）；aarch64 Linux 同路径支持；macOS(HVF)/Windows(WHP) 列为后续。
- libkrun 版本锁定 `stable-1.19.x`（`main` 是不向后兼容的 2.0 开发分支，仅作迁移备忘）。
- 不改动 DSH 的文件系统工具接缝（`ctx.fs`）——工作区是同一份目录，无此必要；边界见 §12。

---

## 2. 总体架构

```
┌───────────────────────────── DSH Host 进程 ─────────────────────────────┐
│  bundle patch 覆盖 sandbox 行:                                          │
│  ctx.sandbox = KrunSandboxProvider (@local/dsh-krun-vm)                 │
│      │ confine(argv, policy) → [krun-exec --session … -- bash -c …]     │
│      │（policy.mode 决定路由到 ro / rw 两个 VM 会话之一）                  │
│      ├── 不可用时回退：注入的 @deepseek-ai/dsh-sandbox-local（bwrap/…）    │
│      └── TerminalBackend(type:'krun') 注册进 ctx.terminals               │
│  ctx.bash = @deepseek-ai/dsh-bash-sandbox（不改动，拒绝/升级/事实渲染原样保留）│
│  KrunVmService（本插件新增 Host 服务，@Remote 供管理页面调用）              │
└───────┬────────────────────────────────────────────────────────────────┘
        │ UNIX socket（JSON 行协议）：krun-backend 守护进程（Rust，进程内直连 libkrun crate）
┌───────▼──── krun-backend serve（每会话一个 VM 子进程 run-session，零挂载、零提权）┐
│ 1. krun_add_virtiofs3("/dev/root", <镜像>/rootfs, read_only=true)        │
│    krun_add_virtiofs3("workspace", <工作区目录>, 按模式 ro / rw)           │
│    krun_add_disk3("data", <工作区数据层>.img, rw)  ← 仅 rw 会话            │
│    krun_fs_add_overlay_file("/dev/root", "dsh-setup" / "dsh-vm-agent")   │
│ 2. krun_add_vsock_port2(42, agent.sock, listen=true)  ← 控制通道          │
│    krun_add_virtio_console_multiport() + 每终端一个 console port          │
│ 3. krun_set_exec("/dsh-setup") → krun_start_enter()                     │
└───────┬────────────────────────────────────────────────────────────────┘
        │ virtio-fs / virtio-blk / virtio-vsock / virtio-console
┌───────▼──────────────────── microVM (libkrunfw 内核) ────────────────────┐
│  隐式 /init.krun：挂伪fs、TSI 网络、stdio 接线（libkrun 原样复用）          │
│  → exec /dsh-setup（静态注入）：tmpfs/数据盘 → overlay 合成（guest 内）      │
│     → pivot_root 成新根 → 挂 workspace 到宿主机同绝对路径 → exec agent      │
│  /            = overlay 合并视图（镜像只读层 ← 工作区数据层）               │
│  <工作区路径>  = 宿主机项目目录（同绝对路径 virtiofs）                       │
│  dsh-vm-agent = 监听 vsock:42，接受 krun-exec 连接，fork/exec 命令           │
│                 并把 stdout/stderr/exit 回传；为 console port 绑定 shell    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心洞察：复用 DSH 既有的沙盒接缝，而不是另起炉灶

调研确认 DSH 有一套完整的、以接缝（capability seam）组织的沙盒体系：

| 事实（已核实） | 设计含义 |
|---|---|
| `ctx.sandbox` 是抽象服务 `SandboxProvider.confine(argv, policy, signal) → ConfinedArgv{argv, enforcement, denialSignatures, runnerFailureRules}`，**失败必须 fail-closed**（`SANDBOX_UNAVAILABLE`）（`dsh-sandbox/lib/types/index.d.ts`） | 我们的 VM 就是该接缝的一个**后端**：`confine()` 返回的 argv 是宿主机上的 `krun-exec` 桥接器，它把原命令送进 VM 执行。VM 回报 `enforcement: 'full'`（真隔离，优于 bwrap 的部分语义） |
| 官方自带 `dsh-sandbox-ssh`（"Remote POSIX sandbox argv provider over the shared SSH helper"）与 `dsh-subprocess-ssh` —— **已有"把命令路由到另一个执行世界"的先例** | VM 后端在结构上与之同构，属于该代码库认可的模式 |
| `ctx.shell`（bash 执行器）由 `dsh-bash-sandbox` 提供：它解析每调用策略后调用 `ctx.sandbox.confine(['bash','-c',cmd])` 并直接 spawn 返回的 argv；`danger-full-access` **有意绕过** `ctx.sandbox`；拒绝标记 `[sandbox: file access denied under <mode> mode]`、一次升级重试、`sandbox: {mode, denied, enforcement}` 事实渲染全部由它负责 | **`bash`/`pwsh` 工具、拒绝/升级 UX、审批流零改动**。只要替换 `sandbox` 行，模型体验自动继承 |
| `SandboxPolicyService.resolve({session})` 给出每次调用的 `{mode, workspaceRoot(=会话 cwd), additionalWritableRoots, sessionId}`；模式为会话可覆盖事件（`sandbox/mode`） | VM 会话按 `(workspaceRoot, mode)` 惰性创建；ro/rw 两种 VM 形态与模式语义一一对应 |
| `dsh-sandbox` README 明言其局限是 same-world：需要容器/microVM/远程执行时应替换整条能力。同时允许"provider-level ladder"组合多个机制 | 我们选 **provider 级阶梯**：`KrunSandboxProvider` 链首是 VM，探测失败回退注入的 `dsh-sandbox-local`（bwrap/Landlock），再失败 fail-closed。比替换 `ctx.shell`+`ctx.fs` 的侵入小一个数量级 |
| `dsh-terminal` 暴露 `TerminalBackend{type, spawn(spec) → TerminalBackendSession}`，注册进 `ctx.terminals.registerBackend()`；Web 侧 `dsh-client-ui-sidebar-terminal` 与 `terminal_open/…` 工具通过它工作 | 注册 `type: 'krun'` 后端：每个 Web 终端标签 = VM 内一个 shell（virtio-console 多端口桥接），终端工具六件套全部可用 |
| Loader 补丁方言：带 `id` 的补丁**整体替换**既有行（`config` 全量替换）；`configEditor` 是插件改自身配置的唯一途径 | bundle patch 覆盖官方 base bundle 的 `sandbox` 行 + 插入本插件服务行；运行期 UI 改配置走 `ctx.get('configEditor')` |

---

## 3. 三层数据挂载方案（核心设计）

用户构思：**系统镜像（只读）← 工作区数据（运行时生成数据，覆盖到 `/`）← 工作区目录（读写）**。

**overlay 合成默认放在 guest 内完成**（推荐方案）：已核实 libkrunfw 内置内核直接内建 `CONFIG_OVERLAY_FS=y`（另含 `EXT4_FS=y`、`VIRTIO_FS=y`、`VIRTIO_BLK=y`、`TMPFS_XATTR=y`、`EROFS_FS=y`），guest 具备原生 overlayfs。宿主 supervisor **零挂载、零提权**，只把三块素材交给 libkrun：

```
镜像层  virtiofs(RO)  <data>/images/<imageId>/rootfs     → krun_add_virtiofs3("/dev/root", …, read_only=true)
数据层  virtio-blk    <data>/workspaces/<wsId>/data.img   → krun_add_disk3("data", …, rw)
        （ext4 稀疏文件；宿主对普通文件 mkfs.ext4，免 root。ro 会话用 tmpfs upper）
工作区  virtiofs      <宿主机项目目录>                     → krun_add_virtiofs3("workspace", …, ro/rw)
合成    guest 内      overlay(lower=镜像RO根, upper=数据层/tmpfs) → pivot_root 成为新 /
```

### 3.1 为什么 guest 内合成更优

| 维度 | guest 内合成（推荐） | 宿主侧合成（回退方案 A0） |
|---|---|---|
| 宿主权限 | **零**：不 mount、无需 userns/CAP_SYS_ADMIN，不存在 overlayfs-in-userns 的内核差异问题 | 需私有 mount namespace（+userns）与非特权 overlay / fuse-overlayfs 回退链 |
| `/` 一致性 | 宿主从不接触合并树，无宿主缓存失效面；只有 workspace 共享需要非缓存策略 | merged 树宿主可见，需防缓存陈旧 |
| 镜像格式 | 仍为目录树（"任意 rootfs"目标不变）；可选升级 EROFS 盘（内核已支持：真只读、读放大低） | 目录树 |
| 风险 | 隐式 init 与编排二进制的兼容性（M0 验证）；镜像层目录 rename 可能 EXDEV（见 §3.3） | 风险全部留在宿主侧 |

### 3.2 guest 内编排（保留 libkrun 隐式 init，注入 setup 编排器）

**不重写 PID 1**：保留 libkrun 隐式 `/init.krun`（挂载伪 fs、TSI 网络、stdio→console 接线、env、僵尸回收、退出码上报全部原样复用），把 `krun_set_exec` 指向注入的静态 `dsh-setup`，由它完成挂载编排后 exec agent：

1. `mount tmpfs /run`（镜像根是 RO，挂载点都建在 tmpfs 上）
2. rw 会话：`mount /dev/vda /run/data`（数据层 ext4）；ro 会话：`mount tmpfs /run/upper`（丢弃）
3. `mount -t overlay overlay -o lowerdir=/,upperdir=…,workdir=… /run/newroot`（lower 也可选"再挂一个 `image` tag"方案，M0 择优）
4. `mount --move` 伪 fs（/proc /sys /dev…）到新根 → `mkdir -p` 工作区挂载点（落在 upper）→ `mount -t virtiofs workspace <宿主机同绝对路径>` → `pivot_root`
5. 卸载旧根 → `exec /dsh-vm-agent`（fd 0/1/2 与 env 由 init 已接好，原样继承）

`dsh-setup` 与 `dsh-vm-agent` 经 `krun_fs_add_overlay_file("/dev/root", …)` 注入为**虚拟文件**：根是只读 virtiofs 也能 exec，镜像零改动。**工作区仍以与宿主机相同的绝对路径挂载**，VM 内外路径互换无损，DSH 的 `workingDirectory` 服务值无需映射。virtiofs 权限语义选 `KRUN_SEMANTICS_LINUX_SIMPLIFIED`；工作区共享按"文件会被 guest 之外修改"处理缓存（1.x 用 DAX 窗口 0 等价非缓存路径）。

### 3.3 挂载矩阵（按每次调用的 policy.mode）

| mode | VM 形态 | 镜像层 | 数据层 | 工作区 virtiofs | additionalWritableRoots | enforcement |
|---|---|---|---|---|---|---|
| `read-only` | `krun:<ws>:ro` | virtiofs RO | tmpfs upper（丢弃） | RO | 忽略（DSH 语义） | full |
| `workspace-write` | `krun:<ws>:rw` | virtiofs RO | **ext4 data.img（持久）** | RW | 同路径额外 virtiofs RW | full |
| `danger-full-access` | 不进 `confine()`（executor 直接绕过，宿主机原样执行） | — | — | — | — | — |

数据层实现次序：默认 **ext4 稀疏盘**（overlay upper 的内核原生形态；mkfs 对文件操作免 root，e2fsprogs 软依赖，可捆绑静态 mke2fs 兜底）；"upper 在 virtiofs 目录共享上"（数据层即一个宿主目录，更易管理）取决于 libkrun virtiofs 的 xattr/RENAME_WHITEOUT 语义，M0 验证通过才开放；qcow2（libkrun 原生 `KRUN_DISK_FORMAT_QCOW2`，快照/克隆友好，即原"方案 B"）列为后续镜像格式选项。

> 说明：ro 与 rw 仍是两个独立 VM 会话（libkrun 1.x 在 Linux 上不支持运行期重挂载，进程模型下"重配置 = 重启"），各自惰性启动、独立空闲回收。内存开销（典型 128–256 MiB/会话）远小于传统 VM。写语义与 Docker overlay2 默认（redirect_dir=off）一致：对**镜像层已有目录**的 `rename` 可能得到 `EXDEV`，属已知行为，文档明示。`read-only` 会话整棵根（overlay 无可写 upper）不可写，guest 内写操作得到内核级 `EROFS`——正是 sandbox 方言要上报的拒绝签名。

---

## 4. libkrun 集成层

### 4.1 进程模型

- **为什么是独立 Rust 守护进程 + libkrun 直接依赖**（选型定案 2026-11-14）：libkrun 本身是 Rust 项目，`src/libkrun` 的 `[lib] crate-type = ["cdylib", "lib"]` 且全部 C 函数 `pub extern "C"`——`krun-backend` **以 path 依赖 vendor 进程内直调其 API**：无 dlopen、无手写绑定、无 bindgen/libclang 绑定生成、运行时唯一外部库是 `libkrunfw.so.5`（libkrun 自己 dlopen，soname 固定）。后端对插件暴露 **UNIX socket 上的 JSON 行协议**（`session.ensure/stop/list`、`terminal.open`）；守护进程**不做任何宿主挂载**（overlay 合成在 guest 内，见 §3）、零提权。
  - **进程模型（硬约束）**：`krun_start_enter()` 在成功路径上会于 FFI 内部以工作负载退出码 `exit()` 整个进程——**每会话必须一个独立子进程**（`run-session` 子命令），守护进程只做会话注册表 + 子进程监督。这与 krunkit/krunvm 的"一 VM 一进程"模式一致，并附带崩溃隔离的好处。exec/终端路径直连 agent.sock（VMM 监听），不过守护进程。
  - **JS FFI 弃用记录**：koffi 的失败根因后来定位为 libkrun 的 argv 约定（args 不含 argv[0]，C 示例传 `&guest_argv[1]`）——早期"借用指针直到 start_enter"的推断不成立（`collapse_str_array` 在调用时即复制字符串；但 argv/envp/port_map 数组按 `MAX_ARGS=4096` **定长切片**读取，本包装分配满长 NULL 填充数组规避越界切片）。即便修正约定，JS FFI 在类型安全、调试体验与 ABI 演进上仍是长期负担，直接依赖是结构性解法。
  - 职责分界：镜像/注册表/策略/UI 留在插件（纯文件操作，无需 libkrun）；守护进程只管 VM 运行时。
- 插件 Host 进程只持有会话表与 socket 路径，VMM 崩溃/退出通过子进程 exit 事件感知（对应 `dsh-sandbox` 的 runner-failure 上报路径）。
- FFI 备选：若 `koffi` 装载不便，可退化为捆绑一个百行级 C helper（`-lkrun -lkrun_init`），接口不变。**不捆绑 libkrunfw 二进制**（内核 GPL 许可问题）——运行时依赖见 §4.4。

### 4.2 VM 配置序列（stable-1.19.x C API）

```c
ctx = krun_create_ctx();
krun_set_vm_config(ctx, vcpus, ram_mib);
krun_add_virtiofs3(ctx, "/dev/root", image_rootfs, 0, /*read_only=*/true);        // 镜像层（只读根）
krun_add_disk3(ctx, "data", data_img, KRUN_DISK_FORMAT_RAW, false, false, KRUN_SYNC_RELAXED);  // 数据层（rw 会话）
krun_add_virtiofs3(ctx, "workspace", ws_path, 0, ws_ro, KRUN_SEMANTICS_LINUX_SIMPLIFIED);      // 工作区
krun_fs_add_overlay_file(ctx, "/dev/root", "dsh-setup", setup_bin, len, 0100755, false);       // 静态编排器（虚拟文件）
krun_fs_add_overlay_file(ctx, "/dev/root", "dsh-vm-agent", agent_bin, len, 0100755, false);    // 静态 agent
krun_add_vsock_port2(ctx, 42, agent_sock, /*listen=*/true);  // 控制通道：宿主连 UNIX socket → 桥到 guest vsock
krun_add_virtio_console_multiport(ctx);     // 返回 console_id；每个 Web 终端会话：
krun_add_console_port_inout(ctx, console_id, name, in_fd, out_fd);   // 或 *_tty()（PTY，支持窗口尺寸）
// 网络策略（§4.3）；端口转发：
krun_set_port_map(ctx, port_map /* NULL = 自动暴露 guest 全部监听端口 */);
krun_set_exec(ctx, "/dsh-setup", argv, envp);   // 编排 overlay+pivot → exec /dsh-vm-agent
krun_start_enter(ctx);                      // 阻塞至 VM 关闭
```

要点：
- **隐式 init-blob 原样保留**（`krun_has_feature(KRUN_FEATURE_INIT_BLOB)`）：自动注入 `/init.krun` 与 `/.krun_config.json`，guest 内挂载伪 fs、设置 TSI 网络、接线 stdio 后 exec `/dsh-setup`——镜像无需任何 libkrun 感知。
- 用 `krun_add_virtiofs3("/dev/root", …, read_only=true)` 而非 `krun_set_root`：pivot 之前镜像层严格只读，编排期零写入落盘。
- `krun_fs_add_overlay_file/dir` 把编排器与 agent 注入为**虚拟文件**（只读根亦可 exec），也可预置 `/etc/hostname` 等，零镜像改动。
- `dsh-setup` / `dsh-vm-agent` 静态链接（musl），`x86_64` / `aarch64` 两个变体，置于包内 `guest/`。

### 4.3 网络

| 配置 | 实现 | 适用 |
|---|---|---|
| `tsi`（默认） | 不添加任何 net 设备 → libkrun 自动启用 TSI（guest socket 系统调用经 virtio-vsock 伪装，共享宿主网络） | 开箱即用；注意 **1.19.x 的 `krun_set_port_map` 是改名映射而非白名单**：map 未命中的 guest 端口仍按原端口绑宿主，即 guest 任意监听都会占用宿主同号端口。"只暴露指定端口"用 `none` 档 + `portMap` 转发（下行） |
| `none` | `krun_disable_implicit_vsock()` + `krun_add_vsock(0)`（保留 vsock 但关闭 TSI 劫持） | 严格隔离；控制通道不受影响 |
| `portMap`（任意档位叠加） | **应用层端口转发（2026-11-15 实现，替代 1.19.x 改名映射）**：每条 `host:guest` 配一个额外 vsock 端口（4200 起），VMM 桥接 `run/<key>.fwd<vsock>.sock`，agent（`DSH_FORWARD_PORTS`）中继到 guest `127.0.0.1:<guest>`；provider 在宿主监听 `127.0.0.1:<host>` → 该 socket。`none` 档下即"零宿主端口占用 + 只暴露指定端口"组合；转发连接计入 stat `fwdConns`（免于空闲回收） | 显式白名单式暴露 |

**按工作区覆盖（2026-11-15）**：网络档不随全局一刀切——工作区绑定（registry.json）可带 `network: tsi|none`，boot 解析顺序 = 绑定值 → 全局默认；管理页绑定卡与 `/api/krun/workspaces/network` 可设置，档位进会话指纹，变化即停旧启新（下次会话重建生效）。安全注记：libkrun 官方安全模型明确"VM 边界不限制通过设备暴露的宿主资源"，TSI 使用 VMM 的宿主网络权限——因此 `network: 'none'` 是唯一网络级隔离档位（`portMap` 转发是显式开的孔），文档必须如实说明（文件效果词汇不覆盖网络，这与 DSH 沙盒模式语义一致）。

### 4.4 运行时依赖与安装

**资产位置原则（2026-11-16 修正）**：插件**不得依赖用户目录下的任何路径**（曾硬编码 `~/opt/e2fsprogs`、`~/opt/krun-m0/images`、`~/opt/libkrun/lib`，普通机器根本不存在 ⇒ 建盘直接失败）。所有宿主侧插件资产一律落在 `<dataDir>`（默认 `~/.dsh/storages/krun-vm`）内，其余依赖按「环境变量 → 系统路径 → PATH → dataDir 捆绑」四级发现。

| 依赖 | 获取 | 发现顺序（绝不硬编码用户目录） |
|---|---|---|
| `libkrunfw.so.5`（内核捆绑库；libkrun 已进程内编译进 krun-backend，运行时由其 dlopen） | 系统包 / 官方 release 预构建 tgz（v5.6.4 实测可用）；插件自持位置 `<dataDir>/tools/lib` | `config.libDir` → 系统多架构库目录（含 `ldconfig` 可见面）→ `<dataDir>/tools/lib`；缺失即 fail-closed 并在环境体检给出动作。`<dataDir>/tools/libkrunfw*.tgz` 存在时**激活期自动解包**；`POST /api/krun/tools` 可显式安装 |
| `/dev/kvm` 可写 | 现有内核模块 | `open` + `KVM_GET_API_VERSION` ioctl |
| overlayfs | **guest 内核自带（libkrunfw `CONFIG_OVERLAY_FS=y`，已核实）** | 宿主侧无探测项；隐式 init 在只读根下的兼容性由 M0 验证 |
| e2fsprogs（对普通文件 `mkfs.ext4`，免 root） | 宿主发行版自带（Debian/Ubuntu 默认安装）；无系统的发行版可放提取版到 `<dataDir>/tools/e2fsprogs` | `KRUN_MKE2FS` → 系统绝对路径（`/usr/sbin`、`/sbin` 等；**PATH 常不含 /sbin，必须显式查**）→ PATH 查找 → `<dataDir>/tools/e2fsprogs`（注入 `KRUN_E2FSPROGS_DIR`） |
| `qemu-img`（仅 qcow2 数据层） | 宿主 qemu-utils | `KRUN_QEMU_IMG` → 系统路径 → PATH → `<dataDir>/tools/bin` |
| guest agent 静态二进制 | 插件包内附带 | 版本握手（协议头） |
| **guest 镜像** | 首次使用自动自举官方 Alpine minirootfs 到 `<dataDir>/images`（宿主网络）；或管理页导入 | 工作区绑定 → 已导入镜像 → 遗留 `config.imageRootfs`（**自动迁入 `<dataDir>/images`**）→ 自举 |

管理页"环境体检"面板展示上述项目（含 `toolsDir`/`dataDir` 实际路径与每项来源：system/bundled/missing），作为 `SANDBOX_UNAVAILABLE` 的可视化归因。

---

## 5. KrunSandboxProvider（sandbox 接缝实现）

```
confine(argv, policy, signal):
  1. policy.mode == 'danger-full-access'  → 理论不可达（executor 绕过）；防御性抛出
  2. 探测/就绪：KVM + libkrun + 镜像存在？（首次结果缓存）
     ├─ 失败且 config.fallbackToLocalSandbox → 委托注入的 dsh-sandbox-local.confine()（阶梯下一级）
     └─ 失败且不允许回退 → throw SandboxUnavailableError('krun', detail)   // fail-closed
  3. route = (canonicalPath(policy.workspaceRoot), policy.mode)
  4. ensureSession(route)：惰性启动 supervisor（镜像解析 → VM 装配与注入 → krun 启动 → agent 握手）
     └─ 启动进度通过服务事件广播给管理页（复用 plugin-manager/install-log 式的事件模式）
  5. 返回 ConfinedArgv:
       argv = [<pkg>/bin/krun-backend, 'exec', '--socket', <session>/agent.sock,
               '--cwd', <spec 由 executor 传入的工作目录>, '--', ...argv]
       enforcement = 'full'
       denialSignatures = ['Read-only file system', 'EROFS', 'Operation not permitted']   // guest 内核方言
       runnerFailureRules = [{ fatalSignatures: ['krun: agent handshake failed',
                                                  'krun: supervisor exited unexpectedly', …] }]
```

- **`krun-exec` 桥接 CLI**（包内 `cli.mjs`，`bash-sandbox` executor 每次 spawn 它）：连接会话 agent socket，发送 `{argv, cwd, env, tty:false}`，双向转发 stdio，回传 exit code。env 原样透传但**剔除宿主专属变量**（`SSH_AUTH_SOCK` 等），`PATH` 由 agent 按镜像默认值处理；`DSH_*` 快照照 `dsh-shell` 契约透传。
- **拒绝语义**：read-only VM 中写文件 → guest 内核 EROFS → stderr `Read-only file system` → `bash-sandbox` 现有分类器直接判 `denied: true` 并追加官方拒绝标记，随后模型用 `sandbox_permissions` 升级 → 新调用 mode 变宽 → 路由到 rw VM（或按用户审批升级到宿主 danger-full-access）。**升级阶梯零改动、语义天然成立。**
- **runner-failure**：supervisor/agent 崩溃经由 `RunnerFailureRule` 与命令失败严格区分（命令没跑 ≠ 命令失败），复用 `dsh-sandbox` 的诊断词汇。
- 每会话的 `policy.sessionId` 用于会话级临时目录命名与归属，对齐 windows-acl 后端的先例。

---

## 6. 镜像管理（KrunVmService，Host 服务）

数据布局（`DSH_HOME` 下的插件域，经 `storageDomain` 打开域 + 纯文件系统存放大对象）：

```
~/.dsh/storages/krun-vm/
  images/<imageId>/
    manifest.json        # { id, name, distro, arch, created, source, format:'dir'|'qcow2', sizeBytes }
    rootfs/              # 目录树（guest 内 overlay 的 lower，virtiofs RO；多工作区共享）
    base.qcow2           # 备选盘格式（qcow2，后续选项）
  workspaces/<workspaceId>/    # workspaceId = canonicalPath(workspaceRoot) 的哈希
    data.img                   # 工作区数据层：ext4 稀疏盘，guest 内作 overlay upper
    imageId                    # 指针：该工作区当前基于哪个镜像
  registry.json                # 域内持久记录（镜像表/工作区绑定/会话元数据）
  run/<sessionId>/agent.sock  console/…       # 仅运行期通道（无宿主 merged 目录）
```

方法集（`@Remote` 标注的供管理页/命令调用；**变更类操作为 user-only，不做成 agent 工具**——见 §8）：

```ts
class KrunVmService extends Service {
  @Remote listImages(): ImageInfo[]
  @Remote listSessions(): SessionInfo[]           // workspace, mode, uptime, pid, resources
  createImage(req: { from: 'tarball'|'oci-export'|'preset', source, name, arch }): Promise<ImageJob>
  @Remote deleteImage(id): Promise<void>          // user-only；有工作区绑定时拒绝
  @Remote bindWorkspace(path, { imageId, resources, network }): Promise<void>
  @Remote unbindWorkspace(path): Promise<void>
  @Remote resetWorkspaceData(path): Promise<void> // 丢弃数据层（=容器级重置）
  @Remote stopSession(route): Promise<void>
  // 内部：ensureSession / confine 支持 / terminal backend / 事件发布
}
```

镜像来源 v1：① 发行版 rootfs tarball（Alpine minirootfs、Debian bootstrap 等 URL/本地文件）；② 本机 `podman/docker export`（检测到容器引擎时）。preset 列表内置 2–3 个经测试的条目。

---

## 7. 生命周期

- **惰性启动**：首个该 `(workspace, mode)` 的 confined 调用触发 boot（libkrun 典型亚秒级）；启动期间的调用在 `confine()` 内 await（deadline 计入 executor 的前台预算，超时即 `timedOut` 事实，符合 shell 接缝语义）。
- **空闲回收**：无活动连接且无 PTY 会话超过 `idleStopMs`（默认 5 min）→ 优雅停机（agent 收到 shutdown → exit(0) → VM 掉电），数据层天然落盘。
- **会话无关性**：VM 按 workspace 存活，Session 归档/叉分不影响；`workspace/session-stop` 事件仅用于提示性收缩（可选配置 `stopWithLastSession`）。
- **插件卸载/HMR**：`apply()` 返回的 disposer 停掉全部 supervisor 进程并清理 run 目录；重启后由持久数据层恢复状态（这正是分层的价值）。
- **终端会话**：`TerminalBackendSession.close()` 关闭对应 console port；VM 停止时所有终端 `status` 转为 `exited`。

---

## 8. 管理界面（DSH Web GUI）

原则（practices.md / user-actions.md）：一个操作只实现一次（Host 服务方法），UI 与 agent 工具都是它的调用者；**授权类/破坏类操作 user-only**。插件 UI 是 Harness UI 的一部分：`--dsw-alias-*` 主题令牌、Client locale、仿 Plugin Manager 页的列表行模式，不引宿主组件包、不写 DOM。

### 8.1 页面：`settings.section` 注册（左栏 Settings → 新增"虚拟机沙盒"页）

| 区块 | 内容 | 操作 |
|---|---|---|
| 环境体检 | libkrun/libkrunfw、/dev/kvm、overlay 能力、agent 版本 | 重测 |
| 运行会话 | 每会话一行：workspace、mode(ro/rw)、运行时长、vCPU/RAM | 停止、重启 |
| 镜像 | 列表（名称/发行版/架构/大小/引用数） | 导入 tarball、从容器导出、设为默认、删除（引用中拒绝） |
| 工作区绑定 | 当前 profile 各 workspace：镜像、网络档、数据层占用 | 绑定/解绑、重置数据层 |
| 设置 | 默认资源、网络、空闲回收、回退开关 | 经 `configEditor.edit()` 保存（普通字段自动重启插件） |

状态刷新走 `wire.view`/轮询 `@Remote listSessions()`；进度类操作（镜像导入）仿 `plugin-manager/install-log` 事件流式展示。

### 8.2 附属入口

- `conversation.input.left`（composer 工具行左侧紧凑位）：当前 Session 的 workspace 命中 VM 会话时显示状态芯片（`VM · rw`），点击打开管理页；启动中显示进度。无会话不渲染（空参与宿主模式一致）。
- `commands.register()` 人类命令：`/vm status`、`/vm stop`、`/vm reset`（命令注册自动获得 `ctx.remote.commands` 可执行性）。
- `tool.call.toolview`（keyed）：若后续新增 `vm_*` 工具，为其注册定制工具卡片视图（v1 无 agent 工具，预留）。

### 8.3 显示资源（安装前清单，host-plugin.md 要求）

- `locale/zh.json`、`locale/en.json`：`meta.title`"虚拟机沙盒"/"VM sandbox"，`meta.description` 一句话能力描述；页面内全部文案双语、句首大写规则。
- 原创图标 `icon.svg`（层叠方块：镜像层/数据层/工作区三层隐喻），≤256 KiB，包内路径。
- `exports` 与 `files` 覆盖 locale、icon、全部运行时文件（`index.js`、`bin/krun-backend`、`guest/*`、`client.js`）。

---

## 9. 包结构与 bundle patch

```
@local/dsh-krun-vm/
  package.json          # name, dsh.bundle.patch, exports{., ./client, ./locale/*.json, ./icon}
  cordis.patch.yml
  index.js              # KrunVmService（含 SandboxProvider + TerminalBackend 注册；守护进程 socket 客户端）
  bin/krun-backend      # Rust 守护进程 + exec 客户端（backend/ 构建产物：serve/exec/probe 子命令）
  backend/              # Rust 工作区源码：守护进程、api 包装、guest agent、guest setup
  backend/vendor/libkrun/   # git submodule：containers/libkrun stable-1.19.x，锁定 1.19.8
                            # （发布点 c4d283c2）；path 依赖 src/libkrun；更新 = update --remote + 重锁 + 重建
  guest/{dsh-setup,dsh-vm-agent}-{x86_64,aarch64}   # 静态编排器 + agent（musl）
  client.js             # 管理页 + 状态芯片（dsh.client 懒注册）
  locale/{zh,en}.json
  icon.svg
```

`cordis.patch.yml`（Loader 方言：`insert` 追加；带 `id` 的补丁整体替换既有行）：

```yaml
- insert:
    - id: krun-vm
      name: '@local/dsh-krun-vm'
      config:
        enabled: true
        fallbackToLocalSandbox: true
        network: tsi
        resources: { vcpus: 2, ramMib: 2048 }
        idleStopMs: 300000
- id: sandbox                      # 覆盖 base bundle 的 sandbox 行（整体替换）
  name: '@local/dsh-krun-vm'
```

组合事实链：`sandbox` 行被我们替换 → `dsh-bash-sandbox`（`bash` 行）不变，仍在 `ctx.sandbox.confine()` 里拿到 VM 包装的 argv → `dsh-sandbox-policy` 行不变，模式/workspaceRoot 语义不变。用 `dsh --profile "$DSH_PROFILE" --dump-config` 验证最终层叠顺序与 `overridden` 状态。

`dsh.client` 段声明 `platform: web` + 懒注册；Client 模块只依赖 React（宿主模块表提供）与自身样式（复制宿主原语的 markup/CSS 并改前缀）。

---

## 10. 插件 Config（schemastery，全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；false 时 confine 直通本地阶梯 |
| `defaultImage` | 首个已导入镜像 | 未绑定工作区的默认镜像 |
| `resources.vcpus / ramMib` | `2 / 2048` | 新会话默认（受 `krun_get_max_vcpus` 钳制） |
| `network` | `tsi` | `tsi` / `none` |
| `portMap` | `null` | `["8080:8080"]`；null = 自动暴露全部 guest 监听端口 |
| `idleStopMs` | `300000` | 空闲回收 |
| `network` | `tsi` | `tsi`（共享宿主网络）/ `none`（隔离：vsock 控制通道保留，宿主零端口占用）；backend 对应 `boot --network tsi\|none`（`krun_disable_implicit_vsock` + `krun_add_vsock(0)`） |
| `fallbackToLocalSandbox` | `true` | VM 不可用时回退 bwrap/Landlock 阶梯 |
| `runner.libkrunPath / libkrunfwPath` | 系统默认 | 私有前缀安装时指定 |
| `workspaces[]` | `[]` | 每工作区覆盖 `{ path, imageId, resources, network, enabled }` |

`.volatile()` 标注运行期只读字段避免无谓重启；写回一律走 `configEditor`（禁止插件自行改 `cordis.patch.yml`）。

---

## 11. 模型可见性

- `bash` 工具 schema 与事实渲染零改动（`dsh-tool-bash` 原样）：模型看到的是 `sandbox: { mode, denied, enforcement: 'full' }`、官方拒绝/升级标记。
- `dsh-sandbox-policy` 自带的 `sandbox:policy` 运行时上下文继续自动注入，无需新 prompt 段。
- v1 **不新增 agent 工具**（管理操作 user-only；模型对 VM 的唯一需要感知的是"命令在一个 Linux 环境里跑"，与现有心智一致）。若后续需要，按 user-actions 模式补 `vm_status` 只读工具 + `tool.call.toolview` 视图。

---

## 12. 安全模型与边界（如实陈述）

1. **强边界**：命令运行于独立内核（KVM），宿主机进程/文件系统对 guest 不可见；暴露面仅三个明确对象：镜像树（virtiofs RO）、**数据层盘文件**（virtio-blk，其内容即"工作区数据层"，guest 全权写入属设计意图，不出工作区存储域）、工作区目录（virtiofs）；无宿主挂载操作、无宿主 `/dev` 直通。enforcement 如实上报 `full`。
2. **工作区归属映射（2026-11-15 实测澄清）**：guest 默认以 root 操作，但 virtiofs 的归属由 **VMM 进程凭据**决定——guest root 创建的工作区文件在宿主上归属 = 启动 harness 的用户（非 root），guest 侧看到的也是宿主真实 uid（1:1 映射，非 root 的 guest 用户照样能写"自己的"工作区）。两条不变量：① 宿主归属恒为 VMM uid（标准部署 = 登录用户），不存在"guest root 文件污染宿主归属"问题；② guest 对工作区的实际写权限被 VMM 凭据约束，guest root 并非宿主侧 god-mode。据此**保持 guest 默认 root**——这是"系统级副作用持久化"（apk/apt 装包等）的设计前提；若改为同 uid 普通用户作默认， guest 内系统级操作将失效，而宿主归属不会因此更正确。
2. **不覆盖面**（与 libkrun 官方安全模型、DSH 沙盒词汇一致）：网络（TSI 共享宿主网络；`network:'none'` 才隔离）、宿主资源消耗（CPU/RAM 由 vCPU/RAM 配置钳制）、旁路通道（工作区目录是宿主与 guest 的共享写面——guest 可写宿主工作区内任何文件，这是设计意图而非缺陷，但意味着"VM 内命令写坏工作区"仍是可能的）。
3. **非 Raw 磁盘镜像风险**：若采用 qcow2 镜像格式（含后续 backing 链），遵循 `krun_add_disk2/3` 的 SECURITY NOTE——格式探测只允许在 guest 拿到写权限之前、对可信镜像执行一次并记住结果。
4. **权限边界**：supervisor 以 harness 用户身份运行，**无 namespace、无提权需求**；/dev/kvm 访问权交给部署者。

---

## 13. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 可行性尖峰** | libkrun(1.19.8)+libkrunfw(5.6.4) 用户前缀就绪（官方 C 示例引导通过；koffi/JS FFI 实证弃用）；`krun-backend` Rust 守护进程骨架（dlopen + 引导冒烟）；**guest 内编排验证**：隐式 init 于只读根可运行、overlay(lower=/)+pivot、ext4 盘 vs upper-on-virtiofs、EXDEV 行为、宿主对普通文件 mkfs.ext4；vsock agent 回环 | 守护进程引导 VM 返回 uname；apt 安装落数据层且 VM 重启后保留 |
| **M1 核心接缝** | 镜像导入/注册表、三层装配、krun-exec 桥接、KrunSandboxProvider + 本地回退、fail-closed 与拒绝方言 | patch 安装后 confined bash 全部落 VM；EROFS 拒绝正确升级；`dsh --dump-config` 显示行覆盖 |
| **M2 持久化与终端** | ro/rw 双会话、空闲回收、TerminalBackend('krun')、port map | Web 终端开在 VM 内；`run_in_background` 任务跨调用存活；重启后数据层保留 |
| **M3 管理界面** | settings.section 页 + input.left 芯片 + /vm 命令 + 环境体检 | 浏览器实测（verification.md 清单）；双语与图标核对 |
| **M4 打磨** | 诊断 skill（仿 windows-acl）、方案 B qcow2 镜像格式、aarch64、文档与 README.zh | — |

---

## 14. 风险与开放问题

1. **隐式 init 与只读镜像根的兼容性**：若 init 在 pivot 前向根写入则编排失败 → M0 首项验证；不行则退回"自写 PID 1"（复用面变小，成本已评估）或宿主侧合成（方案 A0 保留为回退）。
2. **libkrun 分发**：依赖系统安装而非捆绑（libkrunfw 含 GPL 内核）；管理页"环境体检"承担归因；后续可评估提供一条复制粘贴的安装命令。
3. **libkrun 2.0 迁移**：`Payload/VmmBuilder/FsOverlay` 面向对象 API + `CachePolicy` 显式化；封装层（`supervisor.mjs`）已把 libkrun 调用隔离在单文件，迁移成本受控。2.0 稳定前不跟随 main。
4. **virtiofs 一致性**：工作区被 guest 外修改（宿主文件工具）→ 必须非缓存/DAX=0 语义；M2 验证双向实时可见性。
5. **终端窗口尺寸/PTY 细节**：`krun_add_console_port_tty` 对 fd 的 TTY 期望需 M2 实测（参照 muvm 的透传方式）。
6. **端口自动映射的冲突**：`port_map: null` 下 guest 与宿主端口号相同，可能撞端口 → 提供显式 map 配置与文档。
7. **JS FFI 已弃用**（koffi 对 libkrun 借用指针语义不兼容，M0 实证段错误/argv 串改）→ 改为 Rust 原生守护进程 `krun-backend`（UNIX socket JSON 行协议），插件只做 socket 客户端；代价是引入 Rust 构建依赖（本机已有 cargo 1.99）。
8. **多 profile/并发 harness 实例**共享镜像目录的文件锁：registry.json 写入经存储域序列化，域外大对象用原子写（`dsh-atomic-write`）。
9. **overlay upper 支撑面**：默认 ext4 盘（内核原生支持）；"upper 在 virtiofs 目录上"依赖 libkrun virtiofs 的 xattr/RENAME_WHITEOUT 语义，M0 验证通过才作为备选开放。镜像层目录 rename 的 EXDEV 与 Docker overlay2 默认一致，文档明示。

---

## 15. 现状汇总（2026-11-14 验收快照）

### 15.1 里程碑状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| M0 可行性尖峰 | ✅ | libkrun 用户前缀引导、直接依赖、argv 约定、guest 编排、vsock 回环全通（附录 C 前段） |
| M1 核心接缝 | ✅ | confined bash 落 VM、fail-closed、EROFS 拒绝方言、dump-config 行覆盖、E2E（15:37 与当日复验）；**stderr 分离修复后拒绝标记/升级提示闭环**（23:0x 复测；GUI 批准升级步待用户） |
| M2 持久化与终端 | ✅ | 持久化/双会话/网络档位 ✅；空闲回收实测 ✅（stat 活跃连接保护 + 数据层跨回收保留）；run_in_background 跨调用 ✅；Web 终端注册器就绪待实测（坑 7/8）；**侧栏终端已适配**（shellCandidates + 桥 + resize，实测通过） |
| M3 管理界面 | ▲ | settings.section 页 + 状态芯片 + `/api/krun/*` 路由 ✅；`/vm` 命令组 ✅（**用户 GUI 确认通过**）；镜像/绑定四卡 + 预设清单 ✅；数据通道经用户 GUI 确认 |
| M4 打磨 | ▲ | 镜像管理 v1 + 预设清单 ✅（alpine/ubuntu 全流程实测）；**端口转发（none 档白名单组合）** ✅；**qcow2 数据层** ✅；**侧栏终端** ✅；**诊断 skill** ✅；aarch64 agent 预置（构建实测、VM 引导待 aarch64 主机）；serve 守护进程形态待决策 |

### 15.2 运行形态（当前 live 配置）

- **会话守护进程（serve，2026-11-15 接线）**：provider 经 UNIX socket JSON 行协议调用
  `session.ensure/stop/touch/list/gc` + `shutdown`；守护进程持会话注册表、spawn 并监督 boot
  子进程（PDEATHSIG 绑定）、执行端口转发监听与空闲回收；exec/终端数据面仍直连 agent.sock
  不过守护进程。`config.daemon`（默认 true）= false 走遗留直 spawn 路径。跨进程共享：同
  dataDir 的 live/headless 客户端共用同一 VM（会话键相同即复用，配置指纹不同则停旧启新）。
- `network: none`（用户要求零宿主端口占用；切 `tsi` 即得共享宿主网络 + 自动端口暴露）
- 资源 2 vCPU / 2048 MiB，`idleStopMs` 600000（空闲回收 fiber effect 已接 + agent stat 活跃连接保护）
- 数据层：`<dataDir>/workspaces/<ws+mode 哈希>.img`（8.5G 稀疏，ext4 upper）；dataDir 默认
  `~/.dsh/storages/krun-vm`（2026-11-15 起迁入 DSH 数据目录，旧 `~/.dsh-krun` 首次激活自动迁移，
  `config.dataDir` 可显式覆盖）
- 镜像：全部位于 `<dataDir>/images/<id>/`（导入或首次自动自举 Alpine）；`registry.json` 工作区绑定；`config.imageRootfs` 仅作遗留兼容且首次使用时自动迁入 dataDir
- agent 协议 v2：exec2 帧（stdout/stderr/退出码分离）+ stat（活跃连接）；旧 agent 自动回退合并流

### 15.3 已验证能力（证据见附录 C）

持久化跨 VM/跨 dsh 重启；ro EROFS 拒绝（官方拒绝标记/升级提示闭环）；ro/rw 双会话并存；
`--network tsi|none` 双档；TSI 入站自动端口暴露全链路；`exec --env` 到达 guest；管理页路由
三联注册；三预设覆写组合；空闲回收（stat 活跃连接保护 + 数据层跨回收保留）；run_in_background
跨调用存活；`/vm` 命令组；镜像导入→绑定→引导 E2E（alpine/ubuntu 双预设）；端口转发往返；
qcow2 数据层（guest 内首启格式化 + 持久化）；侧栏终端桥（附加/执行/resize）；aarch64 agent 构建。

### 15.4 已知限制与偏差（如实）

- `port_map` 的 1.19.x 改名映射语义仅 backend CLI 保留；provider `portMap` 配置现为 vsock 应用层转发（宿主绑 127.0.0.1，转发连接计入活跃）
- agent resize 经内联 OSC 7777（仅桥与 agent 同代时生效；用户粘贴含该序列的数据会被吞——极小概率，如实记录）
- PTY resize 链路：侧栏桥/agent 工具路径均已支持；GUI 侧栏 shell 选择器里 krun 项经用户补丁层 `shellCandidates` 接线（dsh 更新后需复核默认候选列表）
- `serve` 守护进程已接线（默认）：boot 引导经长寿 spawner 线程执行，PDEATHSIG 绑守护进程生命——客户端断开不杀 VM；dsh 崩溃沿进程树回收全部 VM
- cordis 预设（创造模式）按用户要求未接入终端组
- busybox 测试坑：nc 遇 stdin EOF 即退（`punt!`）、无 httpd applet——均非沙盒问题
- exec2 帧协议为 v2 增量：旧镜像内 agent 走合并流回退（stderr 不分离 → 拒绝分类失效），boot 时 bakeGuestFiles 自动烤入新 agent，滚动更新自愈
- aarch64：agent 静态二进制已预置，VM 引导链（aarch64 libkrunfw/rootfs）未实测

### 15.5 排障手段

- `<dataDir>/diag.log`：provider 激活/路由注册轨迹（krunDiag，稳定后移除；dataDir 默认 `~/.dsh/storages/krun-vm`）
- boot 子进程传 `RUST_LOG=debug`：TSI/vsock 全链路 trace
- `dsh --profile web --dump-config [--patch harness/krun-overlay.yml]`：层叠与组合校验
- `dsh headless --patch harness/krun-overlay-absolute.yml "..."`：激活级冒烟（不占 3080、不动 live 会话）
- boot 日志：`<dataDir>/logs/<key>.log`

### 15.6 使用要点

- 开 VM 内终端（会话内对 agent）："开一个 type 为 krun 的终端" → `terminal_open {"type":"krun"}`
- 切网络档：profile patch 中 `network: none|tsi`（none = 隔离零端口；tsi = 出站联网 + guest 监听自动占宿主端口）
- preset 覆写再生成：见 `harness/krun-preset-override.yml` 头部说明（dsh 更新内置预设后执行）

## 附录 A：本设计依赖的已核实 DSH 接口

- 服务：`sandbox.confine`、`sandboxPolicy.resolve/overrideOf`、`terminals.registerBackend/spawn/read/signal/kill`、`terminalController`(@Remote)、`commands.register/execute`(@Remote)、`configEditor.edit`、`storage/storageDomain`、`workingDirectory`、`webServer`、`subprocess`。
- 事件：`agent/created`、`workspace/session-stop`、`tools/result`、`plugin-manager/install-log`（进度流范式）、`app-boot/config-reload`。
- 插槽：`settings.section`（管理页）、`conversation.input.left`（状态芯片）、`tool.call.toolview`（工具视图，预留）。
- 补丁方言：`insert` / 带 `id` 整体替换 / `!!js` / `configEditor` 回写。

## 附录 B：libkrun 事实（stable-1.19.x `include/libkrun.h` + docs）

- 内核能力（已核实 libkrunfw `config-libkrunfw_x86_64`）：`CONFIG_OVERLAY_FS=y`（redirect_dir/index/metacopy 关闭）、`CONFIG_EXT4_FS=y`、`CONFIG_VIRTIO_FS=y`、`CONFIG_VIRTIO_BLK=y`、`CONFIG_TMPFS(_XATTR)=y`、`CONFIG_EROFS_FS=y`（含 XATTR/ACL）；`CONFIG_SQUASHFS` 未启用。
- 根：`krun_set_root`（virtiofs 目录）；只读根/独立共享：`krun_add_virtiofs3/4(tag,path,shm,read_only,semantics)`。
- 盘：`krun_add_disk3`（RAW/QCOW2、read_only、direct_io、sync_mode）；根盘重挂 `krun_set_root_disk_remount(device,fstype,options)`。
- 通道：`krun_add_vsock_port2(port,unix_path,listen)`；多端口 console `krun_add_virtio_console_multiport` + `krun_add_console_port_{tty,inout}`；`krun_fs_add_overlay_file/dir`。
- 网络：默认隐式 TSI；`krun_add_net_unixstream/unixgram/tap`；`krun_set_port_map`（NULL=自动全暴露）；禁网 = `krun_disable_implicit_vsock` + `krun_add_vsock(0)`。
- 生命周期：`krun_start_enter` 阻塞模型；`VmmHandle` 的 pause/resume/shutdown 在 Linux 为 `FeatureDisabled`（macOS 限定）→ 进程即生命周期。
- 特性探测：`krun_has_feature(KRUN_FEATURE_{NET,BLK,INIT_BLOB,…})`、`krun_get_max_vcpus`、`krun_check_nested_virt`。
- 官方安全模型警示：VM 边界不限制经设备暴露的宿主资源；TSI 使用 VMM 的宿主网络权限。

## 附录 C：M0 实测记录（2026-11-14，本机 x86_64 + KVM API v12）

- 环境：libkrun 1.19.8（vendor stable-1.19.x 源码编译）+ libkrunfw 5.6.4（官方 release 预构建 tgz，当时置于用户前缀 `~/opt/libkrun/lib`，**现改为 `<dataDir>/tools/lib`**）；官方 C 示例 chroot_vm 引导通过。
- **直接依赖可行性**：`src/libkrun` `[lib] crate-type = ["cdylib","lib"]`、C 函数全 `pub extern "C"`、libkrunfw 由 libkrun 运行时 dlopen（soname `libkrunfw.so.5`，无 env 覆盖）→ backend path 依赖 + 进程内直调，引导冒烟 `RUST-DEP-OK` 通过。
- **argv 约定（关键坑）**：`krun_set_exec` 的 args **不含 argv[0]**（C 示例传 `&guest_argv[1]`）；多传程序名 → guest 内 sh 报 `syntax error: unexpected word`。早期 koffi 失败的根因即此（而非"借用指针"——`collapse_str_array` 调用时即复制）。
- **数组边界**：argv/envp/port_map 按 `MAX_ARGS=4096` 定长 `from_raw_parts` 切片（NULL 截断）；包装层分配满长 NULL 填充数组规避越界切片。
- **退出语义**：`krun_start_enter` 成功路径在 FFI 内 `exit()` 整个进程（C 示例实测 exit=工作负载码）→ 每会话一个子进程是硬约束。
- 构建注意：vendor 树含 bindgen 依赖 → 构建 backend 需 `LIBCLANG_PATH`（本机以符号链接 `libclang.so → libclang-21.so.1` 解决）；运行 `krun-backend` 需 `LD_LIBRARY_PATH` 指向 libkrunfw 所在目录。
- 性能参考：release 构建 23s（16 核）；VM 引导至 workload 输出亚秒级。
- **M0.2 编排实测**：`mount --move` 目标为 overlay 时 EINVAL → 改为新根上全新挂载伪 fs（proc/sys/devtmpfs/devpts/shm）；**overlayfs-on-virtiofs-upper 存在上游级摩擦**——内核 overlay 的 workdir 创建（`/run/data/work/work`）得到 mode 000 目录 → EACCES → 只读降级（SIMPLIFIED/COMPLETE 两种语义均复现，dmesg: `failed to create directory … (errno: 13); mounting read-only`；另 `failed to set uuid … falling back to uuid=null`）→ 数据层改用 **ext4 稀疏盘 + virtio-blk**（overlay-on-ext4 经典路径，实测 rw 写入 + 跨重启持久化 ✓）；mke2fs 免 root 获取：`apt-get download e2fsprogs libext2fs2t64 …` + `dpkg-deb -x` 提取运行；内核 6.12 要求无 upper 的 overlay 至少 2 个 lowerdir（ro 会话补空 tmpfs 第二 lower ✓）。
- **工作区同路径挂载**：缺失路径段前的祖先目录盖 tmpfs、其余段普通 mkdir 后挂 workspace virtiofs tag——实测 guest 内 `pwd` 与宿主同路径 ✓，双向共享 ✓（当时用 `~/opt` 下的测试工作区，现资产一律在 dataDir）。
- **M0.4 vsock 回环 ✓**：`krun_add_vsock_port2(42, agent.sock, listen=true)` 由 VMM 监听 UNIX socket、按连接桥接 guest vsock；musl static-pie agent（AF_VSOCK=40 监听 CID_ANY:42）fork/exec + 管道中继 + `EXIT:<code>` 回传；`krun-backend exec` 客户端 3/3 成功、退出码传播正确。注意：VM 退出后 VMM 不清理 agent.sock（陈旧 socket 连接报 ECONNREFUSED），守护进程需在会话表里处理。
- **脚本坑**：`set -- $WS` 会覆盖位置参数——`$3` 在其之后失效；调试输出显示 `$3=agent` 但分支判断失败即此原因（已改为先存 `AGENT="$3"`）。另：console 设备的 stdout/stderr 双端口会使每行日志成对出现。
- **M1 实测（2026-11-14 15:37 端到端打通）**：
  - **V8 `#private` brand 校验坑**：provider 类用 `#config` 等私有字段时，confine 经 cordis context 包装的 receiver 触发 `Receiver must be an instance of class KrunSandboxProvider`（V8 对 #private 访问的 brand 检查）。官方 provider 全用普通实例属性——**插件 provider 类必须避免 `#private` 字段**。
  - **陈旧 agent.sock**：VM 退出后 VMM 不清理 listen 模式的 socket 文件，下次 `krun_add_vsock_port2` 绑定 EEXIST（-17）→ provider 引导前 `rmSync`；后端把 add_vsock_port 失败从 panic 改为干净退出（带 stderr 原因）。
  - **镜像需含 bash**：Alpine minirootfs 无 bash；免 root 安装 = 借镜像内 musl loader 执行 apk（`$R/lib/ld-musl-x86_64.so.1 $R/sbin/apk --root $R add bash`，需 `LD_LIBRARY_PATH=$R/lib:$R/usr/lib`；busybox chroot trigger 报错可忽略）。agent exec 用 `execvp`（bash 工具传裸名）+ exec 失败写诊断后 _exit(126)。
  - **E2E 证据**（真实 DSH 会话 bash → VM）：`Linux localhost 6.12.115 …`（libkrunfw 内核）、`uid=0(root)`、`/dsh-setup` 存在、`/proc/mounts` 含 1 条 overlay、EXIT_CODE=0；harness 侧 `~/.dsh-krun/{run,logs,workspaces}` 工件齐全、VM 会话常驻。
  - fail-closed 实测：boot 失败时 bash 工具收到结构化错误（模式 + "Runner failure" + 日志路径），诊断闭环符合设计。

### M3-M4 补充实测（2026-11-14 晚，headless 激活级 + 直调）

- **关键修复：stderr 分离（exec2 帧协议）**。M0 合并流（stdout+stderr 单管道）下官方拒绝分类
  `matchesSignature(exitCode, result.stderr.text, sigs)` 只查 stderr → EROFS 永远 `denied:false`，
  官方拒绝标记与升级提示不出现（此前 M1 的"EROFS 拒绝方言命中"只验了输出含错误文本，未验 denied 事实——
  滚动 TODO 保留该项是对的）。修复：agent 新增 `{"type":"exec2"}`——先回头行
  `{"ok":true,"stderr":"split"}`，随后帧流 `[tag u8][len u32 LE][payload]`（tag 1=stdout、2=stderr、
  3=退出码），两 relay 线程经互斥整帧写入（scoped threads 借用本地锁，waitpid 与排空并行防管道互锁）；
  `krun-backend exec` 发送 exec2 并解帧，流首无头行则按旧合并协议处理（旧镜像 agent 自动回退，零部署断层）。
- **EROFS → 拒绝闭环实测（read-only headless 会话）**：`touch ./should-be-denied.txt` → stderr
  `Read-only file system` → 工具输出追加官方 `[sandbox: file access denied under read-only mode]` +
  升级提示；`--approval-policy never` 下模型如实报告且不升级。**GUI 会话内批准升级 → 路由切 rw VM**
  的最后一步仍需用户配合验证（headless 无法模拟交互审批）。stdout/stderr/退出码分离回归：
  `echo stdout && echo stderr >&2 && exit 3` 三者如实分离上报。
- **空闲回收实测（idleStopMs=40s + GC 间隔 60s）**：三段 bash 调用——①写 `/opt/idle-marker`；②
  `sleep 75`（期间 GC tick 到期，idle>40s）；③读回。②未被误杀 = **agent stat 活跃连接保护生效**
  （execConns=1 → 跳过回收并刷新计时）；boot 日志 2 行 = ①②后空闲回收、③重新引导；③读回内容不变 =
  数据层跨回收保留。前置修复：`confine()` 原不刷新 `lastUse`（exec 路径会话会被 GC 误杀）→ confine 时刷新。
- **run_in_background 跨调用存活实测**：`run_in_background` 启动 `sleep 40 && echo BG-DONE >> /opt/bg-result`，
  前台两调用后 VM 退出，`debugfs` 读数据层盘 `/upper/opt/bg-result` = `BG-DONE`（boot 日志单行 = 会话
  全程未回收）。VM 内长驻子进程跨 bash 调用存活 ✓。
- **agent stat 协议**：`{"type":"stat"}` → `{"ok":true,"execConns":N,"termConns":M}`（AtomicUsize 计数），
  GC 据此实现设计 §7 的"无活动连接"语义（run_in_background 长驻连接免回收）；旧 agent 无此消息 → stat
  超时回退 liveTerminals 判定。
- **cwd 修正**：`confine()` 不再传 `--cwd process.cwd()`（harness 进程 cwd ≠ 会话 cwd 时 guest 内 cwd 错位）；
  executor 以每次调用的 workdir spawn exec 客户端（LocalBashExecutor `cwd: spec.workdir`），客户端
  `getcwd()` 兜底，工作区同路径挂载下零映射。实测 headless 内 `pwd` = 绑定工作区路径。
- **/vm 命令组（M3）**：`commands.register` 全局注册单命令 `/vm`（rawInput 解析
  `status | stop [all|<key>|ro|rw] | reset confirm`），disposer 挂本插件 fiber（HMR 反注册）；
  headless 激活 diag 全链（"commands inject callback fired" → "registered /vm"）。处理器直测：
  status 汇总镜像/绑定/会话/当前工作区；stop 无匹配报错；reset 两段式（无 confirm 只出计划——
  破坏类操作 user-only，confirm 后停会话 + 删数据层并回报）。
- **镜像管理 E2E（M4 v1）**：数据布局 `<dataDir>/images/<id>/{manifest.json, rootfs}` +
  `registry.json`（工作区绑定，tmp+rename 原子写）。导入核心 `runImportJob` 为纯函数（不经 cordis，
  可直调测试）。来源 v1：URL / 本地 tarball / 目录树 / 容器导出（docker|podman export tar 流落盘再解包）。
  Alpine 导入自动免 root 装 bash（M1 loader 技巧；**判定以 bash 二进制落地为准**——apk 对 chroot
  trigger 报 EPERM 可忽略，首版误把 apk 退出码当致命，已修）。E2E：minirootfs 3.22 URL 导入
  （12.9MiB，bashReady=true）→ 绑定测试工作区 → overlay `imageRootfs: ""` 强制走绑定 → headless
  引导 → `/etc/alpine-release=3.22.0` + `bash 5.2.37` ✓（boot 日志 rootfs=导入镜像路径）。
- **镜像/绑定 API 与管理页**：`GET /api/krun/images`、`POST /api/krun/images/import|delete`、
  `POST /api/krun/workspaces/bind|unbind|reset`；status 快照扩展 images/workspaces/jobs/idleMs。
  管理页新增"镜像"卡（列表/导入表单/删除，引用计数禁删）与"工作区绑定"卡（绑定/解绑/重置数据层），
  导入任务运行中 3s 轮询。删除保护：有绑定或运行中会话引用时拒绝。
- **probe 语义更新**：镜像可用性 = 配置 imageRootfs（遗留单镜像路径，保持兼容）或已导入镜像任一；
  boot 时镜像解析顺序 = registry 工作区绑定 → imageRootfs，无镜像 fail-closed。
- **运行期状态目录迁入 DSH 数据目录（2026-11-15）**：默认 dataDir 从插件自设的 `~/.dsh-krun`
  改为 `~/.dsh/storages/krun-vm`（设计 §6 既定布局；`DSH_HOME` 环境变量被尊重——与
  `@deepseek-ai/dsh-home-paths` 的 defaultDshHome 语义一致，该包对本插件不可解析故本地等价实现）。
  显式 `config.dataDir` 仍优先且不触发迁移。首次激活自动迁移：同盘 rename 原子，跨设备 EXDEV
  退回复制 + 删除；目标已存在则保留 legacy 不合并（不重试不破坏）。假 `$HOME` 沙箱实测：
  迁移（EXDEV 复制回退 + 内容完好）与新默认目录内真实引导会话（uname/exec/workspaces img/
  boot log 全落新目录）均通过。live 重启实测迁移完成，绑定/镜像/数据盘完好（管理页与 `/vm`
  经用户确认通过）。

### 可移植性修正（2026-11-16，用户报告的严重问题）

- **硬编码 `~/opt` 是致命 bug**：`krun-backend` 的 `ensure_data_img` 曾无条件使用
  `{HOME}/opt/e2fsprogs/usr/sbin/mke2fs`（+ 对应 LD_LIBRARY_PATH），镜像/libDir 也指向
  `~/opt/...`。普通机器根本没有这些目录 ⇒ **新建工作区数据盘直接失败**（用户实测复现）。
  更讽刺的是本机 `/sbin/mke2fs`、`/usr/sbin/mkfs.ext4` 一直都在，只是 `which` 因 PATH
  不含 `/sbin` 查不到、代码也从不查系统路径。
- **四级发现 + 资产内聚**：见 §4.4 表格。要点：① 系统绝对路径优先（PATH 不可靠）；
  ② 所有插件资产落 `<dataDir>`（`tools/lib` libkrunfw、`tools/e2fsprogs` 可选提取版、
  `images/` 镜像）③ 遗留外部 `imageRootfs` 首次使用时**自动迁入** `<dataDir>/images`
  （同盘 rename / 跨设备复制）④ 无任何镜像时自举 Alpine minirootfs ⑤ `<dataDir>/tools`
  下的 libkrunfw tgz 激活期自动解包。
- **E2E 验证（真实 dataDir、无 `~/opt`）**：probe 报告 `libkrunfw: bundled(tools/lib)`、
  `e2fsprogs: system`；live `POST /api/krun/ensure` 触发真实建盘（8G 稀疏 ext4，系统
  mke2fs）→ VM 引导 → guest `uname -r` / `df -h /` / agent 在位全部正常。
  另以「全新 dataDir + 空配置」模拟普通机器：镜像自动自举下载 → 建盘 → 引导 → 持久化写入
  全部通过。
- **清理**：实时 profile 与 harness 全部 overlay 中的 `~/opt` 绝对路径已移除（`imageRootfs`
  与 `libDir` 置空 ⇒ 走发现/自举）；`~/downloads/libkrunfw` 内容已迁入
  `<dataDir>/tools/lib`（`libkrunfw.so{,.5,.5.6.4}`）。

### M4 打磨实测（2026-11-15）

- **侧栏终端适配（坑 8 收口）**：调研确认 `dsh-api-terminal-controller` 的接缝 = `shellCandidates`
  配置（node-pty 以会话工作目录 spawn，`resolveExecutable` 验证候选）。适配三件套：
  ① agent term 协议升级——请求带 `cols/rows` 初始尺寸，输入中继扫描宿主桥内联的
  OSC 7777 resize 序列（`ESC ] 7777;resize;C;R BEL`）应用 `TIOCSWINSZ`（内核自动派发
  SIGWINCH），序列不落盘；② 侧栏桥 `plugin/bin/krun`（node 脚本，cwd → (workspace,rw)
  会话键 → agent.sock，stdin/stdout 双向中继 + SIGWINCH 转发 + EXIT 行剥离退出码；
  会话未运行时经新增的 `POST /api/krun/ensure` 引导）；③ 用户补丁层浅覆写
  `terminal-controller` 的 `shellCandidates`（默认六项 + 桥绝对路径）。实测：桥接附加、
  命令执行、resize（stty size 30 100 → OSC 110x33 → 40 120）全部正确。
- **关键修复：agent fd 卫生（CLOEXEC）**。accept/dup/pipe 均未设 CLOEXEC → fork 出的后台
  存活子进程（如 nohup 循环）替已结束的 exec 会话握住 vsock 连接 fd → 宿主 exec 客户端
  read_to_end 永不 EOF，**命令挂死**（guest ps 证实外层 sh 已退、仅后台循环存活）。
  修复 = `dup_cloexec`/`accept4(SOCK_CLOEXEC)`/`pipe2(O_CLOEXEC)` 全量替换（dup2 定向
  0/1/2 的语义路径保留）。复测：nohup 后台命令立即返回、转发连接正常收发。
- **应用层端口转发（`network: tsi + 只暴露指定端口` 收口）**：`portMap` 语义改为 vsock
  应用层转发（§4.3 已更新）：backend `--forward host:guest`（vsock 4200 起 +
  `run/<key>.fwd<vsock>.sock`）+ agent 启动参数 `DSH_FORWARD_PORTS` 中继 guest
  `127.0.0.1:<guest>` + provider 宿主监听 `127.0.0.1:<host>`；none 档下即零占用白名单组合。
  实测：宿主 `127.0.0.1:18080` → guest nc 应答往返 ✓；会话停机自动关监听 ✓；
  stat 增 `fwdConns`（转发连接免空闲回收）。
- **qcow2 数据层**：`dataDiskFormat: 'qcow2'`（backend `--data-format`，qemu-img 建空白盘；
  首次启动 guest 内 `mkfs.ext4 /dev/vda`——setup.sh 挂载失败即格式化）。Alpine 镜像缺
  e2fsprogs → `ensureGuestPackages` 免 root loader-apk 幂等补装（宿主网络；boot 时按需 +
  导入时均可）。实测：qcow2 引导、guest 内格式化、/opt 写入持久化、盘文件 8.6MB（对 8.5G
  raw 稀疏）✓。连带修复：**waitForAgent 改 ping/pong**——VMM 桥接 socket 在 guest agent
  就绪前即可连（mkfs 期间 exec 会 ConnectionReset），以 `{"type":"ping"}` 应答为就绪判据。
- **镜像预设清单**：管理页导入表单内置两个**已实测**预设（alpine-minirootfs 3.22、
  ubuntu-base 24.04.3——后者全流程实测：导入 → 绑定 → 引导出 Ubuntu 24.04.3 LTS +
  bash 5.2.21）。
- **aarch64 预置（未实测）**：agent 以 `RUSTFLAGS="-C linker=rust-lld"` 自包含链接
  aarch64-unknown-linux-musl 成功（静态，无外部 musl 交叉 gcc 依赖）；build.sh best-effort
  产出 `plugin/guest/dsh-vm-agent-aarch64`；provider bake 按宿主架构选择。aarch64 VM 引导
  需 aarch64 libkrunfw + rootfs（x86_64 主机不可实测，待 aarch64 主机）。
- **会话守护进程接线（`serve`，§4.1 决策收敛）**：`cmd_serve` 从 ping 回显骨架升级为完整
  实现（serve.rs 独立模块）。方法集：ping / session.ensure（单飞：in_flight set + Condvar；
  fingerprint 不匹配 → 停旧启新）/ session.stop / session.touch（confine 计活跃）/
  session.list / session.gc（agent stat 探活跃连接，覆盖全部客户端）/ shutdown。生命周期：
  provider 首次 ensure 懒 spawn（detached，继承 LD_LIBRARY_PATH）；无客户端且无会话 60s
  空闲退出并清 socket；disposer 发 shutdown（§7：HMR/卸载停会话，数据层持久）。boot 引导经
  **长寿 spawner 线程**执行（PDEATHSIG 绑守护进程而非发起连接的线程——客户端断开不杀 VM）。
  实测：daemon 引导 + exec ✓；第二客户端同 key ensure 复用 ✓（跨进程共享，live/headless
  不再互抢 socket）；客户端断开会话存活 ✓；配置漂移停旧启新 ✓；`/vm stop` → daemon stop ✓；
  node 退出 → 进程树全灭（PDEATHSIG 链）✓；headless 全链 ✓；`daemon:false` legacy 路径
  回归 ✓。**过程修坑**：① serde 字段 camelCase 对齐（rename_all）；② daemon 侧 mkdir
  （run/、workspaces/ 父目录——legacy 由 provider 预建）；③ agent ping 匹配用 windows(8)
  对 9 字节模式永不命中（改 contains）；④ ensureSession 缓存落账漏 daemon 分支 + booting
  成功路径不清理（gc 回收后同 key 永拿死 promise）。
- **数据层目录迁移（本日早前）**：默认 dataDir 迁入 `~/.dsh/storages/krun-vm`（详见上文
  M3-M4 段）；live 重启实测迁移完成，绑定/镜像/数据盘完好。
- **诊断 skill**：`diagnose-krun-vm-sandbox` 以 `ctx.skills.register` 内联注册（根作用域 =
  全局；`skills` 注册表根作用域可用——web-app 只禁了 filesystem provider 与 tool-skill）。
  内容：结构化错误 → probe → boot log（会话键公式 + 常见结尾表）→ dump-config → headless
  冒烟 → 意图核对（空闲回收/网络档/侧栏接缝）→ 破坏类操作 user-only。headless diag
  全链验证（`registered diagnose-krun-vm-sandbox`）+ 限制命令回归通过。
- **网络档按工作区覆盖（用户需求）**：绑定注册表条目带 `network: tsi|none`（管理页绑定卡
  选择器 + `POST /api/krun/workspaces/network`，`''` 清除恢复全局默认）；boot 解析 =
  `krunWorkspaceSettings(ws)`（绑定值 → 全局默认），网络进会话指纹——档位变化经指纹漂移
  停旧启新。设置路由同步失效本实例会话缓存（下次 ensure 重新比对指纹）。实测：全局 none +
  覆盖 tsi → guest wget 拉回 example.com ✓；覆盖 none → 出站隔离 ✓；缓存条目带生效档位
  （管理页会话行显示）。生效时机 = 下次会话（重）建，其他客户端的既有会话待其自身重建。
- **工作区归属映射验证（用户问询驱动）**：guest root `touch <ws>/f` → 宿主归属 = harness
  用户（VMM 凭据），**非 root**；guest 侧 `ls` 见宿主真实 uid（1000:1000）；guest 内建
  uid1000 用户后 `su -c 'touch <ws>/f2'` 直写成功（rc=0），宿主归属同样正确。结论：无
  "guest root 文件污染宿主归属"问题，不需要同 uid 默认用户；guest 默认 root 保持（§12.2
  已澄清两条不变量）。

### M2 实测记录（2026-11-14 下午，手动 backend 会话 + harness 集成）

- **数据层持久化 ✓**：完整"写入 → 停机 → 重启 → 读回"闭环（/opt/persist-marker-krunval 跨 4 个 VM 会话存活，且覆盖一次 dsh 进程重启）；同一 (workspace, mode) key 复用同一 ext4 数据盘，符合设计。
- **ro 拒绝 + ro/rw 并存 ✓**：ro 会话写根得内核级 EROFS（`Read-only file system`，精确命中 provider denialSignatures 方言）；ro 会话连工作区 virtiofs 也不可写（VMM 设备层 enforcement；guest `mount` 显示 `rw` 属显示怪癖，如实记录）；ro/rw 两个 boot 进程同时存活（双会话并存 ✓）。
- **网络档位（新增 `boot --network tsi|none` + 插件 config.network）**：
  - `tsi`：出站 TCP+DNS 全通（guest `wget http://example.com` 拉回完整页面）；入站自动端口暴露全链路验证（debug trace：`proxy create stream → DGRAM listen → tcp bind [::]:18299 → 转发`，宿主 curl 往返成功）。
  - **DNS 修复**：minirootfs 不带 `/etc/resolv.conf` → provider `bakeGuestFiles` 增加宿主 resolv.conf 烤入（tsi 共享宿主网络，宿主 resolver 经代理可达）；烤入后需重启 VM（virtiofs lower 对后建文件有负缓存）。
  - `none`：guest 内 `wget` 得 `Network unreachable`、宿主零端口占用（guest nc 监听时宿主 `ss` 无 listener）、vsock 控制通道（exec/终端）不受影响 ✓。
  - 1.19.x `port_map` 语义修正（见 §4.3）：改名映射而非白名单。
- **agent env 透传修复**：原实现解析 `req.env` 但 fork 子进程未应用 → 改为父进程预算 envp + PATH 解析、子进程纯 syscall `execve`（规避 fork 后 setenv 的多线程 malloc 死锁风险）；`exec --env DSH_SANDBOX_MODE=…` 实测到达 guest ✓。
- **插件 harness 集成三连坑（重要）**：
  1. `z.enumerator is not a function`——本版 schemastery（3.19 系）无该 API，**枚举 = `z.union([z.const('tsi'), z.const('none')]).default(…)`**（object 内 default/校验行为已实测正确）。import 抛错 → `sandbox` 服务缺失 → bash-sandbox/permission/ptc-runtime 等连锁 pending → **bash 工具消失、web_fetch 一并失效**（依赖链放大）。
  2. `cannot get property "timer" without inject`——cordis 4.1 对 ctx 未声明服务属性的访问直接抛错（可选链无效，GET 本身抛）；**必须 `static inject = ['timer']` 并用 `ctx.interval(cb, ms)`**（fiber effect 自动清理；timer 由 base bundle 提供，`cordis.patch.yml` id: timer）。构造期错误 dump-config 测不出——**激活级冒烟 = `dsh headless --patch <overlay>`**（headless 不占 3080、不动 live 会话；headless profile 无 `@local` 链接 → 插件目录自挂 peer-dep `node_modules` 符号链接 + patch 用绝对路径加载）。
  3. `ctx.effect(fn, label)` 双参签名合法；`ctx.inject([...], cb)` 服务以参数到达（不经 ctx 属性访问）。
  4. **`terminals.registerBackend` 的 DUPLICATE_BACKEND**（HMR reload 必踩）：注册 cleanup 挂在 terminals 服务自己的 fiber 上，插件若不接管 disposer，reload 后旧 backend 仍占着 `type: 'krun'`，新实例注册即抛 → sandbox 激活失败 → bash/ptc/workflow 连锁 pending。修复 = `ctx.effect(() => terminals.registerBackend(backend))` 由本插件 fiber 绑定清理（webServer.register 同型写法本就正确：register 返回的 disposer 由 effect 接管）。**headless 冒烟测不出此类问题（headless 无 terminals/webServer 服务，inject 回调不执行）**。
  5. **`ctx.inject(deps, cb)` 的 cb 收到 `(子ctx, config)`，服务经子ctx 属性访问**（源码 `runtime.callback(this.ctx, config)`；官方写法对照 open-in-app 的 `export const inject = [...]` + `ctx.webServer.register(...)`）。把首参当服务用（`(webServer) => webServer.register(...)`）实际是 `childCtx.register` → 抛错 → 子 plugin fiber 独立失败：**路由/终端后端静默缺失，而 sandbox 主服务照常工作**（bash 正常但管理页 API 全 404 的根因）。修复 = `(injectCtx) => injectCtx.webServer.register(...)`。
  6. **类方法里引用构造函数参数 `ctx` = ReferenceError**：krunRegisterRoutes 里的 `ctx.effect` 越界引用被 try/catch 吞掉后子 fiber 静默失败（管理页 404 的最终根因）——修复 = 构造时保存 `this.krunCtx`。**文件诊断标记法**（provider 向 `~/.dsh-krun/diag.log` 追加带时间戳的激活/注册轨迹）一次定位了"回调没跑 vs 跑了抛错 vs 注册了被摘除"三类假设，推荐保留为激活期排障手段。
  7. **terminals 服务不可在根作用域注册**：web-app preset 把 `@deepseek-ai/dsh-terminal` 放在 `persistent-shell`（cordis:group, `isolate: { terminals: true }`）组内——**每 agent 会话独立实例**，根作用域 `inject(['terminals'])` 永远 pending。该组嵌在 agent-preset 的 `config.plugins` 数据里：**补丁层 group-insert（`- id: <group>, insert: [...]`）够不到**（boot patch 解析只走全局树，报 entry not found），内置预设 Web 编辑器也不可编辑。可行路径 = **用户层覆写 preset 行的 config**（patch 对非 insert 条目按键浅覆写 `target[key] = value`；AgentPreset schema 要求 id+plugins 必填 → 必须带完整 config）。**预设构成事实**：四个内置预设中仅 `preset-minimal` 自带终端组（persistent-shell: pty/terminal-bash/persistent-bash/terminal-pwsh/persistent-pwsh），standard/ptc/cordis 均无 terminals 服务。按用户要求最终覆盖 = minimal（组尾追加注册器）+ standard/ptc（**注入精简终端组**：pty + terminal-bash + 注册器；不带 persistent-bash/pwsh 避免与既有 tool-bash 重复）+ cordis（创造模式）不动。生成已脚本化：取 `dsh-web-app/presets/*.patch.yml` 的 config 块（第 7 行起）左移 4 列（harness/krun-preset-override.yml，**dsh 更新 preset 后需重新生成**）。组内注册器 = 插件子路径导出 `@local/dsh-krun-vm/terminal-backend`（inject ['terminals','sandbox']，fiber 绑定清理）；terminals 不可 isolate 继承，workingDirectory/sandbox 等其他服务均根作用域可见。
  8. **DSH 有两套互不相通的终端系统**（修正 §2"注册 TerminalBackend 即得 Web 终端标签"的设想）：① **GUI 侧栏"新建终端"** = `dsh-api-terminal-controller` 的 shell 选择器路径（`subprocess.spawnTerminal` 按 shellPath 枚举宿主 shell），**完全不经过 terminals 服务的 backend 注册表**——**接缝 = `shellCandidates` 配置（2026-11-15 已适配，见 M4 打磨实测）**：用户补丁层浅覆写该键加入 `plugin/bin/krun` 桥（node-pty 以会话 cwd spawn，桥内联 OSC 7777 转达 resize，会话未运行经 `/api/krun/ensure` 引导）；② **agent 的 `terminal_*` 工具**（dsh-tool-terminal：terminal_open/send/read/signal/kill/list）= terminals 服务的真正消费者，`terminal_open` 的 `type` 是**自由字符串参数**（`args.type.length === 0` 校验后直传 spawn 请求）。两条路径并存。
- **诊断技巧**：`RUST_LOG=debug` 传给 boot 子进程（env_logger 尊重 RUST_LOG 覆盖 `krun_set_log_level` 的默认档），TSI/vsock 全链路 trace 可见。- **测试方法坑（非沙盒问题）**：busybox `nc` stdin 遇 EOF 立即退出（`punt!`，stdin=/dev/null 或管道读尽都会）——监听测试必须挂持久 stdin 或一次性应答器；Alpine busybox 无 `httpd` applet。
- **agent 并发语义**：每连接一线程（并发 exec/终端 OK）；长驻子进程持有 stdout 管道会使该 exec 连接保持（`run_in_background` 场景正是所需语义）， abandoned 连接遗留 relay 线程（低危，VM 会话回收时一并终止）。
- live patch 接线确认：用户层 `disable base sandbox 行 + insert sandbox-vm` 组合在 `--dump-config` 层叠正确（base 行 `disabled: true`、sandbox-vm 带配置插入、sandbox-policy/bash-sandbox 原样）。

## 附录 D：Harness 验证 TODO（滚动清单）

> 勾选项均在附录 C 有实测记录；未勾选项按依赖顺序排列。

**M1 核心接缝**- [x] `dsh --dump-config` 显示 sandbox 行覆盖（用户层 disable + insert 组合）
- [x] 真实 DSH 会话 confined bash 落 VM（15:37 E2E）
- [x] fail-closed（boot 失败 → 结构化 Runner failure）
- [x] ro 会话 EROFS 拒绝方言命中 denialSignatures
- [x] web app 激活稳定复核（diag.log 全链：constructor → webServer inject fired → 3 条路由 registered；管理页经用户确认已出数据）
- [x] EROFS 拒绝标记与升级提示闭环（stderr 分离修复后 headless 实测：官方 `[sandbox: file access denied under read-only mode]` + 升级提示出现，模型如实上报；**GUI 会话内批准升级 → 路由切 rw VM 待用户配合验证**）

**M2 持久化与终端**

- [x] rw 数据层跨 VM 重启持久化（4 会话闭环）
- [x] ro/rw 双会话并存
- [x] 空闲回收实测（idleStopMs=40s：GC 不误杀活跃 exec（agent stat 保护）、空闲后回收重引导、数据层跨回收保留；前置修复 confine 刷新 lastUse）
- [ ] Web 终端开在 VM 内——**已可用的路径 = agent 工具**：新会话里让 agent 调 `terminal_open {"type":"krun"}`（三预设覆写已验证：standard/ptc/minimal 均含注册器）。**侧栏"新建终端"走的是另一套 shell 选择器系统（dsh-api-terminal-controller），不经 backend 注册表，永远不会有 krun 选项**——见附录 C 坑 8；侧栏级 VM 终端列 M4 候选。PTY 80x24 固定，resize 列为后续
- [x] `run_in_background` 任务跨调用存活（VM 内长驻子进程写入数据层，debugfs 读回验证；会话全程未回收）

**M3 管理界面**

- [x] `/api/krun/status|stop|probe` 路由注册（401 前置 = 路由已挂）
- [x] `/vm` 命令组（commands.register 全局单命令：status/stop/reset confirm；headless 激活 diag + 处理器直测；**用户 GUI 确认通过**）
- [x] 镜像/工作区绑定 API（images、images/import、images/delete、workspaces/bind|unbind|reset；导入任务 409 串行）+ `/api/krun/ensure`（侧栏桥引导用）
- [x] 设置页四卡 + 状态芯片 + 镜像预设清单（**用户 GUI 确认设置页与 /vm 通过**）
- [ ] `/vm` 命令的 composer 侧发现性实测（注册已验证，UI 补全/执行待用户；设置页已确认）

**M4 打磨**

- [x] 镜像管理 v1（URL/tarball/dir/容器导出导入 + manifest + registry.json 绑定 + 删除保护；导入 E2E：minirootfs 3.22 → 绑定 → 引导 ✓）
- [x] 镜像预设清单（alpine-minirootfs 3.22 + ubuntu-base 24.04.3，均已导入 + 引导实测；管理页"预设（已测）"选择器）
- [x] `network: none` + `portMap` 应用层端口转发（vsock 通道：宿主 127.0.0.1:<host> → guest；往返实测 ✓；stat fwdConns 免回收；1.19.x set_port_map 改名映射仅 backend CLI 保留）
- [x] qcow2 数据层格式（qemu-img 建盘 + guest 内首启格式化 + e2fsprogs 自动补装；实测 ✓）
- [x] 侧栏终端适配（shellCandidates + bin/krun 桥 + OSC 7777 resize + /api/krun/ensure；实测 ✓）
- [x] 诊断 skill（diagnose-krun-vm-sandbox，ctx.skills.register 内联注册；headless diag 验证）
- [x] aarch64 agent 预置（rust-lld 自包含 musl 静态构建实测 ✓、bake 按宿主架构选择；**VM 引导待 aarch64 主机实测**）
- [ ] aarch64 VM 引导端到端（需 aarch64 libkrunfw + rootfs + 主机）
- [ ] README 之外的独立排障文档（诊断 skill 已承载主要内容；可再出 troubleshooting.md）
- [x] `serve` 守护进程接线（设计 §4.1 收敛）：注册表/单飞 ensure/配置指纹/监督/gc/转发监听/空闲退出；跨进程共享 + PDEATHSIG 链实测 ✓（`daemon:false` 为遗留直 spawn 逃生开关）

**遗留修正项**
- [x] agent env 透传（父进程 execve 方案）
- [x] resolv.conf 烤入
- [x] terminals.registerBackend fiber 绑定（DUPLICATE_BACKEND，见附录 C 第 4 条坑）
- [x] 管理页 404 根因修复（坑 5/6：inject 回调签名 + 类方法 ctx 越界引用；diag.log 全链验证）
- [x] backend usage 字符串补全（`--setup/--ws-path/--data-img/--network`）
- [x] **stderr 分离（exec2 帧协议）**：合并流使官方拒绝分类（只查 stderr）永远 denied=false，拒绝标记/升级 UX 失效——本日实测发现并修复
- [x] **confine 刷新 lastUse**：exec 路径会话此前不计时，会被空闲 GC 误杀
- [x] **cwd 兜底**：confine 不再传 harness 进程 cwd，executor spawn cwd 经 exec 客户端 getcwd() 透传
- [x] **agent fd 卫生（CLOEXEC）**：accept/dup/pipe 泄漏连接 fd 给 fork 子进程，后台存活子进程令 exec 挂死——实测发现并修复
- [x] **waitForAgent ping/pong**：VMM 桥接 socket 早于 guest agent 就绪可连（qcow2 首启 mkfs 场景），以 ping 应答为就绪判据
- [ ] 移除 provider 的 krunDiag 诊断标记（当前保留为排障手段，稳定一轮后清理）
- [ ] `krun_get_max_vcpus` 探测在内建沙盒下返回 -1（probe 需 /dev/kvm 可达；provider probe 已正确 fail-closed）