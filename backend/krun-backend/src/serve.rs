//! `serve` 守护进程：会话注册表 + 子进程监督（设计 §4.1）。
//!
//! 进程模型硬约束：`krun_start_enter` 在成功路径 exit() 整个进程 → 每 VM 一个独立
//! `boot` 子进程（本守护进程 spawn 并监督）。exec/终端/端口转发的数据面仍直连
//! agent.sock / fwd socket，不过守护进程。对插件暴露 UNIX socket 上的 JSON 行协议：
//!
//!   {"method":"ping"}                                → {"ok":true,"kind":"krun-backend-serve",…}
//!   {"method":"session.ensure","params":{key,ws,mode,image,vcpus,ram,network,
//!        dataImg?,dataFormat,agentSock,logPath,forwards:[{host,guest}],fingerprint}}
//!                                                    → {"ok":true,"key":…,"reused":bool,"agentSock":…}
//!     单飞（同 key 并发共享一次引导）；fingerprint 不匹配 → 停旧会话重启（配置漂移防线）。
//!   {"method":"session.stop","params":{key}}          → {"ok":true,"stopped":bool}
//!   {"method":"session.touch","params":{key}}         → {"ok":true}（confine 计活跃）
//!   {"method":"session.list"}                         → {"ok":true,"sessions":[…]}
//!   {"method":"session.gc","params":{idleMs}}         → {"ok":true,"stopped":[key,…]}
//!     超空闲会话先经 agent stat 探活跃连接（exec/term/fwd），有连接则刷新计时。
//!   {"method":"shutdown"}                             → {"ok":true,"shutdown":true} 后停全会话退出
//!
//! 生命周期：provider 首次 ensure 时 spawn（继承其 env，含 LD_LIBRARY_PATH → boot 子进程）；
//! 无客户端连接且无会话超过 IDLE_EXIT_MS 自动退出并清理 socket。boot 子进程经 PDEATHSIG
//! 绑定守护进程——守护进程死亡（含 dsh 崩溃沿进程树传播）回收全部 VM，无孤儿。

use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const VSOCK_FORWARD_BASE: u32 = 4200;
const IDLE_EXIT_MS: u128 = 60_000;
const AGENT_PING_INTERVAL_MS: u64 = 150;
const BOOT_DEADLINE: Duration = Duration::from_secs(30);

struct Forward {
    stop: Arc<AtomicBool>,
}

struct Session {
    key: String,
    ws: String,
    mode: String,
    image: String,
    fingerprint: String,
    child: Child,
    agent_sock: String,
    started_at: Instant,
    last_use: Instant,
    forwards: Vec<Forward>,
}

impl Session {
    fn stop_forwards(&mut self) {
        for f in &self.forwards {
            f.stop.store(true, Ordering::SeqCst);
        }
    }

    /// SIGTERM 停 VM 并关闭转发监听；短暂等待退出（VMM 关机亚秒级）。
    fn kill(&mut self) {
        self.stop_forwards();
        let _ = self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

type BootReply = std::sync::mpsc::Sender<Result<(Child, Vec<Forward>), String>>;

struct Registry {
    sessions: Mutex<HashMap<String, Session>>,
    in_flight: Mutex<HashSet<String>>,
    in_flight_cv: Condvar,
    /// boot spawner 的请求通道（长寿线程专职 spawn——PDEATHSIG 语义正确性）。
    spawn_tx: Mutex<std::sync::mpsc::Sender<(EnsureParams, BootReply)>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardParam {
    host: u16,
    guest: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureParams {
    key: String,
    ws: String,
    mode: String,
    image: String,
    vcpus: u8,
    ram: u32,
    #[serde(default)]
    network: String,
    #[serde(default)]
    data_img: Option<String>,
    #[serde(default)]
    data_format: String,
    agent_sock: String,
    log_path: String,
    #[serde(default)]
    forwards: Vec<ForwardParam>,
    fingerprint: String,
}

/// agent 就绪等待：ping/pong 为准（VMM 桥接 socket 在 guest agent 起来前即可连，
/// 见 qcow2 首启 mkfs 场景）。
fn wait_agent(sock_path: &str, deadline: Instant, child: &mut Child) -> Result<(), String> {
    loop {
        if Instant::now() >= deadline {
            return Err(format!("agent not ready within deadline: {sock_path}"));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("boot exited early: {status}"));
        }
        if agent_ping(sock_path) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(AGENT_PING_INTERVAL_MS));
    }
}

/// 单次 ping 探测（短连接）。
fn agent_ping(sock_path: &str) -> bool {
    let mut s = match UnixStream::connect(sock_path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    use std::io::Write;
    if std::io::Write::write_all(&mut s, b"{\"type\":\"ping\"}\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = std::io::Read::read(&mut s, &mut buf).unwrap_or(0);
    let text = std::str::from_utf8(&buf[..n]).unwrap_or("");
    text.contains("\"ok\":true")
}

/// agent stat：活跃连接计数（exec/term/fwd），空闲回收的"无活动连接"判据。
fn agent_stat(sock_path: &str) -> Option<(u64, u64, u64)> {
    let mut s = UnixStream::connect(sock_path).ok()?;
    use std::io::Write;
    std::io::Write::write_all(&mut s, b"{\"type\":\"stat\"}\n").ok()?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut s, &mut buf).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&buf).ok()?;
    Some((
        v["execConns"].as_u64()?,
        v["termConns"].as_u64()?,
        v["fwdConns"].as_u64()?,
    ))
}

fn build_boot_args(p: &EnsureParams) -> Vec<String> {
    let mut args = vec![
        "boot".to_string(),
        "--rootfs".into(),
        p.image.clone(),
        "--setup".into(),
        p.mode.clone(),
        "--ws-path".into(),
        p.ws.clone(),
        "--vcpus".into(),
        p.vcpus.to_string(),
        "--ram".into(),
        p.ram.to_string(),
        "--agent-sock".into(),
        p.agent_sock.clone(),
    ];
    if let Some(di) = &p.data_img {
        args.push("--data-img".into());
        args.push(di.clone());
        if p.data_format == "qcow2" {
            args.push("--data-format".into());
            args.push("qcow2".into());
        }
    }
    if p.network == "none" {
        args.push("--network".into());
        args.push("none".into());
    }
    for f in &p.forwards {
        args.push("--forward".into());
        args.push(format!("{}:{}", f.host, f.guest));
    }
    args
}

/// 启动端口转发监听（宿主 127.0.0.1:<host> → run/<key>.fwd<vsock> → agent → guest）。
/// 失败（端口占用等）返回 Err，由 ensure 整体失败（fail-closed）。
fn start_forwards(agent_sock: &str, forwards: &[ForwardParam]) -> Result<Vec<Forward>, String> {
    let mut out = Vec::new();
    for (i, f) in forwards.iter().enumerate() {
        let vsock_port = VSOCK_FORWARD_BASE + i as u32;
        let sock_path = format!("{agent_sock}.fwd{vsock_port}");
        let listener = TcpListener::bind(("127.0.0.1", f.host))
            .map_err(|e| format!("forward listen 127.0.0.1:{}: {e}", f.host))?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let sock_t = sock_path.clone();
        std::thread::spawn(move || {
            listener.set_nonblocking(true).ok();
            while !stop_t.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((conn, _)) => {
                        let sock_path = sock_t.clone();
                        std::thread::spawn(move || relay_tcp(conn, sock_path));
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        });
        out.push(Forward { stop });
    }
    Ok(out)
}

/// 单连接中继：宿主 TCP ↔ agent 转发 socket。双向泵 + EOF 侧 shutdown 对端写方向，
/// 两个方向都能把对端泵解锁（同 agent handle_forward 的模式）。
fn relay_tcp(conn: TcpStream, sock_path: String) {
    let up = match UnixStream::connect(&sock_path) {
        Ok(u) => u,
        Err(_) => return,
    };
    let conn_r = match conn.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let up_w = match up.try_clone() {
        Ok(u) => u,
        Err(_) => return,
    };
    let up_r = match up.try_clone() {
        Ok(u) => u,
        Err(_) => return,
    };
    let a = std::thread::spawn(move || {
        pump(conn_r, up_w);
        let _ = up.shutdown(Shutdown::Write);
    });
    pump(up_r, conn);
    let _ = a.join();
}

fn pump<R: std::io::Read, W: std::io::Write>(mut src: R, mut dst: W) {
    let mut buf = [0u8; 16384];
    loop {
        match src.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if dst.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = dst.flush();
}

fn session_summary(s: &Session) -> serde_json::Value {
    json!({
        "key": s.key,
        "ws": s.ws,
        "mode": s.mode,
        "image": s.image,
        "agentSock": s.agent_sock,
        "uptimeMs": s.started_at.elapsed().as_millis() as u64,
        "idleMs": s.last_use.elapsed().as_millis() as u64,
        "forwards": s.forwards.iter().map(|_| ()).count(),
    })
}

fn handle_conn(stream: UnixStream, registry: &Arc<Registry>, socket_path: &str, last_busy: &Arc<Mutex<Instant>>) {
    let mut reader = std::io::BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut writer = stream;
    let mut line = String::new();
    loop {
        line.clear();
        use std::io::BufRead;
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        *last_busy.lock().unwrap() = Instant::now();
        let (reply, shutdown) = dispatch(line, registry);
        if std::io::Write::write_all(&mut writer, format!("{reply}\n").as_bytes()).is_err() {
            return;
        }
        if shutdown {
            let _ = std::fs::remove_file(socket_path);
            std::process::exit(0);
        }
    }
}

fn dispatch(line: &str, registry: &Arc<Registry>) -> (String, bool) {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return (json!({"ok": false, "err": format!("bad request: {e}")}).to_string(), false),
    };
    let method = v["method"].as_str().unwrap_or("");
    let params = &v["params"];
    match method {
        "ping" => (
            json!({"ok": true, "kind": "krun-backend-serve", "version": env!("CARGO_PKG_VERSION")}).to_string(),
            false,
        ),
        "session.ensure" => match serde_json::from_value::<EnsureParams>(params.clone()) {
            Ok(p) => (session_ensure(registry, p), false),
            Err(e) => (json!({"ok": false, "err": format!("bad ensure params: {e}")}).to_string(), false),
        },
        "session.stop" => {
            let key = params["key"].as_str().unwrap_or("").to_string();
            let mut sessions = registry.sessions.lock().unwrap();
            let stopped = match sessions.remove(&key) {
                Some(mut s) => {
                    s.kill();
                    true
                }
                None => false,
            };
            (json!({"ok": true, "stopped": stopped}).to_string(), false)
        }
        "session.touch" => {
            let key = params["key"].as_str().unwrap_or("").to_string();
            let mut sessions = registry.sessions.lock().unwrap();
            if let Some(s) = sessions.get_mut(&key) {
                s.last_use = Instant::now();
            }
            (json!({"ok": true}).to_string(), false)
        }
        "session.list" => {
            let sessions = registry.sessions.lock().unwrap();
            let list: Vec<serde_json::Value> = sessions.values().map(session_summary).collect();
            (json!({"ok": true, "sessions": list}).to_string(), false)
        }
        "session.gc" => {
            let idle_ms = params["idleMs"].as_u64().unwrap_or(600_000) as u128;
            let candidates: Vec<(String, String)> = {
                let sessions = registry.sessions.lock().unwrap();
                sessions
                    .iter()
                    .filter(|(_, s)| s.last_use.elapsed().as_millis() > idle_ms)
                    .map(|(k, s)| (k.clone(), s.agent_sock.clone()))
                    .collect()
            };
            let mut stopped = Vec::new();
            for (key, sock) in candidates {
                let active = agent_stat(&sock).map(|(e, t, f)| e + t + f > 0).unwrap_or(false);
                let mut sessions = registry.sessions.lock().unwrap();
                if let Some(s) = sessions.get_mut(&key) {
                    if active {
                        s.last_use = Instant::now();
                    } else if let Some(mut s) = sessions.remove(&key) {
                        s.kill();
                        stopped.push(key);
                    }
                }
            }
            (json!({"ok": true, "stopped": stopped}).to_string(), false)
        }
        "shutdown" => {
            let mut sessions = registry.sessions.lock().unwrap();
            for (_, mut s) in sessions.drain() {
                s.kill();
            }
            (json!({"ok": true, "shutdown": true}).to_string(), true)
        }
        other => (json!({"ok": false, "err": format!("unknown method {other}")}).to_string(), false),
    }
}

fn session_ensure(registry: &Arc<Registry>, p: EnsureParams) -> String {
    // 单飞：同 key 并发共享一次引导
    {
        let mut inflight = registry.in_flight.lock().unwrap();
        while inflight.contains(&p.key) {
            inflight = registry.in_flight_cv.wait(inflight).unwrap();
        }
        let mut sessions = registry.sessions.lock().unwrap();
        if let Some(s) = sessions.get_mut(&p.key) {
            let alive = matches!(s.child.try_wait(), Ok(None));
            if alive && s.fingerprint == p.fingerprint {
                let summary = session_summary(s);
                return json!({"ok": true, "key": p.key, "reused": true, "agentSock": s.agent_sock, "session": summary}).to_string();
            }
            // 已退出（janitor 未及回收）或配置漂移：停旧启新
            if let Some(mut old) = sessions.remove(&p.key) {
                old.kill();
            }
        }
        inflight.insert(p.key.clone());
    }
    // 引导移交长寿 spawner 线程执行：PDEATHSIG 绑定守护进程生命而非发起连接的
    // 线程——连接断开（如客户端重连）不应连带杀掉已就绪的 VM。
    let (tx, rx) = std::sync::mpsc::channel();
    let key_for_reply = p.key.clone();
    let ws_for_reply = p.ws.clone();
    let mode_for_reply = p.mode.clone();
    let image_for_reply = p.image.clone();
    let fingerprint_for_reply = p.fingerprint.clone();
    let key_agent_sock = p.agent_sock.clone();
    let send_result = registry
        .spawn_tx
        .lock()
        .unwrap()
        .send((p, tx))
        .is_ok();
    let result = rx.recv().unwrap_or_else(|_| Err("spawner dropped".into()));
    let _ = send_result;
    {
        let mut inflight = registry.in_flight.lock().unwrap();
        inflight.remove(&key_for_reply);
        registry.in_flight_cv.notify_all();
    }
    match result {
        Ok((child, forwards)) => {
            let mut sessions = registry.sessions.lock().unwrap();
            let session = Session {
                key: key_for_reply.clone(),
                ws: ws_for_reply,
                mode: mode_for_reply,
                image: image_for_reply,
                fingerprint: fingerprint_for_reply,
                child,
                agent_sock: key_agent_sock.clone(),
                started_at: Instant::now(),
                last_use: Instant::now(),
                forwards,
            };
            let summary = session_summary(&session);
            sessions.insert(key_for_reply.clone(), session);
            json!({"ok": true, "key": key_for_reply, "reused": false, "agentSock": key_agent_sock, "session": summary}).to_string()
        }
        Err(e) => json!({"ok": false, "err": e}).to_string(),
    }
}

fn boot_session(p: &EnsureParams) -> Result<(Child, Vec<Forward>), String> {
    // 关键：VMM 对 listen 模式 vsock port 绑定已存在 socket 文件会 EEXIST（VM 退出不清理）
    let _ = std::fs::remove_file(&p.agent_sock);
    for i in 0..p.forwards.len() {
        let _ = std::fs::remove_file(format!("{}.fwd{}", p.agent_sock, VSOCK_FORWARD_BASE + i as u32));
    }
    if let Some(parent) = std::path::Path::new(&p.log_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // agent.sock 与数据盘的父目录（provider 不再预建；run/ 由首启 VMM 绑定需要）
    if let Some(parent) = std::path::Path::new(&p.agent_sock).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Some(di) = &p.data_img {
        if let Some(parent) = std::path::Path::new(di).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p.log_path)
        .map_err(|e| format!("open log {}: {e}", p.log_path))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut child = Command::new(exe)
        .args(build_boot_args(p))
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("spawn boot: {e}"))?;
    let deadline = Instant::now() + BOOT_DEADLINE;
    if let Err(e) = wait_agent(&p.agent_sock, deadline, &mut child) {
        let _ = child.kill();
        return Err(e);
    }
    let forwards = match start_forwards(&p.agent_sock, &p.forwards) {
        Ok(f) => f,
        Err(e) => {
            let _ = child.kill();
            return Err(e);
        }
    };
    Ok((child, forwards))
}

pub fn run(socket: &str) -> ! {
    // 已有存活守护进程（另一客户端刚起）→ 静默退出；否则清陈旧 socket 后绑定
    if daemon_ping(socket) {
        std::process::exit(0);
    }
    let _ = std::fs::remove_file(socket);
    if let Some(parent) = std::path::Path::new(socket).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = match UnixListener::bind(socket) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("krun-backend serve: bind {socket}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("krun-backend serve: listening on {socket}");
    // boot spawner：长寿线程专职 spawn boot 子进程（PDEATHSIG 语义正确性，见 session_ensure）
    let (spawn_tx, spawn_rx) =
        std::sync::mpsc::channel::<(EnsureParams, std::sync::mpsc::Sender<Result<(Child, Vec<Forward>), String>>)>();
    {
        std::thread::spawn(move || {
            for (p, reply_tx) in spawn_rx {
                let result = boot_session(&p);
                let _ = reply_tx.send(result);
            }
        });
    }
    let registry = Arc::new(Registry {
        sessions: Mutex::new(HashMap::new()),
        in_flight: Mutex::new(HashSet::new()),
        in_flight_cv: Condvar::new(),
        spawn_tx: Mutex::new(spawn_tx),
    });
    let clients = Arc::new(AtomicUsize::new(0));
    let last_busy = Arc::new(Mutex::new(Instant::now()));
    // janitor：回收退出子进程（崩溃监督）+ 空闲退出（无客户端且无会话）
    {
        let registry = registry.clone();
        let clients = clients.clone();
        let last_busy = last_busy.clone();
        let socket = socket.to_string();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let mut sessions = registry.sessions.lock().unwrap();
            let mut dead = Vec::new();
            for (k, s) in sessions.iter_mut() {
                if matches!(s.child.try_wait(), Ok(Some(_))) {
                    dead.push(k.clone());
                }
            }
            for k in &dead {
                if let Some(mut s) = sessions.remove(k) {
                    s.stop_forwards();
                }
            }
            drop(sessions);
            let idle = clients.load(Ordering::SeqCst) == 0
                && registry.sessions.lock().unwrap().is_empty()
                && last_busy.lock().unwrap().elapsed().as_millis() > IDLE_EXIT_MS;
            if idle {
                let _ = std::fs::remove_file(&socket);
                std::process::exit(0);
            }
        });
    }
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        clients.fetch_add(1, Ordering::SeqCst);
        *last_busy.lock().unwrap() = Instant::now();
        let registry = registry.clone();
        let clients = clients.clone();
        let last_busy = last_busy.clone();
        let socket = socket.to_string();
        std::thread::spawn(move || {
            handle_conn(stream, &registry, &socket, &last_busy);
            clients.fetch_sub(1, Ordering::SeqCst);
        });
    }
    std::process::exit(0)
}

/// 守护进程存活探测（ping 协议）。
fn daemon_ping(socket: &str) -> bool {
    let mut s = match UnixStream::connect(socket) {
        Ok(s) => s,
        Err(_) => return false,
    };
    use std::io::Write;
    if std::io::Write::write_all(&mut s, b"{\"method\":\"ping\"}\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    let n = std::io::Read::read(&mut s, &mut buf).unwrap_or(0);
    n > 0 && buf[..n].windows(4).any(|w| w == b"\"ok\"")
}
