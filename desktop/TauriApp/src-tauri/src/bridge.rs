use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{Endpoint, Phase, ShellState, StatusPayload, Summary};

const POLL: Duration = Duration::from_millis(3_000);
/// How long a freshly spawned bridge gets before its control panel must answer.
const START_BUDGET: Duration = Duration::from_secs(30);
/// How long a previously healthy bridge gets to come back before a replacement is spawned.
const REATTACH_BUDGET: Duration = Duration::from_secs(15);
/// How long the failure screen waits before trying again on its own.
const FAILURE_BACKOFF: Duration = Duration::from_secs(5);

/* ── path discovery ───────────────────────────────────────────────────────── */

/// Mirrors findProjectRoot() in the bridge's src/config.ts: walk up from the executable
/// (or BRIDGE_PROJECT_ROOT) until a directory containing web/index.html appears.
fn find_project_root() -> Option<PathBuf> {
    if let Ok(root) = env::var("BRIDGE_PROJECT_ROOT") {
        let root = root.trim();
        if !root.is_empty() {
            let path = PathBuf::from(root);
            return path.join("web").join("index.html").is_file().then_some(path);
        }
    }

    let exe_dir = env::current_exe().ok()?.parent()?.to_path_buf();
    let mut starts = vec![exe_dir];
    if let Ok(cwd) = env::current_dir() {
        starts.push(cwd);
    }
    if cfg!(target_os = "linux") {
        starts.push(PathBuf::from("/usr/share/discord-audio-bridge"));
    }
    for start in starts {
        let mut dir: Option<&Path> = Some(&start);
        for _ in 0..8 {
            let current = match dir {
                Some(d) => d,
                None => break,
            };
            if current.join("web").join("index.html").is_file() {
                return Some(current.to_path_buf());
            }
            dir = current.parent();
        }
    }
    None
}

/// Mirrors runtimeRoot() in the bridge's src/config.ts: the project root when writable,
/// otherwise the per-user state directory a read-only install uses.
fn runtime_root() -> PathBuf {
    if let Ok(root) = env::var("BRIDGE_RUNTIME_ROOT") {
        let root = root.trim();
        if !root.is_empty() {
            return PathBuf::from(root);
        }
    }
    if let Some(project) = find_project_root() {
        if is_writable(&project) {
            return project;
        }
    }
    user_state_dir()
}

/// Where the bridge's persistent log lives, for the tray's "Open logs folder" action.
pub fn bridge_logs_dir() -> PathBuf {
    runtime_root().join("logs")
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".dab-app-write-probe");
    let ok = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&probe)
        .is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

fn user_state_dir() -> PathBuf {
    let base = if cfg!(target_os = "linux") {
        dirs::state_dir().or_else(|| dirs::home_dir().map(|h| h.join(".local/state")))
    } else {
        dirs::data_dir().or_else(|| dirs::home_dir())
    };
    base.expect("no home or state directory to keep runtime files in")
        .join("discord-audio-bridge")
}

/* ── endpoint discovery ───────────────────────────────────────────────────── */

/// Read and validate `.control-token`, then prove the bridge behind it answers with a
/// snapshot - the same contract as findRunningControlPanel() in src/control/launcher.ts.
/// A stale file after a crash is normal and simply means "not attachable".
fn probe_saved_endpoint(agent: &ureq::Agent) -> Option<Endpoint> {
    let path = runtime_root().join(".control-token");
    let raw = fs::read_to_string(path).ok()?;
    let saved: Value = serde_json::from_str(&raw).ok()?;
    let port = saved.get("port")?.as_u64()?;
    if !(1..=u64::from(u16::MAX)).contains(&port) {
        return None;
    }
    let token = saved.get("token")?.as_str()?;
    if token.len() < 24
        || token.len() > 256
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }

    let endpoint = Endpoint { port: port as u16, token: token.into() };
    let mut response = agent
        .get(&endpoint.state_url())
        .header("Authorization", &format!("Bearer {}", endpoint.token))
        .call()
        .ok()?;
    let body: Value = response.body_mut().read_json().ok()?;
    body.get("bot").is_some().then_some(endpoint)
}

/* ── spawning ─────────────────────────────────────────────────────────────── */

fn spawn_bridge(app: &AppHandle) -> Result<Child, String> {
    // Development checkout: run the TypeScript entry with Node, exactly like npm start
    // and the WinForms shell do. BRIDGE_PROJECT_ROOT points at the sibling checkout.
    if let Some(root) = find_project_root() {
        if root.join("src").join("index.ts").is_file() {
            let node = resolve_node().ok_or(
                "found the discord-audio-bridge checkout but no Node.js on PATH \
(Node 22.18+ is required to run the bridge from source)",
            )?;
            return start_child(app, &node, &[root.join("src").join("index.ts")], &root);
        }
    }

    // Packaged layout: the bridge executable sits in a bridge/ folder next to this app.
    let name = if cfg!(windows) { "discord-audio-bridge.exe" } else { "discord-audio-bridge" };
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .ok_or("cannot locate this application's own directory")?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(path) = env::var("BRIDGE_EXECUTABLE") {
        let path = PathBuf::from(path.trim());
        if !path.as_os_str().is_empty() {
            candidates.push(path);
        }
    }
    candidates.push(exe_dir.join("bridge").join(name));
    candidates.push(exe_dir.join(name));
    for candidate in &candidates {
        if candidate.is_file() {
            let cwd = candidate.parent().unwrap_or(Path::new(".")).to_path_buf();
            return start_child(app, candidate, &[], &cwd);
        }
    }

    Err(concat!(
        "no bridge to launch. Point BRIDGE_PROJECT_ROOT at a discord-audio-bridge checkout, ",
        "or put the packaged bridge executable in a bridge/ folder beside this app ",
        "(or set BRIDGE_EXECUTABLE).",
    )
    .into())
}

/// Resolve Node from PATH, mirroring BotProcess.ResolveNode() in the main repository:
/// absolute PATH hits only, so a stray executable cannot shadow the real interpreter.
fn resolve_node() -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn start_child(app: &AppHandle, program: &Path, args: &[PathBuf], cwd: &Path) -> Result<Child, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;

    // Both pipes must be drained or the child blocks once its output buffer fills. Lines are
    // kept in a short ring buffer so the failure screen can show why a start went wrong.
    if let Some(stdout) = child.stdout.take() {
        drain_pipe(app, stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        drain_pipe(app, stderr);
    }

    #[cfg(windows)]
    {
        // A kill-on-close job means the bridge can never outlive this shell, even if it crashes.
        if let Err(e) = crate::winjob::kill_on_close(&child) {
            eprintln!("could not attach bridge to a kill-on-close job: {e}");
        }
    }

    Ok(child)
}

/// Drain a child output pipe on its own thread, keeping lines in the shell's log ring buffer.
/// ChildStdout and ChildStderr are distinct types, so this is generic over Read + Send.
fn drain_pipe(app: &AppHandle, pipe: impl std::io::Read + Send + 'static) {
    let app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let state = app.state::<ShellState>();
            let mut inner = state.0.lock().unwrap();
            inner.push_log(&line);
        }
    });
}

/* ── supervision ──────────────────────────────────────────────────────────── */

/// One supervision thread lives for the whole app lifetime. It attaches to an already
/// running bridge if there is one, starts a child only when nothing answers, and keeps
/// the tray in step once attached. This is the WinForms shell's BotProcess lifecycle,
/// restated for two platforms.
pub fn supervise(app: AppHandle) {
    loop {
        if is_quitting(&app) {
            return;
        }

        // 1. A bridge that already answers wins: attaching never collides with npm start.
        if let Some(endpoint) = probe_saved_endpoint(&agent(&app)) {
            if run_attached(&app, endpoint) {
                return;
            }
            continue;
        }

        // 2. Nothing answered. If the bridge is merely restarting, give it a moment
        //    rather than spawning a duplicate on top of it.
        set_phase(&app, Phase::Locating, "looking for a running bridge");
        if let Some(endpoint) = wait_for_endpoint(&app, REATTACH_BUDGET) {
            if run_attached(&app, endpoint) {
                return;
            }
            continue;
        }

        // 3. Still nothing. If we already own a live child, it is still starting - never
        //    spawn a second copy alongside it.
        let owns_live_child = {
            let state = app.state::<ShellState>();
            let mut inner = state.0.lock().unwrap();
            inner
                .child
                .as_mut()
                .is_some_and(|c| c.try_wait().is_ok_and(|s| s.is_none()))
        };
        if owns_live_child {
            set_phase(&app, Phase::Starting, "waiting for the bridge control panel");
            if let Some(endpoint) = wait_for_endpoint(&app, START_BUDGET) {
                if run_attached(&app, endpoint) {
                    return;
                }
            }
            thread::sleep(POLL);
            continue;
        }

        // 4. No bridge anywhere: start one.
        set_phase(&app, Phase::Starting, "starting the bridge");
        match spawn_bridge(&app) {
            Ok(child) => {
                {
                    let state = app.state::<ShellState>();
                    let mut inner = state.0.lock().unwrap();
                    inner.logs.clear();
                    inner.child = Some(child);
                }
                if let Some(endpoint) = wait_for_endpoint(&app, START_BUDGET) {
                    if run_attached(&app, endpoint) {
                        return;
                    }
                    continue;
                }
                set_phase(
                    &app,
                    Phase::Failed,
                    "the bridge started but never exposed its control panel (is DISCORD_TOKEN set?)",
                );
            }
            Err(detail) => {
                set_phase(&app, Phase::Failed, &detail);
            }
        }

        // 5. After a failure, wait quietly before trying again, unless the user retries first.
        let deadline = Instant::now() + FAILURE_BACKOFF;
        while Instant::now() < deadline {
            if is_quitting(&app) {
                return;
            }
            if wants_retry(&app) {
                clear_retry(&app);
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
}

/// Poll the saved endpoint until the bridge answers, or the deadline passes.
fn wait_for_endpoint(app: &AppHandle, budget: Duration) -> Option<Endpoint> {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if is_quitting(app) {
            return None;
        }
        if let Some(endpoint) = probe_saved_endpoint(&agent(app)) {
            return Some(endpoint);
        }
        thread::sleep(Duration::from_millis(500));
    }
    None
}

/// Returns true when the app is quitting (caller should stop), false when the bridge went away.
fn run_attached(app: &AppHandle, endpoint: Endpoint) -> bool {
    {
        let state = app.state::<ShellState>();
        let mut inner = state.0.lock().unwrap();
        inner.endpoint = Some(endpoint.clone());
        inner.phase = Phase::Attached;
        inner.detail = String::new();
    }
    emit_status(app);
    navigate(app, &endpoint.panel_url());
    app.emit("bridge://ready", endpoint.panel_url()).ok();

    let mut missed = 0u32;
    loop {
        thread::sleep(POLL);
        if is_quitting(app) {
            return true;
        }

        match read_summary(&agent(app), &endpoint) {
            Ok(summary) => {
                missed = 0;
                {
                    let state = app.state::<ShellState>();
                    state.0.lock().unwrap().summary = summary;
                }
                crate::tray::refresh(app);
            }
            Err(_) => {
                missed += 1;
                if missed >= 5 {
                    // Sustained silence: either the bridge died or it is restarting.
                    set_phase(app, Phase::Locating, "the bridge stopped answering; looking for it");
                    return false;
                }
            }
        }
    }
}

/// The subset of GET /api/state the tray needs - same fields BridgeClient.cs reads.
pub fn read_summary(agent: &ureq::Agent, endpoint: &Endpoint) -> Result<Summary, ureq::Error> {
    let mut response = agent
        .get(&endpoint.state_url())
        .header("Authorization", &format!("Bearer {}", endpoint.token))
        .call()?;
    let body: Value = response.body_mut().read_json()?;

    let ready = body
        .pointer("/bot/ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut summary = Summary { ready, ..Summary::default() };

    if let Some(playing) = body.get("nowPlaying").filter(|v| v.is_object()) {
        let title = playing.get("title").and_then(Value::as_str).unwrap_or("");
        let artist = playing.get("artist").and_then(Value::as_str).unwrap_or("");
        if !title.trim().is_empty() {
            summary.track = Some(if artist.trim().is_empty() {
                title.to_string()
            } else {
                format!("{artist} - {title}")
            });
        }
    }

    let sessions = body
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(first) = sessions.first() else {
        return Ok(summary);
    };

    summary.streaming = true;
    summary.guild_id = first.get("guildId").and_then(Value::as_str).map(str::to_string);
    summary.muted = first.get("muted").and_then(Value::as_bool).unwrap_or(false);

    let labels: Vec<String> = first
        .get("sources")
        .and_then(Value::as_array)
        .map(|sources| {
            sources
                .iter()
                .filter_map(|s| s.get("label").and_then(Value::as_str))
                .filter(|l| !l.trim().is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    summary.label = (!labels.is_empty()).then(|| labels.join(" + "));
    if summary.label.is_none() {
        summary.label = first
            .pointer("/source/label")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    Ok(summary)
}

/* ── actions from tray and hotkeys ────────────────────────────────────────── */

pub fn toggle_mute(app: &AppHandle) {
    let (endpoint, summary) = {
        let state = app.state::<ShellState>();
        let inner = state.0.lock().unwrap();
        (inner.endpoint.clone(), inner.summary.clone())
    };
    let Some(endpoint) = endpoint else { return };
    let Some(guild_id) = summary.guild_id.clone() else { return };
    let body = serde_json::json!({ "guildId": guild_id, "muted": !summary.muted });
    let _ = agent(app)
        .post(&endpoint.api_url("mute"))
        .header("Authorization", &format!("Bearer {}", endpoint.token))
        .send_json(&body);
}

pub fn stop_stream(app: &AppHandle) {
    let (endpoint, summary) = {
        let state = app.state::<ShellState>();
        let inner = state.0.lock().unwrap();
        (inner.endpoint.clone(), inner.summary.clone())
    };
    let Some(endpoint) = endpoint else { return };
    let Some(guild_id) = summary.guild_id else { return };
    let body = serde_json::json!({ "guildId": guild_id });
    let _ = agent(app)
        .post(&endpoint.api_url("stop"))
        .header("Authorization", &format!("Bearer {}", endpoint.token))
        .send_json(&body);
}

pub fn quit(app: &AppHandle) {
    {
        let state = app.state::<ShellState>();
        let mut inner = state.0.lock().unwrap();
        inner.quitting = true;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    app.exit(0);
}

/* ── small helpers ────────────────────────────────────────────────────────── */

fn agent(app: &AppHandle) -> ureq::Agent {
    let state = app.state::<ShellState>();
    let inner = state.0.lock().unwrap();
    inner.agent.clone()
}

fn is_quitting(app: &AppHandle) -> bool {
    let state = app.state::<ShellState>();
    let inner = state.0.lock().unwrap();
    inner.quitting
}

fn wants_retry(app: &AppHandle) -> bool {
    let state = app.state::<ShellState>();
    let inner = state.0.lock().unwrap();
    inner.retry
}

pub fn clear_retry(app: &AppHandle) {
    let state = app.state::<ShellState>();
    state.0.lock().unwrap().retry = false;
}

pub fn set_phase(app: &AppHandle, phase: Phase, detail: &str) {
    {
        let state = app.state::<ShellState>();
        let mut inner = state.0.lock().unwrap();
        inner.phase = phase;
        inner.detail = detail.to_string();
        if phase == Phase::Failed || phase == Phase::Locating {
            inner.endpoint = None;
        }
    }
    emit_status(app);
}

pub fn emit_status(app: &AppHandle) {
    let payload = {
        let state = app.state::<ShellState>();
        let inner = state.0.lock().unwrap();
        StatusPayload {
            phase: inner.phase,
            detail: inner.detail.clone(),
            panel_url: inner.endpoint.as_ref().map(|e| e.panel_url()),
        }
    };
    app.emit("bridge://status", payload).ok();
}

/// Navigate the main webview to an absolute URL. The URL is JSON-encoded so no quoting
/// surprises are possible; the only pages this touches are the shell's own loader and the
/// bridge's own loopback panel.
pub fn navigate(app: &AppHandle, url: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(encoded) = serde_json::to_string(url) {
            let _ = window.eval(&format!("location.replace({encoded})"));
        }
    }
}

/// Go back to the loader screen after the webview has moved on to the panel.
pub fn navigate_home(app: &AppHandle) {
    let home = {
        let state = app.state::<ShellState>();
        let inner = state.0.lock().unwrap();
        inner.home_url.clone()
    };
    if let Some(home) = home {
        navigate(app, &home);
    }
}
