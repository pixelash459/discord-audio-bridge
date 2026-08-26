mod bridge;
mod hotkeys;
mod state;
mod tray;
#[cfg(windows)]
mod winjob;

use state::{ShellState, StatusPayload};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// The loader screen the window opens on. Once the bridge's control panel answers, the
/// supervisor navigates the webview to it; everything the user then touches - sources,
/// destinations, meters, setup, logs - is the same panel the browser serves.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Must be registered first, per the plugin docs. A second launch just raises the
        // existing window, because the bridge underneath owns a fixed control port.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            app.manage(ShellState(std::sync::Mutex::new(state::Inner::new())));
            let logs_dir = bridge::bridge_logs_dir();
            {
                let state = app.state::<ShellState>();
                let mut inner = state.0.lock().unwrap();
                inner.logs_dir = Some(logs_dir);
            }
            tray::create(app.handle())?;
            hotkeys::register(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || bridge_supervisor(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let quitting = {
                    let state = app.state::<ShellState>();
                    let inner = state.0.lock().unwrap();
                    inner.quitting
                };
                if !quitting {
                    // Hide to the tray, exactly like the WinForms shell: music keeps
                    // playing while the window is out of the way.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            shell_status,
            shell_logs,
            shell_retry,
            shell_open_logs,
            shell_show,
            shell_hello,
            shell_open_panel,
            shell_save_setup
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // On Windows the kill-on-close job object already covers a crashed shell; this
            // is the Linux equivalent for any exit path we do survive to see.
            if let RunEvent::Exit = event {
                bridge::kill_owned_child(&app);
            }
        });
}

fn bridge_supervisor(app: AppHandle) {
    bridge::supervise(app);
}

/* ── commands the loader screen calls ─────────────────────────────────────── */

#[tauri::command]
fn shell_status(app: AppHandle) -> StatusPayload {
    let state = app.state::<ShellState>();
    let inner = state.0.lock().unwrap();
    StatusPayload {
        phase: inner.phase,
        detail: inner.detail.clone(),
        panel_url: inner.endpoint.as_ref().map(|e| e.panel_url()),
    }
}

#[tauri::command]
fn shell_logs(app: AppHandle) -> String {
    let state = app.state::<ShellState>();
    let inner = state.0.lock().unwrap();
    inner.logs.clone()
}

/// Retry from the failure screen: nudges the supervisor out of its post-failure backoff.
#[tauri::command]
fn shell_retry(app: AppHandle) {
    {
        let state = app.state::<ShellState>();
        state.0.lock().unwrap().retry = true;
    }
    bridge::emit_status(&app);
}

#[tauri::command]
fn shell_open_logs(app: AppHandle) -> Result<(), String> {
    let dir = {
        let state = app.state::<ShellState>();
        let inner = state.0.lock().unwrap();
        inner.logs_dir.clone()
    };
    let Some(dir) = dir else {
        return Err("logs folder is not known yet".into());
    };
    tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn shell_show(app: AppHandle) {
    tray::show_main(&app);
}

/// The loader calls this on startup so the shell remembers where "back to the loader" is
/// after the webview has moved on to the panel.
#[tauri::command]
fn shell_hello(app: AppHandle, url: String) {
    let state = app.state::<ShellState>();
    let mut inner = state.0.lock().unwrap();
    if inner.home_url.is_none() {
        inner.home_url = Some(url);
    }
}

/// Manual "open the panel now" from the loader: navigate the main window to the bridge's
/// panel using its saved endpoint. An escape hatch in case automatic navigation raced.
#[tauri::command]
fn shell_open_panel(app: AppHandle) -> Result<(), String> {
    let url = {
        let state = app.state::<ShellState>();
        let inner = state.0.lock().unwrap();
        inner.endpoint.as_ref().map(|e| e.panel_url())
    };
    match url {
        Some(url) => {
            bridge::navigate(&app, &url);
            Ok(())
        }
        None => Err("the bridge is not attached yet".into()),
    }
}

/// First-run setup: persist the bot token (and optional application id) where the bridge will
/// load it, then wake the supervisor so it starts the bridge right away.
#[tauri::command]
fn shell_save_setup(app: AppHandle, token: String, appId: Option<String>) -> Result<(), String> {
    bridge::save_setup(&token, appId.as_deref())?;
    {
        let state = app.state::<ShellState>();
        let mut inner = state.0.lock().unwrap();
        inner.token_saved = true;
        inner.retry = true;
    }
    bridge::emit_status(&app);
    Ok(())
}
