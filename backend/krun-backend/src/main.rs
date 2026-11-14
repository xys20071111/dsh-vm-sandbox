//! krun-backend：DSH krun 沙盒的 VM 运行时守护进程。
//!
//! 子命令：
//! - `probe`                     检查 libkrun 特性（INIT_BLOB/NET/BLK）与 /dev/kvm
//! - `boot`                      引导对齐冒烟：等价官方 chroot_vm 示例（进程随工作负载退出）
//! - `serve --socket <path>`     守护进程模式（UNIX socket 上的 JSON 行协议；方法集后续里程碑实现）

mod api;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::ExitCode;

fn usage() -> ! {
    eprintln!("usage: krun-backend <probe|boot|exec|serve> [options]");
    eprintln!("  probe");
    eprintln!("  boot --rootfs <p> [--console <f>] [--vcpus <n>] [--ram <mib>] [--agent-sock <p>] [--setup ro|rw] [--ws-path <p>] [--data-img <p>] [--network tsi|none] [--port-map host:guest] -- <command...>");
    eprintln!("  exec --socket <p> [--cwd <d>] -- <argv...>");
    eprintln!("  serve --socket <path>");
    std::process::exit(2);
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("probe") => cmd_probe(),
        Some("boot") => cmd_boot(&args[1..]),
        Some("exec") => cmd_exec(&args[1..]),
        Some("serve") => cmd_serve(&args[1..]),
        _ => usage(),
    }
}

/// exec 客户端：直连会话的 agent socket（VMM 监听桥接到 guest vsock），不过守护进程。
/// 输出为子进程 stdout+stderr 合并流，末行 "EXIT:<code>"；本进程以该码退出。
fn cmd_exec(args: &[String]) -> ExitCode {
    let mut socket = None;
    let mut cwd: Option<String> = None;
    let mut envs: Vec<String> = Vec::new();
    let mut argv: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--socket" => { socket = Some(args.get(i + 1).expect("--socket needs a value").clone()); i += 2; }
            "--cwd" => { cwd = Some(args.get(i + 1).expect("--cwd needs a value").clone()); i += 2; }
            "--env" => { envs.push(args.get(i + 1).expect("--env needs a value").clone()); i += 2; }
            "--" => { argv = args[i + 1..].to_vec(); break; }
            other => { eprintln!("exec: unknown option {other}"); usage(); }
        }
    }
    let socket = socket.unwrap_or_else(|| { eprintln!("exec: --socket is required"); usage(); });
    if argv.is_empty() { eprintln!("exec: argv after -- is required"); usage(); }

    let mut stream = std::os::unix::net::UnixStream::connect(&socket)
        .unwrap_or_else(|e| { eprintln!("exec: connect {socket}: {e}"); std::process::exit(1); });
    let req = serde_json::json!({ "type": "exec", "argv": argv, "cwd": cwd, "env": envs });
    writeln!(stream, "{req}").expect("send request");

    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut stream, &mut out).expect("read agent stream");
    let marker = b"\nEXIT:";
    let (output, code) = match out.windows(marker.len()).rposition(|w| w == marker) {
        Some(pos) => {
            let code_str = String::from_utf8_lossy(&out[pos + marker.len()..])
                .trim().trim_end_matches('\n').to_string();
            (out[..pos + 1].to_vec(), code_str.trim().parse::<i32>().unwrap_or(125))
        }
        None => (out, 125), // 代理异常：无 EXIT 行
    };
    let _ = std::io::stdout().write_all(&output);
    if code < 0 { ExitCode::FAILURE } else { ExitCode::from(code as u8) }
}

fn cmd_probe() -> ExitCode {
    api::set_log_level(1).ok();
    let kvm = std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm").is_ok();
    println!("libkrun: linked in-process");
    println!(
        "features: net={} blk={} init_blob={}",
        api::has_feature(api::KRUN_FEATURE_NET).unwrap_or(-1),
        api::has_feature(api::KRUN_FEATURE_BLK).unwrap_or(-1),
        api::has_feature(api::KRUN_FEATURE_INIT_BLOB).unwrap_or(-1)
    );
    println!("max_vcpus: {}", api::get_max_vcpus().unwrap_or(-1));
    println!("/dev/kvm: {kvm}");
    if kvm { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// 与官方 chroot_vm 示例对齐的引导冒烟。
/// 命令行约定：`boot -- -- <program> <args...>`；exec_path = program，
/// set_exec 的 args **不含程序名**（libkrun 的 argv 约定，见 api.rs）。
/// 成功路径下 libkrun 在 FFI 内部 exit() 本进程，本函数只在启动前出错时返回。
/// 确保稀疏 ext4 数据盘存在：缺失则创建并格式化（优先用提取的 mke2fs，宿主 PATH 兜底）。
fn ensure_ext4_data_img(img: &std::path::Path, size_mib: u64) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    if !img.exists() {
        let mut f = std::fs::File::create(img).map_err(|e| e.to_string())?;
        f.set_len(size_mib * 1024 * 1024).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    // ext 超级块魔数 0xEF53 位于偏移 1080
    let mut f = std::fs::File::open(img).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(1080)).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 2];
    f.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if magic == [0x53, 0xEF] {
        return Ok(()); // 已格式化
    }
    drop(f);
    let home = std::env::var("HOME").unwrap_or_default();
    let mke2fs = std::env::var("KRUN_MKE2FS")
        .unwrap_or_else(|_| format!("{home}/opt/e2fsprogs/usr/sbin/mke2fs"));
    let libdir = format!("{home}/opt/e2fsprogs/usr/lib/x86_64-linux-gnu");
    let status = std::process::Command::new(&mke2fs)
        .env("LD_LIBRARY_PATH", &libdir)
        .args(["-F", "-q", "-t", "ext4", "-m", "0"])
        .arg(img)
        .status()
        .map_err(|e| format!("spawn {mke2fs}: {e}"))?;
    if !status.success() {
        return Err(format!("mke2fs failed: {status}"));
    }
    Ok(())
}

fn cmd_boot(args: &[String]) -> ExitCode {
    let mut rootfs = None;
    let mut console = None;
    let mut vcpus = 2u8;
    let mut ram = 1024u32;
    let mut setup_mode: Option<String> = None; // Some("ro"|"rw") 时走 guest 内编排路径
    let mut setup_script = String::from("setup.sh");
    let mut ws_path: Option<String> = None;
    let mut data_img: Option<String> = None;
    let mut agent_sock: Option<String> = None;
    let mut port_map: Vec<String> = Vec::new();
    let mut network = String::from("tsi");
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--rootfs" => { rootfs = Some(args.get(i + 1).expect("--rootfs needs a value").clone()); i += 2; }
            "--console" => { console = Some(args.get(i + 1).expect("--console needs a value").clone()); i += 2; }
            "--vcpus" => { vcpus = args.get(i + 1).expect("--vcpus needs a value").parse().expect("--vcpus must be a number"); i += 2; }
            "--ram" => { ram = args.get(i + 1).expect("--ram needs a value").parse().expect("--ram must be a number"); i += 2; }
            "--setup" => { setup_mode = Some(args.get(i + 1).expect("--setup needs a value").clone()); i += 2; }
            "--setup-script" => { setup_script = args.get(i + 1).expect("--setup-script needs a value").clone(); i += 2; }
            "--ws-path" => { ws_path = Some(args.get(i + 1).expect("--ws-path needs a value").clone()); i += 2; }
            "--data-img" => { data_img = Some(args.get(i + 1).expect("--data-img needs a value").clone()); i += 2; }
            "--agent-sock" => { agent_sock = Some(args.get(i + 1).expect("--agent-sock needs a value").clone()); i += 2; }
            "--port-map" => { port_map.push(args.get(i + 1).expect("--port-map needs a value").clone()); i += 2; }
            "--network" => { network = args.get(i + 1).expect("--network needs a value").clone(); i += 2; }
            "--" => { rest = args[i + 1..].to_vec(); break; }
            other => { eprintln!("boot: unknown option {other}"); usage(); }
        }
    }
    let rootfs = rootfs.unwrap_or_else(|| { eprintln!("boot: --rootfs is required"); usage(); });

    api::set_log_level(3).expect("set_log_level");
    let ctx = api::create_ctx().expect("create_ctx");
    api::set_vm_config(ctx, vcpus, ram).expect("set_vm_config");

    // 网络档位（设计 §4.3）：
    //   tsi（默认）—— 不加 net 设备，libkrun 隐式启用 TSI；guest 监听端口自动绑宿主同号端口。
    //   none —— 显式 Explicit{tsi_flags=0}：vsock 设备保留（agent 控制通道不受影响），
    //           关闭 TSI INET 劫持 → guest 无宿主网络、宿主零端口占用。注意 1.19.x 的
    //           port_map 是改名映射而非白名单，未命中的端口仍按原端口绑宿主，因此
    //           "只暴露指定端口"需要 none 档 + 应用层代理，此处不混用。
    if network == "none" {
        api::disable_implicit_vsock(ctx).expect("disable_implicit_vsock");
        api::add_vsock(ctx, 0).expect("add_vsock (tsi off)");
    } else if network != "tsi" {
        eprintln!("boot: unknown network mode {network} (expected tsi|none)");
        usage();
    }

    if let Some(mode) = &setup_mode {
        // 编排路径：镜像根走只读 virtiofs（KRUN_FS_ROOT_TAG）。
        // 编排脚本由镜像创建时烤入 rootfs（/dsh-setup）；overlay-file 注入机制对
        // root passthrough 的读取路径有内容服务问题（见设计文档附录 C），暂不使用。
        api::add_virtiofs(ctx, "/dev/root", &rootfs, 0, true, api::KRUN_SEMANTICS_LINUX_SIMPLIFIED)
            .expect("add_virtiofs root (ro)");
        let ws = ws_path.clone().unwrap_or_else(|| { eprintln!("boot: --ws-path is required with --setup"); usage(); });
        let ws_ro = mode == "ro";
        api::add_virtiofs(ctx, "workspace", &ws, 0, ws_ro, api::KRUN_SEMANTICS_LINUX_SIMPLIFIED)
            .expect("add_virtiofs workspace");
        if let Some(di) = &data_img {
            // 数据层 = ext4 稀疏盘（virtio-blk）：overlayfs-on-ext4 是内核经典支持路径。
            // virtiofs 目录作 upper 在内核 overlayfs workdir 创建处有 EACCES 摩擦（见附录 C）。
            ensure_ext4_data_img(std::path::Path::new(di), 8192).expect("ensure data img");
            api::add_disk(ctx, "data", di, api::KRUN_DISK_FORMAT_RAW, false, false, api::KRUN_SYNC_RELAXED)
                .expect("add_disk data");
        }
        if let Some(sock) = &agent_sock {
            // 控制通道：VMM 监听该 UNIX socket，每个连接桥接为 guest 内 vsock 连接。
            // 失败时干净退出（stderr 带原因），让 provider 的 waitForAgent 超时路径
            // 带上日志定位，而不是 panic。
            if let Err(err) = api::add_vsock_port(ctx, 42, sock, true) {
                eprintln!("krun-backend: add_vsock_port agent: {err}");
                std::process::exit(1);
            }
        }
        if !port_map.is_empty() {
            // 显式端口映射（"host:guest"）；空数组/未指定 = libkrun 自动暴露 guest 监听端口
            let refs: Vec<&str> = port_map.iter().map(String::as_str).collect();
            if let Err(err) = api::set_port_map(ctx, &refs) {
                eprintln!("krun-backend: set_port_map: {err}");
                std::process::exit(1);
            }
        }
        let mut args_refs: Vec<&str> = vec!["/dsh-setup", mode, ws.as_str()];
        if agent_sock.is_some() {
            args_refs.push("agent");
        }
        let envp = vec!["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "TERM=xterm-256color"];
        api::set_exec(ctx, "/bin/sh", &args_refs, &envp).expect("set_exec");
        eprintln!("booting (setup mode={mode} agent={}) rootfs={rootfs} ws={ws} data-img={data_img:?} ...", agent_sock.is_some());
    } else {
        api::set_root(ctx, &rootfs).expect("set_root");
        if let Some(c) = &console {
            api::set_console_output(ctx, c).expect("set_console_output");
        }
        if rest.is_empty() { eprintln!("boot: workload command after -- is required"); usage(); }
        let (exec, workload_args) = rest.split_first().expect("non-empty rest");
        // 显式最小 env，避免宿主环境泄入 guest。
        let envp = vec![
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME=/root",
            "TERM=xterm-256color",
        ];
        let args_refs: Vec<&str> = workload_args.iter().map(String::as_str).collect();
        api::set_exec(ctx, exec, &args_refs, &envp).expect("set_exec");
        eprintln!("booting rootfs={rootfs} vcpus={vcpus} ram={ram}MiB exec={exec} args={workload_args:?}...");
    }
    let rc = api::start_enter(ctx).expect("start_enter");
    eprintln!("start_enter returned {rc} (only reachable on pre-start errors)");
    ExitCode::SUCCESS
}

/// 守护进程骨架：绑定 UNIX socket，逐行读取 JSON 请求。M0.2 只回显/探活，
/// 方法集（session.ensure/stop/list、terminal.open）在后续里程碑实现。
fn cmd_serve(args: &[String]) -> ExitCode {
    let mut socket = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--socket" => { socket = Some(args.get(i + 1).expect("--socket needs a value").clone()); i += 2; }
            other => { eprintln!("serve: unknown option {other}"); usage(); }
        }
    }
    let socket = socket.unwrap_or_else(|| { eprintln!("serve: --socket is required"); usage(); });

    let _ = std::fs::remove_file(&socket); // 清理陈旧 socket
    let listener = UnixListener::bind(&socket).expect("bind control socket");
    eprintln!("krun-backend serve: listening on {socket}");
    for stream in listener.incoming() {
        let mut stream = match stream { Ok(s) => s, Err(e) => { eprintln!("accept: {e}"); continue; } };
        let mut reader = BufReader::new(stream.try_clone().expect("try_clone"));
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() { continue; }
        let reply = if line.contains("\"ping\"") {
            "{\"ok\":true,\"result\":{\"version\":\"0.1.0\",\"kind\":\"krun-backend\"}}"
        } else {
            "{\"ok\":false,\"err\":\"not_implemented\"}"
        };
        let _ = writeln!(stream, "{reply}");
    }
    ExitCode::SUCCESS
}
