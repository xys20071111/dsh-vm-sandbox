#!/bin/sh
# M0.2 guest 内三层编排（busybox ash）。镜像创建时烤入 rootfs 为 /dsh-setup。
# 用法（经 krun_set_exec）: /bin/sh /dsh-setup <MODE:ro|rw> <WS_HOST_ABS_PATH>
echo "SETUP: args=$# [$1|$2|$3] agent-marker=$(grep -c dsh-vm-agent /dsh-setup)"
# 层次: lower=只读镜像根(virtiofs /dev/root) ← upper=数据层(ro=tmpfs 丢弃 / rw=ext4 盘 /dev/vda)
#       工作区=virtiofs "workspace" 共享，挂到宿主机同绝对路径。合成后 chroot 进入。
MODE="${1:-rw}"
WS="${2:?workspace host path required}"
AGENT="${3:-}"
shift 3 || true
# Backend restricts share names to whitespace-free safe tokens.
MOUNT_NAMES="$*"

set -e

# Install a bounded set of packages in the guest's merged root. In rw mode this
# writes to the persistent overlay; package files never go into the shared host
# workspace or the read-only lower image. Ubuntu/Debian's minimal base may omit
# gpgv, so bootstrap it once over HTTPS using the host CA bundle baked at boot;
# after that, normal apt signature verification is required for all packages. Run
# apt's helpers as root: minimal base images may not provision the _apt sandbox user.
ensure_guest_tools() {
  chroot /run/newroot /bin/sh -c '
    need=""
    for package in "$@"; do
      case "$package" in
        bash) command -v bash >/dev/null 2>&1 || need="$need bash" ;;
        python3) command -v python3 >/dev/null 2>&1 || need="$need python3" ;;
        *) echo "SETUP: unsupported required package: $package"; exit 26 ;;
      esac
    done
    [ -z "$need" ] && { echo "SETUP: requested guest tools already available:$*"; exit 0; }
    echo "SETUP: missing guest tools:$need"
    if command -v apk >/dev/null 2>&1; then
      set -- $need
      apk add --no-cache "$@"
    elif command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      if ! command -v gpgv >/dev/null 2>&1 || ! gpgv --version >/dev/null 2>&1; then
        if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
          echo "SETUP: apt bootstrap needs a trusted CA bundle, but none is installed"
          exit 22
        fi
        for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
          [ -f "$source" ] || continue
          sed -i "s#http://#https://#g" "$source"
        done
        apt-get -o APT::Sandbox::User=root -o Acquire::AllowInsecureRepositories=true update || exit 23
        apt-get -o APT::Sandbox::User=root --allow-unauthenticated -o Acquire::AllowInsecureRepositories=true install -y --no-install-recommends gpgv || exit 24
        command -v gpgv >/dev/null 2>&1 || { echo "SETUP: HTTPS bootstrap did not install gpgv"; exit 25; }
        echo "SETUP: bootstrapped gpgv over verified HTTPS; enabling signed apt verification"
      fi
      # Minimal rootfs images may not provision the unprivileged _apt sandbox user.
      # We are already inside the isolated VM; run apt helpers as root so gpgv can execute.
      apt-get -o APT::Sandbox::User=root update
      set -- $need
      apt-get -o APT::Sandbox::User=root install -y --no-install-recommends "$@"
      apt-get clean
      rm -rf /var/lib/apt/lists/*
    else
      echo "SETUP: unsupported package manager; cannot install:$need"
      exit 20
    fi
    for package in "$@"; do
      case "$package" in
        bash) command -v bash >/dev/null 2>&1 || exit 21 ;;
        python3) command -v python3 >/dev/null 2>&1 || exit 21 ;;
      esac
    done
    echo "SETUP: required guest tools installed successfully:$need"
  ' krun-setup "$@"
}

# 1. 运行时挂载点基座（镜像根是只读的，全部建在 tmpfs 上）
mount -t tmpfs tmpfs /run
mkdir -p /run/newroot /run/data

# 2. 合成根
if [ "$MODE" = rw ]; then
  # 数据层盘：宿主预格式化（raw 常规路径）或空白盘（qcow2 首次启动）时在 guest 内格式化
  if ! mount -t ext4 /dev/vda /run/data; then
    echo "SETUP: /dev/vda not formatted — mkfs in guest"
    if ! command -v mkfs.ext4 >/dev/null 2>&1 && ! command -v mke2fs >/dev/null 2>&1; then
      if ! ensure_guest_tools e2fsprogs; then
        echo "SETUP: cannot format the VM data disk; install e2fsprogs or use a preformatted disk"
        exit 1
      fi
    fi
    mkfs_tool="$(command -v mkfs.ext4 || command -v mke2fs || true)"
    if [ -z "$mkfs_tool" ]; then
      echo "SETUP: missing e2fsprogs; provide a rootfs with mkfs.ext4 or mke2fs for qcow2 first boot"
      exit 1
    fi
    "$mkfs_tool" -q /dev/vda
    mount -t ext4 /dev/vda /run/data
  fi
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

# Restore the validated extra share names; the path walk above reused positional args.
set -- $MOUNT_NAMES
# 5. Additional host shares: tags are validated by the host backend; mount RO in guest.
#    The virtiofs daemon also enforces RO at the host FUSE operation layer, so a guest
#    remount cannot make backing data writable (though this is not a general isolation boundary).
if [ "$#" -gt 0 ]; then
  mkdir -p /run/newroot/mnt/dsh-shares
  for name in "$@"; do
    mkdir -p "/run/newroot/mnt/dsh-shares/$name"
    mount -t virtiofs -o ro "$name" "/run/newroot/mnt/dsh-shares/$name"
  done
fi

# 6. Ensure tools needed by this VM image. Packages install to the writable overlay
#    (persisted in the workspace data disk), never into the host workspace or RO lower.
if [ "$MODE" = rw ]; then
  if ! ensure_guest_tools bash python3; then
    echo "SETUP: bash/python3 installation failed; file management or bash execution may be unavailable"
  fi
else
  if ! chroot /run/newroot /bin/sh -c 'command -v bash >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1'; then
    echo "SETUP: read-only session; missing bash/python3 will not be installed"
  fi
fi

# 7/8. 进入合成根：agent 模式常驻（VM 随 agent 退出而关机），否则执行一次性验证负载
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
