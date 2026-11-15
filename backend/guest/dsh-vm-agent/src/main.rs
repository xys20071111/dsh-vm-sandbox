//! dsh-vm-agent：guest 内代理。监听 AF_VSOCK（默认端口 42），每个连接一个 exec 会话。
//!
//! M0 协议（行分隔 JSON 请求 + 原始输出 + EXIT 行，M1 换成帧化协议）：
//!   请求：{"type":"exec","argv":["/bin/sh","-c","…"],"cwd":"/path","env":["K=V",…]}
//!   响应：子进程 stdout+stderr 合并直写连接；结束后一行 "EXIT:<code>"，随后关闭。
//!   请求：{"type":"exec2",…}（v2，stdout/stderr 分离）：先回一行
//!     {"ok":true,"stderr":"split"}，随后帧流 [tag u8][len u32 LE][payload]：
//!     tag 1=stdout、2=stderr、3=退出码（payload=十进制字符串）。stdout/stderr
//!     分离是官方拒绝分类（matchesSignature 只查 stderr）与拒绝标记/升级 UX 的前提。
//!   请求：{"type":"term","cwd":"/path","cols":N,"rows":M}（cols/rows 可省，默认 80x24）
//!     guest 内真实 PTY 双向桥接；窗口尺寸变化由宿主侧桥以内联 OSC 序列转达：
//!     输入流中的 ESC ] 7777 ; resize ; <cols> ; <rows> BEL 被扫描并应用
//!     TIOCSWINSZ（内核自动向前台进程组发 SIGWINCH），不写入 shell。
//!   启动参数 DSH_FORWARD_PORTS="hostVsockPort:guestPort,…"：监听额外 vsock 端口，
//!     连接中继到 guest 本机 TCP——网络 none 档下"零宿主端口占用 + 只暴露指定端口"
//!     的应用层代理（设计 §4.3）。
//!   请求：{"type":"ping"} → {"ok":true}
//!   请求：{"type":"stat"} → {"ok":true,"execConns":N,"termConns":M,"fwdConns":K}
//!     （活跃连接数；宿主侧空闲回收据此判断"无活动连接"，见设计 §7——
//!      run_in_background 长驻子进程/端口转发连接会让会话免于回收）

use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::io::{FromRawFd, RawFd};
use std::sync::atomic::{AtomicUsize, Ordering};

const AF_VSOCK: libc::c_int = 40;
const VMADDR_CID_ANY: u32 = 0xFFFF_FFFF;
const DEFAULT_PORT: u32 = 42;

static EXEC_CONNS: AtomicUsize = AtomicUsize::new(0);
static TERM_CONNS: AtomicUsize = AtomicUsize::new(0);
static FWD_CONNS: AtomicUsize = AtomicUsize::new(0);

/// 复制 fd 并置 CLOEXEC：agent 内部 fd 一律不落进 fork/exec 的子进程——
/// 否则后台存活子进程会替已结束的会话握住 vsock 连接，宿主 exec 客户端
/// 永远等不到 EOF（实测：nohup 后台循环令 exec 挂死）。
fn dup_cloexec(fd: RawFd) -> RawFd {
    let n = unsafe { libc::dup(fd) };
    if n >= 0 {
        unsafe { libc::fcntl(n, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    n
}

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    argv: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
    #[serde(default)]
    port: Option<u32>,
    #[serde(default)]
    target: Option<String>,
}

/// 终端会话：guest 内真实 PTY（posix_openpt），连接双向桥接到 master。
/// 初始尺寸取请求 cols/rows（默认 80x24）；后续尺寸变化由宿主桥以内联 OSC
/// 序列转达（见模块头注释），输入中继扫描后应用 TIOCSWINSZ。
fn handle_term(conn: RawFd, cwd: Option<String>, cols: Option<u16>, rows: Option<u16>) {
    unsafe {
        let master = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
        if master < 0 {
            return;
        }
        if libc::grantpt(master) != 0 || libc::unlockpt(master) != 0 {
            libc::close(master);
            return;
        }
        let mut name_buf = [0 as libc::c_char; 128];
        if libc::ptsname_r(master, name_buf.as_mut_ptr(), name_buf.len()) != 0 {
            libc::close(master);
            return;
        }
        let slave_path = std::ffi::CStr::from_ptr(name_buf.as_ptr()).to_owned();
        let slave = libc::open(slave_path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY);
        if slave < 0 {
            libc::close(master);
            return;
        }
        // 初始窗口尺寸
        let ws = libc::winsize {
            ws_row: rows.unwrap_or(24),
            ws_col: cols.unwrap_or(80),
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        libc::ioctl(master, libc::TIOCSWINSZ, &ws);

        let pid = libc::fork();
        if pid == 0 {
            libc::close(master);
            libc::setsid();
            libc::ioctl(slave, libc::TIOCSCTTY, 0 as libc::c_int);
            libc::dup2(slave, libc::STDIN_FILENO);
            libc::dup2(slave, libc::STDOUT_FILENO);
            libc::dup2(slave, libc::STDERR_FILENO);
            if slave > 2 {
                libc::close(slave);
            }
            if let Some(cwd) = &cwd {
                let c = std::ffi::CString::new(cwd.as_str()).unwrap_or_default();
                libc::chdir(c.as_ptr());
            }
            let prog = std::ffi::CString::new("/bin/sh").unwrap_or_default();
            let a0 = std::ffi::CString::new("-sh").unwrap_or_default();
            let mut argv_p = [a0.as_ptr(), std::ptr::null()];
            libc::execvp(prog.as_ptr(), argv_p.as_mut_ptr());
            libc::_exit(126);
        }
        libc::close(slave);

        // 输入：连接 → master（扫描内联 OSC resize）；输出：master → 连接
        // （各线程持有自己的 dup，conn 本体由调用方在线程收尾后关闭）
        let master_in = dup_cloexec(master);
        let conn_in = dup_cloexec(conn);
        let pid_for_thread = pid;
        let reader = std::thread::spawn(move || {
            let mut src = unsafe { std::fs::File::from_raw_fd(conn_in) };
            relay_input_with_resize(src, master_in);
            // 连接关闭：杀前台进程组（EOF 由关闭 master 写端表达）
            unsafe { libc::kill(-(pid_for_thread), libc::SIGTERM) };
        });
        let master_out = dup_cloexec(master);
        let conn_out = dup_cloexec(conn);
        let writer = std::thread::spawn(move || {
            let mut src = unsafe { std::fs::File::from_raw_fd(master_out) };
            let mut dst = unsafe { std::fs::File::from_raw_fd(conn_out) };
            let _ = std::io::copy(&mut src, &mut dst);
        });

        let mut status = 0 as libc::c_int;
        libc::waitpid(pid, &mut status, 0);
        libc::close(master);
        let _ = reader.join();
        let _ = writer.join();
        let code = if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else if libc::WIFSIGNALED(status) {
            128 + libc::WTERMSIG(status)
        } else {
            125
        };
        let _ = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)).write_all(format!("\nEXIT:{code}\n").as_bytes()) };
    }
}

fn vsock_listen(port: u32) -> RawFd {
    let fd = unsafe { libc::socket(AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    assert!(fd >= 0, "socket(AF_VSOCK) failed");
    let addr = libc::sockaddr_vm {
        svm_family: AF_VSOCK as libc::sa_family_t,
        svm_reserved1: 0,
        svm_port: port,
        svm_cid: VMADDR_CID_ANY,
        svm_zero: [0; 4],
    };
    let rc = unsafe {
        libc::bind(
            fd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    assert!(rc == 0, "bind(AF_VSOCK:{port}) failed");
    let rc = unsafe { libc::listen(fd, 64) };
    assert!(rc == 0, "listen failed");
    fd
}

/// 可失败的 vsock 监听（端口转发用：单档失败只影响该端口，不应带崩 agent）。
fn vsock_listen_opt(port: u32) -> Option<RawFd> {
    let fd = unsafe { libc::socket(AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return None;
    }
    let addr = libc::sockaddr_vm {
        svm_family: AF_VSOCK as libc::sa_family_t,
        svm_reserved1: 0,
        svm_port: port,
        svm_cid: VMADDR_CID_ANY,
        svm_zero: [0; 4],
    };
    let rc = unsafe {
        libc::bind(
            fd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        unsafe { libc::close(fd) };
        return None;
    }
    if unsafe { libc::listen(fd, 64) } != 0 {
        unsafe { libc::close(fd) };
        return None;
    }
    Some(fd)
}

/// 输入中继（term 通道）：普通字节透传至 master；扫描宿主桥内联的 OSC 7777
/// resize 序列（ESC ] 7777 ; resize ; <cols> ; <rows> BEL|ST）应用 TIOCSWINSZ
/// （内核自动向前台进程组派发 SIGWINCH），序列本身不落盘。不完整/不匹配的
/// ESC ] 前缀按原样透传；序列只由宿主侧桥生成，用户键入不可能构造出前缀。
fn relay_input_with_resize(mut src: std::fs::File, master: RawFd) {
    const PATTERN: &[u8] = b"\x1b]7777;resize;";
    let mut pending: Vec<u8> = Vec::new();
    let mut collecting: Option<Vec<u8>> = None;
    let mut buf = [0u8; 8192];
    loop {
        let n = src.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if let Some(acc) = collecting.as_mut() {
                // 收集 resize 参数直至 BEL / ST（ESC \）
                if b == 0x07 {
                    apply_resize(acc, master);
                    collecting = None;
                } else if acc.last() == Some(&0x1b) && b == b'\\' {
                    acc.pop();
                    apply_resize(acc, master);
                    collecting = None;
                } else {
                    acc.push(b);
                }
                continue;
            }
            pending.push(b);
            if pending == PATTERN {
                collecting = Some(Vec::new());
                pending.clear();
            } else if !PATTERN.starts_with(&pending) {
                let data = std::mem::take(&mut pending);
                if !write_fd(master, &data) {
                    return;
                }
            }
        }
        if collecting.is_none() && !pending.is_empty() && !PATTERN.starts_with(&pending) {
            let data = std::mem::take(&mut pending);
            if !write_fd(master, &data) {
                return;
            }
        }
    }
}

fn write_fd(fd: RawFd, data: &[u8]) -> bool {
    let mut off = 0usize;
    while off < data.len() {
        let w = unsafe { libc::write(fd, data[off..].as_ptr() as *const libc::c_void, data.len() - off) };
        if w <= 0 {
            return false;
        }
        off += w as usize;
    }
    true
}

fn apply_resize(acc: &[u8], master: RawFd) {
    let s = String::from_utf8_lossy(acc);
    let mut it = s.trim().split(';');
    if let (Some(c), Some(r)) = (
        it.next().and_then(|v| v.trim().parse::<u16>().ok()),
        it.next().and_then(|v| v.trim().parse::<u16>().ok()),
    ) {
        let ws = libc::winsize { ws_row: r, ws_col: c, ws_xpixel: 0, ws_ypixel: 0 };
        unsafe { libc::ioctl(master, libc::TIOCSWINSZ, &ws) };
    }
}

fn parse_ipv4(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut ip: u32 = 0;
    for p in parts {
        let v: u32 = p.parse().ok()?;
        if v > 255 {
            return None;
        }
        ip = (ip << 8) | v;
    }
    Some(ip)
}

/// 端口转发连接：vsock → guest 本机 TCP（应用层代理）。双向泵，EOF 侧尽力
/// shutdown 对端写方向以解除另一泵的阻塞；泄漏的泵只延迟空闲回收，不破坏会话。
fn handle_forward(conn: RawFd, target: String) {
    FWD_CONNS.fetch_add(1, Ordering::SeqCst);
    unsafe {
        let (ip_s, port_s) = match target.rsplit_once(':') {
            Some(x) => x,
            None => { FWD_CONNS.fetch_sub(1, Ordering::SeqCst); return; }
        };
        let (ip, port) = match (parse_ipv4(ip_s), port_s.parse::<u16>().ok()) {
            (Some(i), Some(p)) => (i, p),
            _ => { FWD_CONNS.fetch_sub(1, Ordering::SeqCst); return; }
        };
        let tcp = libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if tcp < 0 {
            FWD_CONNS.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let mut addr: libc::sockaddr_in = std::mem::zeroed();
        addr.sin_family = libc::AF_INET as libc::sa_family_t;
        addr.sin_port = port.to_be();
        addr.sin_addr.s_addr = ip.to_be();
        if libc::connect(
            tcp,
            &addr as *const libc::sockaddr_in as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        ) != 0 {
            libc::close(tcp);
            FWD_CONNS.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let conn_w = dup_cloexec(conn);
        let tcp_r = dup_cloexec(tcp);
        let tcp_w = dup_cloexec(tcp);
        let conn_r = dup_cloexec(conn);
        // 泵 1：conn → tcp（EOF：shutdown tcp 写方向）；泵 2：tcp → conn（EOF：shutdown conn 写方向，vsock 尽力而为）
        let p1 = std::thread::spawn(move || {
            pump(conn_r, tcp_w, true);
            unsafe { libc::close(tcp_w); libc::close(conn_r); }
        });
        let p2 = std::thread::spawn(move || {
            pump(tcp_r, conn_w, true);
            unsafe { libc::close(conn_w); libc::close(tcp_r); }
        });
        let _ = p1.join();
        let _ = p2.join();
        libc::close(tcp);
        FWD_CONNS.fetch_sub(1, Ordering::SeqCst);
    }
}

fn pump(src: RawFd, dst: RawFd, eof_shutdown_dst: bool) {
    let mut buf = [0u8; 16384];
    loop {
        let n = unsafe { libc::read(src, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n <= 0 {
            break;
        }
        if !write_fd(dst, &buf[..n as usize]) {
            break;
        }
    }
    if eof_shutdown_dst {
        unsafe { libc::shutdown(dst, libc::SHUT_WR) };
    }
}

/// 启动端口转发监听（DSH_FORWARD_PORTS="hostVsock:guestPort,…"，应用层代理）。
fn start_forward_listeners(spec: &str) {
    for item in spec.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let Some((vport, gport)) = item.split_once(':') else {
            eprintln!("dsh-vm-agent: bad forward spec {item:?}");
            continue;
        };
        let (Ok(vport), Ok(gport)) = (vport.parse::<u32>(), gport.parse::<u16>()) else {
            eprintln!("dsh-vm-agent: bad forward spec {item:?}");
            continue;
        };
        let Some(lfd) = vsock_listen_opt(vport) else {
            eprintln!("dsh-vm-agent: forward listen vsock:{vport} failed");
            continue;
        };
        let target = format!("127.0.0.1:{gport}");
        std::thread::spawn(move || {
            eprintln!("dsh-vm-agent: forward vsock:{vport} -> {target}");
            loop {
                let conn = unsafe { libc::accept4(lfd, std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
                if conn < 0 {
                    continue;
                }
                let target = target.clone();
                std::thread::spawn(move || {
                    handle_forward(conn, target);
                    unsafe { libc::close(conn) };
                });
            }
        });
    }
}

fn handle_conn(conn: RawFd) {
    // 读取请求行用 conn 的 dup（本副本随作用域关闭）；conn 本体留给会话中继
    let mut reader = BufReader::new(unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)) });
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let req: Request = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("{{\"ok\":false,\"err\":\"{e}\"}}\n");
            let _ = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)).write_all(msg.as_bytes()) };
            return;
        }
    };
    if req.r#type == "ping" {
        let _ = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)).write_all(b"{\"ok\":true}\n") };
        return;
    }
    if req.r#type == "stat" {
        let msg = format!(
            "{{\"ok\":true,\"execConns\":{},\"termConns\":{},\"fwdConns\":{}}}\n",
            EXEC_CONNS.load(Ordering::SeqCst),
            TERM_CONNS.load(Ordering::SeqCst),
            FWD_CONNS.load(Ordering::SeqCst)
        );
        let _ = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)).write_all(msg.as_bytes()) };
        return;
    }
    if req.r#type == "term" {
        TERM_CONNS.fetch_add(1, Ordering::SeqCst);
        handle_term(conn, req.cwd, req.cols, req.rows);
        TERM_CONNS.fetch_sub(1, Ordering::SeqCst);
        return;
    }
    if req.r#type == "exec2" {
        // v2：stdout/stderr 分离（帧协议）。旧客户端不受影响（仍走下方合并路径）。
        EXEC_CONNS.fetch_add(1, Ordering::SeqCst);
        handle_exec2(conn, &req);
        EXEC_CONNS.fetch_sub(1, Ordering::SeqCst);
        return;
    }
    if req.argv.is_empty() {
        let _ = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)).write_all(b"EXIT:125\n") };
        return;
    }

    EXEC_CONNS.fetch_add(1, Ordering::SeqCst);

    // stdout+stderr 合并的管道（M0 协议，保留给旧 exec 客户端）
    let mut pipe_fds = [0 as RawFd; 2];
    unsafe { libc::pipe2(pipe_fds.as_mut_ptr(), libc::O_CLOEXEC) };
    let (pipe_rd, pipe_wr) = (pipe_fds[0], pipe_fds[1]);

    // 环境构造（父进程完成全部分配；子进程 fork 后只做 syscall，规避多线程 setenv 死锁）
    let (env_cstrings, program_path) = build_exec_env(&req);
    let mut envp_p: Vec<*const libc::c_char> = env_cstrings.iter().map(|s| s.as_ptr()).collect();
    envp_p.push(std::ptr::null());

    // fork：子进程把管道接到 stdout/stderr，stdin 接 /dev/null，然后 exec
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        unsafe {
            libc::close(pipe_rd);
            libc::dup2(pipe_wr, libc::STDOUT_FILENO);
            libc::dup2(pipe_wr, libc::STDERR_FILENO);
            if pipe_wr > 2 {
                libc::close(pipe_wr);
            }
            let devnull = libc::open(b"/dev/null\0".as_ptr() as *const libc::c_char, libc::O_RDWR);
            if devnull >= 0 {
                libc::dup2(devnull, libc::STDIN_FILENO);
            }
            if let Some(cwd) = &req.cwd {
                let c = std::ffi::CString::new(cwd.as_str()).unwrap_or_default();
                libc::chdir(c.as_ptr());
            }
            let program = std::ffi::CString::new(program_path.as_str()).unwrap_or_default();
            let argv: Vec<std::ffi::CString> = req
                .argv
                .iter()
                .map(|s| std::ffi::CString::new(s.as_str()).unwrap_or_default())
                .collect();
            let mut argv_p: Vec<*const libc::c_char> = argv.iter().map(|s| s.as_ptr()).collect();
            argv_p.push(std::ptr::null());
            libc::execve(program.as_ptr(), argv_p.as_ptr(), envp_p.as_ptr());
            // exec 失败：向合并输出管道写诊断，再以 126 退出
            let msg = format!("dsh-vm-agent: exec {} failed (errno {})\n", req.argv[0], std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
            libc::write(libc::STDERR_FILENO, msg.as_ptr() as *const libc::c_void, msg.len());
            libc::_exit(126);
        }
    }

    // 父进程：关写端，中继管道 → 连接
    unsafe { libc::close(pipe_wr) };
    let mut out = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)) };
    let relay = std::thread::spawn(move || {
        let mut src = unsafe { std::fs::File::from_raw_fd(pipe_rd) };
        let _ = std::io::copy(&mut src, &mut out);
    });

    // 回收子进程，取退出码
    let mut status = 0 as libc::c_int;
    unsafe { libc::waitpid(pid, &mut status, 0) };
    let code = if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        125
    };

    let _ = relay.join();
    // relay 线程持有自己的 conn dup（随线程结束关闭）；EXIT 行另起一个 dup 写入
    let _ = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)).write_all(format!("\nEXIT:{code}\n").as_bytes()) };
    EXEC_CONNS.fetch_sub(1, Ordering::SeqCst);
}

/// 父进程完成全部 env/PATH 分配（fork 后子进程只做 syscall，规避多线程 setenv 死锁）：
/// 继承 agent 环境，req.env 的 K=V 覆盖（dsh-shell 契约的 DSH_* 快照透传由此生效）；
/// 裸名按最终环境的 PATH 查找（bash 工具传来的是裸名 'bash'）。调用方保证 argv 非空。
fn build_exec_env(req: &Request) -> (Vec<std::ffi::CString>, String) {
    let mut env_map: std::collections::HashMap<String, String> = std::env::vars().collect();
    for kv in &req.env {
        if let Some(eq) = kv.find('=') {
            env_map.insert(kv[..eq].to_string(), kv[eq + 1..].to_string());
        }
    }
    let env_cstrings: Vec<std::ffi::CString> = env_map
        .iter()
        .filter_map(|(k, v)| std::ffi::CString::new(format!("{k}={v}")).ok())
        .collect();
    let program_path = if req.argv[0].contains('/') {
        req.argv[0].clone()
    } else {
        let path = env_map.get("PATH").cloned().unwrap_or_default();
        let hit = path
            .split(':')
            .filter(|d| !d.is_empty())
            .map(|d| format!("{d}/{}", req.argv[0]))
            .find(|cand| {
                let c = std::ffi::CString::new(cand.as_str()).unwrap_or_default();
                unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
            });
        hit.unwrap_or_else(|| req.argv[0].clone()) // 无命中留给 exec 失败路径报诊断
    };
    (env_cstrings, program_path)
}

/// 帧写入：互斥下整帧一次 write_all（dup 副本随写入结束关闭，conn 本体由调用方管理）。
fn write_frame(conn: RawFd, lock: &std::sync::Mutex<()>, tag: u8, payload: &[u8]) {
    let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.push(tag);
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    let _ = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)).write_all(&buf) };
}

/// exec2：stdout/stderr 分离（帧协议，见模块头注释）。官方拒绝分类（matchesSignature）
/// 只查 stderr——合并流下 EROFS 永远判不出 denied，拒绝标记与升级 UX 失效，此为修复。
fn handle_exec2(conn: RawFd, req: &Request) {
    let _ = unsafe { std::fs::File::from_raw_fd(dup_cloexec(conn)).write_all(b"{\"ok\":true,\"stderr\":\"split\"}\n") };
    let lock = std::sync::Mutex::new(());
    if req.argv.is_empty() {
        write_frame(conn, &lock, 3, b"125");
        return;
    }

    let (env_cstrings, program_path) = build_exec_env(req);
    let mut envp_p: Vec<*const libc::c_char> = env_cstrings.iter().map(|s| s.as_ptr()).collect();
    envp_p.push(std::ptr::null());

    // 两条独立管道：stdout / stderr
    let mut op = [0 as RawFd; 2];
    let mut ep = [0 as RawFd; 2];
    unsafe {
        libc::pipe2(op.as_mut_ptr(), libc::O_CLOEXEC);
        libc::pipe2(ep.as_mut_ptr(), libc::O_CLOEXEC);
    }
    let (out_rd, out_wr) = (op[0], op[1]);
    let (err_rd, err_wr) = (ep[0], ep[1]);

    let pid = unsafe { libc::fork() };
    if pid == 0 {
        unsafe {
            libc::close(out_rd);
            libc::close(err_rd);
            libc::dup2(out_wr, libc::STDOUT_FILENO);
            libc::dup2(err_wr, libc::STDERR_FILENO);
            if out_wr > 2 {
                libc::close(out_wr);
            }
            if err_wr > 2 {
                libc::close(err_wr);
            }
            let devnull = libc::open(b"/dev/null\0".as_ptr() as *const libc::c_char, libc::O_RDWR);
            if devnull >= 0 {
                libc::dup2(devnull, libc::STDIN_FILENO);
            }
            if let Some(cwd) = &req.cwd {
                let c = std::ffi::CString::new(cwd.as_str()).unwrap_or_default();
                libc::chdir(c.as_ptr());
            }
            let program = std::ffi::CString::new(program_path.as_str()).unwrap_or_default();
            let argv: Vec<std::ffi::CString> = req
                .argv
                .iter()
                .map(|s| std::ffi::CString::new(s.as_str()).unwrap_or_default())
                .collect();
            let mut argv_p: Vec<*const libc::c_char> = argv.iter().map(|s| s.as_ptr()).collect();
            argv_p.push(std::ptr::null());
            libc::execve(program.as_ptr(), argv_p.as_ptr(), envp_p.as_ptr());
            // exec 失败：诊断走 stderr 帧
            let msg = format!("dsh-vm-agent: exec {} failed (errno {})\n", req.argv[0], std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
            libc::write(libc::STDERR_FILENO, msg.as_ptr() as *const libc::c_void, msg.len());
            libc::_exit(126);
        }
    }

    unsafe {
        libc::close(out_wr);
        libc::close(err_wr);
    }
    // scoped threads 借用本地 lock 排空两条管道；waitpid 与排空并行
    // （先排空后回收会因管道缓冲写满而互锁），全部完成后再写退出码帧。
    let code_cell = std::cell::Cell::new(125i32);
    std::thread::scope(|s| {
        let lk: &std::sync::Mutex<()> = &lock;
        for (rfd, tag) in [(out_rd, 1u8), (err_rd, 2u8)] {
            s.spawn(move || {
                let mut src = unsafe { std::fs::File::from_raw_fd(rfd) };
                let mut buf = [0u8; 8192];
                loop {
                    let n = src.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    write_frame(conn, lk, tag, &buf[..n]);
                }
            });
        }
        let mut status = 0 as libc::c_int;
        unsafe { libc::waitpid(pid, &mut status, 0) };
        let code = if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else if libc::WIFSIGNALED(status) {
            128 + libc::WTERMSIG(status)
        } else {
            125
        };
        code_cell.set(code);
    });
    let code = code_cell.get();
    // 退出码帧最后写（客户端据帧结束，不再扫描 EXIT 行）
    write_frame(conn, &lock, 3, format!("{code}").as_bytes());
}

fn main() {
    let port: u32 = std::env::var("DSH_AGENT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    if let Ok(spec) = std::env::var("DSH_FORWARD_PORTS") {
        start_forward_listeners(&spec);
    }
    let lfd = vsock_listen(port);
    eprintln!("dsh-vm-agent: listening on vsock:{port}");
    loop {
        let conn = unsafe { libc::accept4(lfd, std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
        if conn < 0 {
            continue;
        }
        std::thread::spawn(move || {
            handle_conn(conn);
            unsafe { libc::close(conn) };
        });
    }
}
