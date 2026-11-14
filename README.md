# krun VM sandbox — DeepSeek Harness 的 libkrun microVM 沙盒插件

把 DSH（DeepSeek Harness）的 sandbox 接缝替换为 libkrun microVM 后端：受限命令在
独立内核的轻量 VM 内执行，工作区以同绝对路径双向共享，系统级副作用持久化在
"工作区数据层"（ext4 稀疏盘，guest 内 overlay upper），镜像层只读可复用。

完整设计、实测记录与验证清单见 **[krun-vm-sandbox-design.md](krun-vm-sandbox-design.md)**
（附录 C = 实测记录；附录 D = 验证 TODO）。

## 能力一览（2026-11-14）

- **Sandbox 接缝**：confine 落 VM、fail-closed、EROFS 拒绝方言 + 官方拒绝标记/升级提示
  （agent exec2 帧协议做 stdout/stderr 分离——官方拒绝分类只查 stderr）
- **空闲回收**：idleStopMs + agent `stat` 活跃连接探测（run_in_background 长驻子进程免回收）
- **`/vm` 人类命令**：`/vm status`、`/vm stop [all|<key>|ro|rw]`、`/vm reset confirm`（两段式确认）
- **镜像管理**：URL / tarball / 目录 / 容器导出导入到 `<dataDir>/images/<id>/`，
  manifest + `registry.json` 工作区绑定（boot 解析顺序 = 绑定 → imageRootfs）、
  删除保护、Alpine 导入自动免 root 装 bash；管理页"镜像 / 工作区绑定"两卡
- **管理页**：Settings → "VM sandbox"（环境体检 / 运行会话 / 镜像 / 工作区绑定）+ composer 状态芯片

## 布局

| 路径 | 内容 |
|---|---|
| `krun-vm-sandbox-design.md` | 设计文档（§1-14 设计；附录 A-D 接口/事实/实测/TODO） |
| `backend/krun-backend/` | 宿主侧 Rust CLI：`probe` / `boot`（每会话一 VM 进程）/ `exec`（agent 客户端，exec2 帧解包）/ `serve`（预留） |
| `backend/guest/dsh-vm-agent/` | guest 内代理（musl static-pie）：vsock:42 上的 exec（fork/execve + env 透传）、exec2（stdout/stderr/退出码帧分离）、term（PTY）、stat（活跃连接） |
| `backend/vendor/libkrun/` | **git submodule**：containers/libkrun `stable-1.19.x`，锁定 1.19.8 发布点（c4d283c2）；path 依赖 `src/libkrun`，可打补丁 |
| `plugin/` | `@local/dsh-krun-vm` 插件：`index.js`（SandboxProvider + /vm 命令 + 镜像管理路由 + 空闲回收）、`terminal-backend.js`（persistent-shell 组内注册器）、`client.js`（设置页四卡 + 状态芯片）、`guest/setup.sh`（guest 内三层编排）、`bin/krun-backend`、`guest/dsh-vm-agent`（构建产物，已忽略） |
| `m0/` | 可行性尖峰：FFI 探针 / 引导冒烟（koffi 路线已弃用的实证） |
| `harness/` | 接线工件：`krun-overlay.yml`（dsh --patch 用）、`krun-preset-override.yml`（三预设覆写生成物）、`krun-overlay-headless-*.yml`（headless 验证 overlay） |
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

验证：`dsh --profile web --dump-config`；激活冒烟：
`dsh headless --patch harness/krun-overlay-headless-test.yml "..."`（不占 3080、不动 live 会话；
绝对路径加载插件 + headless 默认模型路由）。

注意：插件代码更新后，live web 实例需重启 dsh（或插件重载）才会加载新代码；
已运行会话的 VM 由 provider disposer 停止，数据层天然落盘恢复。

## 运行时依赖

- `/dev/kvm` 可写（KVM API v12 实测通过）
- `libkrunfw.so.5`（soname 固定；provider 配置 `libDir` 指向其目录）
- e2fsprogs 对普通文件 `mkfs.ext4`（免 root）
- guest 镜像：默认 imageRootfs 指向准备好的 rootfs 目录树（环境相关，本机在
  `~/opt/krun-m0/images/alpine/rootfs`，provider boot 时自动烤入 agent/setup/resolv.conf）；
  或经管理页/API 导入到 `~/.dsh-krun/images/<id>/` 后按工作区绑定
