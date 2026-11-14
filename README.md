# krun VM sandbox — DeepSeek Harness 的 libkrun microVM 沙盒插件

把 DSH（DeepSeek Harness）的 sandbox 接缝替换为 libkrun microVM 后端：受限命令在
独立内核的轻量 VM 内执行，工作区以同绝对路径双向共享，系统级副作用持久化在
"工作区数据层"（ext4 稀疏盘，guest 内 overlay upper），镜像层只读可复用。

完整设计、实测记录与验证清单见 **[krun-vm-sandbox-design.md](krun-vm-sandbox-design.md)**
（附录 C = 实测记录；附录 D = 验证 TODO）。

## 布局

| 路径 | 内容 |
|---|---|
| `krun-vm-sandbox-design.md` | 设计文档（§1-14 设计；附录 A-D 接口/事实/实测/TODO） |
| `backend/krun-backend/` | 宿主侧 Rust CLI：`probe` / `boot`（每会话一 VM 进程）/ `exec`（agent 客户端）/ `serve`（预留） |
| `backend/guest/dsh-vm-agent/` | guest 内代理（musl static-pie）：vsock:42 上的 exec（fork/execve + env 透传）与 term（PTY） |
| `backend/vendor/libkrun/` | **git submodule**：containers/libkrun `stable-1.19.x`，锁定 1.19.8 发布点（c4d283c2）；path 依赖 `src/libkrun`，可打补丁 |
| `plugin/` | `@local/dsh-krun-vm` 插件：`index.js`（SandboxProvider + 管理路由 + 空闲回收）、`terminal-backend.js`（persistent-shell 组内注册器）、`client.js`（设置页 + 状态芯片）、`guest/setup.sh`（guest 内三层编排）、`bin/krun-backend`、`guest/dsh-vm-agent`（构建产物，已忽略） |
| `m0/` | 可行性尖峰：FFI 探针 / 引导冒烟（koffi 路线已弃用的实证） |
| `harness/` | 接线工件：`krun-overlay.yml`（dsh --patch 用）、`krun-preset-override.yml`（三预设覆写生成物） |
| `scripts/build.sh` | 构建并部署两个二进制到 `plugin/` |

## 构建

依赖：rustup（含 `x86_64-unknown-linux-musl` target）、libclang（bindgen）、
运行时需要 `libkrunfw.so.5`（本机用户前缀 `~/opt/libkrun/lib`）。

```bash
scripts/build.sh
```

## 接线（live profile）

`~/.dsh/profiles/web/cordis.patch.yml`：

1. disable base bundle 的 `sandbox` 行 + insert `sandbox-vm`（provider 替换，network: none）
2. `preset-minimal` / `preset-standard` / `preset-ptc` 三预设覆写（persistent-shell 组内
   注册 krun 终端后端；**cordis/创造模式未动**）。preset 为快照，dsh 更新后用
   `harness/krun-preset-override.yml` 头部的生成方式重新生成。

验证：`dsh --profile web --dump-config`；激活冒烟：`dsh headless --patch harness/krun-overlay.yml "..."`。

## 运行时依赖

- `/dev/kvm` 可写（KVM API v12 实测通过）
- `libkrunfw.so.5`（soname 固定；provider 配置 `libDir` 指向其目录）
- e2fsprogs 对普通文件 `mkfs.ext4`（免 root）
- guest 镜像：Alpine minirootfs 目录树（环境相关，本机在 `~/opt/krun-m0/images/alpine/rootfs`，
  provider boot 时自动烤入 agent/setup/resolv.conf）
