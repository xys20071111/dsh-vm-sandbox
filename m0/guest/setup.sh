#!/bin/sh
# M0.2 guest 内三层编排（busybox ash）。镜像创建时烤入 rootfs 为 /dsh-setup。
# 用法（经 krun_set_exec）: /bin/sh /dsh-setup <MODE:ro|rw> <WS_HOST_ABS_PATH>
echo "SETUP: args=$# [$1|$2|$3] agent-marker=$(grep -c dsh-vm-agent /dsh-setup)"
# 层次: lower=只读镜像根(virtiofs /dev/root) ← upper=数据层(ro=tmpfs 丢弃 / rw=ext4 盘 /dev/vda)
#       工作区=virtiofs "workspace" 共享，挂到宿主机同绝对路径。合成后 chroot 进入。
MODE="${1:-rw}"
WS="${2:?workspace host path required}"
AGENT="${3:-}"

set -e

# 1. 运行时挂载点基座（镜像根是只读的，全部建在 tmpfs 上）
mount -t tmpfs tmpfs /run
mkdir -p /run/newroot /run/data

# 2. 合成根
if [ "$MODE" = rw ]; then
  mount -t ext4 /dev/vda /run/data
  mkdir -p /run/data/upper /run/data/work
  mount -t overlay overlay -o "lowerdir=/,upperdir=/run/data/upper,workdir=/run/data/work" /run/newroot
else
  # 只读会话：无 upper 的纯 lower 合成（内核 6.12 要求至少 2 个 lowerdir，
  # 补一个空 tmpfs 作第二 lower）→ 整棵根不可写，写操作得到内核级 EROFS
  mkdir -p /run/empty
  mount -t tmpfs tmpfs /run/empty
  mount -t overlay overlay -o "lowerdir=/:/run/empty" /run/newroot
fi

# 3. 伪文件系统：在新根上全新挂载（overlay 目标不接受 mount --move，EINVAL）
mount -t proc proc /run/newroot/proc
mount -t sysfs sys /run/newroot/sys
mount -t devtmpfs dev /run/newroot/dev
mkdir -p /run/newroot/dev/pts /run/newroot/dev/shm
mount -t devpts devpts /run/newroot/dev/pts
mount -t tmpfs shm /run/newroot/dev/shm

# 4. 工作区挂载点：与宿主机同绝对路径。首个缺失路径段之前的祖先目录上盖 tmpfs，
#    其余段在 tmpfs 上普通 mkdir（只读根上无法 mkdir）。
P="/run/newroot"
oldIFS=$IFS; IFS='/'
set -- $WS
IFS=$oldIFS
FIRST_MISSING=1
for c in "$@"; do
  [ -z "$c" ] && continue
  if [ "$FIRST_MISSING" = 1 ] && [ -d "$P/$c" ]; then
    P="$P/$c"
    continue
  fi
  if [ "$FIRST_MISSING" = 1 ]; then
    mount -t tmpfs "tmpfs-ws" "$P"
    FIRST_MISSING=0
  fi
  P="$P/$c"
  mkdir -p "$P"
done
mount -t virtiofs workspace "$P"

# 5/6. 进入合成根：agent 模式常驻（VM 随 agent 退出而关机），否则执行一次性验证负载
if [ "$AGENT" = agent ]; then
  echo "SETUP: agent branch taken"
  chroot /run/newroot /usr/bin/dsh-vm-agent
  echo "SETUP: agent exited rc=$?"
  exit $?
fi
exec chroot /run/newroot /bin/sh -c '
  if [ "'"$MODE"'" = rw ]; then
    echo m-$$ >> /opt/persist-marker 2>&1 && echo "SETUP: RW-UPPER-WRITE-OK" || echo "SETUP: RW-UPPER-WRITE-FAIL(EROFS?)"
    echo ws-$ > "'"$WS"'/.ws-write-test" 2>&1 && echo "SETUP: WS-RW-OK" || echo "SETUP: WS-RW-FAIL"
    echo "SETUP: persisted markers:"; cat /opt/persist-marker 2>/dev/null; cat "'"$WS"'/.ws-write-test" 2>/dev/null
  else
    if touch /opt/nope 2>/dev/null; then echo "SETUP: UNEXPECTED-WRITABLE-ROOT"; else echo "SETUP: RO-DENIED-OK"; fi
  fi
  echo IN-CHROOT-OK; id
  [ -d '"$WS"' ] && echo WS-VISIBLE-OK
  exit 0'
