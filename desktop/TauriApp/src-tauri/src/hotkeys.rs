use tauri::AppHandle;

use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::bridge;
use crate::tray;

/// The same three combinations the WinForms shell registers. A registration failure here is
/// almost always another application owning the combination, which is a reason to carry on
/// quietly rather than to complain.
pub fn register(app: &AppHandle) -> tauri::Result<()> {
    let modifiers = Modifiers::CONTROL | Modifiers::ALT;
    let mute = Shortcut::new(Some(modifiers), Code::KeyM);
    let stop = Shortcut::new(Some(modifiers), Code::KeyS);
    let show = Shortcut::new(Some(modifiers), Code::KeyB);

    let builder = tauri_plugin_global_shortcut::Builder::new().with_handler(move |app, shortcut, event| {
        if event.state != ShortcutState::Pressed {
            return;
        }
        if shortcut == &mute {
            bridge::toggle_mute(app);
        } else if shortcut == &stop {
            bridge::stop_stream(app);
        } else if shortcut == &show {
            tray::show_main(app);
        }
    });
    if let Err(e) = app.plugin(builder.build()) {
        eprintln!("global shortcut plugin failed to initialize: {e}");
    }

    let shortcuts = app.global_shortcut();
    let mut registered = 0u8;
    for shortcut in [&mute, &stop, &show] {
        match shortcuts.register(*shortcut) {
            Ok(()) => registered += 1,
            Err(e) => eprintln!("hotkey {shortcut:?} not registered (probably owned by another app): {e}"),
        }
    }
    if registered < 3 {
        eprintln!("registered {registered}/3 global hotkeys");
    }
    Ok(())
}
