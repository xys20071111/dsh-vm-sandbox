// M0.1 引导冒烟：koffi 直调 libkrun C API，启动 Alpine rootfs。
// 工作负载退出后 VMM 会在 FFI 调用内部 exit() 整个进程——这是 libkrun 1.x 的预期行为。
// 验收：/tmp/krun-m0-console.log 出现 M0-BOOT-OK。
import fs from 'node:fs';
import koffi from 'koffi';

const LIB = process.env.KRUN_LIB ?? `${process.env.HOME}/opt/libkrun/lib/libkrun.so.1`;
const ROOTFS = process.env.KRUN_ROOTFS ?? `${process.env.HOME}/opt/krun-m0/images/alpine/rootfs`;
const CONSOLE = process.env.KRUN_CONSOLE ?? '/tmp/krun-m0-console.log';

const log = (msg) => fs.writeSync(1, `${msg}\n`);
const err = (msg) => fs.writeSync(2, `${msg}\n`);
const fail = (name, rc) => {
  if (rc < 0) {
    err(`${name} failed: ${rc}`);
    process.exit(1);
  }
};

const lib = koffi.load(LIB);
log(`loaded ${LIB}`);

// 关键：libkrun C API 借用字符串/数组指针直到 VM 启动（部分甚至整个 VM 生命周期）。
// koffi 的 JS 字符串临时缓冲在调用返回后被回收，必须在 JS 侧持有持久 C 内存。
const CharPtrPtr = koffi.pointer('const char *');
const KEPT = []; // 防 GC：所有传给 libkrun 的持久内存引用
// libkrun 借用指针直到 krun_start_enter 才序列化配置，全部用持久 Buffer + 显式地址。
const cstr = (s) => {
  const b = Buffer.from(`${s}\0`, 'utf8');
  KEPT.push(b);
  return b;
};
// char*[]：持久 Buffer 内写入 8 字节元素地址 + NULL 结尾（koffi 数组编组会产生调用后即失效的临时内存，不可用）
const cptrArray = (bufs) => {
  const arr = Buffer.alloc(8 * (bufs.length + 1));
  bufs.forEach((b, i) => arr.writeBigUInt64LE(koffi.address(b), i * 8));
  KEPT.push(arr);
  return arr;
};

const krun_set_log_level = lib.func('krun_set_log_level', 'int32_t', ['uint32_t']);
const krun_create_ctx = lib.func('krun_create_ctx', 'int32_t', []);
const krun_set_vm_config = lib.func('krun_set_vm_config', 'int32_t', ['uint32_t', 'uint8_t', 'uint32_t']);
const krun_set_root = lib.func('krun_set_root', 'int32_t', ['uint32_t', 'const char *']);
const krun_set_console_output = lib.func('krun_set_console_output', 'int32_t', ['uint32_t', 'const char *']);
const krun_set_exec = lib.func('krun_set_exec', 'int32_t', ['uint32_t', 'const char *', CharPtrPtr, CharPtrPtr]);
const krun_start_enter = lib.func('krun_start_enter', 'int32_t', ['uint32_t']);

fail('set_log_level', krun_set_log_level(3));
const ctx = krun_create_ctx();
fail('create_ctx', ctx);
log(`ctx = ${ctx}`);

let rc;
rc = krun_set_vm_config(ctx, 2, 1024); log(`set_vm_config rc=${rc}`); fail('set_vm_config', rc);
rc = krun_set_root(ctx, cstr(ROOTFS)); log(`set_root rc=${rc}`); fail('set_root', rc);
rc = krun_set_console_output(ctx, cstr(CONSOLE)); log(`set_console_output rc=${rc}`); fail('set_console_output', rc);

const argv = cptrArray([cstr('/bin/sh'), cstr('-c'), cstr('uname -a && id && head -2 /etc/os-release && echo M0-BOOT-OK')]);
const envp = cptrArray([cstr('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'), cstr('HOME=/root'), cstr('TERM=xterm-256color')]);
rc = krun_set_exec(ctx, cstr('/bin/sh'), argv, envp); log(`set_exec rc=${rc}`); fail('set_exec', rc);

log('booting VM (workload exit will exit() this process from inside libkrun)...');
rc = krun_start_enter(ctx);
// 只有启动前出错才会走到这里；正常路径下 libkrun 已 exit() 进程。
err(`start_enter returned ${rc}`);
process.exit(rc < 0 ? 1 : 0);
