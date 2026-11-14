#!/usr/bin/env bash
# 构建 krun-backend（宿主，glibc release）与 dsh-vm-agent（guest，musl static-pie）
# 并部署到 plugin/。libkrun 以 path 依赖进程内直连（backend/vendor/libkrun）。
#
# 依赖：
#   - cargo + rustup target x86_64-unknown-linux-musl
#   - libclang（backend vendor 树的 bindgen 需要，LIBCLANG_PATH 可覆盖）
#   - 运行 krun-backend 时需 LD_LIBRARY_PATH 指向 libkrunfw.so.5 所在目录
#     （provider 配置项 libDir 已覆盖此需求）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"

# 确保 libkrun submodule 已检出（fresh clone 后首次构建需要）
git -C "$ROOT" submodule update --init

export LIBCLANG_PATH="${LIBCLANG_PATH:-/usr/lib/x86_64-linux-gnu}"

echo "== build krun-backend (host release)"
cargo build --release -p krun-backend

echo "== build dsh-vm-agent (musl static-pie)"
cargo build --release --target x86_64-unknown-linux-musl -p dsh-vm-agent

install -D -m 0755 target/release/krun-backend ../plugin/bin/krun-backend
install -D -m 0755 target/x86_64-unknown-linux-musl/release/dsh-vm-agent \
  "../plugin/guest/dsh-vm-agent-x86_64"

echo "== deployed: plugin/bin/krun-backend, plugin/guest/dsh-vm-agent-x86_64"
echo "note: guest agent 变更后由 provider boot 时的 bakeGuestFiles 自动烤入镜像树；"
echo "      已运行的 VM 会话需停止重启才会加载新 agent。"
