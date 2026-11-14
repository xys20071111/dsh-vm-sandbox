#!/usr/bin/env bash
# M0.1 运行器：设置库路径，跑引导冒烟，输出控制台日志与退出码。
set -u
export LD_LIBRARY_PATH="$HOME/opt/libkrun/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
CONSOLE="${KRUN_CONSOLE:-/tmp/krun-m0-console.log}"
rm -f "$CONSOLE"
node "$(dirname "$0")/boot-test.mjs"
rc=$?
echo "--- node exit=$rc (即工作负载退出码)"
if [ -f "$CONSOLE" ]; then
  echo "--- console output:"
  cat "$CONSOLE"
else
  echo "--- (no console file at $CONSOLE)"
fi
