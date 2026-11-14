//! libkrun 直接依赖的进程内 API 包装（无 dlopen、无手写绑定）。
//!
//! 调用约定要点（源自 vendor/libkrun/src/libkrun/src/lib.rs，2026-11-14 核实）：
//! - `krun_set_exec` 的 args 数组**不含 argv[0]**：程序名走 exec_path 参数，
//!   C 示例 chroot_vm 传的是 `&guest_argv[1]`；多传程序名会让 guest 内 shell 把
//!   程序名当脚本文件，报 "syntax error: unexpected word"。
//! - argv/envp/port_map 数组按 **MAX_ARGS=4096 定长切片**读取（`collapse_str_array`
//!   在 NULL 处截断并当场复制字符串），本包装分配满长 NULL 填充数组以避免
//!   `from_raw_parts` 越界切片的 UB 边界。
//! - 字符串在每次调用内即被复制，无需为 start_enter 保活。

use std::ffi::{c_char, CString};

const MAX_ARGS: usize = 4096;

pub const KRUN_DISK_FORMAT_RAW: u32 = 0;
pub const KRUN_DISK_FORMAT_QCOW2: u32 = 1;
pub const KRUN_SYNC_RELAXED: u32 = 1;
pub const KRUN_SEMANTICS_LINUX_SIMPLIFIED: u32 = 1;
pub const KRUN_FEATURE_NET: u64 = 0;
pub const KRUN_FEATURE_BLK: u64 = 1;
pub const KRUN_FEATURE_INIT_BLOB: u64 = 11;

fn check(rc: i32, what: &str) -> Result<(), String> {
    if rc < 0 {
        Err(format!("{what}: {rc}"))
    } else {
        Ok(())
    }
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|e| format!("interior NUL in string argument: {e}"))
}

/// NULL 结尾且满长（MAX_ARGS）NULL 填充的指针数组。
fn padded_ptr_array(items: &[CString]) -> Vec<*const c_char> {
    let mut v: Vec<*const c_char> = items.iter().map(|s| s.as_ptr()).collect();
    v.push(std::ptr::null());
    v.resize(MAX_ARGS, std::ptr::null());
    v
}

pub fn set_log_level(level: u32) -> Result<(), String> {
    check(unsafe { krun::krun_set_log_level(level) }, "set_log_level")
}

pub fn create_ctx() -> Result<u32, String> {
    let r = unsafe { krun::krun_create_ctx() };
    if r < 0 {
        Err(format!("create_ctx: {r}"))
    } else {
        Ok(r as u32)
    }
}

pub fn free_ctx(ctx: u32) -> Result<(), String> {
    check(unsafe { krun::krun_free_ctx(ctx) }, "free_ctx")
}

pub fn set_vm_config(ctx: u32, vcpus: u8, ram_mib: u32) -> Result<(), String> {
    check(unsafe { krun::krun_set_vm_config(ctx, vcpus, ram_mib) }, "set_vm_config")
}

pub fn set_root(ctx: u32, root_path: &str) -> Result<(), String> {
    let p = cstr(root_path)?;
    check(unsafe { krun::krun_set_root(ctx, p.as_ptr()) }, "set_root")
}

pub fn add_virtiofs(ctx: u32, tag: &str, path: &str, shm: u64, read_only: bool, semantics: u32) -> Result<(), String> {
    let t = cstr(tag)?;
    let p = cstr(path)?;
    check(unsafe { krun::krun_add_virtiofs4(ctx, t.as_ptr(), p.as_ptr(), shm, read_only, semantics) }, "add_virtiofs")
}

pub fn add_disk(ctx: u32, block_id: &str, disk_path: &str, format: u32, read_only: bool, direct_io: bool, sync_mode: u32) -> Result<(), String> {
    let id = cstr(block_id)?;
    let p = cstr(disk_path)?;
    check(unsafe { krun::krun_add_disk3(ctx, id.as_ptr(), p.as_ptr(), format, read_only, direct_io, sync_mode) }, "add_disk")
}

pub fn fs_add_overlay_file(ctx: u32, fs_tag: &str, path: &str, data: &[u8], mode: u32, one_shot: bool) -> Result<(), String> {
    let t = cstr(fs_tag)?;
    let p = cstr(path)?;
    check(
        unsafe { krun::krun_fs_add_overlay_file(ctx, t.as_ptr(), p.as_ptr(), data.as_ptr(), data.len(), mode, one_shot) },
        "fs_add_overlay_file",
    )
}

pub fn add_vsock_port(ctx: u32, port: u32, filepath: &str, listen: bool) -> Result<(), String> {
    let p = cstr(filepath)?;
    check(unsafe { krun::krun_add_vsock_port2(ctx, port, p.as_ptr(), listen) }, "add_vsock_port")
}

pub fn set_port_map(ctx: u32, entries: &[&str]) -> Result<(), String> {
    let cs: Vec<CString> = entries.iter().map(|s| cstr(s)).collect::<Result<_, _>>()?;
    let ptrs = padded_ptr_array(&cs);
    check(unsafe { krun::krun_set_port_map(ctx, ptrs.as_ptr()) }, "set_port_map")
}

pub fn set_console_output(ctx: u32, filepath: &str) -> Result<(), String> {
    let p = cstr(filepath)?;
    check(unsafe { krun::krun_set_console_output(ctx, p.as_ptr()) }, "set_console_output")
}

/// args **不含程序名**（见模块注释）；exec_path 是 guest 内的可执行文件路径。
pub fn set_exec(ctx: u32, exec_path: &str, args: &[&str], envp: &[&str]) -> Result<(), String> {
    let exec = cstr(exec_path)?;
    let argv_c: Vec<CString> = args.iter().map(|s| cstr(s)).collect::<Result<_, _>>()?;
    let envp_c: Vec<CString> = envp.iter().map(|s| cstr(s)).collect::<Result<_, _>>()?;
    let argv = padded_ptr_array(&argv_c);
    let env = padded_ptr_array(&envp_c);
    check(
        unsafe { krun::krun_set_exec(ctx, exec.as_ptr(), argv.as_ptr(), env.as_ptr()) },
        "set_exec",
    )
}

/// 阻塞直至 VM 关闭；成功路径下 libkrun 在 FFI 内部以工作负载退出码 exit() 进程
/// （因此每会话必须独立子进程运行）。
pub fn start_enter(ctx: u32) -> Result<i32, String> {
    let r = unsafe { krun::krun_start_enter(ctx) };
    if r < 0 {
        Err(format!("start_enter: {r}"))
    } else {
        Ok(r)
    }
}

pub fn has_feature(feature: u64) -> Result<i32, String> {
    let r = unsafe { krun::krun_has_feature(feature) };
    if r < 0 {
        Err(format!("has_feature({feature}): {r}"))
    } else {
        Ok(r)
    }
}

pub fn get_max_vcpus() -> Result<i32, String> {
    let r = unsafe { krun::krun_get_max_vcpus() };
    if r < 0 {
        Err(format!("get_max_vcpus: {r}"))
    } else {
        Ok(r)
    }
}

pub fn disable_implicit_vsock(ctx: u32) -> Result<(), String> {
    check(unsafe { krun::krun_disable_implicit_vsock(ctx) }, "disable_implicit_vsock")
}

pub fn add_vsock(ctx: u32, tsi_features: u32) -> Result<(), String> {
    check(unsafe { krun::krun_add_vsock(ctx, tsi_features) }, "add_vsock")
}
