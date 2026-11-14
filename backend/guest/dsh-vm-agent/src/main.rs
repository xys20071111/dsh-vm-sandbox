//! dsh-vm-agent：guest 内代理。监听 AF_VSOCK（默认端口 42），每个连接一个 exec 会话。
//!
//! M0 协议（行分隔 JSON 请求 + 原始输出 + EXIT 行，M1 换成帧化协议）：
//!   请求：{"type":"exec","argv":["/bin/sh","-c","…"],"cwd":"/path","env":["K=V",…]}
//!   响应：子进程 stdout+stderr 合并直写连接；结束后一行 "EXIT:<code>"，随后关闭。
//!   请求：{"type":"ping"} → {"ok":true}

use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::io::{FromRawFd, RawFd};

const AF_VSOCK: libc::c_int = 40;
const VMADDR_CID_ANY: u32 = 0xFFFF_FFFF;
const DEFAULT_PORT: u32 = 42;

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
}

/// 终端会话：guest 内真实 PTY（posix_openpt），连接双向桥接到 master。
/// v1：固定 80x24；信号由宿主侧经 PTY 输入控制字符（0x03 等）由行规程派发。
fn handle_term(conn: RawFd, cwd: Option<String>) {
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
        // 默认窗口尺寸
        let ws = libc::winsize { ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0 };
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

        // 输入：连接 → master；输出：master → 连接（各线程持有自己的 dup，
        // conn 本体由调用方在线程收尾后关闭）
        let master_in = libc::dup(master);
        let conn_in = libc::dup(conn);
        let pid_for_thread = pid;
        let reader = std::thread::spawn(move || {
            let mut src = unsafe { std::fs::File::from_raw_fd(conn_in) };
            let mut dst = unsafe { std::fs::File::from_raw_fd(master_in) };
            let _ = std::io::copy(&mut src, &mut dst);
            // 连接关闭：杀前台进程组（EOF 由关闭 master 写端表达）
            unsafe { libc::kill(-(pid_for_thread), libc::SIGTERM) };
        });
        let master_out = libc::dup(master);
        let conn_out = libc::dup(conn);
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
        let _ = unsafe { std::fs::File::from_raw_fd(libc::dup(conn)).write_all(format!("\nEXIT:{code}\n").as_bytes()) };
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

fn handle_conn(conn: RawFd) {
    // 读取请求行用 conn 的 dup（本副本随作用域关闭）；conn 本体留给会话中继
    let mut reader = BufReader::new(unsafe { std::fs::File::from_raw_fd(libc::dup(conn)) });
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let req: Request = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("{{\"ok\":false,\"err\":\"{e}\"}}\n");
            let _ = unsafe { std::fs::File::from_raw_fd(libc::dup(conn)).write_all(msg.as_bytes()) };
            return;
        }
    };
    if req.r#type == "ping" {
        let _ = unsafe { std::fs::File::from_raw_fd(libc::dup(conn)).write_all(b"{\"ok\":true}\n") };
        return;
    }
    if req.r#type == "term" {
        handle_term(conn, req.cwd);
        return;
    }
    if req.argv.is_empty() {
        let _ = unsafe { std::fs::File::from_raw_fd(libc::dup(conn)).write_all(b"EXIT:125\n") };
        return;
    }

    // stdout+stderr 合并的管道
    let mut pipe_fds = [0 as RawFd; 2];
    unsafe { libc::pipe(pipe_fds.as_mut_ptr()) };
    let (pipe_rd, pipe_wr) = (pipe_fds[0], pipe_fds[1]);

    // 环境构造（父进程完成全部分配；子进程 fork 后只做 syscall，规避多线程 setenv 死锁）：
    // 继承 agent 环境，req.env 的 K=V 覆盖（dsh-shell 契约的 DSH_* 快照透传由此生效）。
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
    let mut envp_p: Vec<*const libc::c_char> = env_cstrings.iter().map(|s| s.as_ptr()).collect();
    envp_p.push(std::ptr::null());

    // PATH 解析（父进程）：裸名按最终环境的 PATH 查找（bash 工具传来的是裸名 'bash'）
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
        match hit {
            Some(p) => p,
            None => req.argv[0].clone(), // 留给 exec 失败路径报诊断
        }
    };

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
    let mut out = unsafe { std::fs::File::from_raw_fd(libc::dup(conn)) };
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
    let _ = unsafe { std::fs::File::from_raw_fd(libc::dup(conn)).write_all(format!("\nEXIT:{code}\n").as_bytes()) };
}

fn main() {
    let port: u32 = std::env::var("DSH_AGENT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let lfd = vsock_listen(port);
    eprintln!("dsh-vm-agent: listening on vsock:{port}");
    loop {
        let conn = unsafe { libc::accept(lfd, std::ptr::null_mut(), std::ptr::null_mut()) };
        if conn < 0 {
            continue;
        }
        std::thread::spawn(move || {
            handle_conn(conn);
            unsafe { libc::close(conn) };
        });
    }
}
