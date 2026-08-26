use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::bridge;
use crate::state::{tooltip, ShellState, TrayMenu};

/// The tray half is not decoration: this application spends its life hidden, so the icon
/// has to say what the bridge is doing and the menu has to offer the actions people
/// actually take. Same jobs as the WinForms shell it replaces, autostart included.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Discord Audio Bridge", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, "mute", "Mute", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop stream", false, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open logs folder", true, None::<&str>)?;
    let autostart_enabled = {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    };
    // with_id(manager, id, text, enabled, checked, accelerator): the item must stay
    // clickable so the user can turn autostart on; `checked` mirrors the OS registration.
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start with your computer",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &mute, &stop, &logs, &autostart, &separator, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("app icon").clone())
        .tooltip("Discord Audio Bridge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "mute" => bridge::toggle_mute(app),
            "stop" => bridge::stop_stream(app),
            "logs" => open_logs(app),
            "autostart" => toggle_autostart(app),
            "quit" => bridge::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayMenu { mute, stop, autostart });
    Ok(())
}

/// Mirror the checkbox state into the OS registration: tick = launch at login.
fn toggle_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let now_enabled = manager.is_enabled().unwrap_or(false);
    let result = if now_enabled {
        manager.disable()
    } else {
        manager.enable()
    };
    match result {
        Ok(()) => {
            if let Some(menu) = app.try_state::<TrayMenu>() {
                let _ = menu.autostart.set_checked(!now_enabled);
            }
        }
        Err(e) => {
            eprintln!("could not change autostart: {e}");
            // Keep the checkbox honest if the OS registration did not change.
            if let Some(menu) = app.try_state::<TrayMenu>() {
                let _ = menu.autostart.set_checked(now_enabled);
            }
        }
    }
}

/// Called after every successful state poll: keep tooltip and mute/stop labels in step.
pub fn refresh(app: &AppHandle) {
    let (summary, endpoint) = {
        let state = app.state::<ShellState>();
        let inner = state.0.lock().unwrap();
        (inner.summary.clone(), inner.endpoint.is_some())
    };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tooltip(&summary)));
    }
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let label = if summary.muted { "Unmute" } else { "Mute" };
        let _ = menu.mute.set_text(label);
        let can_control = endpoint && summary.streaming && summary.guild_id.is_some();
        let _ = menu.mute.set_enabled(can_control);
        let _ = menu.stop.set_enabled(can_control);
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn open_logs(app: &AppHandle) {
    let dir = {
        let state = app.state::<ShellState>();
        let inner = state.0.lock().unwrap();
        inner.logs_dir.clone()
    };
    let Some(dir) = dir else { return };
    if dir.is_dir() {
        if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&dir) {
            eprintln!("could not open logs folder: {e}");
        }
    }
}
