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
/// Start attempts before the supervisor stops auto-retrying and waits for the user.
const MAX_START_ATTEMPTS: u32 = 3;

/* ── path discovery ───────────────────────────────────────────────────────── */

/// Directory that contains the packaged bridge executable + web/ assets, when this shell
/// was built with the bridge-payload resource bundle. On Windows that sits next to the
/// app exe; on Linux deb/rpm/AppImage it lives under Tauri's resource dir
/// (`/usr/lib/<exe>/bridge` or `$APPDIR/usr/lib/<exe>/bridge`).
fn bundled_bridge_root(app: Option<&AppHandle>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(app) = app {
        if let Ok(dir) = app.path().resource_dir() {
            candidates.push(dir.join("bridge"));
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bridge"));
            // Linux installers put resources under /usr/lib/<name>/, while the binary
            // itself is in /usr/bin/. Tauri's resource_dir() uses the exe basename, but the
            // deb/rpm bundler historically copies resources under productName - try both.
            if cfg!(target_os = "linux") {
                if let Some(name) = exe.file_name() {
                    candidates.push(PathBuf::from("/usr/lib").join(name).join("bridge"));
                }
                candidates.push(PathBuf::from("/usr/lib/Discord Audio Bridge/bridge"));
                candidates.push(PathBuf::from("/usr/lib/Discord Audio Bridge App/bridge"));
                if let Ok(appdir) = env::var("APPDIR") {
                    let appdir = appdir.trim();
                    if !appdir.is_empty() {
                        let appdir = PathBuf::from(appdir);
                        if let Some(name) = exe.file_name() {
                            candidates.push(appdir.join("usr/lib").join(name).join("bridge"));
                        }
                        candidates.push(appdir.join("usr/lib/Discord Audio Bridge/bridge"));
                        candidates.push(appdir.join("usr/lib/Discord Audio Bridge App/bridge"));
                    }
                }
            }
        }
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("web").join("index.html").is_file())
}

/// Mirrors findProjectRoot() in the bridge's src/config.ts: walk up from the executable
/// (or BRIDGE_PROJECT_ROOT) until a directory containing web/index.html appears.
fn find_project_root(app: Option<&AppHandle>) -> Option<PathBuf> {
    if let Ok(root) = env::var("BRIDGE_PROJECT_ROOT") {
        let root = root.trim();
        if !root.is_empty() {
            let path = PathBuf::from(root);
            return path.join("web").join("index.html").is_file().then_some(path);
        }
    }

    if let Some(bundled) = bundled_bridge_root(app) {
        return Some(bundled);
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
fn runtime_root(app: Option<&AppHandle>) -> PathBuf {
    if let Ok(root) = env::var("BRIDGE_RUNTIME_ROOT") {
        let root = root.trim();
        if !root.is_empty() {
            return PathBuf::from(root);
        }
    }
    if let Some(project) = find_project_root(app) {
        if is_writable(&project) {
            return project;
        }
    }
    user_state_dir()
}

/// Where the bridge's persistent log lives, for the tray's "Open logs folder" action.
/// Prefers a logs directory that actually exists among the candidate roots.
pub fn bridge_logs_dir(app: &AppHandle) -> PathBuf {
    for root in control_token_candidates(Some(app)) {
        let logs = root.join("logs");
        if logs.is_dir() {
            return logs;
        }
    }
    user_state_dir().join("logs")
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

/// Every place a running bridge may have written its `.control-token`. The bridge writes
/// the file into ITS runtime root, which differs by how it was started: a checkout run
/// via npm start uses the project dir, a packaged install uses the per-user state dir.
/// Probing only one of those is why the shell used to spawn a duplicate bridge on top of
/// a perfectly healthy system install.
fn control_token_candidates(app: Option<&AppHandle>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(root) = env::var("BRIDGE_RUNTIME_ROOT") {
        let root = root.trim();
        if !root.is_empty() {
            roots.push(PathBuf::from(root));
        }
    }
    // Prefer the writable runtime root the shell itself would choose - that is where
    // save_setup wrote .env and where a spawned bridge writes .control-token.
    roots.push(runtime_root(app));
    if let Some(project) = find_project_root(app) {
        roots.push(project);
    }
    roots.push(user_state_dir());
    let mut seen = std::collections::HashSet::new();
    roots.retain(|r| seen.insert(r.clone()));
    roots
}

/// Read and validate a `.control-token`, then prove the bridge behind it answers with a
/// snapshot - the same contract as findRunningControlPanel() in src/control/launcher.ts.
/// A stale file after a crash is normal and simply means "not attachable" for that root.
fn probe_token_file(agent: &ureq::Agent, path: &Path) -> Option<Endpoint> {
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

/// Try every candidate runtime root. A stale `.control-token` in an earlier root must not
/// hide a live bridge whose token lives somewhere else (project dir vs per-user state dir).
fn probe_saved_endpoint(app: &AppHandle, agent: &ureq::Agent) -> Option<Endpoint> {
    control_token_candidates(Some(app))
        .into_iter()
        .map(|root| root.join(".control-token"))
        .filter(|path| path.is_file())
        .find_map(|path| probe_token_file(agent, &path))
}

/* ── first-run setup ──────────────────────────────────────────────────────── */

/// A value that survives a plain KEY=VALUE .env line without quoting games: no whitespace,
/// no quotes, no backslash, no comment marker. Written with unicode escapes so no tool in
/// the pipeline can mangle the literals again.
fn savable(value: &str) -> bool {
    !value.chars().any(char::is_whitespace)
        && !value.contains('\u{22}')
        && !value.contains('\u{5c}')
        && !value.contains('\u{27}')
        && !value.contains('\u{23}')
}

/// Whether a bot token exists anywhere the bridge would look: the process environment or any
/// candidate runtime root's .env. Mirrors the bridge's own loadEnvFiles precedence loosely -
/// for a yes/no decision, finding it in any one place is enough.
fn has_saved_token(app: &AppHandle) -> bool {
    if env::var("DISCORD_TOKEN").map(|v| !v.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    control_token_candidates(Some(app)).iter().any(|root| {
        fs::read_to_string(root.join(".env"))
            .map(|raw| env_value(&raw, "DISCORD_TOKEN").is_some())
            .unwrap_or(false)
    })
}

/// Read one KEY=VALUE from .env text. Same tolerant shape the bridge's parser accepts:
/// optional surrounding quotes, anything after # in an unquoted value ignored.
fn env_value(raw: &str, key: &str) -> Option<String> {
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() != key {
            continue;
        }
        let mut value = v.trim();
        if let Some(hash) = value.find('#') {
            let quoted = value.starts_with('"') || value.starts_with('\u{27}');
            if !quoted {
                value = value[..hash].trim();
            }
        }
        let trimmed = value.trim_matches('"').trim_matches('\u{27}');
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    None
}

/// Write setup answers into the runtime root's .env, preserving every other line. This is the
/// exact file the spawned bridge loads (its runtimeRoot resolves the same way), so saving here
/// is what makes the next spawn able to sign in.
pub fn save_setup(app: &AppHandle, token: &str, app_id: Option<&str>) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("the bot token is empty".into());
    }
    if !savable(token) {
        return Err("the bot token contains characters that cannot be saved safely".into());
    }
    if let Some(app_id) = app_id {
        if !savable(app_id) {
            return Err("the application id contains characters that cannot be saved safely".into());
        }
    }

    let root = runtime_root(Some(app));
    fs::create_dir_all(&root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let path = root.join(".env");
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let mut out = String::with_capacity(existing.len() + 96);
    let mut wrote_token = false;
    let mut wrote_app_id = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        let is_key = |key: &str| {
            trimmed.starts_with(key)
                && trimmed[key.len()..].trim_start().starts_with('=')
        };
        if is_key("DISCORD_TOKEN") {
            out.push_str("DISCORD_TOKEN=");
            out.push_str(token);
            wrote_token = true;
        } else if is_key("DISCORD_APP_ID") {
            match app_id.map(str::trim).filter(|s| !s.is_empty()) {
                Some(app_id) => {
                    out.push_str("DISCORD_APP_ID=");
                    out.push_str(app_id);
                    wrote_app_id = true;
                }
                None => out.push_str(line),
            }
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if !wrote_token {
        out.push_str("DISCORD_TOKEN=");
        out.push_str(token);
        out.push('\n');
    }
    if !wrote_app_id {
        if let Some(app_id) = app_id.map(str::trim).filter(|s| !s.is_empty()) {
            out.push_str("DISCORD_APP_ID=");
            out.push_str(app_id.trim());
            out.push('\n');
        }
    }

    fs::write(&path, out).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(())
}

/* ── spawning ─────────────────────────────────────────────────────────────── */

fn spawn_bridge(app: &AppHandle) -> Result<Child, String> {
    // Development checkout: run the TypeScript entry with Node, exactly like npm start
    // and the WinForms shell do. BRIDGE_PROJECT_ROOT points at the sibling checkout.
    if let Some(root) = find_project_root(Some(app)) {
        if root.join("src").join("index.ts").is_file() {
            let node = resolve_node().ok_or(
                "found the discord-audio-bridge checkout but no Node.js on PATH \
(Node 22.18+ is required to run the bridge from source)",
            )?;
            check_node_version(&node)?;
            return start_child(app, &node, &[root.join("src").join("index.ts")], &root);
        }
    }

    // Packaged layout: the bridge executable sits in a bridge/ folder next to this app
    // (Windows) or under Tauri's resource dir (Linux deb/rpm/AppImage).
    let name = if cfg!(windows) {
        "discord-audio-bridge.exe"
    } else {
        "discord-audio-bridge"
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(path) = env::var("BRIDGE_EXECUTABLE") {
        let path = PathBuf::from(path.trim());
        if !path.as_os_str().is_empty() {
            candidates.push(path);
        }
    }
    if let Some(bundled) = bundled_bridge_root(Some(app)) {
        candidates.push(bundled.join(name));
    }
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .ok_or("cannot locate this application's own directory")?;
    candidates.push(exe_dir.join("bridge").join(name));
    candidates.push(exe_dir.join(name));
    for candidate in &candidates {
        if candidate.is_file() {
            // Prefer the folder that actually has web/ assets. Falling back to the
            // executable's parent covers BRIDGE_EXECUTABLE pointing at a portable layout.
            let cwd = candidate
                .parent()
                .map(|dir| {
                    if dir.join("web").join("index.html").is_file() {
                        dir.to_path_buf()
                    } else if let Some(bundled) = bundled_bridge_root(Some(app)) {
                        bundled
                    } else {
                        dir.to_path_buf()
                    }
                })
                .unwrap_or_else(|| PathBuf::from("."));
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

/// The bridge runs TypeScript directly, which needs Node's native type stripping
/// (22.18+). A pre-22 Node fails with a syntax error deep in the sources, so gate it
/// here and say what to do instead.
fn check_node_version(node: &Path) -> Result<(), String> {
    let output = Command::new(node)
        .arg("--version")
        .output()
        .map_err(|e| format!("could not run {} --version: {e}", node.display()))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = text
        .trim_start_matches('v')
        .split('.')
        .map(|p| p.trim().parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    if (major, minor) < (22, 18) {
        return Err(format!(
            "Node 22.18+ is required to run the bridge from source, found {text} at {} \
(install Node 22+, or point BRIDGE_EXECUTABLE at a packaged bridge)",
            node.display()
        ));
    }
    Ok(())
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
        // Same writable root save_setup uses. Without this, a packaged bridge whose
        // install folder is writable treats that folder as runtimeRoot and never sees
        // the AppData .env the first-run form just wrote.
        .env("BRIDGE_RUNTIME_ROOT", runtime_root(Some(app)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Packaged and checkout layouts both keep web/ next to the process cwd. Setting this
    // explicitly stops the bridge from walking into the wrong tree (e.g. /usr/bin) when the
    // Linux shell lives apart from its resource dir.
    if cwd.join("web").join("index.html").is_file() {
        command.env("BRIDGE_PROJECT_ROOT", cwd);
    } else if let Some(root) = find_project_root(Some(app)) {
        command.env("BRIDGE_PROJECT_ROOT", root);
    }

    // The Unix twin of the Windows kill-on-close job: the kernel signals the child when this
    // process dies, which covers SIGKILL and SIGTERM - exits that never reach our cleanup code.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Close the fork race: if the parent died between fork and prctl, follow it now.
                if libc::getppid() == 1 {
                    libc::_exit(0);
                }
                Ok(())
            });
        }
    }
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

/// How the wait-for-panel loop can end.
enum WaitOutcome {
    Ready(Endpoint),
    /// The deadline passed with no panel. Detail says what the bridge last said.
    Timeout(String),
    /// The bridge child exited before exposing a panel. Detail says how and why.
    ChildDied(String),
}

/// One supervision thread lives for the whole app lifetime. It attaches to an already
/// running bridge if there is one, starts a child only when nothing answers, and keeps
/// the tray in step once attached. This is the WinForms shell's BotProcess lifecycle,
/// restated for two platforms - plus a bounded start budget, because an unattended
/// respawn loop against a broken Node would spin forever.
pub fn supervise(app: AppHandle) {
    let mut failed_starts: u32 = 0;
    loop {
        if is_quitting(&app) {
            return;
        }

        // 1. A bridge that already answers wins: attaching never collides with npm start.
        if let Some(endpoint) = probe_saved_endpoint(&app, &agent(&app)) {
            if run_attached(&app, endpoint) {
                return;
            }
            failed_starts = 0;
            continue;
        }

        // 2. Nothing answered. If the bridge is merely restarting, give it a moment
        //    rather than spawning a duplicate on top of it.
        set_phase(&app, Phase::Locating, "looking for a running bridge");
        match wait_for_endpoint(&app, REATTACH_BUDGET) {
            WaitOutcome::Ready(endpoint) => {
                if run_attached(&app, endpoint) {
                    return;
                }
                failed_starts = 0;
                continue;
            }
            WaitOutcome::ChildDied(detail) => {
                set_phase(&app, Phase::Failed, &detail);
                failed_starts += 1;
            }
            WaitOutcome::Timeout(_) => {}
        }

        // 3. Still nothing. If we already own a live child, it is still starting - never
        //    spawn a second copy alongside it.
        if owns_live_child(&app) {
            set_phase(&app, Phase::Starting, "waiting for the bridge control panel");
            match wait_for_endpoint(&app, START_BUDGET) {
                WaitOutcome::Ready(endpoint) => {
                    if run_attached(&app, endpoint) {
                        return;
                    }
                    failed_starts = 0;
                    continue;
                }
                WaitOutcome::ChildDied(detail) => {
                    set_phase(&app, Phase::Failed, &detail);
                    failed_starts += 1;
                }
                WaitOutcome::Timeout(_) => {
                    // Alive but panel-less past the whole budget: our own child is broken
                    // (or configured without a panel). Stop it rather than orbiting it.
                    kill_owned_child(&app);
                    set_phase(
                        &app,
                        Phase::Failed,
                        "the bridge is running but its control panel never answered - \
is CONTROL_PORT disabled, or is the port already taken?",
                    );
                    failed_starts += 1;
                }
            }
            continue;
        }

        // 4. No bridge anywhere. Before starting one, make sure a bot token exists:
        //    a bridge without credentials only leads to a confusing panel. The setup form
        //    is the whole first-run experience; nothing spawns until it is filled in.
        if !has_saved_token(&app) {
            set_phase(
                &app,
                Phase::SetupNeeded,
                "no bot token configured yet - enter one to start",
            );
            while !is_quitting(&app) {
                {
                    let state = app.state::<ShellState>();
                    let inner = state.0.lock().unwrap();
                    if inner.token_saved {
                        break;
                    }
                }
                // A bridge may appear while the form is open (user ran npm start, say), or a
                // token may land in an .env by hand - both should let the app move on.
                if probe_saved_endpoint(&app, &agent(&app)).is_some() || has_saved_token(&app) {
                    break;
                }
                thread::sleep(Duration::from_millis(250));
            }
            {
                let state = app.state::<ShellState>();
                state.0.lock().unwrap().token_saved = false;
            }
            continue;
        }

        // 5. Start one - unless earlier attempts already used the budget.
        if failed_starts >= MAX_START_ATTEMPTS {
            set_phase(
                &app,
                Phase::Failed,
                "gave up starting the bridge after repeated failures - check the bridge output below, then Retry",
            );
            // Hold here until the user presses Retry (or quits); never auto-respawn.
            while !is_quitting(&app) {
                if wants_retry(&app) {
                    clear_retry(&app);
                    failed_starts = 0;
                    break;
                }
                thread::sleep(Duration::from_millis(250));
            }
            continue;
        }

        set_phase(&app, Phase::Starting, "starting the bridge");
        match spawn_bridge(&app) {
            Ok(child) => {
                {
                    let state = app.state::<ShellState>();
                    let mut inner = state.0.lock().unwrap();
                    inner.logs.clear();
                    inner.child = Some(child);
                }
                match wait_for_endpoint(&app, START_BUDGET) {
                    WaitOutcome::Ready(endpoint) => {
                        if run_attached(&app, endpoint) {
                            return;
                        }
                        failed_starts = 0;
                        continue;
                    }
                    WaitOutcome::ChildDied(detail) => {
                        set_phase(&app, Phase::Failed, &detail);
                        failed_starts += 1;
                    }
                    WaitOutcome::Timeout(_) => {
                        // Same as the owns_live_child timeout path: a panel-less child will
                        // only burn another START_BUDGET if left alive, so stop it now.
                        kill_owned_child(&app);
                        set_phase(
                            &app,
                            Phase::Failed,
                            "the bridge is running but its control panel never answered - is the port free, and is DISCORD_TOKEN set?",
                        );
                        failed_starts += 1;
                    }
                }
            }
            Err(detail) => {
                set_phase(&app, Phase::Failed, &detail);
                failed_starts += 1;
            }
        }

        // 6. After a failure, wait quietly before trying again, unless the user retries first.
        let deadline = Instant::now() + FAILURE_BACKOFF;
        while Instant::now() < deadline {
            if is_quitting(&app) {
                return;
            }
            if wants_retry(&app) {
                clear_retry(&app);
                failed_starts = 0;
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
}

/// Stop and reap the bridge child this shell owns, if any. Never touches a bridge
/// started by anyone else.
pub fn kill_owned_child(app: &AppHandle) {
    let state = app.state::<ShellState>();
    let mut inner = state.0.lock().unwrap();
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Whether the bridge child we spawned is still alive, reaped if it has exited.
fn owns_live_child(app: &AppHandle) -> bool {
    let state = app.state::<ShellState>();
    let mut inner = state.0.lock().unwrap();
    inner
        .child
        .as_mut()
        .is_some_and(|c| c.try_wait().is_ok_and(|s| s.is_none()))
}

/// Poll the saved endpoint until the bridge answers, the deadline passes, or - when the
/// shell owns the child - the bridge dies first. Distinguishing those last two is what
/// makes the failure screen honest: a timeout means "slow", a death means "broken", and
/// the bridge's own last words are the best diagnostic either way.
fn wait_for_endpoint(app: &AppHandle, budget: Duration) -> WaitOutcome {
    let deadline = Instant::now() + budget;
    loop {
        if is_quitting(app) {
            return WaitOutcome::Timeout("app is quitting".into());
        }
        if let Some(endpoint) = probe_saved_endpoint(app, &agent(app)) {
            return WaitOutcome::Ready(endpoint);
        }

        let exited = {
            let state = app.state::<ShellState>();
            let mut inner = state.0.lock().unwrap();
            inner.child.as_mut().and_then(|c| c.try_wait().ok().flatten())
        };
        if let Some(status) = exited {
            let mut detail = format!("the bridge exited during startup ({status})");
            if let Some(last) = last_log_line(app) {
                detail.push_str(": ");
                detail.push_str(&last);
            }
            return WaitOutcome::ChildDied(detail);
        }

        if Instant::now() >= deadline {
            return WaitOutcome::Timeout("no control panel within the budget".into());
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// The last non-empty line the bridge printed, for failure details.
fn last_log_line(app: &AppHandle) -> Option<String> {
    let state = app.state::<ShellState>();
    let inner = state.0.lock().unwrap();
    inner
        .logs
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(200).collect())
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
    app.emit("bridge-ready", endpoint.panel_url()).ok();

    let mut missed = 0u32;
    loop {
        thread::sleep(POLL);
        if is_quitting(app) {
            return true;
        }

        // Navigation can silently do nothing on some webview backends, so watch it: log
        // every URL change on the main window. This is the difference between "panel is
        // showing" and "loader claims success while nothing happened".
        log_url_change(app);

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
        if phase == Phase::Failed || phase == Phase::Locating || phase == Phase::SetupNeeded {
            inner.endpoint = None;
            inner.summary = Summary::default();
        }
    }
    // The panel page cannot show loader UI (retry, setup, status). Whenever we leave
    // Attached, bring the webview back so those screens are reachable again.
    if phase != Phase::Attached {
        navigate_home(app);
    }
    emit_status(app);
    crate::tray::refresh(app);
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
    app.emit("bridge-status", payload).ok();
}

/// Navigate the main webview to an absolute URL. Uses WebviewWindow::navigate - the
/// sanctioned API - rather than eval(location.replace), which some webview backends
/// silently ignore for cross-origin targets.
pub fn navigate(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    match url.parse::<tauri::Url>() {
        Ok(parsed) => {
            if let Err(e) = window.navigate(parsed) {
                eprintln!("navigate to {url} failed: {e}");
            }
        }
        Err(e) => eprintln!("could not parse {url} as a URL: {e}"),
    }
}

/// Log the main window's URL whenever it changes. Cheap, permanent, and the one signal
/// that says the panel really took over the window.
fn log_url_change(app: &AppHandle) {
    let current = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok().map(|u| u.to_string()));
    if let Some(current) = current {
        let state = app.state::<ShellState>();
        let mut inner = state.0.lock().unwrap();
        let changed = inner.last_nav_url.as_deref() != Some(current.as_str());
        if changed {
            eprintln!("window url -> {current}");
            inner.last_nav_url = Some(current);
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
