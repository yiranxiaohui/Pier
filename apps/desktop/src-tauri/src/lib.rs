mod host;
mod terminal;
mod tray;
mod updater;

use host::HostManager;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use terminal::TerminalManager;
use updater::UpdateManager;

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Quit the whole app (the close button only hides the window).
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first: a second launch focuses the running instance instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            host::host_status,
            host::host_logs,
            host::host_restart,
            updater::update_status,
            updater::update_check,
            updater::update_install,
            updater::update_set_auto_check,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_kill_all,
            quit_app
        ])
        .setup(|app| {
            let manager = HostManager::new(app.handle().clone());
            app.manage(manager.clone());
            app.manage(TerminalManager::default());
            let updates = UpdateManager::new(app.handle().clone());
            app.manage(updates.clone());
            let update_item = tray::create(app.handle())?;
            updates.set_tray_item(update_item);
            manager.start();
            updates.start_scheduler();
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Pier (and running agents) alive in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Pier desktop app");

    app.run(|app, event| match event {
        // Only an explicit quit (tray menu / app.exit) ends the process.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        RunEvent::Exit => {
            app.state::<TerminalManager>().kill_all();
            app.state::<HostManager>().shutdown();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app),
        _ => {}
    });
}
