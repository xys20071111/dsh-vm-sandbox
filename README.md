# krun VM sandbox — DeepSeek Harness 的 libkrun microVM 沙盒插件

把 DSH（DeepSeek Harness）的 sandbox 接缝替换为 libkrun microVM 后端：受限命令在
独立内核的轻量 VM 内执行，工作区以同绝对路径双向共享，系统级副作用持久化在
"工作区数据层"（ext4 稀疏盘，guest 内 overlay upper），镜像层只读可复用。

完整设计、实测记录与验证清单见 **[krun-vm-sandbox-design.md](krun-vm-sandbox-design.md)**
（附录 C = 实测记录；附录 D = 验证 TODO）。

## 能力一览（2026-11-15）

- **Sandbox 接缝**：confine 落 VM、fail-closed、EROFS 拒绝方言 + 官方拒绝标记/升级提示
  （agent exec2 帧协议做 stdout/stderr 分离——官方拒绝分类只查 stderr）
- **空闲回收**：idleStopMs + agent `stat` 活跃连接探测（run_in_background 长驻子进程与
  端口转发连接免回收）
- **`/vm` 人类命令**：`/vm status`、`/vm stop [all|<key>|ro|rw]`、`/vm reset confirm`（两段式确认）
- **镜像管理**：URL / tarball / 目录 / 容器导出导入到 `<dataDir>/images/<id>/`，
  manifest + `registry.json` 工作区绑定（boot 解析顺序 = 绑定 → imageRootfs）、
  删除保护、Alpine 自动免 root 装包；管理页"镜像 / 工作区绑定"两卡 +
  内置已测预设（alpine-minirootfs 3.22、ubuntu-base 24.04）
- **侧栏终端**：GUI"新建终端"shell 选择器里的 `krun` 项（`plugin/bin/krun` 桥，
  OSC 7777 resize 直达 guest PTY，会话未运行自动引导）
- **网络档按工作区**：全局默认 + 工作区绑定覆盖（tsi/none，管理页选择器/`workspaces/network` API），
  档位变化自动停旧启新；全局 DNS 可在管理页设置 IPv4/IPv6 DNS 地址，持久化到 `<dataDir>/dns.json`，VM 启动前写入 guest `/etc/resolv.conf`（强制 TCP DNS 以兼容 TSI）；留空使用宿主 `resolv.conf` 的 DNS；`portMap: ["host:guest"]` = vsock 应用层转发（宿主绑 127.0.0.1），
  `none` 档下即"零占用 + 只暴露指定端口"组合
- **qcow2 数据层**：`dataDiskFormat: 'qcow2'`（qemu-img 建盘，guest 内首启格式化）
- **诊断 skill**：`diagnose-krun-vm-sandbox`（全局 skill，排障路径 + 常见失败表）
- **会话守护进程**：`serve`（默认开启，`daemon: false` 回退直 spawn）——跨进程共享会话
  （同 dataDir 的 live/headless 共用一 VM）、配置指纹漂移防线、boot 子进程监督、PDEATHSIG 孤儿回收
- **管理页**：侧栏独立的“虚拟机管理”（环境/会话/镜像看板、工作区镜像绑定与网络档、额外只读目录挂载、虚拟机专用文件管理）+ composer 状态芯片。文件管理仅作用于 guest 持久目录 `/root/vm-files`，不会读写宿主文件系统；单文件传输上限 64 KiB（受 guest exec argv 长度限制）。guest 首次以读写模式启动时，会检测 `bash` 与 `python3`；缺少时用 Alpine `apk` 或 Ubuntu/Debian `apt-get` 安装到持久可写层。精简 Ubuntu/Debian 缺少 `gpgv` 时，安装器先用宿主 CA 根证书和 HTTPS 引导 `gpgv`，之后恢复 apt 签名校验；apt 辅助进程在隔离 VM 内以 root 运行，避免极简镜像缺少 `_apt` 用户时校验器无法启动。只读会话不会安装；缺少可信 CA、包管理器、仓库或网络时会记录提示并继续启动首次 apt 安装的启动等待上限为 180 秒；使用 qcow2 时 rootfs 仍需预置 `mkfs.ext4` 或 `mke2fs`。
- **Agent rootfs 选择与 VM 创建**：`krun_vm` 工具列出可选镜像并允许 Agent 为当前工作区绑定所选 rootfs、设置网络/ro-rw 并启动 VM；只接受管理的镜像 ID，不接收任意宿主路径或 URL。无导入镜像时可用已配置 rootfs 或官方 Alpine 自动回退。

## DSH 兼容性

插件清单针对当前运行时 DSH `0.2.2-rc.5` 声明兼容，并依赖同版 `@deepseek-ai/dsh-sandbox`。该 VM provider 尚不支持 SandboxPolicy 的 `additionalWritableRoots`：出现此策略时会 fail-closed 返回 `SANDBOX_UNAVAILABLE`，不会静默忽略额外授权。

## 布局

| 路径 | 内容 |
|---|---|
| `krun-vm-sandbox-design.md` | 设计文档（§1-14 设计；附录 A-D 接口/事实/实测/TODO） |
| `backend/krun-backend/` | 宿主侧 Rust：`probe` / `boot`（每会话一 VM 子进程，PDEATHSIG 绑父）/ `exec`（agent 客户端，exec2 帧解包）/ `serve`（**会话守护进程**：注册表/监督/gc/端口转发监听，协议见 serve.rs） |
| `backend/guest/dsh-vm-agent/` | guest 内代理（musl static-pie）：vsock:42 上的 exec（fork/execve + env 透传）、exec2（stdout/stderr/退出码帧分离）、term（PTY + OSC 7777 resize）、vsock 端口转发中继、stat（活跃连接）；全 fd CLOEXEC |
| `backend/vendor/libkrun/` | **git submodule**：containers/libkrun `stable-1.19.x`，锁定 1.19.8 发布点（c4d283c2）；path 依赖 `src/libkrun`，可打补丁 |
| `plugin/` | `@local/dsh-krun-vm` 插件：`index.js`（SandboxProvider + /vm 命令 + 管理 API + 端口转发监听 + 空闲回收）、`guest-files.js`（VM 内安全文件操作）、`diagnose-skill.js`（诊断 skill）、`terminal-backend.js`（persistent-shell 组内注册器）、`client.js`（侧栏虚拟机管理、文件/挂载页面 + 状态芯片）、`guest/setup.sh`（guest 内三层编排 + 首启格式化）、`bin/krun`（侧栏终端桥）、`bin/krun-backend`、`guest/dsh-vm-agent{-aarch64,}`（构建产物，已忽略） |
| `m0/` | 可行性尖峰：FFI 探针 / 引导冒烟（koffi 路线已弃用的实证） |
| `harness/` | 接线工件：`krun-overlay.yml`（dsh --patch 用）、`krun-preset-override.yml`（三预设覆写生成物）、`krun-overlay-headless-*.yml`（headless 验证 overlay） |
| `scripts/build.sh` | 构建并部署二进制到 `plugin/`（x86_64 + best-effort aarch64 agent） |

## 构建

依赖：rustup（含 `x86_64-unknown-linux-musl` target）、libclang（bindgen）、
运行时需要 `libkrunfw.so.5`（系统安装，或放到 `<dataDir>/tools/lib`；见下"运行时依赖"）。

```bash
scripts/build.sh
```

## 接线（live profile）

`~/.dsh/profiles/web/cordis.patch.yml`：

1. disable base bundle 的 `sandbox` 行 + insert `sandbox-vm`（provider 替换，network: none）
2. `preset-minimal` / `preset-standard` / `preset-ptc` 三预设覆写（persistent-shell 组内
   注册 krun 终端后端；**cordis/创造模式未动**）。preset 为快照，dsh 更新后用
   `harness/krun-preset-override.yml` 头部的生成方式重新生成。

验证：`dsh --profile web --dump-config`；激活冒烟：
`dsh headless --patch harness/krun-overlay-headless-test.yml "..."`（不占 3080、不动 live 会话；
绝对路径加载插件 + headless 默认模型路由）。

注意：插件代码更新后，live web 实例需重启 dsh（或插件重载）才会加载新代码；
已运行会话的 VM 由 provider disposer 停止，数据层天然落盘恢复。

## 运行时依赖（全部按「环境变量 → 系统 → PATH → `<dataDir>` 捆绑」发现，不依赖任何用户目录）

- `/dev/kvm` 可写（KVM API v12 实测通过）
- `libkrunfw.so.5`：系统包，或放 `libkrunfw*.tgz` 到 `<dataDir>/tools/`（激活期自动解包到
  `tools/lib`），或 `POST /api/krun/tools {"path": "<tgz>"}` 显式安装
- e2fsprogs（`mkfs.ext4`/`mke2fs`）：发行版默认自带；无则可放提取版到
  `<dataDir>/tools/e2fsprogs`（注入 `KRUN_E2FSPROGS_DIR`）或设 `KRUN_MKE2FS`
- `qemu-img`（仅 `dataDiskFormat: qcow2`）：主机 qemu-utils，或 `KRUN_QEMU_IMG`
- **guest 镜像**：无需预置——首次使用自动自举 Alpine minirootfs 到 `<dataDir>/images/`；
  也可管理页/API 导入，或把遗留 rootfs 目录配到 `imageRootfs`（首次使用自动迁入 dataDir）
- 运行期资产目录：默认 `~/.dsh/storages/krun-vm`（`DSH_HOME` 被尊重），含 `images/`
  `workspaces/` `tools/` `logs/` `run/` `registry.json`；旧默认 `~/.dsh-krun` 首次激活自动迁入
