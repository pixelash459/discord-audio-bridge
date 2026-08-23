use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::bridge;
use crate::state::{tooltip, ShellState, TrayMenu};

/// The tray half is not decoration: this application spends its life hidden, so the icon
/// has to say what the bridge is doing and the menu has to offer the actions people
/// actually take. Same three jobs as the WinForms shell it replaces.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Discord Audio Bridge", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, "mute", "Mute", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop stream", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open logs folder", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &mute, &stop, &logs, &separator, &quit])?;

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

    app.manage(TrayMenu { mute });
    Ok(())
}

/// Called after every successful state poll: keep tooltip and mute label in step.
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
        let enabled = endpoint && summary.streaming && summary.guild_id.is_some();
        let _ = menu.mute.set_enabled(enabled);
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
