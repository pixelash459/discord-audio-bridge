use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

/// One line for the tray tooltip, which Windows truncates at 127 characters.
pub fn tooltip(summary: &Summary) -> String {
    if !summary.ready {
        return "Discord Audio Bridge — connecting".into();
    }
    if !summary.streaming {
        return "Discord Audio Bridge — idle".into();
    }
    let what = summary
        .track
        .as_deref()
        .or(summary.label.as_deref())
        .unwrap_or("audio");
    let line = format!("{}: {what}", if summary.muted { "Muted" } else { "Streaming" });
    if line.chars().count() > 120 {
        let cut: String = line.chars().take(119).collect();
        format!("{cut}…")
    } else {
        line
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Looking for a bridge that is already running.
    Locating,
    /// A bridge child was started; waiting for its control panel to answer.
    Starting,
    /// The control panel answered; the window shows it.
    Attached,
    /// Something failed; the loader screen explains and offers Retry.
    Failed,
    /// No bot token anywhere: the setup form is shown before any bridge is started.
    SetupNeeded,
}

#[derive(Clone, Serialize)]
pub struct StatusPayload {
    pub phase: Phase,
    pub detail: String,
    pub panel_url: Option<String>,
}

/// Distilled control snapshot - the same fields desktop/BridgeApp/BridgeClient.cs reads in the
/// main repository, derived from the same GET /api/state response.
#[derive(Clone, Default, Serialize)]
pub struct Summary {
    pub ready: bool,
    pub streaming: bool,
    pub muted: bool,
    pub label: Option<String>,
    pub track: Option<String>,
    /// Guild of the first live session; what the tray actions operate on.
    pub guild_id: Option<String>,
}

/// The authenticated loopback endpoint, read from the bridge's `.control-token` file.
#[derive(Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

impl Endpoint {
    pub fn panel_url(&self) -> String {
        format!("http://127.0.0.1:{}/#token={}", self.port, self.token)
    }

    pub fn state_url(&self) -> String {
        format!("http://127.0.0.1:{}/api/state", self.port)
    }

    pub fn api_url(&self, route: &str) -> String {
        format!("http://127.0.0.1:{}/api/{route}", self.port)
    }
}

/// Everything the shell tracks, guarded by one lock. Threads hold it only for short copies.
pub struct Inner {
    pub phase: Phase,
    pub detail: String,
    pub endpoint: Option<Endpoint>,
    pub summary: Summary,
    pub logs: String,
    pub child: Option<std::process::Child>,
    pub quitting: bool,
    /// Set by the loader's Retry button; the supervisor checks it while waiting after a failure.
    pub retry: bool,
    /// Set once setup saved a token; wakes the supervisor out of SetupNeeded.
    pub token_saved: bool,
    /// Where the loader screen lives, remembered so the shell can navigate back to it.
    pub home_url: Option<String>,
    /// Last observed main-window URL, for navigation-change logging.
    pub last_nav_url: Option<String>,
    pub logs_dir: Option<PathBuf>,
    /// Loopback HTTP only: no TLS, small pool, short timeouts.
    pub agent: ureq::Agent,
}

impl Inner {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(3)))
            .build();
        Self {
            phase: Phase::Locating,
            detail: "looking for a running bridge".into(),
            endpoint: None,
            summary: Summary::default(),
            logs: String::new(),
            child: None,
            quitting: false,
            retry: false,
            token_saved: false,
            home_url: None,
            last_nav_url: None,
            logs_dir: None,
            agent: config.into(),
        }
    }

    /// Same ring-buffer cap the WinForms shell used: enough history to diagnose a bad start.
    pub fn push_log(&mut self, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        self.logs.push_str(line);
        self.logs.push('\n');
        if self.logs.len() > 8000 {
            let cut = self.logs.len() - 8000;
            self.logs = self.logs[cut..].to_string();
        }
    }
}

pub struct ShellState(pub Mutex<Inner>);

/// Stored handles for tray menu items whose state changes at runtime.
pub struct TrayMenu {
    pub mute: tauri::menu::MenuItem<tauri::Wry>,
    pub autostart: tauri::menu::CheckMenuItem<tauri::Wry>,
}
